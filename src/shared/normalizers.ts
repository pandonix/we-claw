import type { ChatState, SessionStatus, SessionSummary, TranscriptMessage } from "./types";

export const UNTITLED_SESSION = "未命名会话";
const SUMMARY_TITLE_LENGTH = 64;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        return asString(record.text) ?? asString(record.content) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  return asString(record.text) ?? asString(record.content) ?? "";
}

function visibleTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return textFromContent(value);
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      const type = asString(record.type);
      if (type && type !== "text") return "";
      return asString(record.text) ?? asString(record.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizeSession(value: unknown): SessionSummary {
  const directKey = asString(value);
  const record = asRecord(value);
  const sessionKey = asString(record.key) ?? asString(record.sessionKey) ?? directKey ?? asString(record.id) ?? asString(record.sessionId) ?? "unknown";
  const sessionId = asString(record.sessionId) ?? asString(record.id);
  const title =
    readableSessionTitle([record.displayName, record.derivedTitle, record.label], sessionKey, sessionId) ??
    readableSessionTitle([truncateTitleCandidate(record.lastMessagePreview)], sessionKey, sessionId) ??
    UNTITLED_SESSION;
  const status = normalizeStatus(record.status, record.running);

  return {
    id: sessionKey,
    sessionKey,
    sessionId,
    title,
    subtitle: asString(record.subtitle) ?? asString(record.workspace) ?? asString(record.agent) ?? "OpenClaw Gateway",
    updatedAt: asString(record.updatedAt) ?? asString(record.updated_at) ?? asString(record.lastMessageAt),
    status
  };
}

export function titleFromHistory(messages: TranscriptMessage[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const recentUserMessage = findRecentUserMessage(messages);
  return readableSessionTitle([truncateTitleCandidate(firstUserMessage?.text), truncateTitleCandidate(recentUserMessage?.text)]);
}

export function normalizeSessions(value: unknown): SessionSummary[] {
  const record = asRecord(value);
  const sessions = Array.isArray(value) ? value : Array.isArray(record.sessions) ? record.sessions : [];
  return sessions.map(normalizeSession).filter((session) => session.id !== "unknown");
}

export function normalizeMessage(value: unknown, fallbackId: string): TranscriptMessage {
  const record = asRecord(value);
  const role = record.role === "user" || record.role === "assistant" || record.role === "system" || record.role === "error" ? record.role : "assistant";
  const text = textFromContent(record.text ?? record.message ?? record.content ?? record.delta ?? record.errorMessage ?? record.summary);

  return {
    id: asString(record.id) ?? asString(record.messageId) ?? fallbackId,
    role,
    text: text || "[unsupported content]",
    status: record.status === "running" || record.status === "error" || record.status === "aborted" ? record.status : "final",
    timestamp: asString(record.timestamp) ?? asString(record.createdAt)
  };
}

export function normalizeHistory(value: unknown): TranscriptMessage[] {
  const record = asRecord(value);
  const messages = Array.isArray(value) ? value : Array.isArray(record.messages) ? record.messages : Array.isArray(record.history) ? record.history : [];
  return messages.flatMap((message, index) => normalizeHistoryMessage(message, `history-${index}`));
}

export function reduceChatEvent(state: ChatState, event: unknown): ChatState {
  const record = asRecord(event);
  const kind = asString(record.kind) ?? asString(record.state) ?? asString(record.status) ?? asString(record.type);
  const message = normalizeMessage(record.message ?? record, `event-${state.messages.length}`);

  if (kind === "started" || kind === "accepted" || kind === "in_flight") {
    return { ...state, running: true, error: undefined };
  }

  if (kind === "error") {
    return { ...state, running: false, error: message.text, messages: [...state.messages, { ...message, role: "error", status: "error" }] };
  }

  if (kind === "aborted") {
    return { ...state, running: false, messages: [...state.messages, { ...message, status: "aborted" }] };
  }

  if (kind === "delta" || record.delta) {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.status === "running") {
      messages[messages.length - 1] = { ...last, text: `${last.text}${message.text}`, status: "running" };
    } else {
      messages.push({ ...message, role: "assistant", status: "running" });
    }
    return { ...state, running: true, messages };
  }

  if (kind === "final") {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    const finalMessage: TranscriptMessage = { ...message, role: "assistant", status: "final" };
    if (last?.role === "assistant" && last.status === "running") {
      messages[messages.length - 1] = { ...finalMessage, id: message.id || last.id, text: message.text || last.text };
      return { ...state, running: false, error: undefined, messages };
    }
    return { ...state, running: false, error: undefined, messages: [...messages, finalMessage] };
  }

  return { ...state, running: kind === "running", messages: [...state.messages, message] };
}

function normalizeStatus(status: unknown, running: unknown): SessionStatus {
  if (running === true) return "running";
  if (status === "running" || status === "idle" || status === "error") return status;
  return "unknown";
}

function normalizeHistoryMessage(value: unknown, fallbackId: string): TranscriptMessage[] {
  const record = asRecord(value);
  if (record.role !== "user" && record.role !== "assistant" && record.role !== "system" && record.role !== "error") return [];
  const text = visibleTextFromContent(record.text ?? record.message ?? record.content ?? record.delta ?? record.errorMessage ?? record.summary);
  if (!text.trim()) return [];
  return [
    {
      id: asString(record.id) ?? asString(record.messageId) ?? fallbackId,
      role: record.role,
      text,
      status: record.status === "running" || record.status === "error" || record.status === "aborted" ? record.status : "final",
      timestamp: asString(record.timestamp) ?? asString(record.createdAt)
    }
  ];
}

function findRecentUserMessage(messages: TranscriptMessage[]): TranscriptMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index];
  }
  return undefined;
}

function readableSessionTitle(candidates: unknown[], sessionKey?: string, sessionId?: string): string | undefined {
  for (const candidate of candidates) {
    const text = normalizeTitleCandidate(candidate);
    if (!text || isTechnicalSessionTitle(text, sessionKey, sessionId)) continue;
    return text;
  }
  return undefined;
}

function normalizeTitleCandidate(value: unknown): string | undefined {
  const text = asString(value);
  return text?.replace(/\s+/g, " ");
}

function truncateTitleCandidate(value: unknown): string | undefined {
  const text = normalizeTitleCandidate(value);
  if (!text) return undefined;
  return text.length > SUMMARY_TITLE_LENGTH ? `${text.slice(0, SUMMARY_TITLE_LENGTH - 1)}…` : text;
}

function isTechnicalSessionTitle(text: string, sessionKey?: string, sessionId?: string): boolean {
  const identifiers = [sessionKey, sessionId].filter((value): value is string => Boolean(value));
  if (identifiers.includes(text)) return true;
  if (/^session\s+[0-9a-f-]{6,}$/i.test(text)) return true;
  if (/^[0-9a-f]{8}\s+\(\d{4}-\d{2}-\d{2}\)$/i.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) return true;
  if (/^[a-z0-9]+:[a-z0-9_.:-]+$/i.test(text)) return true;
  if (/^[0-9a-f]{16,}$/i.test(text)) return true;
  return false;
}
