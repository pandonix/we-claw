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
});
