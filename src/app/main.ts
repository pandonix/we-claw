import { GatewayClient } from "../gateway/client";
import { normalizeHistory, normalizeSessions, reduceAgentEvent, reduceChatEvent, reduceToolEvent, titleFromHistory, UNTITLED_SESSION } from "../shared/normalizers";
import type { BootstrapResponse, ChatState, ConnectionState, ConversationNotice, SessionSummary, ToolBlock, TranscriptMessage, WorkIndex, WorkItem } from "../shared/types";
import {
  applyWorkTitleFromHistory,
  createWorkIndexEntry,
  markWorkItemOpened,
  normalizeWorkIndex,
  projectWorkItems,
  promoteSessionToWorkItem
} from "../shared/work-items";
import "./styles.css";

const SESSION_TITLE_CACHE_KEY = "we-claw.sessionTitleCache.v1";
const WORK_INDEX_CACHE_KEY = "we-claw.workIndex.v1";

interface AppState {
  bootstrap?: BootstrapResponse;
  connection: ConnectionState;
  sessions: SessionSummary[];
  workIndex: WorkIndex;
  workItems: WorkItem[];
  activeWorkId?: string;
  activeSessionId?: string;
  chat: ChatState;
  composerText: string;
  statusText: string;
  isCreatingSession: boolean;
  isRefreshingSessions: boolean;
}

const maybeRoot = document.querySelector<HTMLDivElement>("#app");
if (!maybeRoot) throw new Error("Missing #app root");
const appRoot = maybeRoot;

let gateway: GatewayClient | undefined;
let historyRequestSeq = 0;
let pendingSessionMessageReloadSessionKey: string | undefined;
let subscribedSessionKey: string | undefined;
let state: AppState = {
  connection: "starting",
  sessions: [],
  workIndex: readWorkIndex(),
  workItems: [],
  chat: {
    messages: [],
    running: false
  },
  composerText: "",
  statusText: "正在读取本地启动状态",
  isCreatingSession: false,
  isRefreshingSessions: false
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

    if (bootstrapResponse.runtime.reachable) {
      await connectGateway(browserRuntimeUrl(bootstrapResponse));
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
  state = { ...state, connection: "reconnecting", statusText: `正在连接 ${runtimeName()}` };
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
        replayDeferredSessionMessageReload(chatEvent);
        return;
      }
      if (frame.event === "agent") {
        const agentEvent = frame.payload ?? frame.params ?? frame.data ?? frame.result ?? frame;
        const eventSessionKey = sessionKeyFromEvent(agentEvent);
        if (eventSessionKey && state.activeSessionId && eventSessionKey !== state.activeSessionId) return;
        state = { ...state, chat: reduceAgentEvent(state.chat, agentEvent), statusText: statusFromAgentEvent(agentEvent, state.statusText) };
        render();
        return;
      }
      if (frame.event === "session.tool") {
        const toolEvent = frame.payload ?? frame.params ?? frame.data ?? frame.result ?? frame;
        const eventSessionKey = sessionKeyFromEvent(toolEvent);
        if (eventSessionKey && state.activeSessionId && eventSessionKey !== state.activeSessionId) return;
        state = { ...state, chat: reduceToolEvent(state.chat, toolEvent), statusText: statusFromAgentEvent(toolEvent, state.statusText) };
        render();
        return;
      }
      if (frame.event === "session.message") {
        handleSessionMessageEvent(frame.payload ?? frame.params ?? frame.data ?? frame.result ?? frame);
        return;
      }
      if (frame.type === "sessions.changed" || frame.event === "sessions.changed") {
        void loadSessions();
        return;
      }
      if (frame.type === "shutdown" || frame.event === "shutdown") {
        state = { ...state, connection: "disconnected", statusText: `${runtimeName()} 已断开` };
        render();
        return;
      }
    });
    await gateway.connect();
    state = { ...state, connection: "connected", statusText: `${runtimeName()} connected` };
    render();
    await gateway.request("health").catch(() => undefined);
    await gateway.request("sessions.subscribe").catch(() => undefined);
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

