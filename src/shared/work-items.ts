import { titleFromHistory, UNTITLED_SESSION } from "./normalizers";
import type { SessionSummary, TranscriptMessage, WorkIndex, WorkIndexEntry, WorkItem, WorkItemKind, WorkItemSource, WorkItemTitleSource } from "./types";

export const WORK_INDEX_VERSION = 1;
export const UNTITLED_WORK = "未命名工作";
const DEFAULT_WORK_SUBTITLE = "OpenClaw · local workspace";

export interface ProjectWorkItemsParams {
  workIndex: WorkIndex;
  sessions: SessionSummary[];
  activeSessionKey?: string;
  now?: number;
}

export interface CreateWorkIndexEntryParams {
  targetSessionKey: string;
  targetSessionId?: string;
  title?: string;
  titleSource?: WorkItemTitleSource;
  source?: WorkItemSource;
  kind?: WorkItemKind;
  now?: number;
  id?: string;
}

export function normalizeWorkIndex(value: unknown, now = Date.now()): WorkIndex {
  const record = asRecord(value);
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const seenKeys = new Set<string>();
  const items: WorkIndexEntry[] = [];

  for (const rawItem of rawItems) {
    const item = normalizeWorkIndexEntry(rawItem, now);
    if (!item || seenKeys.has(item.targetSessionKey)) continue;
    seenKeys.add(item.targetSessionKey);
    items.push(item);
  }

  return { version: WORK_INDEX_VERSION, items };
}

export function createWorkIndexEntry(params: CreateWorkIndexEntryParams): WorkIndexEntry {
  const now = params.now ?? Date.now();
  const targetSessionKey = params.targetSessionKey.trim();
  return {
    id: params.id ?? `work:${randomId()}`,
    targetSessionKey,
    targetSessionId: normalizeOptionalText(params.targetSessionId),
    title: normalizeOptionalText(params.title),
    titleSource: params.titleSource ?? (params.title ? "first-message" : "fallback"),
    source: params.source ?? "we-claw",
    kind: params.kind ?? "task",
    createdAt: now,
    lastOpenedAt: now,
    pinned: false,
    hidden: false
  };
}

export function migrateWorkSessionKey(
  workIndex: WorkIndex,
  fromSessionKey: string,
  toSessionKey: string,
  targetSessionId?: string
): WorkIndex {
  const fromKey = normalizeOptionalText(fromSessionKey);
  const toKey = normalizeOptionalText(toSessionKey);
  if (!fromKey || !toKey || fromKey === toKey) return workIndex;

  const fromEntry = workIndex.items.find((item) => item.targetSessionKey === fromKey);
  if (!fromEntry) return workIndex;
  const existingEntry = workIndex.items.find((item) => item.targetSessionKey === toKey);
  const mergedEntry = mergeMigratedWorkEntry(fromEntry, existingEntry, toKey, targetSessionId);
  let inserted = false;
  const items: WorkIndexEntry[] = [];

  for (const item of workIndex.items) {
    if (item.targetSessionKey !== fromKey && item.targetSessionKey !== toKey) {
      items.push(item);
      continue;
    }
    if (inserted) continue;
    items.push(mergedEntry);
    inserted = true;
  }

  return { version: WORK_INDEX_VERSION, items };
}

export function reconcileClaudePendingWorkIndex(workIndex: WorkIndex, sessions: SessionSummary[]): WorkIndex {
  let next = workIndex;
  for (const entry of workIndex.items) {
    if (!entry.targetSessionKey.startsWith("claude:pending:")) continue;
    const session = findClaudePendingMatch(entry, sessions);
    if (!session) continue;
    next = migrateWorkSessionKey(next, entry.targetSessionKey, session.sessionKey, session.sessionId);
  }
  return next;
}

export function projectWorkItems(params: ProjectWorkItemsParams): WorkItem[] {
  const now = params.now ?? Date.now();
  const sessionByKey = new Map(params.sessions.map((session) => [session.sessionKey, session]));
  const itemBySessionKey = new Map<string, WorkItem>();

  for (const entry of params.workIndex.items) {
    if (entry.hidden) continue;
    const session = sessionByKey.get(entry.targetSessionKey);
    itemBySessionKey.set(entry.targetSessionKey, workItemFromEntry(entry, session, now));
  }

  for (const session of params.sessions) {
    if (itemBySessionKey.has(session.sessionKey)) continue;
    if (!shouldExposeGatewaySession(session, params.activeSessionKey)) continue;
    const entry = createWorkIndexEntry({
      id: workIdForSessionKey(session.sessionKey),
      targetSessionKey: session.sessionKey,
      targetSessionId: session.sessionId,
      title: session.title === UNTITLED_SESSION ? undefined : session.title,
      titleSource: session.title === UNTITLED_SESSION ? "fallback" : "gateway",
      source: "runtime",
      kind: "run",
      now
    });
    itemBySessionKey.set(session.sessionKey, workItemFromEntry(entry, session, now));
  }

  return [...itemBySessionKey.values()].sort(compareWorkItems);
}

