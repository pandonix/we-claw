import { GatewayClient } from "../gateway/client";
import { normalizeHistory, normalizeSessions, reduceChatEvent, titleFromHistory, UNTITLED_SESSION } from "../shared/normalizers";
import type { BootstrapResponse, ChatState, ConnectionState, SessionSummary, TranscriptMessage } from "../shared/types";
import "./styles.css";

interface AppState {
  bootstrap?: BootstrapResponse;
  connection: ConnectionState;
  sessions: SessionSummary[];
  activeSessionId?: string;
  chat: ChatState;
  composerText: string;
  statusText: string;
  isCreatingSession: boolean;
}

const maybeRoot = document.querySelector<HTMLDivElement>("#app");
if (!maybeRoot) throw new Error("Missing #app root");
const appRoot = maybeRoot;

let gateway: GatewayClient | undefined;
let historyRequestSeq = 0;
let state: AppState = {
  connection: "starting",
  sessions: [],
  chat: {
    messages: [],
    running: false
  },
  composerText: "",
  statusText: "正在读取本地启动状态",
  isCreatingSession: false
};

render();
void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`);
    const bootstrapResponse = (await response.json()) as BootstrapResponse;
    state = { ...state, bootstrap: bootstrapResponse, statusText: statusFromBootstrap(bootstrapResponse) };
    render();

    if (bootstrapResponse.gateway.reachable) {
      await connectGateway(browserGatewayUrl(bootstrapResponse));
    } else {
      state = { ...state, connection: "disconnected" };
      render();
    }
  } catch (error) {
    state = {
      ...state,
      connection: "error",
      statusText: error instanceof Error ? error.message : "Bootstrap failed"
    };
    render();
  }
}

async function connectGateway(url: string): Promise<void> {
  state = { ...state, connection: "reconnecting", statusText: "正在连接 OpenClaw Gateway" };
  render();

  try {
    gateway = new GatewayClient(url);
    gateway.onEvent((frame) => {
      if (frame.type === "chat" || frame.event === "chat") {
        const chatEvent = frame.payload ?? frame.params ?? frame.data ?? frame.result ?? frame;
        const eventSessionKey = sessionKeyFromEvent(chatEvent);
        if (eventSessionKey && state.activeSessionId && eventSessionKey !== state.activeSessionId) return;
        state = { ...state, chat: reduceChatEvent(state.chat, chatEvent), statusText: statusFromChatEvent(chatEvent, state.statusText) };
        render();
      }
      if (frame.type === "sessions.changed" || frame.event === "sessions.changed") {
        void loadSessions();
      }
      if (frame.type === "shutdown") {
        state = { ...state, connection: "disconnected", statusText: "Gateway 已断开" };
        render();
      }
    });
    await gateway.connect();
    state = { ...state, connection: "connected", statusText: "Gateway connected" };
    render();
    await gateway.request("health").catch(() => undefined);
    await loadSessions({ loadHistoryForActive: true });
  } catch (error) {
    state = {
      ...state,
      connection: "error",
      statusText: classifyGatewayError(error)
    };
    render();
  }
}

async function loadSessions(options: { loadHistoryForActive?: boolean } = {}): Promise<void> {
  if (!gateway) return;
  const result = await gateway.request("sessions.list", {
    includeDerivedTitles: true,
    includeLastMessage: true
  }).catch((error) => {
    state = { ...state, statusText: error instanceof Error ? error.message : "sessions.list failed" };
    return undefined;
  });
  const sessions = normalizeSessions(result);
  const hasActiveSession = Boolean(state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId));
  const activeSessionId = hasActiveSession ? state.activeSessionId : sessions[0]?.id;
  state = { ...state, sessions, activeSessionId };
  render();
  if (activeSessionId && options.loadHistoryForActive) await loadHistory(activeSessionId);
}

async function loadHistory(sessionId: string): Promise<void> {
  if (!gateway) return;
  const requestSeq = ++historyRequestSeq;
  state = { ...state, chat: { messages: [], running: false }, statusText: "正在加载会话历史" };
  render();
  const history = await gateway.request("chat.history", { sessionKey: sessionId }).catch((error) => {
    if (requestSeq === historyRequestSeq && state.activeSessionId === sessionId) {
      state = { ...state, statusText: error instanceof Error ? error.message : "chat.history failed" };
      render();
    }
    return undefined;
  });
  if (requestSeq !== historyRequestSeq || state.activeSessionId !== sessionId) return;
  const messages = normalizeHistory(history);
  state = { ...state, sessions: applyHistoryTitle(sessionId, messages), chat: { messages, running: false }, statusText: "会话历史已加载" };
  render();
}

async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || !gateway || state.connection !== "connected") return;

  const userMessage: TranscriptMessage = {
    id: `local-${Date.now()}`,
    role: "user",
    text: trimmed,
    status: "final"
  };
  const sessionKey = state.activeSessionId;
  state = {
    ...state,
    composerText: "",
    sessions: sessionKey ? applyHistoryTitle(sessionKey, [userMessage]) : state.sessions,
    chat: { ...state.chat, running: true, messages: [...state.chat.messages, userMessage] },
    statusText: "chat.send 已发送"
  };
  render();

  if (!sessionKey) {
    state = {
      ...state,
      composerText: trimmed,
      chat: { ...state.chat, running: false, error: "No OpenClaw session is selected." },
      statusText: "发送失败，输入已保留"
    };
    render();
    return;
  }

  const params = { sessionKey, message: trimmed, idempotencyKey: createIdempotencyKey() };
  const result = await gateway.request("chat.send", params).catch((error) => {
    state = {
      ...state,
      composerText: trimmed,
      chat: { ...state.chat, running: false, error: error instanceof Error ? error.message : "chat.send failed" },
      statusText: "发送失败，输入已保留"
    };
    render();
    return undefined;
  });
  if (result) {
    state = { ...state, chat: reduceChatEvent(state.chat, result), statusText: statusFromChatSendResult(result) };
    render();
  }
}

function applyHistoryTitle(sessionId: string, messages: TranscriptMessage[]): SessionSummary[] {
  const title = titleFromHistory(messages);
  if (!title) return state.sessions;
  return state.sessions.map((session) => (session.id === sessionId && session.title === UNTITLED_SESSION ? { ...session, title } : session));
}

async function abortRun(): Promise<void> {
  if (!gateway || !state.activeSessionId) return;
  await gateway.request("chat.abort", { sessionKey: state.activeSessionId }).catch(() => undefined);
  state = { ...state, chat: { ...state.chat, running: false }, statusText: "已请求停止当前运行" };
  render();
}

function render(): void {
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="session-rail" aria-label="OpenClaw sessions">
        <div class="brand-row">
          <strong>We-Claw</strong>
          <span class="gateway-dot ${state.connection}"></span>
        </div>
        <button class="new-session" data-action="new-session" type="button" ${canCreateSession() ? "" : "disabled"} aria-busy="${state.isCreatingSession ? "true" : "false"}">${state.isCreatingSession ? "创建中..." : "+ 新会话"}</button>
        <div class="rail-heading">
          <span>Gateway Sessions</span>
          <button type="button" aria-label="刷新会话" data-action="refresh">↻</button>
        </div>
        <div class="session-list" data-testid="session-list">
          ${renderSessions()}
        </div>
        <button class="settings-row" type="button">本地设置</button>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div class="title-block">
            <strong>${escapeHtml(activeSession?.title ?? "OpenClaw 会话工作台")}</strong>
            <span>${escapeHtml(activeSession?.subtitle ?? "loopback Gateway · local workspace")}</span>
          </div>
          <div class="top-actions">
            <span class="runtime-pill ${state.connection}"><i></i>${escapeHtml(labelForConnection(state.connection))}</span>
            <button type="button" aria-label="重新连接" data-action="reconnect">↻</button>
          </div>
        </header>
        <section class="conversation" data-testid="conversation" aria-label="会话内容">
          ${renderDiagnostics()}
          ${state.chat.messages.map(renderMessage).join("")}
          ${state.chat.running ? `<article class="run-row"><span></span><p>OpenClaw 正在处理当前请求</p></article>` : ""}
          ${state.chat.error ? `<article class="inline-error"><strong>运行失败</strong><p>${escapeHtml(state.chat.error)}</p></article>` : ""}
        </section>
        <form class="composer" data-testid="composer">
          <label class="sr-only" for="prompt">输入消息</label>
          <textarea id="prompt" rows="1" placeholder="输入 prompt，发送到当前 OpenClaw session" ${state.connection === "connected" ? "" : "disabled"}>${escapeHtml(state.composerText)}</textarea>
          <div class="composer-bar">
            <span>${escapeHtml(state.statusText)}</span>
            <button class="send" type="${state.chat.running ? "button" : "submit"}" data-action="${state.chat.running ? "abort" : "send"}" aria-label="${state.chat.running ? "停止" : "发送"}" ${canSubmit() ? "" : "disabled"}>${state.chat.running ? "■" : "↑"}</button>
          </div>
        </form>
        <footer class="statusbar">
          <span>${escapeHtml(state.bootstrap?.gateway.ownership ?? "none")} gateway</span>
          <span>${escapeHtml(state.bootstrap?.openclaw.version ?? "OpenClaw 未确认")}</span>
        </footer>
      </main>
    </div>
  `;

  bindEvents();
  const conversation = appRoot.querySelector(".conversation");
  conversation?.scrollTo({ left: 0, top: conversation.scrollHeight });
}

