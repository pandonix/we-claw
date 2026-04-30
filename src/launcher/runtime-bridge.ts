import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { getSessionMessages, listSessions, query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { GatewayFrame, RuntimeBootstrap, RuntimeCapabilities, RuntimeKind, RuntimeTransport, SessionSummary, TranscriptMessage } from "../shared/types";
import type { LauncherContext } from "./bootstrap.js";
import { bridgeGatewayWebSocket } from "./gateway-bridge.js";
import { redact } from "./redact.js";

const RUNTIME_BRIDGE_PATH = "/api/runtime/ws";
const CLAUDE_PENDING_PREFIX = "claude:pending:";
const CLAUDE_SESSION_PREFIX = "claude:";
const DEFAULT_SESSION_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 200;

type UpgradeServer = {
  on(event: "upgrade", listener: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

type RuntimeEventEmitter = (frame: GatewayFrame) => void;

interface LocalClaudeSession {
  sessionKey: string;
  sessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
}

export function runtimeBridgePath(): string {
  return RUNTIME_BRIDGE_PATH;
}

export function installRuntimeBridge(server: UpgradeServer, context: LauncherContext): void {
  const claudeRuntime = new ClaudeAgentSdkRuntime(context);
  server.on("upgrade", (request, socket, head) => {
    const pathname = safePathname(request.url);
    if (pathname !== RUNTIME_BRIDGE_PATH) return;
    if (runtimeKind(context) === "openclaw") {
      void bridgeGatewayWebSocket(request, socket, head, context);
      return;
    }
    void bridgeLocalRuntimeWebSocket(request, socket, head, context, claudeRuntime);
  });
}

export function runtimeKind(context: LauncherContext): RuntimeKind {
  return context.config.runtimeKind === "auto" ? "openclaw" : context.config.runtimeKind;
}

export function runtimeBootstrap(context: LauncherContext, gateway: RuntimeBootstrap, openclawVersion?: string): RuntimeBootstrap {
  const kind = runtimeKind(context);
  if (kind === "openclaw") {
    return {
      kind,
      transport: "gateway-ws",
      name: "OpenClaw",
      available: gateway.available,
      version: openclawVersion,
      bridgePath: RUNTIME_BRIDGE_PATH,
      capabilities: openClawCapabilities(),
      reachable: gateway.reachable,
      ready: gateway.ready,
      ownership: gateway.ownership,
      processState: gateway.processState,
      error: gateway.error
    };
  }

  if (kind === "claude-agent-sdk") {
    const version = detectClaudeAgentSdkVersion();
    return {
      kind,
      transport: "library-sdk",
      name: "Claude Agent SDK",
      available: Boolean(version),
      version,
      bridgePath: RUNTIME_BRIDGE_PATH,
      capabilities: claudeAgentSdkCapabilities(),
      reachable: Boolean(version),
      ready: Boolean(version),
      ownership: "managed",
      processState: version ? "running" : "failed",
      error: version ? undefined : "Claude Agent SDK package is not installed."
    };
  }

  return {
    kind,
    transport: transportForRuntime(kind),
    name: runtimeName(kind),
    available: false,
    bridgePath: RUNTIME_BRIDGE_PATH,
    capabilities: emptyCapabilities(),
    reachable: false,
    ready: false,
    ownership: "none",
    processState: "not-started",
    error: `${runtimeName(kind)} runtime is not implemented in this build.`
  };
}

export function normalizeClaudeSession(value: unknown): SessionSummary {
  const record = asRecord(value);
  const sessionId = asString(record.sessionId) ?? asString(record.session_id) ?? asString(record.id) ?? "unknown";
  const lastModified = asNumber(record.lastModified) ?? asNumber(record.mtime) ?? asNumber(record.updatedAt);
  const createdAt = asNumber(record.createdAt);
  const title = asString(record.summary) ?? asString(record.customTitle) ?? asString(record.firstPrompt) ?? "未命名会话";
  const cwd = asString(record.cwd);
  return {
    id: `${CLAUDE_SESSION_PREFIX}${sessionId}`,
    sessionKey: `${CLAUDE_SESSION_PREFIX}${sessionId}`,
    sessionId,
    title,
    subtitle: cwd ? `Claude Agent SDK · ${cwd}` : "Claude Agent SDK",
    updatedAt: new Date(lastModified ?? createdAt ?? Date.now()).toISOString(),
    status: "idle"
  };
}

export function normalizeClaudeHistoryMessages(messages: unknown[]): TranscriptMessage[] {
  return messages.flatMap((item, index) => {
    const record = asRecord(item);
    const role = record.type === "user" || record.type === "assistant" || record.type === "system" ? record.type : undefined;
    if (!role) return [];
    const message = asRecord(record.message);
    const text = visibleTextFromContent(message.content ?? message.text ?? message);
    if (!text.trim()) return [];
    return [
      {
        id: asString(record.uuid) ?? `claude-history-${index}`,
        role,
        text,
        status: "final",
        timestamp: asString(message.timestamp) ?? asString(record.timestamp)
      }
    ];
  });
}

export function claudeStreamDeltaText(message: unknown): string | undefined {
  const record = asRecord(message);
  if (record.type !== "stream_event") return undefined;
  const event = asRecord(record.event);
  if (event.type !== "content_block_delta") return undefined;
  const delta = asRecord(event.delta);
  return asString(delta.text);
}

async function bridgeLocalRuntimeWebSocket(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: LauncherContext,
  claudeRuntime: ClaudeAgentSdkRuntime
): Promise<void> {
  if (request.socket.remoteAddress && !isLoopbackAddress(request.socket.remoteAddress)) {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  acceptBrowserSocket(socket, key);
  sendTextFrame(socket, JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: crypto.randomUUID() } }));

  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = readClientFrame(buffer);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.consumed);
      if (parsed.opcode === 8) {
        socket.end();
        return;
      }
      if (parsed.opcode === 9) {
        sendControlFrame(socket, 10, parsed.payload);
        continue;
      }
      if (parsed.opcode !== 1) continue;
      void handleRuntimeFrame(parsed.payload.toString("utf8"), socket, context, claudeRuntime);
    }
  });
  socket.on("error", () => socket.destroy());
}

