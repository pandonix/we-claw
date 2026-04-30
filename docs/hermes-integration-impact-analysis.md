# Multi-Runtime Integration Impact Analysis

本文分析在尽量保持当前 We-Claw 前端交付形态不变的情况下，除了打通 OpenClaw 通讯外，再对接 `codespace/hermes-agent`、Claude Agent SDK，以及 Claude Code 类 CLI runtime 时需要做的改造。

结论：改造重点不应放在重做 UI，而应放在 Node launcher、runtime adapter、bridge、协议 client 和 normalizer 上。当前前端已经是一个相对薄的工作台，主要依赖会话列表、历史、发送、停止、事件流这些抽象能力；OpenClaw、Hermes、Claude Agent SDK 和 CLI runtime 都能提供其中一部分能力，但 transport、事件形态、session 语义、审批模型和可中断性不同。因此应新增 runtime adapter 层，把不同 runtime 统一成 We-Claw 内部的最小运行时接口，并通过 capability 明确降级。

## 当前 We-Claw 形态

当前项目是 Vite + TypeScript + thin Node launcher：

- `src/app/main.ts` 负责桌面工作台 UI：session rail、conversation、composer、statusbar。
- `src/launcher/server.ts` 负责本地 HTTP 服务、静态文件、`/api/bootstrap`。
- `src/launcher/gateway-bridge.ts` 负责浏览器到 OpenClaw Gateway 的 WebSocket bridge，并在 Node 侧注入 OpenClaw auth/device 信息。
- `src/gateway/client.ts` 是浏览器侧 OpenClaw Gateway RPC client。
- `src/shared/normalizers.ts` 把 session/history/chat event 归一化成 UI 可消费的数据。

当前前端主要调用：

- `sessions.list`
- `sessions.create`
- `chat.history`
- `chat.send`
- `chat.abort`
- `health`

这说明前端的业务面很窄，适合保留 UI，通过 adapter 扩展 runtime。

## Runtime 类型分层

不应把所有 runtime 都当作 Gateway。更准确的抽象是先区分 transport，再区分 capability：

```ts
type RuntimeKind = "openclaw" | "hermes" | "claude-agent-sdk" | "cli-process";

type RuntimeTransport =
  | "gateway-ws"
  | "stdio-jsonrpc"
  | "library-sdk"
  | "cli-process";

interface RuntimeCapabilities {
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
```

推荐路径：

| Runtime | 推荐 transport | 优先级 | 说明 |
| --- | --- | --- | --- |
| OpenClaw | `gateway-ws` | v1 默认 | 继续使用 OpenClaw Gateway 作为事实来源。 |
| Hermes | `stdio-jsonrpc` | 显式启用 | 使用 Hermes TUI Gateway，不嵌入 Dashboard。 |
| Claude Agent SDK | `library-sdk` | Claude runtime 首选 | 用 `@anthropic-ai/claude-agent-sdk` 或 Python SDK 作为库集成。 |
| Claude Code 类 CLI / `claw-code` | `cli-process` | fallback/实验 | 只在 SDK 不适用或目标明确是 CLI 兼容时使用。 |

## Hermes 可对接面

`codespace/hermes-agent` 里最相关的接口是 `tui_gateway`，不是 Hermes Dashboard 的 React 页面。

Hermes TUI 架构证据：

- `hermes-agent/AGENTS.md` 说明 TUI 是 `Node (Ink) -> stdio JSON-RPC -> Python (tui_gateway)`。
- TypeScript 负责屏幕，Python 负责 sessions、tools、model calls、slash command logic。
- `ui-tui/src/gatewayClient.ts` 通过 `python -m tui_gateway.entry` 启动 Python 子进程，并用 JSON-RPC over stdio 收发消息。
- `tui_gateway/ws.py` 也提供与 stdio wire-compatible 的 WebSocket handler，但 Hermes Dashboard 的 `/api/ws` 被 token 与 embedded chat flag gate 住。

Hermes 的核心方法名与 OpenClaw 不同：

| UI 需要的语义 | OpenClaw 当前调用 | Hermes 对应方法 |
| --- | --- | --- |
| 创建会话 | `sessions.create` | `session.create` |
| 会话列表 | `sessions.list` | `session.list` |
| 恢复会话 | 当前未显式建模 | `session.resume` |
| 历史记录 | `chat.history` | `session.history` |
| 发送 prompt | `chat.send` | `prompt.submit` |
| 停止/中断 | `chat.abort` | `session.interrupt` |

Hermes 的事件也不同：

