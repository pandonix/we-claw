import crypto from "node:crypto";
import type { ConversationNotice, GatewayFrame, RuntimeCapabilities, SessionSummary, ToolBlock, TranscriptMessage } from "../shared/types";
import type { LauncherContext } from "./bootstrap.js";
import { HermesJsonRpcClient, type HermesGatewayEvent } from "./hermes-jsonrpc.js";
import { redact } from "./redact.js";

const HERMES_SESSION_PREFIX = "hermes:";
const DEFAULT_SESSION_LIMIT = 200;

type RuntimeEventEmitter = (frame: GatewayFrame) => void;

interface RuntimeHistory {
  messages: TranscriptMessage[];
  toolBlocks?: ToolBlock[];
  notices?: ConversationNotice[];
}

export interface HermesRpcClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onEvent(listener: (event: HermesGatewayEvent) => void): () => void;
  getStatus?(): { running: boolean; ready: boolean; stderrTail: string; lastError?: string };
  dispose?(): void;
}

export class HermesRuntime {
  private readonly persistedToActive = new Map<string, string>();
  private readonly activeToPersisted = new Map<string, string>();
  private readonly sessionSubscribers = new Set<RuntimeEventEmitter>();
  private readonly messageSubscribers = new Map<string, Set<RuntimeEventEmitter>>();
  private unsubscribeClientEvents?: () => void;

  constructor(
    context: LauncherContext,
    private readonly client: HermesRpcClient = new HermesJsonRpcClient(context.config)
  ) {
    this.subscribeClientEvents();
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.subscribeClientEvents();
    const result = await this.client.request("session.list", { limit: DEFAULT_SESSION_LIMIT });
    return normalizeHermesSessions(result);
  }

  async createSession(emit?: RuntimeEventEmitter): Promise<SessionSummary> {
    this.subscribeClientEvents();
    const result = await this.client.request("session.create", { cols: 100 });
    const activeSessionId = sessionIdFromResult(result);
    if (!activeSessionId) throw new Error("Hermes session.create did not return session_id.");

    const persistedSessionId = await this.lookupPersistedSessionId(activeSessionId).catch(() => activeSessionId);
    this.rememberSession(persistedSessionId, activeSessionId);
    const summary = normalizeHermesSession({
      id: persistedSessionId,
      title: titleFromResult(result),
      source: "tui",
      started_at: Date.now() / 1000
    });
    this.emitSessionsChanged(emit);
    return summary;
  }

  async loadHistory(sessionKey: string): Promise<RuntimeHistory> {
    this.subscribeClientEvents();
    const activeSessionId = await this.ensureActiveSession(sessionKey);
    const result = await this.client.request("session.history", { session_id: activeSessionId });
    return normalizeHermesHistory(result, hermesSessionKey(realHermesSessionId(sessionKey) ?? activeSessionId));
  }

  async sendPrompt(sessionKey: string, prompt: string, emit: RuntimeEventEmitter): Promise<unknown> {
    this.subscribeClientEvents();
    const text = prompt.trim();
    if (!text) throw new Error("chat.send requires a non-empty message.");
    const activeSessionId = await this.ensureActiveSession(sessionKey);
    const persistedSessionId = this.activeToPersisted.get(activeSessionId) ?? realHermesSessionId(sessionKey) ?? activeSessionId;
    const stableSessionKey = hermesSessionKey(persistedSessionId);
    emit(chatPayload("started", stableSessionKey));
    await this.client.request("prompt.submit", { session_id: activeSessionId, text });
    return {
      status: "started",
      runId: stableSessionKey,
      sessionKey: stableSessionKey
    };
  }

  async abort(sessionKey: string): Promise<unknown> {
    this.subscribeClientEvents();
    const activeSessionId = await this.ensureActiveSession(sessionKey);
    await this.client.request("session.interrupt", { session_id: activeSessionId }, 5000);
    return { status: "aborted", sessionKey };
  }

  subscribeSessions(emit: RuntimeEventEmitter): unknown {
    this.sessionSubscribers.add(emit);
    return { subscribed: true };
  }

  subscribeSessionMessages(sessionKey: string, emit: RuntimeEventEmitter): unknown {
    if (!sessionKey) return { subscribed: false };
    const subscribers = this.messageSubscribers.get(sessionKey) ?? new Set<RuntimeEventEmitter>();
    subscribers.add(emit);
    this.messageSubscribers.set(sessionKey, subscribers);
    return { subscribed: true };
  }

  unsubscribeSessionMessages(sessionKey: string, emit: RuntimeEventEmitter): unknown {
    if (!sessionKey) return { subscribed: false };
    const subscribers = this.messageSubscribers.get(sessionKey);
    subscribers?.delete(emit);
    if (subscribers?.size === 0) this.messageSubscribers.delete(sessionKey);
    return { subscribed: false };
  }

