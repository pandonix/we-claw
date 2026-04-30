# Issue: 在 Conversation 流中展示 OpenClaw Tool Events

## 背景

`docs/openclaw-web-node-plan.md` 的设计方向是 conversation-first：conversation/workspace 区域是主要交互表面，后续应承载 messages、tool rows、media、artifacts、approvals、errors 和 progress。

当前需要单独讨论和跟踪的问题是：OpenClaw 返回的类似 tool use、tool call、tool output、tool result 这样的运行过程消息，应该如何在 conversation 区域中展示。

计划文档里的结论倾向是：

- V1 先展示基础 chat transcript、运行状态和错误状态。
- Tool events 不作为 v1 的首要能力。
- 等 chat/session loop 稳定后，再把 tool events 做成 inline typed stream blocks。
- Tool events 不应该默认塞进永久右侧面板，也不应该直接作为 raw JSON 展示给普通用户。

## 目标

- 明确哪些 OpenClaw/Gateway 事件应进入 conversation stream。
- 设计 tool use、tool output、tool error、tool lifecycle update 的 UI 表达。
- 保持 user/assistant 文本消息仍是 conversation 的主要阅读对象。
- 保持事件的时间顺序，让用户能理解 agent 正在做什么。
- 避免 tool events 刷屏、重复追加或破坏布局稳定性。
- 为后续实现提供可测试的 event-to-block 映射规则。

## 非目标

- 不在当前 v1 chat/session 基础链路完成前强行实现完整 tool event UI。
- 不实现完整 raw payload inspector。
- 不把 conversation 改造成日志终端。
- 不新增永久右侧 tool/activity 面板作为默认布局。
- 不展示未清洗的敏感路径、token、auth-bearing URL 或完整原始 payload。
- 不在本 issue 内处理 approval RPC 的完整交互；approval card 可作为后续独立 issue。

## 设计方向

Conversation stream 后续可以从简单 transcript 演进为 typed event surface：

- `message.user`: 用户消息气泡。
- `message.assistant`: 助手文本气泡。
- `run.status`: 紧凑运行状态，例如 generating、aborting、recovering history。
- `error.notice`: 可恢复错误块。
- `tool.call`: 紧凑 tool row，展示工具名、状态、耗时和一行摘要。
- `tool.output.text`: 可折叠文本/日志/代码输出。
- `tool.error`: 紧凑错误 row，可展开查看摘要或安全细节。
- `media.image` / `artifact.file` / `artifact.diff`: 后续作为 preview-first rich blocks。

Tool rows 应该是低视觉权重的过程信息，不能压过 user/assistant 消息。默认展示摘要，必要时允许展开。

## OpenClaw 事件分析

基于 `../openclaw` 源码和文档，Gateway WebSocket 的服务端推送统一是：

```ts
{ type: "event", event, payload, seq?, stateVersion? }
```

OpenClaw 文档和 Control UI 源码显示，We-Claw 不应该只处理 `chat`。如果要完整支持 conversation-first 的 agent follow-along，至少需要识别以下事件族。

### P0: 基础 chat/session loop

- `chat`
  - 用途：助手文本流、最终回答、错误、abort 状态。
  - 已知 payload：`runId`、`sessionKey`、`seq`、`state: "delta" | "final" | "error" | "aborted"`、`message`、`errorMessage`。
  - Conversation 行为：渲染 user/assistant 主消息和 minimal run state。
- `sessions.changed`
  - 用途：session index 或 metadata 变化。
  - Conversation 行为：刷新 session rail；不直接插入 conversation。
- `session.message`
  - 用途：订阅 session 后收到 transcript/message 更新。
  - Conversation 行为：不要直接把 payload 当消息渲染；对当前 session 触发或延迟 `chat.history` reload。
  - 注意：active run 期间应避免立即 reload，防止和 streaming/optimistic message 状态打架。
- `shutdown`
  - 用途：Gateway shutdown 或 restart 通知。
  - Conversation 行为：显示连接/可恢复错误状态，不作为普通聊天消息。
