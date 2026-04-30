# Hermes Integration Impact Analysis

本文分析在尽量保持当前 We-Claw 前端交付形态不变的情况下，除了打通 OpenClaw 通讯外，再对接 `codespace/hermes-agent` 需要做的改造。

结论：改造重点不应放在重做 UI，而应放在 Node launcher、bridge、协议 client 和 normalizer 上。当前前端已经是一个相对薄的工作台，主要依赖会话列表、历史、发送、停止、事件流这些抽象能力；OpenClaw 与 Hermes 都能提供类似能力，但协议、方法名、事件形态和 session 语义不同。因此应新增 runtime adapter 层，把 OpenClaw Gateway 与 Hermes TUI Gateway 统一成 We-Claw 内部的最小运行时接口。

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

## 推荐目标架构

保留当前前端布局和交付物，把 Gateway 改造成更中性的 Runtime 概念：

```text
Browser UI
  -> /api/bootstrap
  -> /api/runtime/ws
Node launcher
  -> OpenClawRuntimeAdapter -> OpenClaw Gateway WebSocket
  -> HermesRuntimeAdapter   -> python -m tui_gateway.entry JSON-RPC stdio
```

内部 adapter 提供统一能力：

```ts
interface AgentRuntimeAdapter {
  kind: "openclaw" | "hermes";
  status(): Promise<RuntimeStatus>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSummary>;
  loadHistory(sessionId: string): Promise<TranscriptMessage[]>;
  sendPrompt(sessionId: string | undefined, text: string): Promise<void>;
  abort(sessionId: string | undefined): Promise<void>;
  close(): Promise<void>;
}
```

前端可以继续保持现在的 session rail、conversation、composer，只需要把文案从固定 `OpenClaw Gateway` 改为 runtime-aware。

## 必要改造

### 1. Bootstrap 类型改造

当前 `BootstrapResponse` 里有强 OpenClaw 结构：

- `openclaw`
- `gateway`

建议新增中性结构：