async function loadSessions(options: { loadHistoryForActive?: boolean; showRefreshing?: boolean } = {}): Promise<void> {
  if (!gateway) return;
  if (options.showRefreshing) {
    if (state.isRefreshingSessions) return;
    state = { ...state, isRefreshingSessions: true, statusText: "正在刷新工作列表" };
    render();
  }

  try {
    const result = await gateway
      .request("sessions.list", {
        includeDerivedTitles: true,
        includeLastMessage: true
      })
      .catch((error) => {
        state = { ...state, statusText: error instanceof Error ? error.message : "sessions.list failed" };
        return undefined;
      });
    if (result === undefined) return;

    const sessions = applyCachedTitles(normalizeSessions(result));
    const projection = projectActiveWork({
      sessions,
      workIndex: state.workIndex,
      activeWorkId: state.activeWorkId,
      activeSessionId: state.activeSessionId
    });
    const statusText = options.showRefreshing && (!projection.activeSessionId || !options.loadHistoryForActive) ? "工作列表已刷新" : state.statusText;
    state = { ...state, sessions, workItems: projection.workItems, activeWorkId: projection.activeWorkId, activeSessionId: projection.activeSessionId, statusText };
    render();
    if (projection.activeSessionId && options.loadHistoryForActive) await loadHistory(projection.activeSessionId);
  } finally {
    if (options.showRefreshing) {
      state = { ...state, isRefreshingSessions: false };
      render();
    }
  }
}

async function loadHistory(sessionId: string, options: { preserveRuntimeBlocks?: boolean } = {}): Promise<void> {
  if (!gateway) return;
  const requestSeq = ++historyRequestSeq;
  await subscribeSessionMessages(sessionId);
  const preservedToolBlocks = options.preserveRuntimeBlocks ? state.chat.toolBlocks : undefined;
  const preservedNotices = options.preserveRuntimeBlocks ? state.chat.notices : undefined;
  state = { ...state, chat: { messages: [], toolBlocks: preservedToolBlocks, notices: preservedNotices, running: false }, statusText: "正在加载会话历史" };
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
  const historyRecord = history && typeof history === "object" ? (history as { toolBlocks?: unknown; notices?: unknown }) : {};
  const historyToolBlocks = Array.isArray(historyRecord.toolBlocks) ? (historyRecord.toolBlocks as ToolBlock[]) : undefined;
  const historyNotices = Array.isArray(historyRecord.notices) ? (historyRecord.notices as ConversationNotice[]) : undefined;
  const sessions = applyHistoryTitle(sessionId, messages);
  const workIndex = applyWorkTitleFromHistory(state.workIndex, sessionId, messages);
  if (workIndex !== state.workIndex) saveWorkIndex(workIndex);
  const workItems = projectWorkItems({ workIndex, sessions, activeSessionKey: state.activeSessionId });
  state = {
    ...state,
    sessions,
    workIndex,
    workItems,
    chat: {
      messages,
      toolBlocks: historyToolBlocks ?? (options.preserveRuntimeBlocks ? state.chat.toolBlocks : undefined),
      notices: historyNotices ?? (options.preserveRuntimeBlocks ? state.chat.notices : undefined),
      running: false
    },
    statusText: "会话历史已加载"
  };
  render();
}

