export type ConnectionState = "starting" | "connected" | "reconnecting" | "disconnected" | "error";

export type RuntimeKind = "openclaw" | "hermes" | "claude-agent-sdk" | "cli-process";
export type RuntimeTransport = "gateway-ws" | "stdio-jsonrpc" | "library-sdk" | "cli-process";
export type RuntimeOwnership = "external" | "managed" | "none";
export type RuntimeProcessState = "not-started" | "starting" | "running" | "external" | "failed";
export type RuntimeSelectionSource = "env" | "settings" | "default";

export interface RuntimeCapabilities {
  sessions: boolean;
  sessionList: boolean;
  resume: boolean;
  fork: boolean;
  stream: boolean;
  abort: boolean;
  approvals: boolean;
  toolEvents: boolean;
  mcp: boolean;
  hooks: boolean;
}

export interface RuntimeBootstrap {
  kind: RuntimeKind;
  transport: RuntimeTransport;
  name: string;
  available: boolean;
  version?: string;
  bridgePath: string;
  capabilities: RuntimeCapabilities;
  reachable: boolean;
  ready: boolean;
  ownership: RuntimeOwnership;
  processState: RuntimeProcessState;
  error?: string;
}

export interface RuntimeOption {
  kind: RuntimeKind;
  name: string;
  transport: RuntimeTransport;
  available: boolean;
  configured: boolean;
  version?: string;
  detail?: string;
}

export interface RuntimeSelection {
  current: RuntimeKind;
  configured: RuntimeKind;
  source: RuntimeSelectionSource;
  locked: boolean;
  settingsPath: string;
  options: RuntimeOption[];
  claudeSdk: {
    cwd: string;
    permissionMode: string;
    allowedTools: string[];
    model?: string;
  };
  hermes?: {
    configured: boolean;
    root?: string;
    cwd: string;
    startupTimeoutMs: number;
  };
}

export interface BootstrapDiagnostics {
  code: string;
  message: string;
  detail?: string;
}

export interface BootstrapResponse {
  node: {
    version: string;
    compatible: boolean;
    required: string;
  };
  openclaw: {
    available: boolean;
    version?: string;
    executable?: string;
    error?: string;
  };
  gateway: {
    url: string;
    httpUrl: string;
    port: number;
    bridgePath?: string;
    bridgeAuthReady?: boolean;
    ownership: RuntimeOwnership;
    reachable: boolean;
    ready: boolean;
    processState: RuntimeProcessState;
    error?: string;
  };
  runtime: RuntimeBootstrap;
  runtimeSelection?: RuntimeSelection;
  diagnostics: BootstrapDiagnostics[];
}

export interface GatewayFrame {
  type: string;
  id?: string | number;
  method?: string;
  event?: string;
  payload?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
  data?: unknown;
}

export interface GatewayCapabilities {
  methods: Set<string>;
}

export type SessionStatus = "running" | "idle" | "error" | "unknown";

export interface SessionSummary {
  id: string;
  sessionKey: string;
  sessionId?: string;
  title: string;
  subtitle: string;
  updatedAt?: string;
  status: SessionStatus;
}

export type WorkItemSource = "we-claw" | "gateway" | "channel" | "runtime";
export type WorkItemKind = "task" | "conversation" | "run";
export type WorkItemTitleSource = "user" | "first-message" | "gateway" | "manual" | "fallback";

export interface WorkItem {
  id: string;
  title: string;
  titleSource: WorkItemTitleSource;
  subtitle?: string;
  targetSessionKey: string;
  targetSessionId?: string;
  source: WorkItemSource;
  kind: WorkItemKind;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  pinned?: boolean;
  hidden?: boolean;
  running?: boolean;
  status?: SessionStatus;
}

export interface WorkIndexEntry {
  id: string;
  targetSessionKey: string;
  targetSessionId?: string;
  title?: string;
  titleSource?: WorkItemTitleSource;
  source: WorkItemSource;
  kind: WorkItemKind;
  createdAt: number;
  lastOpenedAt?: number;
  pinned?: boolean;
  hidden?: boolean;
}

export interface WorkIndex {
  version: 1;
  items: WorkIndexEntry[];
}

export type MessageRole = "user" | "assistant" | "system" | "error";

export interface TranscriptMessage {
  id: string;
  role: MessageRole;
  text: string;
  status?: "running" | "final" | "error" | "aborted";
  timestamp?: string;
}

export type ToolBlockStatus = "running" | "updated" | "completed" | "error";

export interface ToolBlock {
  id: string;
  toolCallId: string;
  runId?: string;
  sessionKey?: string;
  name: string;
  status: ToolBlockStatus;
  summary: string;
  input?: string;
  output?: string;
  startedAt?: number;
  updatedAt?: number;
}

export type ConversationNoticeKind = "runtime" | "compaction" | "fallback" | "error";

export interface ConversationNotice {
  id: string;
  kind: ConversationNoticeKind;
  text: string;
  timestamp: number;
  runId?: string;
}

export interface ChatState {
  messages: TranscriptMessage[];
  toolBlocks?: ToolBlock[];
  notices?: ConversationNotice[];
  running: boolean;
  error?: string;
}
