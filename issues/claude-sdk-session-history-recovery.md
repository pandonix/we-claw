# Issue: 修复 Claude SDK Runtime 重启后的历史消息恢复

## 背景

Claude Agent SDK runtime 已接入 We-Claw 的统一 runtime bridge。当前实现支持：

- `sessions.list` 读取 Claude 本地 session 列表。
- `sessions.create` 创建 We-Claw 本地 pending work。
- `chat.send` 通过 Claude Agent SDK `query()` 发起运行。
- `chat.history` 通过 Claude Agent SDK `getSessionMessages()` 读取本地 Claude session history。

但在实际使用中，服务重启后，之前 Claude SDK 模式下的对话历史可能不再出现在主对话框中。用户看到的是一个仍存在的 We-Claw 工作入口，但打开后 transcript 为空，像是 Claude SDK 不支持历史消息。

这不是一个临时使用问题，需要作为独立可靠性问题跟踪并解决。

## 问题

Claude SDK 模式的新工作首期使用 `claude:pending:<uuid>` 作为 We-Claw session key。首次 `query()` 返回真实 Claude `session_id` 后，launcher 会把真实 id 记录在内存中的 local session 对象里。

当前风险点：

- pending session 到真实 Claude session 的映射只在 launcher 内存里。
- 服务重启后，launcher 的 local session map 丢失。
- 前端 `workIndex` 仍可能保存旧的 `claude:pending:<uuid>`。
- 重启后 `chat.history` 对 pending key 无法解析出真实 Claude `session_id`，因此返回空历史。
- `sessions.list` 虽然能看到真实 `claude:<sessionId>`，但不会自动把旧 pending work 迁移到真实 session。

最终表现是：历史消息存在于 Claude 本地 session store 中，但 We-Claw 主对话框没有绑定到正确的 session key。

## 目标

- Claude SDK runtime 重启后，已有 We-Claw 工作能自动恢复到真实 Claude session。
- 用户打开原来的工作入口时，对话框显示历史消息，而不是空 transcript。
- 首次运行拿到真实 Claude `session_id` 后，前端持久 work index 不再长期保存不可恢复的 pending key。
- pending session 和真实 session 的归并逻辑有明确测试覆盖。
- 保持 Claude Agent SDK 作为历史事实来源；We-Claw 只保存必要的 UI 索引和映射。

## 非目标

- 不实现 Claude session 的自定义存储或复制完整 transcript。
- 不把 We-Claw 变成 Claude session store 的替代来源。
- 不改变 OpenClaw runtime 的 session/history 行为。
- 不在本 issue 内设计多 runtime 同屏会话管理。
- 不依赖用户手动展开“运行时会话”再把真实 session 加入工作。

## 证据与当前代码路径

- `src/launcher/runtime-bridge.ts`
  - `createSession()` 创建 `claude:pending:<uuid>` local session。
  - `captureSessionId()` 在 SDK stream 中捕获真实 `session_id`，但映射保存在 launcher 内存。
  - `loadHistory()` 只有在 local session 有 `sessionId`，或传入 key 可解析为 `claude:<sessionId>` 时，才会调用 `getSessionMessages()`。
- `src/app/main.ts`
  - `createWorkFromGateway()` 会把 `sessions.create` 返回的 pending session key 写入 `workIndex`。
  - 启动时 `loadSessions({ loadHistoryForActive: true })` 会按 `workIndex` 选择 active work 并加载历史。
- `plans/claude-sdk-integration/01-集成基线与实施建议.md`
  - 已明确记录“首期 session 映射保存在 launcher 内存中；launcher 重启后 pending session 会丢失”。

## 技术方向

### 方案 A: 首次捕获真实 session id 后迁移 work index

当 Claude SDK stream 中出现真实 `session_id` 时，runtime bridge 应向前端发出可识别的 session key 迁移事件，例如：

```text
session.migrated
fromSessionKey = claude:pending:<uuid>
toSessionKey = claude:<sessionId>
sessionId = <sessionId>
```

前端收到后：

1. 将 `workIndex` 中的 `targetSessionKey` 从 pending key 更新为真实 key。
2. 保留原 work id、标题、创建时间、置顶/隐藏状态。
3. 更新 active work/session。
4. 保存 runtime-scoped localStorage。
5. 后续 `chat.history` 使用真实 `claude:<sessionId>`。

这是首选方向，因为它能在问题产生前消除不可恢复 key。

### 方案 B: 启动时 reconciliation

作为防御层，启动后如果 `workIndex` 中存在 `claude:pending:*`，可以尝试根据 Claude SDK `sessions.list` 的 session metadata 做归并。

可用信号可能包括：