async function handleRuntimeFrame(frameText: string, socket: Duplex, context: LauncherContext, claudeRuntime: ClaudeAgentSdkRuntime): Promise<void> {
  let frame: GatewayFrame;
  try {
    frame = JSON.parse(frameText) as GatewayFrame;
  } catch {
    sendTextFrame(socket, JSON.stringify({ type: "error", error: "Invalid runtime frame JSON." }));
    return;
  }
  if (frame.type !== "req" || !frame.method) return;

  const emit: RuntimeEventEmitter = (eventFrame) => sendTextFrame(socket, JSON.stringify(eventFrame));
  try {
    const payload = await dispatchRuntimeRequest(frame.method, frame.params, context, claudeRuntime, emit);
    sendTextFrame(socket, JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
  } catch (error) {
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: false,
        error: { message: error instanceof Error ? redact(error.message) : redact(String(error)) }
      })
    );
  }
}

async function dispatchRuntimeRequest(
  method: string,
  params: unknown,
  context: LauncherContext,
  claudeRuntime: ClaudeAgentSdkRuntime,
  emit: RuntimeEventEmitter
): Promise<unknown> {
  if (method === "connect") return { methods: runtimeMethods(runtimeKind(context)), runtime: runtimeBootstrap(context, gatewayRuntimePlaceholder()) };
  if (method === "health") return { ready: true, runtime: runtimeKind(context) };
  if (method === "sessions.subscribe" || method === "sessions.messages.subscribe") return { subscribed: true };
  if (method === "sessions.messages.unsubscribe") return { subscribed: false };

  if (runtimeKind(context) !== "claude-agent-sdk") {
    throw new Error(`${runtimeName(runtimeKind(context))} runtime bridge is not implemented.`);
  }

  if (method === "sessions.list") return { sessions: await claudeRuntime.listSessions() };
  if (method === "sessions.create") return claudeRuntime.createSession();
  if (method === "chat.history") return { messages: await claudeRuntime.loadHistory(sessionKeyFromParams(params)) };
  if (method === "chat.send") return claudeRuntime.sendPrompt(sessionKeyFromParams(params), messageFromParams(params), emit);
  if (method === "chat.abort") return claudeRuntime.abort(sessionKeyFromParams(params));
  throw new Error(`Unsupported runtime method: ${method}`);
}