function bindEvents(): void {
  appRoot.querySelector<HTMLFormElement>(".composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const textarea = appRoot.querySelector<HTMLTextAreaElement>("#prompt");
    void sendPrompt(textarea?.value ?? "");
  });
  appRoot.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => {
    state.composerText = (event.target as HTMLTextAreaElement).value;
  });
  appRoot.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.sessionId;
      if (!sessionId) return;
      state = { ...state, activeSessionId: sessionId };
      render();
      void loadHistory(sessionId);
    });
  });
  appRoot.querySelector<HTMLButtonElement>("[data-action='refresh']")?.addEventListener("click", () => void loadSessions({ loadHistoryForActive: true }));
  appRoot.querySelector<HTMLButtonElement>("[data-action='reconnect']")?.addEventListener("click", () => void bootstrap());
  appRoot.querySelector<HTMLButtonElement>("[data-action='abort']")?.addEventListener("click", () => void abortRun());
  appRoot.querySelector<HTMLButtonElement>("[data-action='new-session']")?.addEventListener("click", () => void createSession());
}

async function createSession(): Promise<void> {
  if (!gateway || !canCreateSession()) return;
  state = { ...state, isCreatingSession: true, statusText: "正在创建 OpenClaw session" };
  render();

  const result = await gateway.request("sessions.create", {}).catch((error) => {
    state = {
      ...state,
      isCreatingSession: false,
      statusText: error instanceof Error ? error.message : "sessions.create failed"
    };
    render();
    return undefined;
  });
  const [session] = normalizeSessions([result]);
  if (session) {
    state = {
      ...state,
      sessions: upsertSession(state.sessions, session),
      activeSessionId: session.id,
      chat: { messages: [], running: false },
      isCreatingSession: false,
      statusText: "新会话已创建"
    };
    render();
  } else {
    await loadSessions({ loadHistoryForActive: true });
    state = { ...state, isCreatingSession: false };
    render();
  }
}

