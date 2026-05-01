import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import type { BootstrapDiagnostics, BootstrapResponse, RuntimeKind, RuntimeOption, RuntimeSelection, RuntimeTransport } from "../shared/types";
import { createLauncherConfig, isNodeCompatible, type LauncherConfig } from "./config.js";
import { resolveGatewayAuth } from "./gateway-auth.js";
import { gatewayBridgePath } from "./gateway-bridge.js";
import { redact } from "./redact.js";
import { detectClaudeAgentSdkVersion, runtimeBootstrap } from "./runtime-bridge.js";

const execFileAsync = promisify(execFile);
const HERMES_DETECTION_CACHE_TTL_MS = 30_000;

let hermesDetectionCache:
  | {
      key: string;
      expiresAt: number;
      promise: Promise<HermesDetection>;
    }
  | undefined;

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
  const hermes = context.config.runtimeKind === "hermes" ? await detectHermes(context.config) : hermesStatusFromConfig(context.config);
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
  if (context.config.runtimeKind === "hermes" && !hermes.available) {
    diagnostics.push({
      code: hermes.code,
      message: hermes.message,
      detail: hermes.error
    });
  }

  let runtime = runtimeBootstrap(
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
  );
  if (context.config.runtimeKind === "hermes" && !hermes.available) {
    runtime = {
      ...runtime,
      available: false,
      reachable: false,
      ready: false,
      processState: "failed",
      error: hermes.error
    };
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
    runtime,
    runtimeSelection: createRuntimeSelection(context, openclaw, gateway.error, hermes),
    diagnostics
  };
}

export function createRuntimeSelection(
  context: LauncherContext,
  openclaw: BootstrapResponse["openclaw"],
  gatewayError?: string,
  hermes = hermesStatusFromConfig(context.config)
): RuntimeSelection {
  const claudeVersion = detectClaudeAgentSdkVersion();
  const current = context.config.runtimeKind;
  return {
    current,
    configured: current,
    source: context.config.runtimeKindSource,
    locked: context.config.runtimeKindLocked,
    settingsPath: context.config.settingsPath,
    options: [
      runtimeOption({
        kind: "openclaw",
        configured: current === "openclaw",
        version: openclaw.version,
        available: openclaw.available,
        detail: openclaw.available ? undefined : openclaw.error ?? gatewayError
      }),
      runtimeOption({
        kind: "claude-agent-sdk",
        configured: current === "claude-agent-sdk",
        version: claudeVersion,
        available: Boolean(claudeVersion),
        detail: claudeVersion ? undefined : "Claude Agent SDK package is not installed."
      }),
      runtimeOption({
        kind: "hermes",
        configured: current === "hermes",
        available: hermes.available,
        version: hermes.version,
        detail: hermes.available ? hermes.detail : hermes.error
      })
    ],
    claudeSdk: {
      cwd: context.config.claudeSdkCwd,
      permissionMode: context.config.claudeSdkPermissionMode,
      allowedTools: context.config.claudeSdkAllowedTools,
      model: context.config.claudeSdkModel
    },
    hermes: {
      configured: Boolean(context.config.hermesRoot),
      root: context.config.hermesRoot,
      cwd: context.config.hermesCwd,
      startupTimeoutMs: context.config.hermesStartupTimeoutMs
    }
  };
}

function runtimeOption(params: {
  kind: RuntimeKind;
  configured: boolean;
  available: boolean;
  version?: string;
  detail?: string;
}): RuntimeOption {
  return {
    kind: params.kind,
    name: runtimeName(params.kind),
    transport: runtimeTransport(params.kind),
    configured: params.configured,
    available: params.available,
    version: params.version,
    detail: params.detail
  };
}

function runtimeTransport(kind: RuntimeKind): RuntimeTransport {
  if (kind === "claude-agent-sdk") return "library-sdk";
  if (kind === "hermes") return "stdio-jsonrpc";
  if (kind === "cli-process") return "cli-process";
  return "gateway-ws";
}

function runtimeName(kind: RuntimeKind): string {
  return {
    openclaw: "OpenClaw",
    hermes: "Hermes",
    "claude-agent-sdk": "Claude Agent SDK",
    "cli-process": "CLI Process"
  }[kind];
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

interface HermesDetection {
  available: boolean;
  code: string;
  message: string;
  detail?: string;
  error?: string;
  version?: string;
}

export async function detectHermes(config: LauncherConfig): Promise<HermesDetection> {
  if (!config.hermesRoot) return hermesStatusFromConfig(config);
  const cacheKey = [config.hermesPython, config.hermesRoot, config.hermesCwd, config.hermesStartupTimeoutMs].join("\0");
  const now = Date.now();
  if (hermesDetectionCache?.key === cacheKey && hermesDetectionCache.expiresAt > now) {
    return hermesDetectionCache.promise;
  }

  const promise = detectHermesUncached(config);
  hermesDetectionCache = {
    key: cacheKey,
    expiresAt: now + HERMES_DETECTION_CACHE_TTL_MS,
    promise
  };
  return promise;
}

async function detectHermesUncached(config: LauncherConfig): Promise<HermesDetection> {
  const hermesRoot = config.hermesRoot;
  if (!hermesRoot) return hermesStatusFromConfig(config);
  try {
    const pythonPath = process.env.PYTHONPATH?.trim();
    const env = {
      ...process.env,
      PYTHONPATH: pythonPath ? `${hermesRoot}${delimiter}${pythonPath}` : hermesRoot
    };
    await execFileAsync(
      config.hermesPython,
      ["-c", "import tui_gateway.entry"],
      { cwd: config.hermesCwd, env, timeout: config.hermesStartupTimeoutMs }
    );
    return {
      available: true,
      code: "hermes.available",
      message: "Hermes TUI Gateway entry is available.",
      detail: `Hermes root: ${hermesRoot}`
    };
  } catch (error) {
    const message = error instanceof Error ? redact(error.message) : redact(String(error));
    return {
      available: false,
      code: "hermes.entry-unavailable",
      message: "Hermes TUI Gateway entry could not be imported.",
      error: message
    };
  }
}

function hermesStatusFromConfig(config: LauncherConfig): HermesDetection {
  if (!config.hermesRoot) {
    return {
      available: false,
      code: "hermes.root-missing",
      message: "Hermes root is not configured.",
      error: "Set WE_CLAW_HERMES_ROOT to the local hermes-agent checkout before selecting WE_CLAW_RUNTIME=hermes."
    };
  }
  return {
    available: true,
    code: "hermes.configured",
    message: "Hermes runtime is configured.",
    detail: `Hermes root: ${config.hermesRoot}`
  };
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