- `connect.challenge`
  - 用途：Gateway 握手挑战。
  - Conversation 行为：由 Gateway client 处理，不进入 UI stream。

### P1: Tool stream 和运行过程

- `agent` with `payload.stream === "tool"`
  - 用途：live tool call / tool output cards 的主来源。
  - 已知 payload：
    - `runId`
    - `seq`
    - `stream: "tool"`
    - `ts`
    - `sessionKey`
    - `data.phase: "start" | "update" | "result"`
    - `data.toolCallId`
    - `data.name`
    - `data.args`
    - `data.partialResult`
    - `data.result`
  - Conversation 行为：
    - `phase: "start"` -> `tool.call`
    - `phase: "update"` -> 更新同一个 `tool.call`，可带预览输出
    - `phase: "result"` -> 完成同一个 `tool.call`，并可生成 `tool.output.text`
  - Key：优先用 `data.toolCallId` 合并 lifecycle。
- `session.tool`
  - 用途：Gateway 把 tool lifecycle 镜像给 session subscribers，便于 UI 后加入某个 in-flight session 时仍能看到 live tool cards。
  - Conversation 行为：按与 `agent.stream=tool` 相同的规则归一化。
- `agent` with `payload.stream === "lifecycle"`
  - 用途：run lifecycle，常见 `data.phase: "start" | "end" | "error"`，也可能承载 fallback cleanup。
  - Conversation 行为：更新 run status、错误状态或清理 pending tool stream；默认不作为高权重消息展示。
- `agent` with `payload.stream === "compaction"`
  - 用途：session compaction 过程状态。
  - Conversation 行为：可渲染 compact status row 或临时 inline notice。
- `agent` with `payload.stream === "fallback"`
  - 用途：模型 fallback 状态。
  - Conversation 行为：可渲染低权重 inline notice，例如 selected model fallback 到 active model。

### P2: 需要单独产品化的 inline blocks

- `exec.approval.requested` / `exec.approval.resolved`
  - 用途：system run / exec approval lifecycle。
  - Conversation 行为：后续做 inline approval card；需要明确 approve/reject 控件和风险摘要。
- `plugin.approval.requested` / `plugin.approval.resolved`
  - 用途：plugin approval lifecycle。
  - Conversation 行为：后续和 exec approval 一起做 approval card，但 resolver method 不同。
- `chat.side_result`
  - 用途：OpenClaw Control UI 已支持 side result，例如 BTW/side task 结果。
  - Conversation 行为：可作为辅助结果卡片；不应打断主 assistant 回答。
- `presence` / `health` / `heartbeat` / `tick`
  - 用途：运行环境、健康状态、liveness。
  - Conversation 行为：主要进 topbar/statusbar/debug log；除非故障，不进入主 conversation stream。

### P3: 后续控制台/设置能力

- `cron`
- `device.pair.requested` / `device.pair.resolved`
- `node.pair.requested` / `node.pair.resolved`
- `node.invoke.request`
- `voicewake.changed`
- `voicewake.routing.changed`
- `talk.mode`
- `update.available`

这些事件在 OpenClaw Gateway 中存在或被 Control UI 处理，但不属于当前 conversation tool stream 的核心范围。后续如果 We-Claw 扩展成更完整的 Control UI，再按对应功能区处理。

## 当前 We-Claw 缺口

当前 We-Claw Gateway client 已经在 connect params 中声明 `caps: ["tool-events"]`，但 app 事件处理主要覆盖：

- `chat`
- `sessions.changed`
- `shutdown`

尚未处理：

- `agent`
- `session.tool`
- `session.message`
- `exec.approval.*`
- `plugin.approval.*`
- `chat.side_result`

因此如果 OpenClaw 当前推送 live tool events，We-Claw 大概率会收到但忽略。后续实现前应先建立内部归一化层：`Gateway event -> ConversationBlock[]`，避免把协议 payload 直接散落在 UI 组件里。

## 展示规则

- Rich blocks 出现在它们发生的 conversation 时间点。
- 同一个 tool call 的 running/completed/error lifecycle update 应更新同一行，而不是重复追加多行。
- Tool row 默认紧凑展示，包含：
  - tool name
  - status
  - duration 或 started/completed 时间
  - 一行 summary
  - 可选 expand/open/copy-visible-text 操作