async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || !gateway || state.connection !== "connected") return;

  const ensuredSessionKey = state.activeSessionId ?? (await createWorkFromGateway({ initialTitle: titleFromPromptText(trimmed), statusText: "正在创建新工作" }));
  if (!ensuredSessionKey) {
    state = {
      ...state,
      composerText: trimmed,
      chat: { ...state.chat, running: false, error: `无法创建 ${runtimeName()} 工作会话。` },
      statusText: "发送失败，输入已保留"
    };
    render();
    return;
  }

  const userMessage: TranscriptMessage = {
    id: `local-${Date.now()}`,
    role: "user",
    text: trimmed,
    status: "final"
  };
  const sessionKey = ensuredSessionKey;
  const sessions = applyHistoryTitle(sessionKey, [userMessage]);
  const workIndex = applyWorkTitleFromHistory(state.workIndex, sessionKey, [userMessage]);
  if (workIndex !== state.workIndex) saveWorkIndex(workIndex);
  const workItems = projectWorkItems({ workIndex, sessions, activeSessionKey: sessionKey });
  state = {
    ...state,
    composerText: "",
    sessions,
    workIndex,
    workItems,
    chat: { ...state.chat, running: true, messages: [...state.chat.messages, userMessage] },
    statusText: "chat.send 已发送"
  };
  render();

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
  saveCachedTitle(sessionId, title);
  return state.sessions.map((session) => (session.id === sessionId && session.title === UNTITLED_SESSION ? { ...session, title } : session));
}

function applyCachedTitles(sessions: SessionSummary[]): SessionSummary[] {
  const titleCache = readTitleCache();
  return sessions.map((session) => {
    if (session.title !== UNTITLED_SESSION) return session;
    const cachedTitle = titleCache[session.id] ?? (session.sessionId ? titleCache[session.sessionId] : undefined);
    return cachedTitle ? { ...session, title: cachedTitle } : session;
  });
}

