export type ConnectionState = "starting" | "connected" | "reconnecting" | "disconnected" | "error";

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
    ownership: "external" | "managed" | "none";
    reachable: boolean;
    ready: boolean;
    processState: "not-started" | "starting" | "running" | "external" | "failed";
    error?: string;
  };
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