- pending work 的标题 / first user message。
- Claude session 的 `summary`、`customTitle`、`firstPrompt`。
- session updatedAt / createdAt 时间窗口。
- cwd scope 一致。

该方案只能作为 fallback，因为标题和时间窗口可能不唯一。

### 推荐实现

先做方案 A，并为方案 B 留一个最小保守 fallback：

- 强制在同一进程内拿到真实 session id 后立即迁移 `workIndex`。
- 对已经存在的历史 pending work，只在高置信度匹配时自动修复；低置信度时保留但标记为需要恢复诊断。

## 实施建议

1. 在 shared types 中增加 session migration event 类型，或沿用 `GatewayFrame` 但规范 `event="session.migrated"` payload。
2. 在 Claude runtime `captureSessionId()` 中，当 session key 从 pending 变为真实 key 时，广播 migration event。
3. 前端事件处理新增 `session.migrated` 分支。
4. 新增 work index helper，例如 `migrateWorkSessionKey(workIndex, fromKey, toSession)`。
5. 迁移时避免重复插入：如果真实 key 已存在 work item，需要合并 pending entry 并去重。
6. 迁移后立即保存 scoped `we-claw.workIndex.v1:<runtimeScope>`。
7. 迁移 active session 后继续保留当前 streaming transcript，不触发空 history 覆盖。
8. `sessions.list` 刷新后，真实 Claude session 应与已迁移 work item 正确关联。
9. 增加单元测试覆盖 work index migration、重复 key 合并、active work key 更新。
10. 增加 runtime bridge 测试覆盖捕获 `session_id` 后发出 migration event。
11. 增加前端集成级测试或 focused DOM test，覆盖重启后 work index 中保存真实 key 并能加载 history。

## 验收标准

- 新建 Claude SDK 工作并发送第一条消息后，localStorage 中对应 work item 的 `targetSessionKey` 最终变为 `claude:<sessionId>`，不是 `claude:pending:<uuid>`。
- 服务重启后，We-Claw 启动并自动选中原工作时，主对话框能显示历史消息。
- `chat.history` 对真实 Claude session key 调用 SDK `getSessionMessages()`。
- 运行中捕获真实 session id 时，UI 不丢失当前 streaming 消息。
- 左侧工作列表不出现 pending work 和真实 Claude session 的重复条目。
- 已存在的 pending work 如果无法高置信度归并，不应错误绑定到其他 Claude session。
- OpenClaw runtime 的 work index、session rail、history 加载不受影响。
- `npm run typecheck`、`npm test`、`npm run build` 通过。

## 测试建议

- `work-items` helper：
  - pending key 迁移为真实 key。
  - pending entry 与 existing real entry 合并去重。
  - title、pinned、hidden、createdAt、lastOpenedAt 保留策略正确。
- `runtime-bridge`：
  - Claude stream message 带 `session_id` 时发出 migration event。
  - pending subscribers 被 mirror 到真实 session key。
  - 后续 `chat.history` 使用真实 key 能读取 SDK history。
- 前端：
  - 收到 `session.migrated` 后更新 active session。
  - 保存后的 work index 重载仍指向真实 key。
  - `loadSessions({ loadHistoryForActive: true })` 会对真实 key 加载历史。

## 风险

- Claude SDK stream 中 `session_id` 出现时机可能早于/晚于首个 delta，需要迁移逻辑不依赖消息顺序。
- 如果同时存在 pending work 和真实 session promoted work，需要谨慎合并，避免丢失用户置顶或标题。
- 启动时 fallback reconciliation 不能过度激进，否则可能把旧工作绑定到错误 Claude 会话。
- localStorage 迁移要保持 runtime scope，避免 OpenClaw 与 Claude SDK work index 混写。

## 实现记录

已实现方案 A：

- Claude runtime 捕获真实 `session_id` 后，将 local session、active run 和 message subscriber 从 `claude:pending:<uuid>` 重绑到 `claude:<sessionId>`。
- Runtime bridge 广播稳定的 `session.migrated` event。
- 前端收到迁移事件后迁移 runtime-scoped `workIndex`，更新 active session，并保留当前 streaming transcript。
- 前端启动/刷新 `sessions.list` 后会把历史遗留的 `claude:pending:*` work item 归并到匹配的真实 Claude session。
- 前端 session normalizer 保留 runtime bridge 返回的 `title` 字段，避免 Claude session 标题被降级成 `未命名会话`。
- Work index helper 支持 pending/real 重复 entry 合并，保留标题、置顶、隐藏和时间字段。

验证：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 在 `http://127.0.0.1:4173/` 刷新真实页面后，历史遗留的 `hello` work item 归并为 `Claude Agent SDK · /Users/insunny/Documents/codespace/we-claw`，对话区显示历史 `hello` / `Hello! How can I help you today?`。
