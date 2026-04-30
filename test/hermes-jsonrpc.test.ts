import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { LauncherConfig } from "../src/launcher/config";
import { HermesJsonRpcClient, type HermesChildProcess } from "../src/launcher/hermes-jsonrpc";

class FakeHermesProcess extends EventEmitter implements HermesChildProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 143;
    return true;
  }

  sendStdout(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  sendStderr(value: string): void {
    this.stderr.write(`${value}\n`);
  }
}

function config(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    openclawExecutable: "openclaw",
    gatewayPort: 18789,
    httpPort: 4173,
    host: "127.0.0.1",
    manageGateway: true,
    runtimeKind: "hermes",
    runtimeKindSource: "env",
    runtimeKindLocked: true,
    settingsPath: ".runtime/settings.json",
    claudeSdkCwd: "/tmp/project",
    claudeSdkPermissionMode: "dontAsk",
    claudeSdkAllowedTools: [],
    hermesPython: "python3",
    hermesRoot: "/tmp/hermes",
    hermesCwd: "/tmp/hermes",
    hermesStartupTimeoutMs: 15000,
    ...overrides
  };
}

describe("HermesJsonRpcClient", () => {
  it("starts the gateway, writes JSON-RPC requests, and resolves responses", async () => {
    const child = new FakeHermesProcess();
    const client = new HermesJsonRpcClient(config(), () => child);
    await startReady(client, child);

    const written: string[] = [];
    child.stdin.on("data", (chunk) => written.push(String(chunk)));

    const request = client.request("session.list", { limit: 1 });
    await vi.waitFor(() => expect(written.join("")).toContain("\"method\":\"session.list\""));
    const id = JSON.parse(written.join("").trim()).id;
    child.sendStdout({ jsonrpc: "2.0", id, result: { sessions: [] } });

    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it("publishes Hermes event notifications", async () => {
    const child = new FakeHermesProcess();
    const client = new HermesJsonRpcClient(config(), () => child);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    await startReady(client, child);
    child.sendStdout({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "active", payload: { text: "hi" } } });

    expect(events).toContainEqual({ type: "gateway.ready", payload: { skin: "default" } });
    expect(events).toContainEqual({ type: "message.delta", session_id: "active", payload: { text: "hi" } });
  });

  it("includes stderr tail in startup timeout diagnostics", async () => {
    vi.useFakeTimers();
    const child = new FakeHermesProcess();
    const client = new HermesJsonRpcClient(config({ hermesStartupTimeoutMs: 25 }), () => child);
    const started = client.start();
    const rejection = expect(started).rejects.toThrow("missing module tui_gateway");
    child.sendStderr("missing module tui_gateway");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(child.killed).toBe(true);
    vi.useRealTimers();
  });
});

async function startReady(client: HermesJsonRpcClient, child: FakeHermesProcess): Promise<void> {
  const started = client.start();
  child.sendStdout({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { skin: "default" } } });
  await started;
}