- 大日志、大 JSON、大 diff、大媒体必须 preview-first，不自动展开。
- 未知 content part 或未知 event 类型可以安全省略、摘要或折叠，不直接裸露 raw payload。
- 输出内容必须限制在 conversation column 内，超长内容使用内部滚动或展开视图，不造成横向页面溢出。
- 稳定 connected 状态仍属于 topbar，不应重复作为 conversation card。

## 待确认问题

- `chat.history` 中历史 tool events 的保真度仍需确认；OpenClaw ACP 文档提到 historic tool calls / richer event types 尚未完整重建。
- We-Claw 是否应该使用 `sessions.subscribe` 还是只对 active session 使用 `sessions.messages.subscribe`，需要结合 session rail 规模和刷新策略决定。
- Tool output 中的路径、媒体 URL、base64 内容如何做安全过滤和预览。
- 哪些 tool events 对普通用户有价值，哪些只适合 debug/details。
- 是否需要在 settings 或 overflow menu 中提供 “show tool details” 类开关。

## 实施建议

1. 先保持 v1 只渲染 `message.text`、compact run state 和 recoverable errors。
2. 增加一个内部事件归一化层，把 Gateway/OpenClaw payload 转成 conversation block model。
3. 为 tool lifecycle 建立稳定 key，例如 `toolCallId`、`callId` 或 Gateway event id。
4. 先实现 `tool.call` 的 compact row，再实现 `tool.output.text` 的折叠块。
5. 对 `agent.stream=tool` 和 `session.tool` 共用同一个 normalizer。
6. 对 `session.message` 只触发当前 session 的 history reload，不直接插入 conversation message。
7. 对 unknown event/content part 做安全 fallback：省略或显示 collapsed unsupported block。
8. 增加 focused tests 覆盖：
   - tool lifecycle update 合并为同一 row。
   - tool output 不作为 assistant 文本混入。
   - `session.tool` 和 `agent.stream=tool` 归一化结果一致。
   - `session.message` 在 active run 期间延迟 reload。
   - unknown payload 不崩溃。
   - 大输出默认折叠。
   - conversation 顺序被保留。

## 验收标准

- 用户消息和助手消息仍是 conversation 的主视觉层级。
- Tool call 可以在 conversation 中以 compact row 展示。
- 同一个 tool call 的状态更新不会刷出多条重复 row。
- Tool output 默认折叠或预览，不会撑坏 conversation 布局。
- 大输出、未知 payload、路径和媒体 URL 不会造成敏感信息泄漏或页面溢出。
- 切换 session 或刷新后，能从 Gateway history/events 恢复合理的 conversation 展示。
- 没有实现 tool event UI 时，v1 仍能安全省略或摘要这些事件，不影响基础聊天。

## 参考

- `docs/openclaw-web-node-plan.md`:
  - Conversation-first workspace。
  - V1 shows messages, running/final/error chat states, and minimal session state。
  - Tool events, artifacts, approvals, logs, and rich payloads are follow-up inline stream blocks。
  - Rich blocks should appear inline at the point they occur in the stream。
- `../openclaw/docs/gateway/protocol.md`:
  - Gateway event frame 和 common event families。
  - `session.message` / `session.tool` / `sessions.changed` / approval events。
- `../openclaw/docs/web/control-ui.md`:
  - `chat.send` 非阻塞，响应通过 `chat` events stream。
  - Control UI 支持 stream tool calls + live tool output cards。
- `../openclaw/ui/src/ui/app-tool-stream.ts`:
  - Control UI 按 `toolCallId` 合并 `agent.stream=tool` 的 start/update/result。
- `../openclaw/src/gateway/server-chat.ts`:
  - Gateway 将 tool lifecycle 镜像为 `session.tool` 给 session subscribers。
- `../openclaw/ui/src/ui/app-gateway.ts`:
  - Control UI 对 `agent`、`chat`、`session.message`、`sessions.changed`、approval events 分开处理。
