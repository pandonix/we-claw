import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import type { BootstrapDiagnostics, BootstrapResponse } from "../shared/types";
import { createLauncherConfig, isNodeCompatible, type LauncherConfig } from "./config.js";
import { resolveGatewayAuth } from "./gateway-auth.js";
import { gatewayBridgePath } from "./gateway-bridge.js";
import { redact } from "./redact.js";
import { runtimeBootstrap } from "./runtime-bridge.js";

const execFileAsync = promisify(execFile);

export interface LauncherContext {
  config: LauncherConfig;
  managedGatewayStarted: boolean;
  gatewayError?: string;
}

export function createLauncherContext(overrides: Partial<LauncherConfig> = {}): LauncherContext {
  return {
    config: { ...createLauncherConfig(), ...overrides },
    managedGatewayStarted: false
  };
}

export async function createBootstrapSnapshot(context: LauncherContext): Promise<BootstrapResponse> {
  const diagnostics: BootstrapDiagnostics[] = [];
  const nodeCompatible = isNodeCompatible();
  if (!nodeCompatible) {
    diagnostics.push({
      code: "node.unsupported",
      message: "OpenClaw requires Node.js 22.12 or newer.",
      detail: `Current Node.js is ${process.versions.node}.`
    });
  }

  const openclaw = await detectOpenClaw(context.config.openclawExecutable);
  if (!openclaw.available) {
    diagnostics.push({
      code: "openclaw.missing",
      message: "OpenClaw executable was not found or did not respond to --version.",
      detail: openclaw.error
    });
  }

  const gateway = await probeGateway(context.config.host, context.config.gatewayPort);
  const gatewayAuth = await resolveGatewayAuth();
  if (!gateway.reachable && openclaw.available && context.config.manageGateway) {
    diagnostics.push({
      code: "gateway.not-running",
      message: "No compatible loopback Gateway is reachable yet.",
      detail: "Start We-Claw with gateway management enabled to launch OpenClaw Gateway automatically."
    });
  }
  if (gatewayAuth.mode === "token" && !gatewayAuth.token) {
    diagnostics.push({
      code: "gateway.auth-token-unresolved",
      message: "OpenClaw Gateway uses token auth, but We-Claw could not resolve a token.",
      detail: gatewayAuth.error
    });
  }

  return {
    node: {
      version: process.versions.node,
      compatible: nodeCompatible,
      required: ">=22.12.0"
    },
    openclaw,
    gateway: {
      url: `ws://${context.config.host}:${context.config.gatewayPort}`,
      httpUrl: `http://${context.config.host}:${context.config.gatewayPort}`,
      port: context.config.gatewayPort,
      bridgePath: gatewayBridgePath(),
      bridgeAuthReady: gatewayAuth.mode !== "token" || Boolean(gatewayAuth.token),
      ownership: context.managedGatewayStarted ? "managed" : gateway.reachable ? "external" : "none",
      reachable: gateway.reachable,
      ready: gateway.ready,
      processState: context.managedGatewayStarted ? "running" : gateway.reachable ? "external" : "not-started",
      error: context.gatewayError ?? gateway.error
    },
    runtime: runtimeBootstrap(
      context,
      {
        kind: "openclaw",
        transport: "gateway-ws",
        name: "OpenClaw",
        available: openclaw.available,
        version: openclaw.version,
        bridgePath: gatewayBridgePath(),
        capabilities: {
          sessions: true,
          sessionList: true,
          resume: true,
          fork: false,
          stream: true,
          abort: true,
          approvals: true,
          toolEvents: true,
          mcp: true,
          hooks: true
        },
        ownership: context.managedGatewayStarted ? "managed" : gateway.reachable ? "external" : "none",
        reachable: gateway.reachable,
        ready: gateway.ready,
        processState: context.managedGatewayStarted ? "running" : gateway.reachable ? "external" : "not-started",
        error: context.gatewayError ?? gateway.error
      },
      openclaw.version
    ),
    diagnostics
  };
}

export async function detectOpenClaw(executable: string): Promise<BootstrapResponse["openclaw"]> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], { timeout: 5000 });
    return {
      available: true,
      executable,
      version: redact((stdout || stderr).trim())
    };
  } catch (error) {
    return {
      available: false,
      executable,
      error: error instanceof Error ? redact(error.message) : String(error)
    };
  }
}

export async function probeGateway(host: string, port: number): Promise<{ reachable: boolean; ready: boolean; error?: string }> {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: "/", timeout: 1000 }, (response) => {
      response.resume();
      resolve({ reachable: true, ready: response.statusCode !== undefined && response.statusCode < 500 });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ reachable: false, ready: false, error: "Gateway probe timed out." });
    });
    request.on("error", (error) => resolve({ reachable: false, ready: false, error: redact(error.message) }));
  });
}
