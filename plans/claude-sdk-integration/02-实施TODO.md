# 实施 TODO

> 当前状态同步于 2026-04-30。状态约定：`[ ]` 未开始、`[~]` 进行中、`[x]` 已完成。

## 1. 依赖与配置

- [x] 增加 `@anthropic-ai/claude-agent-sdk`
- [x] 增加 `WE_CLAW_RUNTIME`
- [x] 增加 `WE_CLAW_CLAUDE_SDK_CWD`
- [x] 增加 `WE_CLAW_CLAUDE_SDK_PERMISSION_MODE`
- [x] 增加 `WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS`
- [x] 增加 `WE_CLAW_CLAUDE_SDK_MODEL`

## 2. Runtime Bridge

- [x] 新增 runtime bootstrap 结构，短期保留 `openclaw` / `gateway`
- [x] 新增 `/api/runtime/ws`
- [x] OpenClaw runtime 复用现有 Gateway bridge
- [x] Claude Agent SDK runtime 支持 `connect` / `health`
- [x] Claude Agent SDK runtime 支持 `sessions.list`
- [x] Claude Agent SDK runtime 支持 `sessions.create`
- [x] Claude Agent SDK runtime 支持 `chat.history`
- [x] Claude Agent SDK runtime 支持 `chat.send`
- [x] Claude Agent SDK runtime 支持 `chat.abort`

## 3. Stream 与 Normalization

- [x] `content_block_delta.delta.text` 映射为 We-Claw chat delta
- [x] `assistant` 完整消息映射为 final assistant message
- [x] `result` 消息收敛 running 状态
- [x] SDK history message 映射为 `TranscriptMessage`
- [x] SDK session metadata 映射为 `SessionSummary`
- [x] tool_use / tool_result block 映射为 compact tool row，并在缺少结果时于历史加载阶段收敛状态
- [x] `chat.history` 返回 `messages`、`toolBlocks`、`notices`，避免刷新后丢失工具与 runtime 事件

## 4. 前端接线

- [x] Bootstrap 连接 `/api/runtime/ws`
- [x] UI 文案从固定 OpenClaw/Gateway 改为 runtime-aware
- [x] 保留现有 session rail / composer / transcript 结构
- [x] Claude runtime 的 `sessions.subscribe` / `sessions.messages.subscribe` 维护真实连接订阅并推送变更事件

## 5. 后续

- [ ] inline approval allow/deny UI
- [ ] fork session 支持
- [ ] Claude usage/cost 展示
- [ ] launcher 重启后的 pending session reconciliation
- [ ] Hermes runtime adapter
- [ ] CLI process fallback adapter
