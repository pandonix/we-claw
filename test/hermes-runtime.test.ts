import { describe, expect, it } from "vitest";
import { createLauncherContext } from "../src/launcher/bootstrap";
import { frameFromHermesEvent, HermesRuntime, normalizeHermesHistory, normalizeHermesSessions, type HermesRpcClient } from "../src/launcher/hermes-runtime";
import type { GatewayFrame } from "../src/shared/types";

class MockHermesClient implements HermesRpcClient {
  requests: { method: string; params?: Record<string, unknown> }[] = [];
  private listener?: (event: { type: string; session_id?: string; payload?: unknown }) => void;

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.list") return { sessions: [{ id: "persisted-1", title: "Existing", started_at: 1777550000, source: "tui" }] } as T;
    if (method === "session.create") return { session_id: "active-1", info: { cwd: "/tmp/hermes" } } as T;
    if (method === "session.title") return { title: "", session_key: "persisted-1" } as T;
    if (method === "session.resume") return { session_id: "active-resumed", resumed: params?.session_id, messages: [] } as T;
    if (method === "session.history") return { messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] } as T;
    if (method === "prompt.submit") return { status: "streaming" } as T;
    if (method === "session.interrupt") return { status: "interrupted" } as T;
    return {} as T;
  }

  onEvent(listener: (event: { type: string; session_id?: string; payload?: unknown }) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: { type: string; session_id?: string; payload?: unknown }): void {
    this.listener?.(event);
  }
}

function runtime(client: MockHermesClient): HermesRuntime {
  return new HermesRuntime(
    createLauncherContext({
      runtimeKind: "hermes",
      hermesRoot: "/tmp/hermes",
      hermesCwd: "/tmp/hermes",
      hermesPython: "python3",
      hermesStartupTimeoutMs: 15000
    }),
    client
  );
}

describe("Hermes runtime adapter", () => {
  it("maps Hermes persisted session rows to We-Claw session keys", () => {
    expect(normalizeHermesSessions({ sessions: [{ id: "abc", title: "Chat", source: "tui" }] })).toEqual([
      {
        id: "hermes:abc",
        sessionKey: "hermes:abc",
        sessionId: "abc",
        title: "Chat",
        subtitle: "Hermes · tui",
        updatedAt: undefined,
        status: "idle"
      }
    ]);
  });

  it("recovers the persisted session id after session.create", async () => {
    const client = new MockHermesClient();
    const summary = await runtime(client).createSession();

    expect(client.requests.map((request) => request.method)).toEqual(["session.create", "session.title"]);
    expect(summary).toMatchObject({
      id: "hermes:persisted-1",
      sessionKey: "hermes:persisted-1",
      sessionId: "persisted-1"
    });
  });

  it("resumes historical sessions before history, send, and interrupt calls", async () => {
    const client = new MockHermesClient();
    const hermes = runtime(client);

    await expect(hermes.loadHistory("hermes:persisted-2")).resolves.toMatchObject({
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" }
      ]
    });
    await hermes.sendPrompt("hermes:persisted-2", "continue", () => undefined);
    await hermes.abort("hermes:persisted-2");

    expect(client.requests).toEqual([
      { method: "session.resume", params: { session_id: "persisted-2", cols: 100 } },
      { method: "session.history", params: { session_id: "active-resumed" } },
      { method: "prompt.submit", params: { session_id: "active-resumed", text: "continue" } },
      { method: "session.interrupt", params: { session_id: "active-resumed" } }
    ]);
  });

  it("routes Hermes stream events through Gateway-like frames with stable session keys", async () => {
    const client = new MockHermesClient();
    const hermes = runtime(client);
    const frames: GatewayFrame[] = [];

    await hermes.createSession();
    hermes.subscribeSessionMessages("hermes:persisted-1", (frame) => frames.push(frame));
    client.emit({ type: "message.delta", session_id: "active-1", payload: { text: "partial" } });
    client.emit({ type: "message.complete", session_id: "active-1", payload: { text: "done", status: "complete" } });

    expect(frames[0]).toMatchObject({ type: "chat", payload: { state: "delta", sessionKey: "hermes:persisted-1", delta: "partial" } });
    expect(frames[1]).toMatchObject({ type: "chat", payload: { state: "final", sessionKey: "hermes:persisted-1" } });
    expect(frames[2]).toMatchObject({ type: "event", event: "session.message", payload: { sessionKey: "hermes:persisted-1" } });
  });

  it("normalizes Hermes history and event frames without frontend-specific protocol branches", () => {
    expect(normalizeHermesHistory({ messages: [{ role: "assistant", content: [{ text: "hello" }] }] }, "hermes:abc").messages).toEqual([
      { id: "hermes-history-0", role: "assistant", text: "hello", status: "final", timestamp: undefined }
    ]);
    expect(frameFromHermesEvent({ type: "tool.complete", session_id: "active", payload: { tool_id: "t1", name: "exec", summary: "ok" } }, "hermes:abc")).toMatchObject({
      type: "event",
      event: "session.tool",
      payload: {
        data: {
          phase: "result",
          toolCallId: "t1",
          name: "exec",
          result: "ok"
        }
      }
    });
  });
});