```ts
runtime: {
  kind: "openclaw" | "hermes";
  name: string;
  available: boolean;
  version?: string;
  bridgePath: string;
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

- `WE_CLAW_RUNTIME=openclaw|hermes|auto`
- `WE_CLAW_HERMES_PYTHON`
- `WE_CLAW_HERMES_ROOT`
- `WE_CLAW_HERMES_CWD`
- 可选：`WE_CLAW_HERMES_STARTUP_TIMEOUT_MS`

`auto` 模式需要明确优先级。建议初期默认 `openclaw`，显式配置 `hermes` 时才走 Hermes，避免当前 OpenClaw v1 交付行为漂移。

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

### 4. WebSocket bridge 改造

当前 `gateway-bridge.ts` 是 OpenClaw 专用，并且会注入 OpenClaw token/device auth。

建议新增中性 route：

- 保留 `/api/gateway/ws` 给 OpenClaw 兼容。
- 新增 `/api/runtime/ws` 作为 UI 默认连接点。

`/api/runtime/ws` 根据 runtime kind 分发：

- OpenClaw：复用现有 bridge 逻辑。
- Hermes：浏览器发来的统一 We-Claw request，由 Node 转成 Hermes JSON-RPC；Node 再把 Hermes event 转成统一 event frame 推给浏览器。

这样前端不需要知道 Hermes 的 JSON-RPC framing。

### 5. Client 与 normalizer 改造

当前 `GatewayClient` 使用 OpenClaw frame：

```json
{ "type": "req", "id": "...", "method": "...", "params": {} }
```

Hermes 使用 JSON-RPC：

```json
{ "jsonrpc": "2.0", "id": "...", "method": "...", "params": {} }
```

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

`normalizers.ts` 需要扩展 Hermes 数据：

- `session.list` 返回 `sessions[].id/title/preview/started_at/message_count/source`。
- `session.resume` 返回 `session_id/resumed/messages/info`。
- `session.history` 返回 `messages[]`。
- `message.delta` 追加到 running assistant message。
- `message.complete` finalize assistant message。
- `error` 生成 error message。
- `status.update` 更新 status text 或轻量 inline row。

### 6. Session id 映射

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

### 7. UI 文案最小调整

为了保持前端交付不变，UI 结构不改，只调整文案来源：

- `OpenClaw 会话工作台` -> `${runtime.name} 会话工作台`
- `Gateway Sessions` -> `Sessions`
- `OpenClaw 正在处理当前请求` -> `${runtime.name} 正在处理当前请求`
- statusbar 显示 `${runtime.kind}`、version、ownership。

不要引入 Hermes Dashboard 的全套导航、配置页、插件页、cron 页，否则会改变当前产品交付形态。

## 不建议的路径

### 不建议直接嵌入 Hermes Dashboard

Hermes Dashboard 是 FastAPI + React 管理面，包含 config、keys、logs、cron、skills、plugins、chat 等多页面。直接嵌入会显著改变当前 We-Claw 的工作台形态。

### 不建议重写 Hermes TUI 主聊天体验

Hermes 自身文档明确：Dashboard 的主 chat 体验嵌入真实 `hermes --tui`，不要在 React 里重写 transcript/composer。We-Claw 如果要保持自己的前端，就应把 Hermes 作为 runtime adapter，而不是复制 Hermes Dashboard 的 UI 设计。

### 不建议把 OpenClaw 与 Hermes 逻辑散落在 UI 中

如果在 `src/app/main.ts` 里直接写 `if runtime === "hermes"` 分支，会很快污染 UI。runtime 差异应限制在 Node adapter、client、normalizer。

## 推荐实施顺序

1. 新增 runtime 类型与配置，但默认仍走 OpenClaw。
2. 新增 `/api/runtime/ws`，OpenClaw runtime 先复用现有 bridge，确保当前行为不变。
3. 把前端从 `/api/gateway/ws` 切到 `/api/runtime/ws`。
4. 提取 OpenClaw adapter，保持原有方法和测试通过。
5. 新增 Hermes stdio JSON-RPC client，只实现 `session.create/list/resume/history`、`prompt.submit`、`session.interrupt`。
6. 新增 Hermes event normalizer，只支持 message/error/status 基础流。
7. 加 session id 映射。
8. 手动验证 Hermes 真实生命周期：创建会话、发送 prompt、流式输出、刷新历史、切换历史会话、中断。
9. 再考虑 tool activity、approval、clarify、slash completion、image attach 等 Hermes 特有能力。

## 验证要求

最小验证：

- `npm run typecheck`
- `npm test`
- `npm run build`
- OpenClaw runtime 下现有 UI 行为不回退。
- Hermes runtime 下能完成 create/list/send/stream/history/interrupt。

Hermes 手动验证建议：

- 使用 `WE_CLAW_RUNTIME=hermes` 启动。
- 创建新会话。
- 发送简单 prompt。
- 看到 `message.delta` 或 `message.complete` 显示到 conversation。
- 刷新 session list。
- 切换到历史 session 并能恢复消息。
- 中断长任务，UI running 状态能结束。

## 风险与未知

- Hermes `tui_gateway` 是内部 TUI 协议，当前源码证据显示可用，但不能确认它是长期稳定 public API。
- Hermes session id 有持久 id 与活跃 id 双层语义，adapter 如果处理不好，会导致历史能列出但不能继续发送。
- Hermes tool/approval/clarify 事件比当前 We-Claw UI 丰富，首期需要明确降级策略。
- 如果产品要求 OpenClaw 与 Hermes 同屏同时连接，而不是二选一 runtime，session rail 需要增加 runtime 分组，UI 改动会变大。
- 如果必须走 Hermes Dashboard `/api/ws`，则还要处理 FastAPI server、ephemeral session token、embedded chat flag 和 dashboard 生命周期，复杂度高于 stdio adapter。

## 总体判断

在保持当前前端交付尽可能不变的目标下，最小合理改造是：

1. 引入 runtime adapter 抽象。
2. 保留现有 UI 结构。
3. OpenClaw 保持现有 Gateway bridge。
4. Hermes 通过 Node 管理 `tui_gateway.entry`，做 JSON-RPC 到 We-Claw 内部会话/聊天语义的转换。
5. 把 runtime 差异限制在 launcher、bridge、client、normalizer，避免进入 UI 组件层。