function upsertSession(sessions: SessionSummary[], nextSession: SessionSummary): SessionSummary[] {
  const existingIndex = sessions.findIndex((session) => session.id === nextSession.id);
  if (existingIndex === -1) return [nextSession, ...sessions];
  return [nextSession, ...sessions.slice(0, existingIndex), ...sessions.slice(existingIndex + 1)];
}

function renderSessions(): string {
  if (!state.sessions.length) {
    return `<div class="empty-sessions">未发现 Gateway sessions</div>`;
  }
  return state.sessions
    .map(
      (session) => `
        <button class="session-row ${session.id === state.activeSessionId ? "active" : ""}" data-session-id="${escapeHtml(session.id)}" type="button">
          <span class="state-dot ${session.status}"></span>
          <span class="session-main">
            <strong>${escapeHtml(session.title)}</strong>
            <em>${escapeHtml(session.subtitle)}</em>
          </span>
          <time>${escapeHtml(formatRelative(session.updatedAt))}</time>
        </button>
      `
    )
    .join("");
}

function renderDiagnostics(): string {
  const diagnostics = state.bootstrap?.diagnostics ?? [];
  if (!diagnostics.length && state.connection !== "disconnected" && state.connection !== "error") return "";
  const items = diagnostics.length
    ? diagnostics
    : [{ code: "gateway.disconnected", message: "本地 OpenClaw Gateway 当前不可达。", detail: state.statusText }];
  return items
    .map(
      (item) => `
      <article class="inline-error">
        <strong>${escapeHtml(item.message)}</strong>
        <p>${escapeHtml(item.detail ?? item.code)}</p>
      </article>
    `
    )
    .join("");
}

