import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncherConfig, isNodeCompatible, readLauncherSettings, runtimeSettingsPath, writeLauncherSettings } from "../src/launcher/config";
import { redact } from "../src/launcher/redact";

describe("launcher config", () => {
  it("resolves env overrides", () => {
    const config = createLauncherConfig({
      WE_CLAW_OPENCLAW_BIN: "/tmp/openclaw",
      WE_CLAW_GATEWAY_PORT: "19001",
      WE_CLAW_HTTP_PORT: "4180",
      WE_CLAW_MANAGE_GATEWAY: "0",
      WE_CLAW_RUNTIME: "claude-agent-sdk",
      WE_CLAW_CLAUDE_SDK_CWD: "/tmp/project",
      WE_CLAW_CLAUDE_SDK_PERMISSION_MODE: "plan",
      WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS: "Read, Glob,Grep",
      WE_CLAW_CLAUDE_SDK_MODEL: "claude-sonnet-4-6"
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      openclawExecutable: "/tmp/openclaw",
      gatewayPort: 19001,
      httpPort: 4180,
      manageGateway: false,
      runtimeKind: "claude-agent-sdk",
      runtimeKindSource: "env",
      runtimeKindLocked: true,
      claudeSdkCwd: "/tmp/project",
      claudeSdkPermissionMode: "plan",
      claudeSdkAllowedTools: ["Read", "Glob", "Grep"],
      claudeSdkModel: "claude-sonnet-4-6"
    });
  });

  it("uses persisted runtime settings when env does not lock runtime", () => {
    const config = createLauncherConfig({} as NodeJS.ProcessEnv, { runtimeKind: "claude-agent-sdk" });
    expect(config).toMatchObject({
      runtimeKind: "claude-agent-sdk",
      runtimeKindSource: "settings",
      runtimeKindLocked: false
    });
  });

  it("falls back to OpenClaw when neither env nor settings select a runtime", () => {
    const config = createLauncherConfig({} as NodeJS.ProcessEnv, {});
    expect(config).toMatchObject({
      runtimeKind: "openclaw",
      runtimeKindSource: "default",
      runtimeKindLocked: false
    });
  });

  it("persists runtime settings in the local runtime directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "we-claw-settings-"));
    const settingsPath = runtimeSettingsPath(directory);
    try {
      writeLauncherSettings({ runtimeKind: "claude-agent-sdk" }, settingsPath);
      expect(readLauncherSettings(settingsPath)).toEqual({ runtimeKind: "claude-agent-sdk" });
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ runtimeKind: "claude-agent-sdk" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks OpenClaw's minimum Node requirement", () => {
    expect(isNodeCompatible("22.11.0")).toBe(false);
    expect(isNodeCompatible("22.12.0")).toBe(true);
    expect(isNodeCompatible("25.6.1")).toBe(true);
  });

  it("redacts auth material from diagnostic strings", () => {
    expect(redact("token=abc password=def OPENCLAW_GATEWAY_TOKEN=ghi")).toBe(
      "token=[redacted] password=[redacted] OPENCLAW_GATEWAY_TOKEN=[redacted]"
    );
  });
});
