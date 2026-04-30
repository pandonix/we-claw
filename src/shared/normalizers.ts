import type { ChatState, ConversationNotice, SessionStatus, SessionSummary, ToolBlock, ToolBlockStatus, TranscriptMessage } from "./types";

export const UNTITLED_SESSION = "未命名会话";
const SUMMARY_TITLE_LENGTH = 64;
const TOOL_BLOCK_LIMIT = 50;
const NOTICE_LIMIT = 20;
const TOOL_OUTPUT_LIMIT = 120_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function asTimestamp(value: unknown): string | undefined {
  const text = asString(value);
  if (text) return text;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
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
    updatedAt: asTimestamp(record.updatedAt) ?? asTimestamp(record.updated_at) ?? asTimestamp(record.lastMessageAt),
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
    if (!hasVisibleEventMessage(record)) return { ...state, running: false };
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
    if (!hasVisibleEventMessage(record)) {
      if (last?.role === "assistant" && last.status === "running") {
        messages[messages.length - 1] = { ...last, status: "final" };
      }
      return { ...state, running: false, error: undefined, messages };
    }
    const finalMessage: TranscriptMessage = { ...message, role: "assistant", status: "final" };
    if (last?.role === "assistant" && last.status === "running") {
      messages[messages.length - 1] = { ...finalMessage, id: message.id || last.id, text: message.text || last.text };
      return { ...state, running: false, error: undefined, messages };
    }
    return { ...state, running: false, error: undefined, messages: [...messages, finalMessage] };
  }

  return { ...state, running: kind === "running", messages: [...state.messages, message] };
}

export function reduceAgentEvent(state: ChatState, event: unknown): ChatState {
  const record = asRecord(event);
  const stream = asString(record.stream);
  if (stream === "tool" || looksLikeToolEvent(record)) {
    return reduceToolEvent(state, record);
  }
  if (stream === "lifecycle") {
    return reduceLifecycleEvent(state, record);
  }
  if (stream === "compaction") {
    return addNotice(state, noticeFromCompaction(record));
  }
  if (stream === "fallback") {
    return addNotice(state, noticeFromFallback(record));
  }
  return state;
}

export function reduceToolEvent(state: ChatState, event: unknown): ChatState {
  const nextTool = normalizeToolEvent(event);
  if (!nextTool) return state;

  const current = state.toolBlocks ?? [];
  const existingIndex = current.findIndex((tool) => tool.toolCallId === nextTool.toolCallId);
  const nextTools =
    existingIndex === -1
      ? [...current, nextTool]
      : current.map((tool, index) => (index === existingIndex ? mergeToolBlock(tool, nextTool) : tool));
  return { ...state, toolBlocks: nextTools.slice(-TOOL_BLOCK_LIMIT) };
}

export function normalizeToolEvent(event: unknown): ToolBlock | undefined {
  const record = asRecord(event);
  const data = asRecord(record.data);
  const source = Object.keys(data).length ? data : record;
  const toolCallId = asString(source.toolCallId) ?? asString(source.tool_call_id) ?? asString(source.callId) ?? asString(source.id);
  if (!toolCallId) return undefined;

  const phase = asString(source.phase) ?? "update";
  const status = statusFromToolPhase(phase);
  const name = asString(source.name) ?? asString(source.toolName) ?? asString(source.tool_name) ?? "tool";
  const timestamp = typeof record.ts === "number" ? record.ts : Date.now();
  const input = source.args !== undefined || source.arguments !== undefined || source.input !== undefined ? formatPayload(source.args ?? source.arguments ?? source.input) : undefined;
  const outputValue =
    phase === "update"
      ? source.partialResult
      : phase === "result" || phase === "end" || phase === "error"
        ? (source.result ?? source.error)
        : undefined;
  const output = outputValue === undefined ? undefined : formatPayload(outputValue, TOOL_OUTPUT_LIMIT);
  const explicitSummary = asString(source.summary) ?? asString(source.message);

  return {
    id: `tool:${toolCallId}`,
    toolCallId,
    runId: asString(record.runId),
    sessionKey: asString(record.sessionKey),
    name,
    status,
    summary: explicitSummary ?? summaryForTool({ name, status, output }),
    input,
    output,
    startedAt: phase === "start" ? timestamp : undefined,
    updatedAt: timestamp
  };
}

function normalizeStatus(status: unknown, running: unknown): SessionStatus {
  if (running === true) return "running";
  if (status === "running" || status === "idle" || status === "error") return status;
  return "unknown";
}

function hasVisibleEventMessage(record: Record<string, unknown>): boolean {
  return record.message !== undefined || record.text !== undefined || record.content !== undefined || record.delta !== undefined || record.errorMessage !== undefined || record.summary !== undefined;
}

