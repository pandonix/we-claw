import type { ChatState, SessionStatus, SessionSummary, TranscriptMessage } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

export function normalizeSession(value: unknown): SessionSummary {
  const record = asRecord(value);
  const id = asString(record.id) ?? asString(record.sessionId) ?? "unknown";
  const title = asString(record.title) ?? asString(record.name) ?? `Session ${id.slice(0, 8)}`;
  const status = normalizeStatus(record.status, record.running);

  return {
    id,
    title,
    subtitle: asString(record.subtitle) ?? asString(record.workspace) ?? asString(record.agent) ?? "OpenClaw Gateway",
    updatedAt: asString(record.updatedAt) ?? asString(record.updated_at) ?? asString(record.lastMessageAt),
    status
  };
}

export function normalizeSessions(value: unknown): SessionSummary[] {
  const record = asRecord(value);
  const sessions = Array.isArray(value) ? value : Array.isArray(record.sessions) ? record.sessions : [];
  return sessions.map(normalizeSession).filter((session) => session.id !== "unknown");
}

export function normalizeMessage(value: unknown, fallbackId: string): TranscriptMessage {
  const record = asRecord(value);
  const role = record.role === "user" || record.role === "assistant" || record.role === "system" ? record.role : "assistant";
  const text = textFromContent(record.text ?? record.message ?? record.content ?? record.delta);

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
  return messages.map((message, index) => normalizeMessage(message, `history-${index}`));
}

export function reduceChatEvent(state: ChatState, event: unknown): ChatState {
  const record = asRecord(event);
  const kind = asString(record.kind) ?? asString(record.status) ?? asString(record.type);
  const message = normalizeMessage(record.message ?? record, `event-${state.messages.length}`);

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

  return { ...state, running: kind === "running", messages: [...state.messages, message] };
}

function normalizeStatus(status: unknown, running: unknown): SessionStatus {
  if (running === true) return "running";
  if (status === "running" || status === "idle" || status === "error") return status;
  return "unknown";
}