function readTitleCache(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SESSION_TITLE_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveCachedTitle(sessionId: string, title: string): void {
  try {
    const titleCache = readTitleCache();
    titleCache[sessionId] = title;
    window.localStorage.setItem(SESSION_TITLE_CACHE_KEY, JSON.stringify(titleCache));
  } catch {
    // localStorage may be unavailable in hardened browser contexts; the in-memory title still works.
  }
}

function readWorkIndex(): WorkIndex {
  try {
    const raw = window.localStorage.getItem(WORK_INDEX_CACHE_KEY);
    return normalizeWorkIndex(raw ? JSON.parse(raw) : undefined);
  } catch {
    return normalizeWorkIndex(undefined);
  }
}

function saveWorkIndex(workIndex: WorkIndex): void {
  try {
    window.localStorage.setItem(WORK_INDEX_CACHE_KEY, JSON.stringify(workIndex));
  } catch {
    // The Gateway session still exists; persistence only affects the UI rail projection.
  }
}

function projectActiveWork(params: {
  sessions: SessionSummary[];
  workIndex: WorkIndex;
  activeWorkId?: string;
  activeSessionId?: string;
}): { workItems: WorkItem[]; activeWorkId?: string; activeSessionId?: string } {
  const workItems = projectWorkItems({
    workIndex: params.workIndex,
    sessions: params.sessions,
    activeSessionKey: params.activeSessionId
  });
  const current = workItems.find((work) => work.id === params.activeWorkId || work.targetSessionKey === params.activeSessionId);
  const activeWork = current ?? workItems[0];
  return {
    workItems,
    activeWorkId: activeWork?.id,
    activeSessionId: activeWork?.targetSessionKey
  };
}

function titleFromPromptText(text: string): string | undefined {
  return titleFromHistory([{ id: "prompt-title", role: "user", text, status: "final" }]);
}

async function abortRun(): Promise<void> {
  if (!gateway || !state.activeSessionId) return;
  await gateway.request("chat.abort", { sessionKey: state.activeSessionId }).catch(() => undefined);
  state = { ...state, chat: { ...state.chat, running: false }, statusText: "已请求停止当前运行" };
  render();
}

function render(): void {
  const activeWork = state.workItems.find((work) => work.id === state.activeWorkId);
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="session-rail" aria-label="工作列表">
        <div class="brand-row">
          <strong>We-Claw</strong>
          <span class="gateway-dot ${state.connection}"></span>
        </div>
        <button class="new-session" data-action="new-work" type="button" ${canCreateWork() ? "" : "disabled"} aria-busy="${state.isCreatingSession ? "true" : "false"}">${state.isCreatingSession ? "创建中..." : "+ 新工作"}</button>
        <div class="rail-heading">
          <span>工作</span>
          <button class="refresh-session ${state.isRefreshingSessions ? "refreshing" : ""}" type="button" aria-label="${state.isRefreshingSessions ? "正在刷新工作" : "刷新工作"}" title="${state.isRefreshingSessions ? "正在刷新工作" : "刷新工作"}" data-action="refresh" ${canRefreshSessions() ? "" : "disabled"} aria-busy="${state.isRefreshingSessions ? "true" : "false"}">↻</button>
        </div>
        <div class="session-list" data-testid="work-list">
          ${renderWorkItems()}
        </div>
        ${renderGatewaySessionsPanel()}
        <button class="settings-row" type="button">本地设置</button>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div class="title-block">
            <strong>${escapeHtml(activeWork?.title ?? `${runtimeName()} 工作台`)}</strong>
            <span>${escapeHtml(activeWork?.subtitle ?? `${runtimeTransportLabel()} · local workspace`)}</span>
          </div>
          <div class="top-actions">
            <span class="runtime-pill ${state.connection}"><i></i>${escapeHtml(labelForConnection(state.connection))}</span>
            <button type="button" aria-label="重新连接" data-action="reconnect">↻</button>
          </div>
        </header>
        <section class="conversation" data-testid="conversation" aria-label="工作内容">
          ${renderDiagnostics()}
          ${state.chat.messages.map(renderMessage).join("")}
          ${renderRuntimeBlocks()}
          ${state.chat.running ? `<article class="run-row"><span></span><p>${escapeHtml(runtimeName())} 正在处理当前请求</p></article>` : ""}
          ${state.chat.error ? `<article class="inline-error"><strong>运行失败</strong><p>${escapeHtml(state.chat.error)}</p></article>` : ""}
        </section>
        <form class="composer" data-testid="composer">
          <label class="sr-only" for="prompt">输入消息</label>
          <textarea id="prompt" rows="1" placeholder="输入 prompt，发送到当前工作" ${state.connection === "connected" ? "" : "disabled"}>${escapeHtml(state.composerText)}</textarea>
          <div class="composer-bar">
            <span>${escapeHtml(state.statusText)}</span>
            <button class="send" type="${state.chat.running ? "button" : "submit"}" data-action="${state.chat.running ? "abort" : "send"}" aria-label="${state.chat.running ? "停止" : "发送"}" ${canSubmit() ? "" : "disabled"}>${state.chat.running ? "■" : "↑"}</button>
          </div>
        </form>
        <footer class="statusbar">
          <span>${escapeHtml(state.bootstrap?.runtime.ownership ?? "none")} runtime</span>
          <span>${escapeHtml(state.bootstrap?.runtime.version ?? `${runtimeName()} 未确认`)}</span>
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
  appRoot.querySelectorAll<HTMLButtonElement>("[data-work-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const workId = button.dataset.workId;
      if (!workId) return;
      void openWorkItem(workId);
    });
  });
  appRoot.querySelectorAll<HTMLButtonElement>("[data-promote-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.promoteSessionId;
      if (!sessionId) return;
      void promoteGatewaySession(sessionId);
    });
  });
  appRoot.querySelector<HTMLButtonElement>("[data-action='refresh']")?.addEventListener("click", () => void refreshSessions());
  appRoot.querySelector<HTMLButtonElement>("[data-action='reconnect']")?.addEventListener("click", () => void bootstrap());
  appRoot.querySelector<HTMLButtonElement>("[data-action='abort']")?.addEventListener("click", () => void abortRun());
  appRoot.querySelector<HTMLButtonElement>("[data-action='new-work']")?.addEventListener("click", () => void createWork());
}

async function createWork(): Promise<void> {
  await createWorkFromGateway({ statusText: `正在创建 ${runtimeName()} 工作` });
}