- `message.start`
- `message.delta`
- `message.complete`
- `error`
- `status.update`
- `tool.start`
- `tool.progress`
- `tool.complete`
- `approval.request`
- `clarify.request`
- `sudo.request`
- `secret.request`

当前 UI 首期可以只消费 message/error/status 类事件，tool/approval/clarify 等先作为后续增强或降级为状态提示。

## Claude Agent SDK 可对接面

如果目标是接入 Claude Code 能力，优先考虑 Claude Agent SDK，而不是直接包 Claude Code CLI。官方文档把 Agent SDK 定位为把 Claude Code 的 agent loop、上下文管理和内置工具以 Python/TypeScript 库形式暴露出来；TypeScript SDK 还通过 optional dependency 捆绑本机 Claude Code binary，不要求用户另行安装 Claude Code。

Claude Agent SDK 的重要能力：

- `query()` 返回 async iterable，可由 Node adapter 转成 We-Claw 内部事件。
- 支持内置工具：`Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`、`WebSearch`、`WebFetch`、`AskUserQuestion` 等。
- 支持 hooks、subagents、MCP、permissions、sessions、checkpointing、usage/cost、OpenTelemetry。
- 支持 `includePartialMessages` / `include_partial_messages`，输出 raw Claude API stream events。
- 支持 session resume、continue 和 fork；session 是本地 JSONL conversation history，不是 filesystem snapshot。
- 支持 permission callback / `canUseTool`，适合映射成 We-Claw inline approval。

Claude Agent SDK 的关键限制：

- SDK 认证应使用 API key 或受支持的云供应商认证；不要设计成复用 claude.ai 登录或 Claude Code 订阅额度。
- Session resume 对 `cwd` 敏感；默认 session 文件在 `~/.claude/projects/<encoded-cwd>/*.jsonl` 下。跨机器恢复需要迁移 session 文件或用应用状态重建上下文。
- TypeScript V2 preview 的 `createSession()` / `resumeSession()` 接口更贴近 We-Claw 的 `send` / `stream` 形态，但当前仍是不稳定 preview。首期应基于稳定 V1 `query()` 封装，再保留未来切换 V2 的 adapter 边界。
- 官方 branding 不建议把第三方产品表现成 Claude Code 或 Anthropic 产品；UI 中应使用 `Claude Agent SDK` 或 `Claude Agent`，避免 `Claude Code Agent`。

Claude Agent SDK 对 We-Claw 的内部方法映射建议：

| UI 需要的语义 | Claude Agent SDK 对应能力 |
| --- | --- |
| 创建会话 | 首次 `query()` 或 V2 `createSession()`；从 init/result message 捕获 `session_id` |
| 会话列表 | SDK session utilities：`listSessions()` / `list_sessions()` |
| 恢复会话 | `resume: sessionId` |
| 继续最近会话 | `continue: true` / `continue_conversation=True` |
| fork 会话 | `forkSession` / `fork_session` |
| 历史记录 | `getSessionMessages()` / `get_session_messages()` |
| 发送 prompt | `query({ prompt, options })` 或 V2 `session.send()` |
| 流式输出 | `includePartialMessages` 后消费 `stream_event` |
| 审批 | `canUseTool` callback / permission callback |
| 停止/中断 | adapter 取消当前 async iterator / abort controller；需验证 SDK 当前版本的取消语义 |