function renderMessage(message: TranscriptMessage): string {
  return `
    <article class="message ${message.role}" data-message-id="${escapeHtml(message.id)}">
      <p>${escapeHtml(message.text)}</p>
      ${message.status && message.status !== "final" ? `<small>${escapeHtml(message.status)}</small>` : ""}
    </article>
  `;
}

function canSubmit(): boolean {
  if (state.chat.running) return state.connection === "connected";
  return state.connection === "connected";
}

function canCreateSession(): boolean {
  return state.connection === "connected" && !state.isCreatingSession && (gateway?.capabilities.methods.has("sessions.create") ?? false);
}

function statusFromBootstrap(bootstrapResponse: BootstrapResponse): string {
  if (!bootstrapResponse.node.compatible) return "Node.js 版本不满足 OpenClaw 要求";
  if (!bootstrapResponse.openclaw.available) return "未找到 openclaw 可执行文件";
  if (!bootstrapResponse.gateway.reachable) return "Gateway 未运行或正在启动";
  return "Bootstrap ready";
}

function classifyGatewayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CONTROL_UI_ORIGIN_NOT_ALLOWED")) {
    return "Gateway 拒绝当前 We-Claw origin；需要配置 allowedOrigins 或使用受限本地代理。";
  }
  if (message.includes("AUTH_") || message.includes("auth")) {
    return "Gateway 需要认证；当前 bootstrap 不会暴露 token。";
  }
  return message || "Gateway connection failed";
}

function browserGatewayUrl(bootstrapResponse: BootstrapResponse): string {
  if (bootstrapResponse.gateway.bridgePath) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${bootstrapResponse.gateway.bridgePath}`;
  }
  return bootstrapResponse.gateway.url;
}

function labelForConnection(connection: ConnectionState): string {
  return {
    starting: "Starting",
    connected: "Gateway Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    error: "Gateway Error"
  }[connection];
}

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `we-claw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function statusFromChatSendResult(result: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const runId = typeof record.runId === "string" ? record.runId : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (runId && (status === "started" || status === "accepted" || status === "in_flight")) return `OpenClaw run ${runId.slice(0, 8)} 已启动`;
  return "OpenClaw 已返回消息";
}

function statusFromChatEvent(event: unknown, fallback: string): string {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  if (record.state === "final") return "OpenClaw 已返回消息";
  if (record.state === "error") return "OpenClaw 返回错误";
  if (record.state === "aborted") return "OpenClaw 运行已停止";
  return fallback;
}

function sessionKeyFromEvent(event: unknown): string | undefined {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  return typeof record.sessionKey === "string" && record.sessionKey.trim() ? record.sessionKey.trim() : undefined;
}

function formatRelative(value?: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 时`;
  return `${Math.round(minutes / 1440)} 天`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