async function createWorkFromGateway(options: { initialTitle?: string; statusText?: string } = {}): Promise<string | undefined> {
  if (!gateway || !canCreateWork()) return undefined;
  state = { ...state, isCreatingSession: true, statusText: options.statusText ?? `正在创建 ${runtimeName()} 工作` };
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
    const entry = createWorkIndexEntry({
      targetSessionKey: session.sessionKey,
      targetSessionId: session.sessionId,
      title: options.initialTitle,
      titleSource: options.initialTitle ? "first-message" : "fallback"
    });
    const workIndex: WorkIndex = { version: 1, items: [entry, ...state.workIndex.items] };
    saveWorkIndex(workIndex);
    const sessions = upsertSession(state.sessions, session);
    const workItems = projectWorkItems({ workIndex, sessions, activeSessionKey: session.sessionKey });
    state = {
      ...state,
      workIndex,
      workItems,
      sessions,
      activeWorkId: entry.id,
      activeSessionId: session.sessionKey,
      chat: { messages: [], running: false },
      isCreatingSession: false,
      statusText: "新工作已创建"
    };
    render();
    return session.sessionKey;
  } else {
    await loadSessions({ loadHistoryForActive: true });
    state = { ...state, isCreatingSession: false };
    render();
    return state.activeSessionId;
  }
}

async function refreshSessions(): Promise<void> {
  if (!gateway || !canRefreshSessions()) return;
  await loadSessions({ loadHistoryForActive: true, showRefreshing: true });
}

function upsertSession(sessions: SessionSummary[], nextSession: SessionSummary): SessionSummary[] {
  const existingIndex = sessions.findIndex((session) => session.id === nextSession.id);
  if (existingIndex === -1) return [nextSession, ...sessions];
  return [nextSession, ...sessions.slice(0, existingIndex), ...sessions.slice(existingIndex + 1)];
}

async function openWorkItem(workId: string): Promise<void> {
  const work = state.workItems.find((item) => item.id === workId);
  if (!work) return;
  const workIndex = markWorkItemOpened(ensureWorkIndexed(work), work.id);
  saveWorkIndex(workIndex);
  const workItems = projectWorkItems({ workIndex, sessions: state.sessions, activeSessionKey: work.targetSessionKey });
  state = { ...state, workIndex, workItems, activeWorkId: work.id, activeSessionId: work.targetSessionKey };
  render();
  await loadHistory(work.targetSessionKey);
}

async function promoteGatewaySession(sessionId: string): Promise<void> {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const workIndex = promoteSessionToWorkItem(state.workIndex, session);
  saveWorkIndex(workIndex);
  const workItems = projectWorkItems({ workIndex, sessions: state.sessions, activeSessionKey: session.sessionKey });
  const activeWork = workItems.find((work) => work.targetSessionKey === session.sessionKey);
  state = { ...state, workIndex, workItems, activeWorkId: activeWork?.id, activeSessionId: session.sessionKey };
  render();
  await loadHistory(session.sessionKey);
}

function ensureWorkIndexed(work: WorkItem): WorkIndex {
  if (state.workIndex.items.some((item) => item.id === work.id)) return state.workIndex;
  const session = state.sessions.find((item) => item.sessionKey === work.targetSessionKey);
  if (session) return promoteSessionToWorkItem(state.workIndex, session);
  return {
    version: 1,
    items: [
      createWorkIndexEntry({
        id: work.id,
        targetSessionKey: work.targetSessionKey,
        targetSessionId: work.targetSessionId,
        title: work.title,
        titleSource: work.titleSource,
        source: work.source,
        kind: work.kind
      }),
      ...state.workIndex.items
    ]
  };
}

function renderWorkItems(): string {
  if (!state.workItems.length) {
    return `<div class="empty-sessions">还没有工作</div>`;
  }
  return state.workItems
    .map(
      (work) => `
        <button class="session-row ${work.id === state.activeWorkId ? "active" : ""}" data-work-id="${escapeHtml(work.id)}" type="button">
          <span class="state-dot ${work.status ?? "unknown"}"></span>
          <span class="session-main">
            <strong>${escapeHtml(work.title)}</strong>
            <em>${escapeHtml(work.subtitle ?? `${runtimeName()} · local workspace`)}</em>
          </span>
          <time>${escapeHtml(formatRelativeTimestamp(work.lastOpenedAt ?? work.updatedAt))}</time>
        </button>
      `
    )
    .join("");
}