Claude stream event normalizer 需要处理：

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`
- 完整 `assistant` message
- `result` message
- compact boundary message
- subagent message 的 `parent_tool_use_id`

其中 `content_block_delta` 需要按 block 累积 text delta 或 tool input delta；不能假设每个 SDK message 都是完整可渲染消息。

## Claude Code 类 CLI / claw-code fallback

`../claw-code` 当前源码证据显示，主 runtime 边界是 Rust `claw` CLI，而不是稳定 daemon/RPC 服务。它支持 interactive REPL、one-shot prompt、`--output-format json`、`--resume`、`.claw/sessions/<workspace_hash>/*.jsonl` session store、permission modes 和 allowed tools。它也有内部 Rust `AssistantEvent`，但这不是外部 wire protocol。

因此 CLI fallback 不应作为 Claude runtime 的首选路径。它适合以下场景：

- 验证与 Claude Code 类命令行体验的兼容性。
- 在 SDK 不可用时跑一次性 prompt。
- 读取 CLI 自己持久化的 session 文件作为 transcript。
- 用 managed subprocess 执行受控任务，并在进程退出后做状态 reconciliation。

CLI fallback 的限制：

- `stream` 只能通过 stdout/stderr 或最终 JSON 输出近似得到；不应把文本解析伪装成稳定事件协议。
- `abort` 只能安全终止 We-Claw 自己启动的 child process，不能杀用户外部 CLI 进程。
- permission approval 往往走 stdin prompt，容易阻塞 Node bridge；首期应通过 permission mode / allowed tools 限制，而不是做 inline approval。
- session 与 cwd/workspace 绑定；session rail 必须按 runtime + workspace 分组。

## 推荐目标架构

保留当前前端布局和交付物，把 Gateway 改造成更中性的 Runtime 概念：

```text
Browser UI
  -> /api/bootstrap
  -> /api/runtime/ws
Node launcher
  -> OpenClawRuntimeAdapter         -> OpenClaw Gateway WebSocket
  -> HermesRuntimeAdapter           -> python -m tui_gateway.entry JSON-RPC stdio
  -> ClaudeAgentSdkRuntimeAdapter   -> @anthropic-ai/claude-agent-sdk
  -> CliProcessRuntimeAdapter       -> managed CLI subprocess fallback
```

内部 adapter 提供统一能力：

```ts
interface AgentRuntimeAdapter {
  kind: RuntimeKind;
  transport: RuntimeTransport;
  capabilities: RuntimeCapabilities;
  status(): Promise<RuntimeStatus>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSummary>;
  loadHistory(sessionId: string): Promise<TranscriptMessage[]>;
  sendPrompt(sessionId: string | undefined, text: string): Promise<void>;
  abort(sessionId: string | undefined): Promise<void>;
  close(): Promise<void>;
}
```

前端可以继续保持现在的 session rail、conversation、composer，只需要把文案从固定 `OpenClaw Gateway` 改为 runtime-aware，并根据 `capabilities` 隐藏或降级 unsupported 控件。

## 必要改造

### 1. Bootstrap 类型改造

当前 `BootstrapResponse` 里有强 OpenClaw 结构：

- `openclaw`
- `gateway`

建议新增中性结构：

```ts
runtime: {
  kind: "openclaw" | "hermes" | "claude-agent-sdk" | "cli-process";
  transport: "gateway-ws" | "stdio-jsonrpc" | "library-sdk" | "cli-process";
  name: string;
  available: boolean;
  version?: string;
  bridgePath: string;
  capabilities: RuntimeCapabilities;
  reachable: boolean;
  ready: boolean;
  ownership: "external" | "managed" | "none";
  processState: "not-started" | "starting" | "running" | "external" | "failed";
  error?: string;
}
```

为了减少一次性破坏，可短期保留 `openclaw` 和 `gateway` 字段，新增 `runtime` 字段供新代码使用。

### 2. Runtime 选择配置

新增配置项：

- `WE_CLAW_RUNTIME=openclaw|hermes|claude-agent-sdk|cli-process|auto`
- `WE_CLAW_HERMES_PYTHON`
- `WE_CLAW_HERMES_ROOT`
- `WE_CLAW_HERMES_CWD`
- 可选：`WE_CLAW_HERMES_STARTUP_TIMEOUT_MS`
- `WE_CLAW_CLAUDE_SDK_PROVIDER=typescript|python`
- `WE_CLAW_CLAUDE_SDK_CWD`
- `WE_CLAW_CLAUDE_SDK_PERMISSION_MODE`
- `WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS`
- `WE_CLAW_CLAUDE_SDK_MODEL`
- `WE_CLAW_CLI_BIN`
- `WE_CLAW_CLI_CWD`
- `WE_CLAW_CLI_TIMEOUT_MS`
- `WE_CLAW_CLI_PERMISSION_MODE`
- `WE_CLAW_CLI_ALLOWED_TOOLS`

`auto` 模式需要明确优先级。建议初期默认 `openclaw`，显式配置 `hermes` 或 `claude-agent-sdk` 时才切换 runtime，避免当前 OpenClaw v1 交付行为漂移。`cli-process` 不应进入默认 auto 优先级，只作为显式 fallback。

### 3. Node launcher 增加 Hermes 管理

Hermes 最小可行对接建议走 stdio subprocess：

```text
python -m tui_gateway.entry
```

原因：

- 与 Hermes TUI 已验证路径一致。
- 不需要启动 Hermes Dashboard/FastAPI。
- 不需要处理 Dashboard session token。
- 不需要把 We-Claw 绑定到 Hermes Dashboard 的 embedded chat 开关。

Node 需要负责：

- 解析 Hermes 源码根目录。
- 设置 `PYTHONPATH`。
- 选择 Python executable。
- 启动/重启 `tui_gateway.entry`。
- 读取 stdout JSON-RPC line。
- 读取 stderr 并转为 launcher diagnostics。
- 在 We-Claw 关闭时终止子进程。

### 4. Node launcher 增加 Claude Agent SDK 管理

Claude Agent SDK 最小可行对接建议优先走 TypeScript SDK：

```text
@anthropic-ai/claude-agent-sdk
```

原因：

- 当前 We-Claw launcher 是 Node/TypeScript，TypeScript SDK 能直接在 Node adapter 内调用。
- SDK 已暴露 agent loop、内置工具、session、stream、permission callback 等核心能力。
- 相比 CLI subprocess，SDK 更适合做可观察、可审批、可恢复的本地工作台 runtime。

Node 需要负责：

- 检测 SDK package 是否安装以及版本。
- 检测认证状态，但不把 API key 或 token 返回给 browser。
- 为每个 active session 管理当前 async iterator / cancellation handle。
- 把 SDK message 转成 We-Claw 内部 event frame。
- 用 SDK session utilities 实现 list/history/rename/tag 等后续能力。
- 用 permission callback 把 tool approval 转成 We-Claw inline approval request。
- 记录 SDK stderr/diagnostics 并 redaction。

### 5. WebSocket bridge 改造

当前 `gateway-bridge.ts` 是 OpenClaw 专用，并且会注入 OpenClaw token/device auth。

建议新增中性 route：

- 保留 `/api/gateway/ws` 给 OpenClaw 兼容。
- 新增 `/api/runtime/ws` 作为 UI 默认连接点。

`/api/runtime/ws` 根据 runtime kind 分发：

- OpenClaw：复用现有 bridge 逻辑。
- Hermes：浏览器发来的统一 We-Claw request，由 Node 转成 Hermes JSON-RPC；Node 再把 Hermes event 转成统一 event frame 推给浏览器。
- Claude Agent SDK：浏览器发来的统一 We-Claw request，由 Node 调用 SDK；SDK async messages 被转成统一 event frame。
- CLI process：浏览器发来的统一 We-Claw request，由 Node 启动/管理 subprocess；stdout/stderr/final JSON 被转成降级事件。

这样前端不需要知道 OpenClaw Gateway frame、Hermes JSON-RPC、Claude SDK message object 或 CLI stdout 的差异。

### 6. Client 与 normalizer 改造

当前 `GatewayClient` 使用 OpenClaw frame：

```json
{ "type": "req", "id": "...", "method": "...", "params": {} }
```

Hermes 使用 JSON-RPC：

```json
{ "jsonrpc": "2.0", "id": "...", "method": "...", "params": {} }
```

Claude Agent SDK 使用库返回的 typed/structured message，不使用 WebSocket 或 JSON-RPC。CLI fallback 使用进程 stdout/stderr 和退出码。

为了让 UI 尽量不变，建议让浏览器继续只使用一个 We-Claw 内部协议：

```json
{ "type": "req", "id": "...", "method": "sessions.list", "params": {} }
```

Node Hermes adapter 负责翻译：

- `sessions.list` -> `session.list`
- `sessions.create` -> `session.create`
- `chat.history` -> `session.history` 或 `session.resume` + `session.history`
- `chat.send` -> `prompt.submit`
- `chat.abort` -> `session.interrupt`

Node Claude Agent SDK adapter 负责翻译：

- `sessions.list` -> `listSessions()` / `list_sessions()`
- `sessions.create` -> 首次 `query()` 建立并捕获 `session_id`，或 V2 `createSession()`
- `chat.history` -> `getSessionMessages()` / `get_session_messages()`
- `chat.send` -> `query({ prompt, options: { resume, includePartialMessages: true } })`
- `chat.abort` -> 取消当前 SDK run；若当前 SDK 版本取消语义不足，降级为 “stop requested” 并等待 run 收敛
- `session.fork` -> `forkSession` / `fork_session`

Node CLI adapter 负责翻译：

- `sessions.list` -> 枚举 CLI session store 或调用 CLI 支持的 session list 命令
- `chat.history` -> 读取 session JSONL
- `chat.send` -> 启动 managed subprocess one-shot prompt
- `chat.abort` -> 终止 We-Claw 启动的 subprocess
- `approvals` -> 首期 unsupported；通过 permission mode / allowed tools 降低阻塞风险

`normalizers.ts` 需要扩展 Hermes 数据：

- `session.list` 返回 `sessions[].id/title/preview/started_at/message_count/source`。
- `session.resume` 返回 `session_id/resumed/messages/info`。
- `session.history` 返回 `messages[]`。
- `message.delta` 追加到 running assistant message。
- `message.complete` finalize assistant message。
- `error` 生成 error message。
- `status.update` 更新 status text 或轻量 inline row。

`normalizers.ts` 也需要扩展 Claude SDK 数据：

- `stream_event.content_block_delta.delta.text` 追加到 running assistant message。
- `content_block_start/stop` 维护 block 生命周期。
- tool use block 映射为 compact tool row。
- `result` message finalize run，记录 cost/usage/session id。
- `SystemMessage init` 提取 `session_id`。
- compact boundary 生成 low-emphasis runtime notice。
- `parent_tool_use_id` 标记 subagent 输出来源。

### 7. Session id 映射

这是 Hermes 对接的主要复杂点。

Hermes 有两类 session id：

- 持久 session key：来自 `session.list` 的 `id`，用于数据库历史。
- 活跃 runtime session id：`session.create` 或 `session.resume` 返回的短 id，用于 `prompt.submit`、`session.history`、`session.interrupt`。

We-Claw adapter 需要维护映射：

```ts
persistedSessionId -> activeHermesSessionId
```

当用户点击历史会话时：

1. 如果没有 active mapping，先调用 `session.resume`。
2. 用返回的 active `session_id` 作为后续 prompt/interrupt/history 的目标。
3. UI rail 仍展示持久 session id 和 title。

Claude Agent SDK 的 session 语义不同：

- SDK session id 来自 init/result message。
- session 默认持久化到 `~/.claude/projects/<encoded-cwd>/*.jsonl`。
- `resume` 要求相同 cwd 和本机 session 文件存在。
- `continue` 恢复当前 cwd 下最新 session，不适合多 session rail 精准切换。
- fork 会产生新的 session id，但 filesystem edits 不是隔离的。

因此 We-Claw 需要维护：

```ts
runtimeKind + cwd + sessionId -> SessionSummary
```

而不是只维护裸 `sessionId`。session rail 也应按 runtime 和 workspace/cwd 分组，避免 OpenClaw/Hermes/Claude session id 冲突。

### 8. UI 文案最小调整

为了保持前端交付不变，UI 结构不改，只调整文案来源：

- `OpenClaw 会话工作台` -> `${runtime.name} 会话工作台`
- `Gateway Sessions` -> `Sessions`
- `OpenClaw 正在处理当前请求` -> `${runtime.name} 正在处理当前请求`
- statusbar 显示 `${runtime.kind}`、version、ownership。
- runtime selector 中 Claude 相关文案使用 `Claude Agent SDK` 或 `Claude Agent`，避免 `Claude Code Agent`。

不要引入 Hermes Dashboard 的全套导航、配置页、插件页、cron 页，否则会改变当前产品交付形态。

## 不建议的路径

### 不建议直接嵌入 Hermes Dashboard

Hermes Dashboard 是 FastAPI + React 管理面，包含 config、keys、logs、cron、skills、plugins、chat 等多页面。直接嵌入会显著改变当前 We-Claw 的工作台形态。

### 不建议重写 Hermes TUI 主聊天体验

Hermes 自身文档明确：Dashboard 的主 chat 体验嵌入真实 `hermes --tui`，不要在 React 里重写 transcript/composer。We-Claw 如果要保持自己的前端，就应把 Hermes 作为 runtime adapter，而不是复制 Hermes Dashboard 的 UI 设计。

### 不建议把 OpenClaw 与 Hermes 逻辑散落在 UI 中

如果在 `src/app/main.ts` 里直接写 `if runtime === "hermes"`、`if runtime === "claude"` 分支，会很快污染 UI。runtime 差异应限制在 Node adapter、client、normalizer。

### 不建议把 Claude Code CLI 作为主集成路径

Claude Code 类 CLI 适合人工交互和一次性命令，但 We-Claw 需要可观察、可审批、可恢复的本地工作台。Claude Agent SDK 已经提供库接口和 session/stream/approval 能力，因此 CLI subprocess 只应作为 fallback 或兼容实验。

## 推荐实施顺序

1. 新增 runtime 类型与配置，但默认仍走 OpenClaw。
2. 新增 `/api/runtime/ws`，OpenClaw runtime 先复用现有 bridge，确保当前行为不变。
3. 把前端从 `/api/gateway/ws` 切到 `/api/runtime/ws`。
4. 提取 OpenClaw adapter，保持原有方法和测试通过。
5. 新增 runtime capability 模型，UI 先按 capability 控制 create/send/stop/approval/tool rows。
6. 新增 Hermes stdio JSON-RPC client，只实现 `session.create/list/resume/history`、`prompt.submit`、`session.interrupt`。
7. 新增 Hermes event normalizer，只支持 message/error/status 基础流。
8. 新增 Claude Agent SDK adapter，只实现 `sessions.list/history`、`chat.send`、stream delta、result finalize、resume。
9. 加 session id + runtime + cwd 映射。
10. 手动验证 Hermes 真实生命周期：创建会话、发送 prompt、流式输出、刷新历史、切换历史会话、中断。
11. 手动验证 Claude Agent SDK 生命周期：发送 prompt、捕获 session id、resume、流式 delta、approval callback、history 读取。
12. 再考虑 tool activity、approval、clarify、slash completion、image attach、fork、subagent 等特有能力。

## 验证要求

最小验证：

- `npm run typecheck`
- `npm test`
- `npm run build`
- OpenClaw runtime 下现有 UI 行为不回退。
- Hermes runtime 下能完成 create/list/send/stream/history/interrupt。
- Claude Agent SDK runtime 下能完成 send/stream/result/session capture/resume/history。

Hermes 手动验证建议：

- 使用 `WE_CLAW_RUNTIME=hermes` 启动。
- 创建新会话。
- 发送简单 prompt。
- 看到 `message.delta` 或 `message.complete` 显示到 conversation。
- 刷新 session list。
- 切换到历史 session 并能恢复消息。
- 中断长任务，UI running 状态能结束。

Claude Agent SDK 手动验证建议：

- 使用 `WE_CLAW_RUNTIME=claude-agent-sdk` 启动。
- 发送只读 prompt，限制 `allowedTools=["Read","Glob","Grep"]`。
- 看到 `content_block_delta` 累积为 assistant 文本。
- 从 init/result message 捕获 session id。
- 使用同一 session id resume 后发送 follow-up。
- 触发一个需要审批的 tool request，确认 inline approval 能 allow/deny。
- 刷新 session list/history，确认 cwd 对应的 session 能恢复。

## 风险与未知

- Hermes `tui_gateway` 是内部 TUI 协议，当前源码证据显示可用，但不能确认它是长期稳定 public API。
- Hermes session id 有持久 id 与活跃 id 双层语义，adapter 如果处理不好，会导致历史能列出但不能继续发送。
- Hermes tool/approval/clarify 事件比当前 We-Claw UI 丰富，首期需要明确降级策略。
- Claude Agent SDK 版本变化会影响 TypeScript/Python API，尤其是 V2 preview；adapter 需要把 SDK 调用限制在单独模块。
- Claude Agent SDK session resume 对 cwd 和本机 session 文件敏感；如果 cwd 不一致，resume 可能变成新上下文。
- Claude Agent SDK 使用 API key 或受支持云供应商认证；不能把 claude.ai 登录或订阅额度设计成产品能力。
- CLI fallback 的 stdout/stderr 不是稳定事件协议，不能承诺与 Gateway/SDK 等价的 streaming 和 approval 能力。
- 如果产品要求 OpenClaw、Hermes、Claude 同屏同时连接，而不是二选一 runtime，session rail 需要增加 runtime 分组，UI 改动会变大。
- 如果必须走 Hermes Dashboard `/api/ws`，则还要处理 FastAPI server、ephemeral session token、embedded chat flag 和 dashboard 生命周期，复杂度高于 stdio adapter。

## 总体判断

在保持当前前端交付尽可能不变的目标下，最小合理改造是：

1. 引入 runtime adapter 抽象。
2. 保留现有 UI 结构。
3. OpenClaw 保持现有 Gateway bridge。
4. Hermes 通过 Node 管理 `tui_gateway.entry`，做 JSON-RPC 到 We-Claw 内部会话/聊天语义的转换。
5. Claude 通过 Claude Agent SDK 做库级集成，优先于 CLI subprocess。
6. CLI subprocess 只作为 fallback 或兼容实验。
7. 把 runtime 差异限制在 launcher、bridge、client、normalizer，避免进入 UI 组件层。

## 参考资料

- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Claude Agent SDK streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Claude Agent SDK approvals/user input: https://code.claude.com/docs/en/agent-sdk/user-input
- Claude Agent SDK TypeScript V2 preview: https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview
