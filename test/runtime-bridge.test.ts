import { describe, expect, it } from "vitest";
import { claudeStreamDeltaText, normalizeClaudeHistory, normalizeClaudeHistoryMessages, normalizeClaudeSession } from "../src/launcher/runtime-bridge";

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

  it("preserves Claude tool calls and compact boundaries in history", () => {
    const history = normalizeClaudeHistory([
      {
        type: "assistant",
        uuid: "a-tool",
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }]
        }
      },
      {
        type: "user",
        uuid: "u-tool-result",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "ok" }] }]
        }
      },
      {
        type: "system",
        uuid: "compact-1",
        message: { subtype: "compact_boundary" }
      }
    ]);

    expect(history.messages).toEqual([]);
    expect(history.toolBlocks).toHaveLength(1);
    expect(history.toolBlocks?.[0]).toMatchObject({
      toolCallId: "tool-1",
      name: "Read",
      status: "completed",
      input: '{\n  "file_path": "README.md"\n}',
      output: "ok"
    });
    expect(history.notices?.[0]).toMatchObject({ kind: "compaction", text: "Claude conversation compacted" });
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
