import { describe, expect, it } from "vitest";
import { normalizeHistory, normalizeSessions, reduceChatEvent } from "../src/shared/normalizers";

describe("normalizers", () => {
  it("normalizes session rows from Gateway-shaped payloads", () => {
    expect(
      normalizeSessions({
        sessions: [{ sessionId: "abc123", name: "实现 UI", workspace: "we-claw", running: true }]
      })
    ).toEqual([
      {
        id: "abc123",
        sessionKey: "abc123",
        sessionId: "abc123",
        title: "实现 UI",
        subtitle: "we-claw",
        updatedAt: undefined,
        status: "running"
      }
    ]);
  });

  it("normalizes text and multipart chat history", () => {
    expect(
      normalizeHistory({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: [{ text: "hi" }, { text: "there" }] }
        ]
      }).map((message) => message.text)
    ).toEqual(["hello", "hi\nthere"]);
  });

  it("merges streaming deltas into the active assistant message", () => {
    const first = reduceChatEvent({ messages: [], running: false }, { type: "delta", delta: "hel" });
    const second = reduceChatEvent(first, { type: "delta", delta: "lo" });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ role: "assistant", text: "hello", status: "running" });
  });

  it("keeps OpenClaw run-start acknowledgements out of the transcript", () => {
    const next = reduceChatEvent({ messages: [], running: false }, { runId: "abc", status: "started" });
    expect(next).toEqual({ messages: [], running: true, error: undefined });
  });

  it("replaces the streaming assistant row with the final OpenClaw event", () => {
    const streaming = reduceChatEvent({ messages: [], running: false }, { state: "delta", message: { role: "assistant", content: "hel" } });
    const final = reduceChatEvent(streaming, { state: "final", message: { role: "assistant", content: "hello" } });
    expect(final.running).toBe(false);
    expect(final.messages).toHaveLength(1);
    expect(final.messages[0]).toMatchObject({ role: "assistant", text: "hello", status: "final" });
  });

  it("normalizes OpenClaw session keys separately from session ids", () => {
    expect(
      normalizeSessions({
        sessions: [{ key: "agent:main:main", sessionId: "764e1dd9-d862-41ca-b98a-9b3209919094" }]
      })[0]
    ).toMatchObject({
      id: "agent:main:main",
      sessionKey: "agent:main:main",
      sessionId: "764e1dd9-d862-41ca-b98a-9b3209919094",
      title: "Session 764e1dd9"
    });
  });
});
