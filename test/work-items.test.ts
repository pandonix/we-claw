import { describe, expect, it } from "vitest";
import { UNTITLED_SESSION } from "../src/shared/normalizers";
import type { SessionSummary, WorkIndex } from "../src/shared/types";
import {
  applyWorkTitleFromHistory,
  createWorkIndexEntry,
  markWorkItemOpened,
  migrateWorkSessionKey,
  normalizeWorkIndex,
  projectWorkItems,
  reconcileClaudePendingWorkIndex,
  promoteSessionToWorkItem,
  UNTITLED_WORK
} from "../src/shared/work-items";

const now = Date.parse("2026-04-30T10:00:00.000Z");

function session(overrides: Partial<SessionSummary> & { sessionKey: string }): SessionSummary {
  const { sessionKey, ...rest } = overrides;
  return {
    id: sessionKey,
    title: "Readable work",
    subtitle: "OpenClaw Gateway",
    status: "idle",
    sessionKey,
    ...rest
  };
}

describe("work item projection", () => {
  it("normalizes stored work index entries and drops malformed rows", () => {
    expect(
      normalizeWorkIndex(
        {
          version: 1,
          items: [
            { id: "work:1", targetSessionKey: " agent:main:dashboard:1 ", source: "gateway", kind: "conversation", createdAt: 1 },
            { id: "bad" },
            { id: "dupe", targetSessionKey: "agent:main:dashboard:1", createdAt: 2 }
          ]
        },
        now
      )
    ).toEqual({
      version: 1,
      items: [
        {
          id: "work:1",
          targetSessionKey: "agent:main:dashboard:1",
          targetSessionId: undefined,
          title: undefined,
          titleSource: undefined,
          source: "gateway",
          kind: "conversation",
          createdAt: 1,
          lastOpenedAt: undefined,
          pinned: false,
          hidden: false
        }
      ]
    });
  });

  it("migrates pending Claude work to the real session key", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [
        {
          ...createWorkIndexEntry({
            id: "work:pending",
            targetSessionKey: "claude:pending:123",
            title: "Investigate history restore",
            titleSource: "first-message",
            now
          }),
          pinned: true
        }
      ]
    };

    const migrated = migrateWorkSessionKey(workIndex, "claude:pending:123", "claude:real-session", "real-session");

    expect(migrated.items).toHaveLength(1);
    expect(migrated.items[0]).toMatchObject({
      id: "work:pending",
      targetSessionKey: "claude:real-session",
      targetSessionId: "real-session",
      title: "Investigate history restore",
      titleSource: "first-message",
      pinned: true
    });
  });

  it("merges duplicate pending and real Claude work entries during migration", () => {
    const pending = createWorkIndexEntry({
      id: "work:pending",
      targetSessionKey: "claude:pending:123",
      title: "Prompt title",
      titleSource: "first-message",
      now
    });
    const existing = {
      ...createWorkIndexEntry({
        id: "work:real",
        targetSessionKey: "claude:real-session",
        title: "Manual title",
        titleSource: "manual",
        now: now - 1000
      }),
      lastOpenedAt: now + 1000,
      pinned: true
    };

    const migrated = migrateWorkSessionKey({ version: 1, items: [pending, existing] }, "claude:pending:123", "claude:real-session", "real-session");

    expect(migrated.items).toHaveLength(1);
    expect(migrated.items[0]).toMatchObject({
      id: "work:pending",
      targetSessionKey: "claude:real-session",
      targetSessionId: "real-session",
      title: "Manual title",
      titleSource: "manual",
      createdAt: now - 1000,
      lastOpenedAt: now + 1000,
      pinned: true
    });
  });

  it("reconciles orphaned Claude pending work to the closest matching persisted session", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [
        createWorkIndexEntry({
          id: "work:pending",
          targetSessionKey: "claude:pending:123",
          title: "hello",
          titleSource: "first-message",
          now
        })
      ]
    };

    const reconciled = reconcileClaudePendingWorkIndex(workIndex, [
      session({
        sessionKey: "claude:older",
        sessionId: "older",
        title: "hello",
        subtitle: "Claude Agent SDK",
        updatedAt: new Date(now - 60_000).toISOString()
      }),
      session({
        sessionKey: "claude:closest",
        sessionId: "closest",
        title: "hello",
        subtitle: "Claude Agent SDK",
        updatedAt: new Date(now + 3_000).toISOString()
      })
    ]);

    expect(reconciled.items[0]).toMatchObject({
      id: "work:pending",
      targetSessionKey: "claude:closest",
      targetSessionId: "closest",
      title: "hello"
    });
  });

  it("leaves Claude pending work unchanged when no title match is available", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [createWorkIndexEntry({ id: "work:pending", targetSessionKey: "claude:pending:123", title: "hello", now })]
    };

    expect(
      reconcileClaudePendingWorkIndex(workIndex, [
        session({
          sessionKey: "claude:other",
          sessionId: "other",
          title: "different",
          subtitle: "Claude Agent SDK",
          updatedAt: new Date(now).toISOString()
        })
      ])
    ).toBe(workIndex);
  });

  it("projects only stored work items from gateway session rows by default", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [createWorkIndexEntry({ id: "work:known", targetSessionKey: "agent:main:dashboard:known", title: "Known work", now })]
    };

    const workItems = projectWorkItems({
      workIndex,
      sessions: [
        session({ sessionKey: "agent:main:dashboard:known", updatedAt: "2026-04-30T10:10:00.000Z" }),
        session({ sessionKey: "agent:main:dashboard:other", title: "Other gateway session" })
      ],
      now
    });

    expect(workItems.map((item) => item.targetSessionKey)).toEqual(["agent:main:dashboard:known"]);
    expect(workItems[0]).toMatchObject({
      id: "work:known",
      title: "Known work",
      targetSessionKey: "agent:main:dashboard:known",
      status: "idle"
    });
  });

  it("does not expose global, unknown, cron, or subagent sessions as active or running work", () => {
    const workItems = projectWorkItems({
      workIndex: { version: 1, items: [] },
      activeSessionKey: "agent:main:subagent:leaf",
      sessions: [
        session({ sessionKey: "global", status: "running" }),
        session({ sessionKey: "unknown", status: "running" }),
        session({ sessionKey: "agent:main:cron:daily", status: "running" }),
        session({ sessionKey: "agent:main:subagent:leaf", status: "running" })
      ],
      now
    });

    expect(workItems).toEqual([]);
  });

  it("adds running top-level sessions as temporary runtime work", () => {
    const workItems = projectWorkItems({
      workIndex: { version: 1, items: [] },
      sessions: [session({ sessionKey: "agent:main:dashboard:running", status: "running", title: "Build the app" })],
      now
    });

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      title: "Build the app",
      source: "runtime",
      kind: "run",
      running: true
    });
  });

  it("projects Hermes persisted sessions even when the local work index is missing", () => {
    const workItems = projectWorkItems({
      workIndex: { version: 1, items: [] },
      sessions: [
        session({
          sessionKey: "hermes:20260501_101706_bda5b7",
          sessionId: "20260501_101706_bda5b7",
          title: "Hermes conversation",
          subtitle: "Hermes · tui",
          updatedAt: new Date(now).toISOString()
        })
      ],
      now
    });

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      title: "Hermes conversation",
      targetSessionKey: "hermes:20260501_101706_bda5b7",
      source: "runtime",
      kind: "run"
    });
  });

  it("promotes an explicit gateway session into stored work", () => {
    const promoted = promoteSessionToWorkItem(
      { version: 1, items: [] },
      session({ sessionKey: "agent:main:dashboard:open", title: "Opened from debug" }),
      now
    );

    expect(promoted.items[0]).toMatchObject({
      targetSessionKey: "agent:main:dashboard:open",
      title: "Opened from debug",
      titleSource: "gateway",
      source: "gateway",
      kind: "conversation",
      lastOpenedAt: now
    });
  });

  it("uses the first user message as the work title without replacing manual titles", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [
        createWorkIndexEntry({ id: "work:auto", targetSessionKey: "agent:main:dashboard:auto", now }),
        createWorkIndexEntry({
          id: "work:manual",
          targetSessionKey: "agent:main:dashboard:manual",
          title: "Manual name",
          titleSource: "manual",
          now
        })
      ]
    };

    const autoTitled = applyWorkTitleFromHistory(workIndex, "agent:main:dashboard:auto", [
      { id: "u1", role: "user", text: "  Implement curated work rail  ", status: "final" }
    ]);
    const manualTitled = applyWorkTitleFromHistory(autoTitled, "agent:main:dashboard:manual", [
      { id: "u2", role: "user", text: "Replacement", status: "final" }
    ]);

    expect(manualTitled.items.map((item) => [item.id, item.title, item.titleSource])).toEqual([
      ["work:auto", "Implement curated work rail", "first-message"],
      ["work:manual", "Manual name", "manual"]
    ]);
  });

  it("keeps indexed untitled work visible even when gateway title is not readable", () => {
    const workIndex: WorkIndex = {
      version: 1,
      items: [createWorkIndexEntry({ id: "work:untitled", targetSessionKey: "agent:main:dashboard:empty", now })]
    };

    const workItems = projectWorkItems({
      workIndex,
      sessions: [session({ sessionKey: "agent:main:dashboard:empty", title: UNTITLED_SESSION })],
      now
    });

    expect(workItems[0]?.title).toBe(UNTITLED_WORK);
  });

  it("moves opened work ahead of older unpinned work while pinned work stays first", () => {
    const base: WorkIndex = {
      version: 1,
      items: [
        { ...createWorkIndexEntry({ id: "work:pinned", targetSessionKey: "agent:main:dashboard:pinned", now: now - 1000 }), pinned: true },
        createWorkIndexEntry({ id: "work:old", targetSessionKey: "agent:main:dashboard:old", now: now - 1000 }),
        createWorkIndexEntry({ id: "work:new", targetSessionKey: "agent:main:dashboard:new", now: now - 500 })
      ]
    };

    const opened = markWorkItemOpened(base, "work:old", now + 1000);
    const workItems = projectWorkItems({ workIndex: opened, sessions: [], now });

    expect(workItems.map((item) => item.id)).toEqual(["work:pinned", "work:old", "work:new"]);
  });
});
