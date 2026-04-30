# 实施 TODO

> 当前状态同步于 2026-04-30。状态约定：`[ ]` 未开始、`[~]` 进行中、`[x]` 已完成。

## 1. Launcher 配置与 Bootstrap

- [ ] `src/launcher/config.ts`：保留现有 `WE_CLAW_RUNTIME=hermes` 解析，并补齐 Hermes 配置字段：`hermesPython`、`hermesRoot`、`hermesCwd`、`hermesStartupTimeoutMs`
- [ ] `src/launcher/config.ts`：增加 `WE_CLAW_HERMES_PYTHON`、`WE_CLAW_HERMES_ROOT`、`WE_CLAW_HERMES_CWD`、`WE_CLAW_HERMES_STARTUP_TIMEOUT_MS` 的默认值、trim/number normalization 与测试覆盖
- [ ] `src/shared/types.ts`：如 UI 需要展示 Hermes 配置细节，在 `RuntimeSelection` 中增加可选 `hermes` 配置摘要；不要把 Python path、cwd 这类 launcher-only 字段散落到 app state
- [ ] `src/launcher/bootstrap.ts`：在 `createRuntimeSelection()` 的 `options` 中加入 Hermes runtime option，展示 configured / available / detail
- [ ] `src/launcher/bootstrap.ts`：补齐 Hermes bootstrap diagnostic，至少区分未配置 `WE_CLAW_HERMES_ROOT`、Python 启动失败、Gateway entry 不可用
- [ ] `src/launcher/runtime-bridge.ts`：让 `runtimeBootstrap()` 对 `hermes` 返回 `transport: "stdio-jsonrpc"`、`bridgePath: "/api/runtime/ws"`、Hermes capabilities 与可诊断的 `processState`

## 2. Hermes 子进程与 JSON-RPC Client

- [ ] 新增 `src/launcher/hermes-jsonrpc.ts` 或 `src/launcher/hermes-runtime.ts`，集中封装 Hermes stdio JSON-RPC，不把协议解析继续堆进 `runtime-bridge.ts`
- [ ] 新模块通过配置中的 Python 执行 `python -m tui_gateway.entry`，使用 `WE_CLAW_HERMES_ROOT` 设置 `PYTHONPATH`，使用 `WE_CLAW_HERMES_CWD` 设置子进程 `cwd`
- [ ] 新模块实现 request id、pending request map、request timeout、启动超时和子进程退出清理
- [ ] 新模块解析 stdout JSON-RPC response，以及 `method: "event"` notification；协议异常统一抛出可 redaction 的 launcher error
- [ ] 新模块收敛 stderr、spawn error、protocol error、startup timeout，供 `bootstrap.ts` 和 runtime bridge 转成 diagnostic / response error
- [ ] 新模块暴露 `dispose()`，用于浏览器断连、launcher 退出、runtime 切换时清理 Hermes 子进程与 pending request

## 3. Runtime Bridge 接线

- [ ] `src/launcher/runtime-bridge.ts`：在 `installRuntimeBridge()` 中新增 Hermes runtime 实例，OpenClaw 仍走 `bridgeGatewayWebSocket()`，Claude SDK 仍走现有 `ClaudeAgentSdkRuntime`
- [ ] `src/launcher/runtime-bridge.ts`：在 `dispatchRuntimeRequest()` 中按 `runtimeKind(context)` 分发到 Hermes adapter，避免 Hermes 请求落入现有 "not implemented" 分支
- [ ] Hermes adapter 支持 `connect` / `health`，返回现有 `runtimeMethods()` 约定与 Hermes runtime bootstrap
- [ ] Hermes adapter 支持 `sessions.list` -> `session.list`
- [ ] Hermes adapter 支持 `sessions.create` -> `session.create`
- [ ] Hermes adapter 支持 `chat.history` -> 必要时 `session.resume`，再 `session.history`
- [ ] Hermes adapter 支持 `chat.send` -> `prompt.submit`
- [ ] Hermes adapter 支持 `chat.abort` -> `session.interrupt`
- [ ] Hermes adapter 内维护 `hermes:<persistedSessionId>` 与 active Hermes `session_id` 的映射；UI / work index 只看持久 `sessionKey`
- [ ] `src/launcher/server.ts`：runtime 切换到 OpenClaw 时仍只启动 OpenClaw Gateway；切换到 Hermes 时不要误触发 Gateway 管理逻辑

## 4. Shared Types 与 Normalization