export function promoteSessionToWorkItem(workIndex: WorkIndex, session: SessionSummary, now = Date.now()): WorkIndex {
  const existing = workIndex.items.find((item) => item.targetSessionKey === session.sessionKey);
  const title = session.title === UNTITLED_SESSION ? undefined : session.title;
  if (existing) {
    return {
      version: WORK_INDEX_VERSION,
      items: workIndex.items.map((item) =>
        item.targetSessionKey === session.sessionKey
          ? {
              ...item,
              title: item.title ?? title,
              titleSource: item.titleSource ?? (title ? "gateway" : "fallback"),
              lastOpenedAt: now,
              hidden: false
            }
          : item
      )
    };
  }

  return {
    version: WORK_INDEX_VERSION,
    items: [
      createWorkIndexEntry({
        id: workIdForSessionKey(session.sessionKey),
        targetSessionKey: session.sessionKey,
        targetSessionId: session.sessionId,
        title,
        titleSource: title ? "gateway" : "fallback",
        source: "gateway",
        kind: "conversation",
        now
      }),
      ...workIndex.items
    ]
  };
}

export function markWorkItemOpened(workIndex: WorkIndex, workId: string, now = Date.now()): WorkIndex {
  return {
    version: WORK_INDEX_VERSION,
    items: workIndex.items.map((item) => (item.id === workId ? { ...item, lastOpenedAt: now, hidden: false } : item))
  };
}

export function applyWorkTitleFromHistory(workIndex: WorkIndex, sessionKey: string, messages: TranscriptMessage[]): WorkIndex {
  const title = titleFromHistory(messages);
  if (!title) return workIndex;
  let changed = false;
  const items = workIndex.items.map((item) => {
    if (item.targetSessionKey !== sessionKey || titleIsUserControlled(item.titleSource)) return item;
    if (item.title === title && item.titleSource === "first-message") return item;
    changed = true;
    return { ...item, title, titleSource: "first-message" as const };
  });
  return changed ? { version: WORK_INDEX_VERSION, items } : workIndex;
}

export function workIdForSessionKey(sessionKey: string): string {
  return `session:${stableHash(sessionKey)}`;
}

function workItemFromEntry(entry: WorkIndexEntry, session: SessionSummary | undefined, now: number): WorkItem {
  const sessionTitle = session?.title && session.title !== UNTITLED_SESSION ? session.title : undefined;
  const title = normalizeOptionalText(entry.title) ?? sessionTitle ?? UNTITLED_WORK;
  const updatedAt = timestampFromSession(session) ?? entry.lastOpenedAt ?? entry.createdAt ?? now;
  return {
    id: entry.id,
    title,
    titleSource: entry.title ? (entry.titleSource ?? "user") : sessionTitle ? "gateway" : "fallback",
    subtitle: session?.subtitle ?? DEFAULT_WORK_SUBTITLE,
    targetSessionKey: entry.targetSessionKey,
    targetSessionId: session?.sessionId ?? entry.targetSessionId,
    source: entry.source,
    kind: entry.kind,
    createdAt: entry.createdAt,
    updatedAt,
    lastOpenedAt: entry.lastOpenedAt,
    pinned: entry.pinned,
    hidden: entry.hidden,
    running: session?.status === "running",
    status: session?.status ?? "unknown"
  };
}

function mergeMigratedWorkEntry(fromEntry: WorkIndexEntry, existingEntry: WorkIndexEntry | undefined, toSessionKey: string, targetSessionId: string | undefined): WorkIndexEntry {
  const titleEntry = preferredTitleEntry(fromEntry, existingEntry);
  return {
    ...fromEntry,
    id: fromEntry.id,
    targetSessionKey: toSessionKey,
    targetSessionId: normalizeOptionalText(targetSessionId) ?? existingEntry?.targetSessionId ?? fromEntry.targetSessionId,
    title: titleEntry?.title,
    titleSource: titleEntry?.titleSource,
    source: fromEntry.source,
    kind: fromEntry.kind,
    createdAt: Math.min(fromEntry.createdAt, existingEntry?.createdAt ?? fromEntry.createdAt),
    lastOpenedAt: Math.max(fromEntry.lastOpenedAt ?? 0, existingEntry?.lastOpenedAt ?? 0) || undefined,
    pinned: Boolean(fromEntry.pinned || existingEntry?.pinned),
    hidden: fromEntry.hidden === true && existingEntry?.hidden === true
  };
}

