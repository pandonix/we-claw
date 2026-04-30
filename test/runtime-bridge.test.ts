import { describe, expect, it } from "vitest";
import { claudeStreamDeltaText, normalizeClaudeHistoryMessages, normalizeClaudeSession } from "../src/launcher/runtime-bridge";

describe("runtime bridge Claude normalizers", () => {
  it("maps SDK session metadata into We-Claw session summaries", () => {
    expect(
      normalizeClaudeSession({
        sessionId: "abc-123",
        summary: "Investigate launch failure",
        cwd: "/tmp/project",
        lastModified: 1777550000000
      })
    ).toMatchObject({
      id: "claude:abc-123",
      sessionKey: "claude:abc-123",
      sessionId: "abc-123",
      title: "Investigate launch failure",
      subtitle: "Claude Agent SDK · /tmp/project",
      status: "idle"
    });
  });

  it("converts SDK history messages into transcript rows", () => {
    expect(
      normalizeClaudeHistoryMessages([
        { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use", name: "Read" }] } }
      ])
    ).toEqual([
      { id: "u1", role: "user", text: "Hello", status: "final" },
      { id: "a1", role: "assistant", text: "Hi", status: "final" }
    ]);
  });

  it("extracts raw content block text deltas", () => {
    expect(
      claudeStreamDeltaText({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }
      })
    ).toBe("partial");
  });
});