  unsubscribeAll(emit: RuntimeEventEmitter): void {
    this.sessionSubscribers.delete(emit);
    for (const [sessionKey, subscribers] of this.messageSubscribers) {
      subscribers.delete(emit);
      if (subscribers.size === 0) this.messageSubscribers.delete(sessionKey);
    }
  }

  dispose(): void {
    this.unsubscribeClientEvents?.();
    this.unsubscribeClientEvents = undefined;
    this.client.dispose?.();
    this.sessionSubscribers.clear();
    this.messageSubscribers.clear();
  }

  private async ensureActiveSession(sessionKey: string): Promise<string> {
    const sessionId = realHermesSessionId(sessionKey);
    if (!sessionId) {
      const created = await this.createSession();
      return this.persistedToActive.get(created.sessionId ?? realHermesSessionId(created.sessionKey) ?? "") ?? created.sessionId ?? created.sessionKey;
    }
    const existingActive = this.persistedToActive.get(sessionId);
    if (existingActive) return existingActive;

    const result = await this.client.request("session.resume", { session_id: sessionId, cols: 100 });
    const activeSessionId = sessionIdFromResult(result);
    if (!activeSessionId) throw new Error("Hermes session.resume did not return session_id.");
    this.rememberSession(sessionId, activeSessionId);
    return activeSessionId;
  }

  private async lookupPersistedSessionId(activeSessionId: string): Promise<string> {
    const titleResult = await this.client.request("session.title", { session_id: activeSessionId });
    const sessionKey = asString(asRecord(titleResult).session_key);
    return sessionKey ?? activeSessionId;
  }

  private rememberSession(persistedSessionId: string, activeSessionId: string): void {
    this.persistedToActive.set(persistedSessionId, activeSessionId);
    this.activeToPersisted.set(activeSessionId, persistedSessionId);
  }

  private subscribeClientEvents(): void {
    if (this.unsubscribeClientEvents) return;
    this.unsubscribeClientEvents = this.client.onEvent((event) => this.handleHermesEvent(event));
  }

  private handleHermesEvent(event: HermesGatewayEvent): void {
    if (event.type === "gateway.ready") return;
    const activeSessionId = event.session_id;
    const persistedSessionId = activeSessionId ? this.activeToPersisted.get(activeSessionId) ?? activeSessionId : undefined;
    const sessionKey = persistedSessionId ? hermesSessionKey(persistedSessionId) : undefined;
    const frame = frameFromHermesEvent(event, sessionKey);
    if (!frame) return;
    this.broadcast(frame, undefined, sessionKey ? this.messageSubscribers.get(sessionKey) : undefined);
    if (event.type === "message.complete" || event.type === "error") {
      if (sessionKey) this.emitSessionMessage(sessionKey);
      this.emitSessionsChanged();
    }
  }

  private emitSessionsChanged(extraEmit?: RuntimeEventEmitter): void {
    this.broadcast({ type: "sessions.changed" }, extraEmit);
  }

  private emitSessionMessage(sessionKey: string, extraEmit?: RuntimeEventEmitter): void {
    this.broadcast({ type: "event", event: "session.message", payload: { sessionKey } }, extraEmit, this.messageSubscribers.get(sessionKey));
  }

  private broadcast(frame: GatewayFrame, extraEmit?: RuntimeEventEmitter, scopedSubscribers?: Set<RuntimeEventEmitter>): void {
    const subscribers = new Set<RuntimeEventEmitter>(scopedSubscribers ?? this.sessionSubscribers);
    if (extraEmit) subscribers.add(extraEmit);
    for (const subscriber of subscribers) subscriber(frame);
  }
}

export function hermesCapabilities(): RuntimeCapabilities {
  return {
    sessions: true,
    sessionList: true,
    resume: true,
    fork: false,
    stream: true,
    abort: true,
    approvals: false,
    toolEvents: true,
    mcp: false,
    hooks: false
  };
}

export function normalizeHermesSession(value: unknown): SessionSummary {
  const record = asRecord(value);
  const persistedId = asString(record.id) ?? asString(record.session_id) ?? asString(record.sessionKey) ?? "unknown";
  const title = asString(record.title) ?? asString(record.preview) ?? "未命名会话";
  const timestamp = asNumber(record.started_at) ? new Date(asNumber(record.started_at)! * 1000).toISOString() : undefined;
  const source = asString(record.source);
  return {
    id: hermesSessionKey(persistedId),
    sessionKey: hermesSessionKey(persistedId),
    sessionId: persistedId,
    title,
    subtitle: source ? `Hermes · ${source}` : "Hermes",
    updatedAt: timestamp,
    status: "idle"
  };
}

export function normalizeHermesSessions(value: unknown): SessionSummary[] {
  const record = asRecord(value);
  const sessions = Array.isArray(value) ? value : Array.isArray(record.sessions) ? record.sessions : [];
  return sessions.map(normalizeHermesSession).filter((session) => session.sessionId && session.sessionId !== "unknown");
}