function preferredTitleEntry(fromEntry: WorkIndexEntry, existingEntry: WorkIndexEntry | undefined): WorkIndexEntry | undefined {
  if (existingEntry?.title && titleIsUserControlled(existingEntry.titleSource)) return existingEntry;
  if (fromEntry.title) return fromEntry;
  if (existingEntry?.title) return existingEntry;
  return fromEntry;
}

function findClaudePendingMatch(entry: WorkIndexEntry, sessions: SessionSummary[]): SessionSummary | undefined {
  const entryTitle = normalizeOptionalText(entry.title);
  if (!entryTitle) return undefined;
  const candidates = sessions
    .filter((session) => session.sessionKey.startsWith("claude:") && !session.sessionKey.startsWith("claude:pending:"))
    .filter((session) => normalizeOptionalText(session.title) === entryTitle);
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => pendingMatchScore(b, entry) - pendingMatchScore(a, entry))[0];
}

function pendingMatchScore(session: SessionSummary, entry: WorkIndexEntry): number {
  const updatedAt = timestampFromSession(session) ?? 0;
  const createdAt = entry.createdAt || 0;
  const distancePenalty = updatedAt && createdAt ? Math.min(Math.abs(updatedAt - createdAt), 86_400_000) : 86_400_000;
  return updatedAt - distancePenalty;
}

function shouldExposeGatewaySession(session: SessionSummary, activeSessionKey: string | undefined): boolean {
  if (isInternalGatewaySession(session.sessionKey)) return false;
  if (session.sessionKey === activeSessionKey) return true;
  if (session.sessionKey.startsWith("hermes:")) return true;
  return session.status === "running" && session.title !== UNTITLED_SESSION;
}

function isInternalGatewaySession(sessionKey: string): boolean {
  const key = sessionKey.trim().toLowerCase();
  if (!key || key === "global" || key === "unknown") return true;
  return key.includes(":subagent:") || key.includes(":cron:") || key.startsWith("cron:") || key.includes(":plugin:") || key.includes(":checkpoint:");
}

function compareWorkItems(a: WorkItem, b: WorkItem): number {
  return numberFlag(b.pinned) - numberFlag(a.pinned) || numberFlag(b.running) - numberFlag(a.running) || recentTime(b) - recentTime(a);
}

function recentTime(item: WorkItem): number {
  return item.lastOpenedAt ?? item.updatedAt ?? item.createdAt;
}

function numberFlag(value: unknown): number {
  return value ? 1 : 0;
}

function normalizeWorkIndexEntry(value: unknown, now: number): WorkIndexEntry | undefined {
  const record = asRecord(value);
  const targetSessionKey = asString(record.targetSessionKey);
  if (!targetSessionKey) return undefined;
  const source = normalizeSource(record.source);
  const kind = normalizeKind(record.kind);
  return {
    id: asString(record.id) ?? workIdForSessionKey(targetSessionKey),
    targetSessionKey,
    targetSessionId: asString(record.targetSessionId),
    title: normalizeOptionalText(record.title),
    titleSource: normalizeTitleSource(record.titleSource),
    source,
    kind,
    createdAt: asNumber(record.createdAt) ?? now,
    lastOpenedAt: asNumber(record.lastOpenedAt),
    pinned: record.pinned === true,
    hidden: record.hidden === true
  };
}

function titleIsUserControlled(titleSource: WorkItemTitleSource | undefined): boolean {
  return titleSource === "user" || titleSource === "manual";
}

function timestampFromSession(session: SessionSummary | undefined): number | undefined {
  if (!session?.updatedAt) return undefined;
  const timestamp = Date.parse(session.updatedAt);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function normalizeSource(value: unknown): WorkItemSource {
  if (value === "we-claw" || value === "gateway" || value === "channel" || value === "runtime") return value;
  return "we-claw";
}

function normalizeKind(value: unknown): WorkItemKind {
  if (value === "task" || value === "conversation" || value === "run") return value;
  return "task";
}

function normalizeTitleSource(value: unknown): WorkItemTitleSource | undefined {
  if (value === "user" || value === "first-message" || value === "gateway" || value === "manual" || value === "fallback") return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return asString(value)?.replace(/\s+/g, " ");
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
