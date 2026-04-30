import { describe, expect, it } from "vitest";
import { normalizeHistory, normalizeSessions, reduceChatEvent, titleFromHistory, UNTITLED_SESSION } from "../src/shared/normalizers";

describe("normalizers", () => {
  it("normalizes session rows from Gateway-shaped payloads", () => {
    expect(
      normalizeSessions({
        sessions: [{ sessionId: "abc123", displayName: "实现 UI", workspace: "we-claw", running: true }]
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

  it("prefers readable session title fields in OpenClaw order", () => {
    expect(
      normalizeSessions({
        sessions: [
          { key: "s1", displayName: "Display title", derivedTitle: "Derived title", label: "Label title", lastMessagePreview: "Preview title" },
          { key: "s2", derivedTitle: "Derived title", label: "Label title", lastMessagePreview: "Preview title" },
          { key: "s3", label: "Label title", lastMessagePreview: "Preview title" },
          { key: "s4", lastMessagePreview: "Preview title" }
        ]
      }).map((session) => session.title)
    ).toEqual(["Display title", "Derived title", "Label title", "Preview title"]);
  });

  it("normalizes preview whitespace and truncates summary-backed session titles", () => {
    const [session] = normalizeSessions({
      sessions: [
        {
          key: "s1",
          lastMessagePreview: "  This is a very long\n\nmessage preview that should become a compact single-line session summary for the rail.  "
        }
      ]
    });

    expect(session?.title).toBe("This is a very long message preview that should become a compac…");
    expect(session?.title).not.toContain("\n");
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

  it("keeps OpenClaw tool payloads out of visible chat history", () => {
    expect(
      normalizeHistory({
        messages: [
          { id: "u1", role: "user", content: "小马" },
          { id: "tc1", role: "assistant", content: [{ type: "toolCall", name: "memory.search", input: { query: "private memory" } }] },
          { id: "tr1", role: "toolResult", content: [{ type: "text", text: "large memory search result" }] },
          {
            id: "a1",
            role: "assistant",
            content: [
              { type: "toolCall", name: "message_user" },
              { type: "text", text: "在，淞哥。\n我在这儿，怎么接着来?" }
            ]
          }
        ]
      }).map((message) => message.text)
    ).toEqual(["小马", "在，淞哥。\n我在这儿，怎么接着来?"]);
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
      title: UNTITLED_SESSION
    });
  });

  it("does not use raw session identifiers as display titles", () => {
    expect(
      normalizeSessions({
        sessions: [
          { key: "agent:main:main", sessionId: "764e1dd9-d862-41ca-b98a-9b3209919094", displayName: "agent:main:main" },
          { key: "s2", derivedTitle: "764e1dd9-d862-41ca-b98a-9b3209919094" },
          { key: "s3", label: "Session 764e1dd9" },
          { key: "s4", label: "3611e932 (2026-04-30)" }
        ]
      }).map((session) => session.title)
    ).toEqual([UNTITLED_SESSION, UNTITLED_SESSION, UNTITLED_SESSION, UNTITLED_SESSION]);
  });

  it("derives a readable title from chat history user messages", () => {
    expect(
      titleFromHistory([
        { id: "a1", role: "assistant", text: "How can I help?", status: "final" },
        { id: "u1", role: "user", text: "  Build the runtime index\nfor session history rail  ", status: "final" },
        { id: "u2", role: "user", text: "Later clarification", status: "final" }
      ])
    ).toBe("Build the runtime index for session history rail");
  });

  it("falls back to the most recent user history message when the first one is technical", () => {
    expect(
      titleFromHistory([
        { id: "u1", role: "user", text: "agent:main:main", status: "final" },
        { id: "a1", role: "assistant", text: "Ready", status: "final" },
        { id: "u2", role: "user", text: "Summarize active OpenClaw logs", status: "final" }
      ])
    ).toBe("Summarize active OpenClaw logs");
  });
});