- [ ] `src/shared/types.ts`：确认现有 `RuntimeCapabilities` 是否足够表达 Hermes 首期能力；approval / clarify / sudo / secret 必须以 unsupported 或 partial 表达，不能在 UI 上呈现为完整闭环
- [ ] `src/launcher/hermes-runtime.ts`：把 `session.list` 结果映射成 `SessionSummary`，统一使用 `id/sessionKey = hermes:<persistedSessionId>`，`sessionId = persistedSessionId`
- [ ] `src/launcher/hermes-runtime.ts`：把 `session.resume` / `session.history` 结果映射成 `TranscriptMessage[]`
- [ ] `src/launcher/hermes-runtime.ts`：把 `message.start`、`message.delta.payload.text`、`message.complete` 转成现有 `chatPayload()` 可被 `src/shared/normalizers.ts` 的 `reduceChatEvent()` 消费的 shape
- [ ] `src/launcher/hermes-runtime.ts`：把 `error` 转成 transcript error，并结束当前 running 状态
- [ ] `src/launcher/hermes-runtime.ts`：把 `status.update` 转成 runtime notice 或轻量 lifecycle event；不要污染普通聊天消息
- [ ] `src/launcher/hermes-runtime.ts`：把 `tool.start` / `tool.progress` / `tool.complete` 首期转成现有 `session.tool` / compact tool row shape，复用 `src/shared/normalizers.ts` 的 `reduceToolEvent()`
- [ ] `src/shared/normalizers.ts`：只有当 Hermes 事件无法在 launcher 侧转换为既有 Gateway-like shape 时，才新增 Hermes 专用 reducer 分支

## 5. App 接线

- [ ] `src/app/main.ts`：Runtime 设置面板展示 Hermes option、configured / available / detail 状态；fallback runtime options 也包含 Hermes
- [ ] `src/app/main.ts`：Composer 继续只发 `chat.send`，Stop 继续只发 `chat.abort`，不要在前端分叉 Hermes 协议
- [ ] `src/app/main.ts`：Session rail / work item 继续使用 `sessionKey`；Hermes 显示 `hermes:<persistedSessionId>`，避免与 OpenClaw / Claude session id 冲突
- [ ] `src/app/main.ts`：Hermes unsupported / partial capability 不展示为完整可用交互；approval / clarify / sudo / secret 首期显示等待输入或降级提示
- [ ] `src/shared/work-items.ts`：首期不需要新增 Hermes migration 逻辑，除非实现中引入 pending Hermes session key；若引入 pending key，按 Claude pending migration 的测试形状补齐

## 6. 测试与验证

- [ ] `test/launcher.test.ts`：覆盖 Hermes env config、`WE_CLAW_RUNTIME=hermes`、启动超时 normalization、runtime option 展示
- [ ] 新增 `test/hermes-jsonrpc.test.ts` 或扩展 `test/runtime-bridge.test.ts`：覆盖 JSON-RPC response、event notification、stderr diagnostic、spawn/protocol/startup timeout
- [ ] `test/runtime-bridge.test.ts`：覆盖 Hermes `sessions.list` / `sessions.create` / `chat.history` / `chat.send` / `chat.abort` 的方法翻译
- [ ] `test/runtime-bridge.test.ts`：覆盖 persisted session id 与 active `session_id` 映射，尤其是历史 resume 后继续 send / interrupt
- [ ] `test/normalizers.test.ts`：覆盖 Hermes delta / complete / error / status / tool event 转成现有 chat、notice、tool row 后的 reducer 行为
- [ ] `test/work-items.test.ts`：仅在新增 Hermes pending key 或迁移行为时补测，否则保持现状
- [ ] 手动验证真实 Hermes create / list / send / stream / history / interrupt 生命周期
- [ ] 回归默认 OpenClaw runtime、`/api/gateway/ws`、Claude Agent SDK runtime

## 7. 建议实施顺序

- [ ] 先落 `config.ts`、`bootstrap.ts`、`types.ts` 与 launcher tests，让 Hermes 在 bootstrap / runtime picker 中可诊断但还不声称可完整运行
- [ ] 再落 Hermes stdio JSON-RPC client，使用单元测试锁住 response、event、stderr、timeout 和 dispose 行为
- [ ] 然后接入 `runtime-bridge.ts` 的方法翻译和 session id 映射，保持前端协议不变
- [ ] 最后补 app 设置展示、normalizer 回归和真实 Hermes 手动生命周期验证

## 8. 后续

- [ ] inline approval allow/deny UI
- [ ] clarify / sudo / secret 交互闭环
- [ ] Hermes tool activity 完整结构化展示
- [ ] Hermes slash command / path completion / image attach
- [ ] Hermes usage、model、cwd、logs 展示
- [ ] Hermes Dashboard / FastAPI WebSocket 备选接入评估