function renderGatewaySessionsPanel(): string {
  if (!state.sessions.length) {
    return `
      <details class="gateway-sessions-panel">
        <summary>运行时会话</summary>
        <div class="empty-sessions">暂无 runtime sessions</div>
      </details>
    `;
  }
  const rows = state.sessions
    .map(
      (session) => `
        <div class="gateway-session-row">
          <span class="state-dot ${session.status}"></span>
          <span class="session-main">
            <strong>${escapeHtml(session.title)}</strong>
            <em>${escapeHtml(session.sessionKey)}</em>
          </span>
          <button type="button" data-promote-session-id="${escapeHtml(session.id)}" title="加入工作">+</button>
        </div>
      `
    )
    .join("");
  return `
    <details class="gateway-sessions-panel">
      <summary>运行时会话</summary>
      <div class="gateway-session-list">${rows}</div>
    </details>
  `;
}

function renderDiagnostics(): string {
  const diagnostics = state.bootstrap?.diagnostics ?? [];
  if (!diagnostics.length && state.connection !== "disconnected" && state.connection !== "error") return "";
  const items = diagnostics.length
    ? diagnostics
    : [{ code: "runtime.disconnected", message: `本地 ${runtimeName()} 当前不可达。`, detail: state.statusText }];
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

function renderRuntimeBlocks(): string {
  const notices = state.chat.notices ?? [];
  const tools = state.chat.toolBlocks ?? [];
  return [...notices.map(renderNotice), ...tools.map(renderToolBlock)].join("");
}

function renderNotice(notice: ConversationNotice): string {
  return `
    <article class="runtime-notice ${notice.kind}" data-notice-id="${escapeHtml(notice.id)}">
      <span>${escapeHtml(noticeLabel(notice.kind))}</span>
      <p>${escapeHtml(notice.text)}</p>
    </article>
  `;
}

function renderToolBlock(tool: ToolBlock): string {
  const output = tool.output?.trim()
    ? `<details><summary>输出</summary><pre>${escapeHtml(tool.output)}</pre></details>`
    : "";
  const input = tool.input?.trim()
    ? `<details><summary>输入</summary><pre>${escapeHtml(tool.input)}</pre></details>`
    : "";
  return `
    <article class="tool-row ${tool.status}" data-tool-call-id="${escapeHtml(tool.toolCallId)}">
      <div class="tool-row-main">
        <span class="tool-status-dot ${tool.status}"></span>
        <strong>${escapeHtml(tool.name)}</strong>
        <em>${escapeHtml(toolStatusLabel(tool.status))}</em>
      </div>
      <p>${escapeHtml(tool.summary)}</p>
      ${input}
      ${output}
    </article>
  `;
}

function canSubmit(): boolean {
  if (state.chat.running) return state.connection === "connected";
  return state.connection === "connected";
}

function canCreateWork(): boolean {
  return state.connection === "connected" && !state.isCreatingSession && (gateway?.capabilities.methods.has("sessions.create") ?? false);
}

function canRefreshSessions(): boolean {
  return state.connection === "connected" && !state.isRefreshingSessions;
}

function runtimeName(): string {
  return state.bootstrap?.runtime.name ?? "Runtime";
}

function runtimeTransportLabel(): string {
  return state.bootstrap?.runtime.transport ?? "runtime";
}

function statusFromBootstrap(bootstrapResponse: BootstrapResponse): string {
  if (!bootstrapResponse.node.compatible) return "Node.js 版本不满足 OpenClaw 要求";
  if (!bootstrapResponse.runtime.available) return `${bootstrapResponse.runtime.name} 不可用`;
  if (!bootstrapResponse.runtime.reachable) return `${bootstrapResponse.runtime.name} 未运行或正在启动`;
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

function browserRuntimeUrl(bootstrapResponse: BootstrapResponse): string {
  if (bootstrapResponse.runtime.bridgePath) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${bootstrapResponse.runtime.bridgePath}`;
  }
  return bootstrapResponse.gateway.url;
}

function labelForConnection(connection: ConnectionState): string {
  return {
    starting: "Starting",
    connected: `${runtimeName()} Connected`,
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    error: `${runtimeName()} Error`
  }[connection];
}

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `we-claw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function statusFromChatSendResult(result: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const runId = typeof record.runId === "string" ? record.runId : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (runId && (status === "started" || status === "accepted" || status === "in_flight")) return `${runtimeName()} run ${runId.slice(0, 8)} 已启动`;
  return `${runtimeName()} 已返回消息`;
}

function statusFromChatEvent(event: unknown, fallback: string): string {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  if (record.state === "final") return `${runtimeName()} 已返回消息`;
  if (record.state === "error") return `${runtimeName()} 返回错误`;
  if (record.state === "aborted") return `${runtimeName()} 运行已停止`;
  return fallback;
}

function statusFromAgentEvent(event: unknown, fallback: string): string {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  const stream = typeof record.stream === "string" ? record.stream : undefined;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  if (stream === "tool" || typeof data.toolCallId === "string") {
    const name = typeof data.name === "string" ? data.name : "tool";
    const phase = typeof data.phase === "string" ? data.phase : "update";
    if (phase === "result") return `${name} 已完成`;
    if (phase === "start") return `${name} 正在运行`;
    return `${name} 已更新`;
  }
  if (stream === "lifecycle" && data.phase === "end") return `${runtimeName()} run 已完成`;
  if (stream === "lifecycle" && data.phase === "error") return `${runtimeName()} run 失败`;
  return fallback;
}

function sessionKeyFromEvent(event: unknown): string | undefined {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  return typeof record.sessionKey === "string" && record.sessionKey.trim() ? record.sessionKey.trim() : undefined;
}

function handleSessionMessageEvent(event: unknown): void {
  const sessionKey = sessionKeyFromEvent(event);
  void loadSessions();
  if (!sessionKey || sessionKey !== state.activeSessionId) return;
  if (state.chat.running) {
    pendingSessionMessageReloadSessionKey = sessionKey;
    return;
  }
  pendingSessionMessageReloadSessionKey = undefined;
  void loadHistory(sessionKey);
}

async function subscribeSessionMessages(sessionKey: string): Promise<void> {
  if (!gateway || subscribedSessionKey === sessionKey) return;
  const previous = subscribedSessionKey;
  if (previous) {
    await gateway.request("sessions.messages.unsubscribe", { key: previous }).catch(() => undefined);
  }
  await gateway
    .request("sessions.messages.subscribe", { key: sessionKey })
    .then(() => {
      subscribedSessionKey = sessionKey;
    })
    .catch(() => undefined);
}

function replayDeferredSessionMessageReload(chatEvent: unknown): void {
  const sessionKey = sessionKeyFromEvent(chatEvent);
  const record = chatEvent && typeof chatEvent === "object" ? (chatEvent as Record<string, unknown>) : {};
  if (!sessionKey || sessionKey !== pendingSessionMessageReloadSessionKey || sessionKey !== state.activeSessionId) return;
  if (record.state !== "final" && record.state !== "error" && record.state !== "aborted") return;
  pendingSessionMessageReloadSessionKey = undefined;
  void loadHistory(sessionKey, { preserveRuntimeBlocks: true });
}

function toolStatusLabel(status: ToolBlock["status"]): string {
  return {
    running: "running",
    updated: "updated",
    completed: "completed",
    error: "error"
  }[status];
}

function noticeLabel(kind: ConversationNotice["kind"]): string {
  return {
    runtime: "run",
    compaction: "compaction",
    fallback: "model",
    error: "error"
  }[kind];
}

function formatRelativeTimestamp(value?: number): string {
  if (!value) return "";
  return formatRelative(new Date(value).toISOString());
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
