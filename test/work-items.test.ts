import { describe, expect, it } from "vitest";
import { UNTITLED_SESSION } from "../src/shared/normalizers";
import type { SessionSummary, WorkIndex } from "../src/shared/types";
import {
  applyWorkTitleFromHistory,
  createWorkIndexEntry,
  markWorkItemOpened,
  normalizeWorkIndex,
  projectWorkItems,
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