function reduceLifecycleEvent(state: ChatState, event: Record<string, unknown>): ChatState {
  const data = asRecord(event.data);
  const phase = asString(data.phase);
  if (phase === "start") {
    return addNotice({ ...state, running: true }, noticeFromText(event, "runtime", "Run started"));
  }
  if (phase === "end") {
    return addNotice({ ...state, running: false, error: undefined }, noticeFromText(event, "runtime", "Run completed"));
  }
  if (phase === "error") {
    const text = asString(data.error) ?? asString(data.errorMessage) ?? "Run failed";
    return addNotice({ ...state, running: false, error: text }, noticeFromText(event, "error", text));
  }
  if (phase === "fallback" || phase === "fallback_cleared") {
    return addNotice(state, noticeFromFallback(event));
  }
  return state;
}

function noticeFromCompaction(event: Record<string, unknown>): ConversationNotice | undefined {
  const data = asRecord(event.data);
  const phase = asString(data.phase);
  if (phase === "start") return noticeFromText(event, "compaction", "Compaction started");
  if (phase === "end" && data.completed === true) return noticeFromText(event, "compaction", "Compaction completed");
  if (phase === "end" && data.willRetry === true) return noticeFromText(event, "compaction", "Compaction retrying");
  return undefined;
}

function noticeFromFallback(event: Record<string, unknown>): ConversationNotice | undefined {
  const data = asRecord(event.data);
  const selected = modelLabel(data.selectedProvider, data.selectedModel) ?? modelLabel(data.fromProvider, data.fromModel);
  const active = modelLabel(data.activeProvider, data.activeModel) ?? modelLabel(data.toProvider, data.toModel);
  if (!selected && !active) return undefined;
  const reason = asString(data.reasonSummary) ?? asString(data.reason);
  const text = selected && active && selected !== active ? `Model fallback: ${selected} -> ${active}` : `Model active: ${active ?? selected}`;
  return noticeFromText(event, "fallback", reason ? `${text} (${reason})` : text);
}

function noticeFromText(event: Record<string, unknown>, kind: ConversationNotice["kind"], text: string): ConversationNotice {
  const runId = asString(event.runId);
  const timestamp = typeof event.ts === "number" ? event.ts : Date.now();
  return {
    id: `notice:${kind}:${runId ?? "session"}:${timestamp}:${text}`,
    kind,
    text,
    timestamp,
    runId
  };
}

function addNotice(state: ChatState, notice: ConversationNotice | undefined): ChatState {
  if (!notice) return state;
  const notices = [...(state.notices ?? []), notice].slice(-NOTICE_LIMIT);
  return { ...state, notices };
}

function looksLikeToolEvent(record: Record<string, unknown>): boolean {
  const data = asRecord(record.data);
  return Boolean(data.toolCallId || data.tool_call_id || data.callId || record.toolCallId || record.tool_call_id || record.callId);
}

function mergeToolBlock(previous: ToolBlock, next: ToolBlock): ToolBlock {
  return {
    ...previous,
    ...next,
    input: next.input ?? previous.input,
    output: next.output ?? previous.output,
    startedAt: previous.startedAt ?? next.startedAt,
    summary: next.summary || previous.summary
  };
}

function statusFromToolPhase(phase: string): ToolBlockStatus {
  if (phase === "start") return "running";
  if (phase === "result" || phase === "end") return "completed";
  if (phase === "error") return "error";
  return "updated";
}

function summaryForTool(params: { name: string; status: ToolBlockStatus; output?: string }): string {
  if (params.output?.trim()) {
    return firstLine(params.output, 96);
  }
  if (params.status === "completed") return `${params.name} completed`;
  if (params.status === "error") return `${params.name} failed`;
  return `${params.name} running`;
}

function firstLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  return `${line.slice(0, limit - 1)}…`;
}

function modelLabel(provider: unknown, model: unknown): string | undefined {
  const modelText = asString(model);
  if (!modelText) return undefined;
  const providerText = asString(provider);
  return providerText ? `${providerText}/${modelText}` : modelText;
}

function formatPayload(value: unknown, limit = 8_000): string {
  if (value === null || value === undefined) return "";
  const contentText = textFromToolContent(value);
  const text =
    typeof value === "string"
      ? value
      : contentText
        ? contentText
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : safeJson(value);
  return truncatePayload(text, limit);
}

function textFromToolContent(value: unknown): string | undefined {
  const record = asRecord(value);
  if (asString(record.text)) return asString(record.text);
  if (!Array.isArray(record.content)) return undefined;
  const parts = record.content
    .map((part) => {
      const item = asRecord(part);
      return asString(item.text) ?? asString(item.content) ?? "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncatePayload(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... truncated (${text.length} chars)`;
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
