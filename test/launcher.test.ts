import { describe, expect, it } from "vitest";
import { createLauncherConfig, isNodeCompatible } from "../src/launcher/config";
import { redact } from "../src/launcher/redact";

describe("launcher config", () => {
  it("resolves env overrides", () => {
    const config = createLauncherConfig({
      WE_CLAW_OPENCLAW_BIN: "/tmp/openclaw",
      WE_CLAW_GATEWAY_PORT: "19001",
      WE_CLAW_HTTP_PORT: "4180",
      WE_CLAW_MANAGE_GATEWAY: "0"
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      openclawExecutable: "/tmp/openclaw",
      gatewayPort: 19001,
      httpPort: 4180,
      manageGateway: false
    });
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
