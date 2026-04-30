import type { RuntimeKind } from "../shared/types";

export interface LauncherConfig {
  openclawExecutable: string;
  gatewayPort: number;
  httpPort: number;
  host: string;
  manageGateway: boolean;
  runtimeKind: RuntimeKind | "auto";
  claudeSdkCwd: string;
  claudeSdkPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  claudeSdkAllowedTools: string[];
  claudeSdkModel?: string;
}

export function createLauncherConfig(env: NodeJS.ProcessEnv = process.env): LauncherConfig {
  return {
    openclawExecutable: env.WE_CLAW_OPENCLAW_BIN || "openclaw",
    gatewayPort: Number(env.WE_CLAW_GATEWAY_PORT || "18789"),
    httpPort: Number(env.WE_CLAW_HTTP_PORT || "4173"),
    host: "127.0.0.1",
    manageGateway: env.WE_CLAW_MANAGE_GATEWAY !== "0",
    runtimeKind: normalizeRuntimeKind(env.WE_CLAW_RUNTIME),
    claudeSdkCwd: env.WE_CLAW_CLAUDE_SDK_CWD || process.cwd(),
    claudeSdkPermissionMode: normalizePermissionMode(env.WE_CLAW_CLAUDE_SDK_PERMISSION_MODE),
    claudeSdkAllowedTools: parseList(env.WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS),
    claudeSdkModel: normalizeOptionalText(env.WE_CLAW_CLAUDE_SDK_MODEL)
  };
}

export function isNodeCompatible(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

function normalizeRuntimeKind(value: string | undefined): RuntimeKind | "auto" {
  if (value === "openclaw" || value === "hermes" || value === "claude-agent-sdk" || value === "cli-process" || value === "auto") return value;
  return "openclaw";
}

function normalizePermissionMode(value: string | undefined): LauncherConfig["claudeSdkPermissionMode"] {
  if (value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan" || value === "dontAsk" || value === "auto") return value;
  return "dontAsk";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}
