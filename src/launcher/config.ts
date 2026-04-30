import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeKind } from "../shared/types";

export interface LauncherSettings {
  runtimeKind?: RuntimeKind;
}

export interface LauncherConfig {
  openclawExecutable: string;
  gatewayPort: number;
  httpPort: number;
  host: string;
  manageGateway: boolean;
  runtimeKind: RuntimeKind;
  runtimeKindSource: "env" | "settings" | "default";
  runtimeKindLocked: boolean;
  settingsPath: string;
  claudeSdkCwd: string;
  claudeSdkPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  claudeSdkAllowedTools: string[];
  claudeSdkModel?: string;
}

export function createLauncherConfig(env: NodeJS.ProcessEnv = process.env, settings = readLauncherSettings()): LauncherConfig {
  const envRuntimeKind = parseRuntimeKind(env.WE_CLAW_RUNTIME);
  const settingsRuntimeKind = parseRuntimeKind(settings.runtimeKind);
  const runtimeKind = envRuntimeKind ?? settingsRuntimeKind ?? "openclaw";
  return {
    openclawExecutable: env.WE_CLAW_OPENCLAW_BIN || "openclaw",
    gatewayPort: Number(env.WE_CLAW_GATEWAY_PORT || "18789"),
    httpPort: Number(env.WE_CLAW_HTTP_PORT || "4173"),
    host: "127.0.0.1",
    manageGateway: env.WE_CLAW_MANAGE_GATEWAY !== "0",
    runtimeKind,
    runtimeKindSource: envRuntimeKind ? "env" : settingsRuntimeKind ? "settings" : "default",
    runtimeKindLocked: Boolean(envRuntimeKind),
    settingsPath: runtimeSettingsPath(),
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

export function runtimeSettingsPath(cwd = process.cwd()): string {
  return join(cwd, ".runtime", "settings.json");
}

export function readLauncherSettings(path = runtimeSettingsPath()): LauncherSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const runtimeKind = parseRuntimeKind(parsed.runtimeKind);
    return runtimeKind ? { runtimeKind } : {};
  } catch {
    return {};
  }
}

export function writeLauncherSettings(settings: LauncherSettings, path = runtimeSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function parseRuntimeKind(value: unknown): RuntimeKind | undefined {
  if (value === "openclaw" || value === "hermes" || value === "claude-agent-sdk" || value === "cli-process") return value;
  if (value === "auto") return "openclaw";
  return undefined;
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