export function normalizeHermesHistory(value: unknown, sessionKey: string): RuntimeHistory {
  const record = asRecord(value);
  const messages = Array.isArray(value) ? value : Array.isArray(record.messages) ? record.messages : [];
  const transcript: TranscriptMessage[] = [];
  messages.forEach((item, index) => {
    const message = normalizeHermesMessage(item, `hermes-history-${index}`);
    if (message) transcript.push(message);
  });
  return { messages: transcript, toolBlocks: [], notices: [{ id: `notice:hermes:${sessionKey}`, kind: "runtime", text: "Hermes history loaded", timestamp: Date.now() }] };
}

export function frameFromHermesEvent(event: HermesGatewayEvent, sessionKey?: string): GatewayFrame | undefined {
  const payload = asRecord(event.payload);
  if (event.type === "message.start") return chatPayload("started", sessionKey);
  if (event.type === "message.delta") return chatPayload("delta", sessionKey, asString(payload.text) ?? "");
  if (event.type === "message.complete") {
    const status = asString(payload.status);
    const text = asString(payload.text);
    if (status === "interrupted") return chatPayload("aborted", sessionKey, text || "Hermes run interrupted.");
    if (status === "error") return chatPayload("error", sessionKey, text || "Hermes run failed.");
    return chatPayload("final", sessionKey, text);
  }
  if (event.type === "error") return chatPayload("error", sessionKey, asString(payload.message) ?? "Hermes runtime error.");
  if (event.type === "status.update") return lifecycleFrame(sessionKey, "status", asString(payload.text) ?? asString(payload.kind) ?? "Hermes status updated");
  if (event.type === "tool.start") return toolEventFrame(sessionKey, "start", payload);
  if (event.type === "tool.progress") return toolEventFrame(sessionKey, "update", payload);
  if (event.type === "tool.complete") return toolEventFrame(sessionKey, "result", payload);
  if (event.type === "approval.request" || event.type === "clarify.request" || event.type === "sudo.request" || event.type === "secret.request") {
    return lifecycleFrame(sessionKey, "waiting", `${event.type} received; inline response is not supported in this phase.`);
  }
  return undefined;
}

function normalizeHermesMessage(value: unknown, fallbackId: string): TranscriptMessage | undefined {
  const record = asRecord(value);
  const role = record.role === "user" || record.role === "assistant" || record.role === "system" || record.role === "error" ? record.role : undefined;
  if (!role) return undefined;
  const text = textFromContent(record.text ?? record.content ?? record.message);
  if (!text.trim()) return undefined;
  return {
    id: asString(record.id) ?? fallbackId,
    role,
    text,
    status: "final",
    timestamp: asString(record.timestamp)
  };
}

function chatPayload(state: "started" | "delta" | "final" | "error" | "aborted", sessionKey?: string, text?: string): GatewayFrame {
  return {
    type: "chat",
    payload: {
      state,
      sessionKey,
      delta: state === "delta" ? text : undefined,
      message: text ? { id: `hermes:${Date.now()}:${crypto.randomUUID()}`, role: state === "error" ? "error" : "assistant", text } : undefined
    }
  };
}

function lifecycleFrame(sessionKey: string | undefined, phase: string, text: string): GatewayFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey,
      data: { phase, text }
    }
  };
}

function toolEventFrame(sessionKey: string | undefined, phase: "start" | "update" | "result", payload: Record<string, unknown>): GatewayFrame {
  const toolCallId = asString(payload.tool_id) ?? asString(payload.toolCallId) ?? asString(payload.id) ?? `hermes-tool:${Date.now()}`;
  return {
    type: "event",
    event: "session.tool",
    payload: {
      stream: "tool",
      ts: Date.now(),
      sessionKey,
      data: {
        phase,
        toolCallId,
        name: asString(payload.name) ?? "tool",
        args: payload.context ? { context: payload.context } : undefined,
        partialResult: phase === "update" ? payload.preview ?? payload.text ?? payload.summary : undefined,
        result: phase === "result" ? payload.summary ?? payload.inline_diff ?? payload.todos ?? payload : undefined,
        summary: asString(payload.summary) ?? asString(payload.preview) ?? asString(payload.context)
      }
    }
  };
}

function hermesSessionKey(sessionId: string): string {
  return sessionId.startsWith(HERMES_SESSION_PREFIX) ? sessionId : `${HERMES_SESSION_PREFIX}${sessionId}`;
}

function realHermesSessionId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return sessionKey.startsWith(HERMES_SESSION_PREFIX) ? sessionKey.slice(HERMES_SESSION_PREFIX.length) : sessionKey;
}

function sessionIdFromResult(value: unknown): string | undefined {
  return asString(asRecord(value).session_id) ?? asString(asRecord(value).sessionId);
}

function titleFromResult(value: unknown): string | undefined {
  const info = asRecord(asRecord(value).info);
  return asString(info.title) ?? asString(asRecord(value).title);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return typeof part === "string" ? part : asString(record.text) ?? asString(record.content) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  return asString(record.text) ?? asString(record.content) ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? redact(text) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