class ClaudeAgentSdkRuntime {
  private readonly localSessions = new Map<string, LocalClaudeSession>();
  private readonly activeRuns = new Map<string, { controller: AbortController; query?: Query }>();

  constructor(private readonly context: LauncherContext) {}

  async listSessions(): Promise<SessionSummary[]> {
    const sdkSessions = await listSessions({
      dir: this.context.config.claudeSdkCwd,
      limit: DEFAULT_SESSION_LIMIT
    });
    const local = [...this.localSessions.values()]
      .map((session) => this.summaryFromLocalSession(session));
    const localSessionIds = new Set([...this.localSessions.values()].map((session) => session.sessionId).filter(Boolean));
    const persisted = sdkSessions
      .filter((session) => !localSessionIds.has(normalizeClaudeSession(session).sessionId))
      .map((session) => normalizeClaudeSession(session));
    return [...local, ...persisted];
  }

  createSession(title = "未命名会话"): SessionSummary {
    const now = Date.now();
    const session: LocalClaudeSession = {
      sessionKey: `${CLAUDE_PENDING_PREFIX}${crypto.randomUUID()}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.localSessions.set(session.sessionKey, session);
    return this.summaryFromLocalSession(session);
  }

  async loadHistory(sessionKey: string): Promise<TranscriptMessage[]> {
    const local = this.localSessions.get(sessionKey);
    if (local && !local.sessionId) return local.messages;

    const sessionId = local?.sessionId ?? realClaudeSessionId(sessionKey);
    if (!sessionId) return [];

    const messages = await getSessionMessages(sessionId, {
      dir: this.context.config.claudeSdkCwd,
      limit: DEFAULT_HISTORY_LIMIT
    });
    return normalizeClaudeHistoryMessages(messages);
  }

  async sendPrompt(sessionKey: string, prompt: string, emit: RuntimeEventEmitter): Promise<unknown> {
    const localSession = this.localSessions.get(sessionKey) ?? this.createLocalSessionForPrompt(sessionKey, prompt);
    const userMessage: TranscriptMessage = {
      id: `user:${Date.now()}`,
      role: "user",
      text: prompt,
      status: "final",
      timestamp: new Date().toISOString()
    };
    localSession.messages.push(userMessage);
    localSession.updatedAt = Date.now();

    const controller = new AbortController();
    const options = this.queryOptions(controller, localSession);
    const run = query({ prompt, options });
    this.activeRuns.set(localSession.sessionKey, { controller, query: run });
    emit(chatPayload("started", localSession.sessionKey));

    void this.consumeRun(run, localSession, emit);
    return { status: "started", runId: localSession.sessionKey, sessionKey: localSession.sessionKey };
  }

  async abort(sessionKey: string): Promise<unknown> {
    const run = this.activeRuns.get(sessionKey);
    run?.controller.abort();
    await run?.query?.interrupt().catch(() => undefined);
    return { status: "aborted", sessionKey };
  }

  private async consumeRun(run: Query, localSession: LocalClaudeSession, emit: RuntimeEventEmitter): Promise<void> {
    let sawAssistantText = false;
    try {
      for await (const message of run) {
        this.captureSessionId(localSession, message);
        const delta = claudeStreamDeltaText(message);
        if (delta) {
          sawAssistantText = true;
          emit(chatPayload("delta", localSession.sessionKey, delta));
          continue;
        }
        for (const tool of toolEventsFromClaudeMessage(message, localSession.sessionKey)) emit(tool);
        const finalText = finalTextFromClaudeMessage(message);
        if (finalText) {
          sawAssistantText = true;
          localSession.messages.push({
            id: messageId(message),
            role: "assistant",
            text: finalText,
            status: "final",
            timestamp: new Date().toISOString()
          });
          emit(chatPayload("final", localSession.sessionKey, finalText));
          continue;
        }
        const result = resultFromClaudeMessage(message);
        if (result) {
          if (result.isError) {
            emit(chatPayload("error", localSession.sessionKey, result.text));
          } else if (!sawAssistantText && result.text) {
            emit(chatPayload("final", localSession.sessionKey, result.text));
          } else {
            emit(chatPayload("final", localSession.sessionKey));
          }
        }
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      emit(chatPayload(aborted ? "aborted" : "error", localSession.sessionKey, aborted ? "Claude Agent SDK run aborted." : redact(error instanceof Error ? error.message : String(error))));
    } finally {
      localSession.updatedAt = Date.now();
      this.activeRuns.delete(localSession.sessionKey);
      emit({ type: "sessions.changed" });
    }
  }

  private captureSessionId(localSession: LocalClaudeSession, message: unknown): void {
    const record = asRecord(message);
    const sessionId = asString(record.session_id);
    if (!sessionId) return;
    localSession.sessionId = sessionId;
  }

  private queryOptions(controller: AbortController, localSession: LocalClaudeSession): Options {
    const resume = localSession.sessionId ?? realClaudeSessionId(localSession.sessionKey);
    return {
      abortController: controller,
      cwd: this.context.config.claudeSdkCwd,
      resume,
      includePartialMessages: true,
      allowedTools: this.context.config.claudeSdkAllowedTools,
      permissionMode: this.context.config.claudeSdkPermissionMode,
      model: this.context.config.claudeSdkModel,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "we-claw/0.1.0"
      }
    };
  }

  private createLocalSessionForPrompt(sessionKey: string, prompt: string): LocalClaudeSession {
    const now = Date.now();
    const session: LocalClaudeSession = {
      sessionKey: sessionKey || `${CLAUDE_PENDING_PREFIX}${crypto.randomUUID()}`,
      sessionId: realClaudeSessionId(sessionKey),
      title: prompt.slice(0, 64) || "未命名会话",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.localSessions.set(session.sessionKey, session);
    return session;
  }

  private summaryFromLocalSession(session: LocalClaudeSession): SessionSummary {
    return {
      id: session.sessionKey,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      title: session.title,
      subtitle: `Claude Agent SDK · ${this.context.config.claudeSdkCwd}`,
      updatedAt: new Date(session.updatedAt).toISOString(),
      status: this.activeRuns.has(session.sessionKey) ? "running" : "idle"
    };
  }
}

function runtimeMethods(kind: RuntimeKind): string[] {
  const common = ["connect", "health", "sessions.list", "sessions.create", "chat.history", "chat.send", "chat.abort", "sessions.subscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe"];
  return kind === "claude-agent-sdk" ? common : common;
}

function chatPayload(state: "started" | "delta" | "final" | "error" | "aborted", sessionKey: string, text?: string): GatewayFrame {
  return {
    type: "chat",
    payload: {
      state,
      sessionKey,
      delta: state === "delta" ? text : undefined,
      message: text ? { id: `claude:${Date.now()}`, role: state === "error" ? "error" : "assistant", text } : undefined
    }
  };
}

function toolEventsFromClaudeMessage(message: unknown, sessionKey: string): GatewayFrame[] {
  const record = asRecord(message);
  const payload = asRecord(record.message);
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((part) => {
    const item = asRecord(part);
    if (item.type !== "tool_use") return [];
    const toolCallId = asString(item.id);
    if (!toolCallId) return [];
    return [
      {
        type: "event",
        event: "session.tool",
        payload: {
          sessionKey,
          phase: "start",
          toolCallId,
          name: asString(item.name) ?? "tool",
          input: item.input
        }
      }
    ];
  });
}

function finalTextFromClaudeMessage(message: unknown): string | undefined {
  const record = asRecord(message);
  if (record.type !== "assistant") return undefined;
  const payload = asRecord(record.message);
  return visibleTextFromContent(payload.content);
}

function resultFromClaudeMessage(message: unknown): { isError: boolean; text: string } | undefined {
  const record = asRecord(message);
  if (record.type !== "result") return undefined;
  const isError = record.is_error === true || asString(record.subtype)?.startsWith("error") === true;
  const errors = Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string") : [];
  const text = asString(record.result) ?? errors.join("\n") ?? "";
  return { isError, text };
}

function messageId(message: unknown): string {
  const record = asRecord(message);
  return asString(record.uuid) ?? `claude:${Date.now()}`;
}

function sessionKeyFromParams(params: unknown): string {
  const record = asRecord(params);
  return asString(record.sessionKey) ?? asString(record.sessionId) ?? "";
}

function messageFromParams(params: unknown): string {
  const record = asRecord(params);
  return asString(record.message) ?? asString(record.text) ?? "";
}

function realClaudeSessionId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  if (sessionKey.startsWith(CLAUDE_PENDING_PREFIX)) return undefined;
  return sessionKey.startsWith(CLAUDE_SESSION_PREFIX) ? sessionKey.slice(CLAUDE_SESSION_PREFIX.length) : sessionKey;
}

function openClawCapabilities(): RuntimeCapabilities {
  return {
    sessions: true,
    sessionList: true,
    resume: true,
    fork: false,
    stream: true,
    abort: true,
    approvals: true,
    toolEvents: true,
    mcp: true,
    hooks: true
  };
}

function claudeAgentSdkCapabilities(): RuntimeCapabilities {
  return {
    sessions: true,
    sessionList: true,
    resume: true,
    fork: false,
    stream: true,
    abort: true,
    approvals: false,
    toolEvents: true,
    mcp: true,
    hooks: true
  };
}

function emptyCapabilities(): RuntimeCapabilities {
  return {
    sessions: false,
    sessionList: false,
    resume: false,
    fork: false,
    stream: false,
    abort: false,
    approvals: false,
    toolEvents: false,
    mcp: false,
    hooks: false
  };
}

function gatewayRuntimePlaceholder(): RuntimeBootstrap {
  return {
    kind: "openclaw",
    transport: "gateway-ws",
    name: "OpenClaw",
    available: true,
    bridgePath: RUNTIME_BRIDGE_PATH,
    capabilities: openClawCapabilities(),
    reachable: true,
    ready: true,
    ownership: "external",
    processState: "external"
  };
}

function transportForRuntime(kind: RuntimeKind): RuntimeTransport {
  if (kind === "hermes") return "stdio-jsonrpc";
  if (kind === "claude-agent-sdk") return "library-sdk";
  if (kind === "cli-process") return "cli-process";
  return "gateway-ws";
}

function runtimeName(kind: RuntimeKind): string {
  return {
    openclaw: "OpenClaw",
    hermes: "Hermes",
    "claude-agent-sdk": "Claude Agent SDK",
    "cli-process": "CLI Process"
  }[kind];
}

function detectClaudeAgentSdkVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return asString(packageJson.version);
  } catch {
    return undefined;
  }
}

function visibleTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    return asString(record.text) ?? "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      const type = asString(record.type);
      if (type && type !== "text") return "";
      return asString(record.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
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

function safePathname(rawUrl?: string): string {
  try {
    return new URL(rawUrl || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function acceptBrowserSocket(socket: Duplex, key: string): void {
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );
}

function readClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
    length = Number(bigLength);
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function sendTextFrame(socket: Duplex, text: string): void {
  sendFrame(socket, 1, Buffer.from(text, "utf8"));
}

function sendControlFrame(socket: Duplex, opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
  sendFrame(socket, opcode, payload);
}

function sendFrame(socket: Duplex, opcode: number, payload: Buffer<ArrayBufferLike>): void {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length <= 0xffff
        ? Buffer.from([0x80 | opcode, 126, (length >> 8) & 0xff, length & 0xff])
        : (() => {
            const buffer = Buffer.alloc(10);
            buffer[0] = 0x80 | opcode;
            buffer[1] = 127;
            buffer.writeBigUInt64BE(BigInt(length), 2);
            return buffer;
          })();
  socket.write(Buffer.concat([header, payload]));
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
