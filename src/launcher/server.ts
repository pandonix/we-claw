import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { RuntimeKind } from "../shared/types.js";
import { createBootstrapSnapshot, createLauncherContext, detectOpenClaw, probeGateway, type LauncherContext } from "./bootstrap.js";
import { parseRuntimeKind, writeLauncherSettings } from "./config.js";
import { installGatewayBridge } from "./gateway-bridge.js";
import { redact } from "./redact.js";
import { installRuntimeBridge, runtimeKind } from "./runtime-bridge.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startWeClawServer(options: { root?: string; openBrowser?: boolean } = {}): Promise<ServerHandle> {
  const context = createLauncherContext();
  const root = resolve(options.root ?? "dist/client");

  if (runtimeKind(context) === "openclaw" && context.config.manageGateway) {
    await ensureGateway(context);
  }

  const server = http.createServer(async (request, response) => {
    if (request.url?.startsWith("/api/runtime/select") && request.method === "POST") {
      await handleRuntimeSelect(request, response, context);
      return;
    }

    if (
      request.url?.startsWith("/api/bootstrap") ||
      request.url?.startsWith("/api/gateway/status") ||
      request.url?.startsWith("/api/runtime/options")
    ) {
      const body = await createBootstrapSnapshot(context);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
      return;
    }

    if (request.url?.startsWith("/api/")) {
      sendJson(response, 404, {
        error: {
          message: "Unknown We-Claw API endpoint.",
          code: "api.not-found"
        }
      });
      return;
    }

    serveStatic(root, request.url ?? "/", response);
  });
  installGatewayBridge(server, context);
  const runtimeBridge = installRuntimeBridge(server, context);

  await new Promise<void>((resolveListen) => server.listen(context.config.httpPort, context.config.host, resolveListen));

  const url = `http://${context.config.host}:${context.config.httpPort}`;
  return {
    url,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      runtimeBridge.close();
    }
  };
}

async function handleRuntimeSelect(request: http.IncomingMessage, response: http.ServerResponse, context: LauncherContext): Promise<void> {
  if (context.config.runtimeKindLocked) {
    sendJson(response, 409, {
      error: {
        message: "Runtime selection is locked by WE_CLAW_RUNTIME.",
        code: "runtime.locked"
      }
    });
    return;
  }

  const body = await readJsonBody(request).catch((error) => {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid JSON body.", code: "runtime.bad-request" } });
    return undefined;
  });
  if (body === undefined) return;

  const runtimeKind = parseRuntimeKind((body as { runtimeKind?: unknown }).runtimeKind);
  if (!runtimeKind) {
    sendJson(response, 400, {
      error: {
        message: "Unsupported runtime kind.",
        code: "runtime.unsupported"
      }
    });
    return;
  }

  persistRuntimeSelection(context, runtimeKind);
  if (runtimeKind === "openclaw" && context.config.manageGateway) {
    await ensureGateway(context);
  }

  sendJson(response, 200, await createBootstrapSnapshot(context));
}

function persistRuntimeSelection(context: LauncherContext, runtimeKind: RuntimeKind): void {
  writeLauncherSettings({ runtimeKind }, context.config.settingsPath);
  context.config.runtimeKind = runtimeKind;
  context.config.runtimeKindSource = "settings";
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 64_000) throw new Error("Request body is too large.");
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function ensureGateway(context: LauncherContext): Promise<void> {
  const openclaw = await detectOpenClaw(context.config.openclawExecutable);
  if (!openclaw.available) return;

  const probe = await probeGateway(context.config.host, context.config.gatewayPort);
  if (probe.reachable) return;

  const child = spawn(context.config.openclawExecutable, [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(context.config.gatewayPort)
  ]);
  context.managedGatewayStarted = true;
  monitorGatewayProcess(child, context);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const nextProbe = await probeGateway(context.config.host, context.config.gatewayPort);
    if (nextProbe.reachable) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }

  context.gatewayError = "OpenClaw Gateway did not become reachable before timeout.";
}

function monitorGatewayProcess(child: ChildProcessWithoutNullStreams, context: LauncherContext): void {
  child.stderr.on("data", (chunk) => {
    context.gatewayError = redact(String(chunk).trim()).slice(0, 500);
  });
  child.on("exit", (code, signal) => {
    context.managedGatewayStarted = false;
    if (code !== 0) {
      context.gatewayError = `Managed Gateway exited with code ${code ?? "none"} signal ${signal ?? "none"}.`;
    }
  });
  const stop = () => child.kill("SIGTERM");
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
}

function serveStatic(root: string, url: string, response: http.ServerResponse): void {
  const pathname = decodeURIComponent(url.split("?")[0] || "/");
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    const fallback = join(root, "index.html");
    if (existsSync(fallback)) {
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
      createReadStream(fallback).pipe(response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}
