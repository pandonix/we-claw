# Issue: 将左侧 Rail 从全量 Gateway Session List 调整为用户工作列表

## 核心结论

左侧主 rail 不应该直接展示 OpenClaw Gateway 的全量 `sessions.list`。

对普通用户而言，左侧应该展示可理解、可继续、可观察的 **工作项 `WorkItem`**。OpenClaw session 仍然存在，但作为底层执行、恢复、路由和调试概念，不作为默认主导航对象。

目标信息架构：

```text
We-Claw WorkItem
  -> targetSessionKey
  -> OpenClaw Gateway session
  -> chat.history / chat.send / chat.abort / runtime events
```

## 背景

当前 We-Claw 左侧 rail 直接展示 OpenClaw Gateway 的 `sessions.list`。这个实现保持了 OpenClaw 作为事实来源，但把 Gateway 的底层 session index 暴露成了主导航。

结合 OpenClaw 源码和原生 UI/channel 设计，这个方向会造成用户困惑：

- `sessions.list` 是运行时/控制面索引，不等于用户心智里的历史任务列表。
- Channel 插件通常从当前外部 conversation 推导一个 `sessionKey`，而不是把所有 Gateway sessions 暴露给终端用户。
- OpenClaw TUI 默认关注当前 session，用 `sessions.list` 刷新当前 session metadata，而不是展示全量主导航。
- OpenClaw Web UI 的 chat 入口使用轻量 session selector；完整 sessions table 是独立管理/诊断视图。
- Gateway session row 可能包含 main、group/channel、subagent、cron、plugin-owned、global/unknown、legacy 等不同语义，混在主 rail 会让用户难以判断应该继续哪一个工作。

## 问题

左侧 rail 作为第一屏主导航时，不应直接等同于 `sessions.list` 的完整投影。

当前设计的问题：

- 技术性 session key/id 出现在主路径。
- 外部频道会话、后台任务、子 agent 会话和本地工作会话混在一起。
- 用户不知道一个 row 代表“任务”、“聊天”、“agent 子进程”还是“运行时状态”。
- session 数量增长后，主导航噪声上升，真实可继续的工作入口反而不明显。
- 为了让 row 可读而优化 session title，会进一步强化“全量 session dump 是主导航”的错误方向。

## 产品概念

### WorkItem

面向普通用户的左侧列表项，表示一件可以继续的工作。

用户应该看到：

- 可读标题。
- 所属 workspace/runtime 的轻量提示。
- 最近更新时间或运行状态。
- 是否 pinned / running / blocked。

用户默认不应该看到：

- raw `sessionKey`。
- raw `sessionId`。
- OpenClaw store path。
- subagent/cron/plugin/internal 分类细节。

### OpenClaw Session

OpenClaw 的底层执行、上下文、路由和恢复状态桶。

它继续负责：

- `chat.history`
- `chat.send`
- `chat.abort`
- transcript/session state
- channel conversation binding
- subagent/cron/plugin runtime state

We-Claw 不替代 OpenClaw session，只在 UI 层建立 `WorkItem -> targetSessionKey` 映射。

### Run

一次 agent 执行。一个 WorkItem 可以经历多次 run。

运行状态来自：

- Gateway `chat` event
- Gateway `agent` event
- Gateway `sessions.changed`
- `sessions.list` row 的 `status` / `startedAt` / `endedAt`

### Gateway Sessions View

高级/调试入口，展示完整 `sessions.list`。这是控制面，不是默认主导航。

## 命名

左侧主区域建议命名：

- `Work`
- `工作`

避免默认命名：

- `Gateway Sessions`
- `Sessions`
- `Session History`

按钮文案：

- `+ 新工作`

空状态文案：

- `还没有工作`

不要使用：

- `未发现 Gateway sessions`

## 数据模型

新增 UI 层模型，不直接复用 Gateway `SessionSummary` 作为主 rail 模型。

建议文件：

- `src/shared/types.ts`：类型定义。
- `src/shared/work-items.ts`：归一化、过滤、提升和投影规则。
- `src/app/main.ts`：状态接入、渲染和交互。
- 后续若迁移到 launcher 持久化，可把 storage 逻辑移到 `src/launcher/`。

建议类型：

```ts
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
  status?: "running" | "idle" | "error" | "unknown";
}

export interface WorkIndexEntry {
  id: string;
  targetSessionKey: string;
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
```

### ID 规则

`WorkItem.id` 是 We-Claw UI id，不等于 OpenClaw `sessionKey`。

建议：

- We-Claw 创建：`work:${crypto.randomUUID()}`
- Gateway session 提升：`session:${stableHash(sessionKey)}`
- Pinned channel conversation：`pin:${stableHash(sessionKey)}`

`targetSessionKey` 才是调 OpenClaw Gateway 的目标。

## WorkItem 如何产生

### 1. 用户点击“新工作”

行为：

1. 调用 `sessions.create`，如果 Gateway 支持。
2. 生成本地 `WorkIndexEntry`。
3. `targetSessionKey = normalizeSessions(result)[0].sessionKey`。
4. 持久化 WorkIndex。
5. 左侧立刻出现 WorkItem。
6. 当前 active target 切换到该 WorkItem。

如果 Gateway 不支持 `sessions.create`：

1. 使用当前默认 session key 或显式生成约定 key。
2. 第一次 `chat.send` 后再确认该 session 是否出现在 `sessions.list`。
3. WorkItem 可先以 optimistic 状态存在。

标题：

- 初始展示 `未命名工作`。
- 用户发送第一条 prompt 后，用第一条 user message 生成标题。

### 2. 用户在空白状态发送第一条 prompt

如果当前没有 active WorkItem：

1. 自动创建 WorkItem。
2. 绑定当前 active OpenClaw session。
3. 标题从 prompt 派生。
4. 发送 `chat.send`。

这避免“用户必须先理解 session 再开始工作”。

### 3. 用户从 Gateway Sessions 视图打开某个 session

行为：

1. 不自动把所有 Gateway sessions 放入主 rail。
2. 用户点击 `Open in Work` / `Add to Work` 后，才把该 session 提升为 WorkItem。
3. 记录 `lastOpenedAt`。
4. 后续它出现在主 rail。

这是主 rail 和调试视图之间的产品边界。

### 4. 用户 pin/bookmark

任何 session 或 channel conversation 被用户 pin 后：

1. 创建或更新 WorkIndexEntry。
2. `pinned = true`。
3. 即使它来自外部 channel，也进入主 rail。

### 5. 运行中 top-level session

运行中且需要用户关注的 top-level session 可以临时进入主 rail。

默认仍然排除：

- subagent
- cron
- plugin-owned
- global/unknown

除非它们属于某个已展示 WorkItem 的展开详情。

## 与 OpenClaw Session 的关联

所有主流程仍通过 `targetSessionKey` 调 Gateway：

```ts
loadHistory(work.targetSessionKey);
gateway.request("chat.send", {
  sessionKey: work.targetSessionKey,
  message,
  idempotencyKey
});
gateway.request("chat.abort", { sessionKey: work.targetSessionKey });
```

状态刷新：

```ts
const sessions = normalizeSessions(await gateway.request("sessions.list", params));
const sessionByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
const workItems = projectWorkItems({ workIndex, sessions, activeSessionKey });
```

Gateway 事件处理：

- `chat`：按 `payload.sessionKey` 找 WorkItem，更新 running/status。
- `agent`：按 `payload.sessionKey` 找 WorkItem，更新 runtime blocks。
- `session.message`：只对当前 WorkItem 触发 history reload。
- `sessions.changed`：刷新 session metadata，或者局部更新 WorkItem。

## WorkIndex 持久化

### V1

先使用 `localStorage`，保持改动轻量：

```ts
const WORK_INDEX_STORAGE_KEY = "we-claw.workIndex.v1";
```

存储内容：

```ts
type WorkIndex = {
  version: 1;
  items: WorkIndexEntry[];
};
```

### 后续

如果 launcher 需要支持跨浏览器/更稳定恢复，再迁移到本地文件，由 Node launcher 提供 API。

候选路径：

- We-Claw app data dir。
- OpenClaw workspace 旁的 We-Claw metadata 文件。

不要写入 OpenClaw session store 来保存纯 UI 状态，避免污染 runtime state。

## 主 Rail 投影规则

输入：

- `WorkIndexEntry[]`
- `SessionSummary[]`
- active session key
- optional local title cache

输出：

- `WorkItem[]`

排序建议：

1. pinned first。
2. running / needs attention。
3. recently opened。
4. recently updated。
5. createdAt。

标题优先级：

1. 用户手动标题。
2. WorkIndex 保存的 title。
3. Gateway `displayName` / `derivedTitle` / `label` / `lastMessagePreview`。
4. `chat.history` 派生标题。
5. `未命名工作`。

subtitle 建议：

- local workspace name。
- runtime label，例如 `OpenClaw`。
- 简短状态，例如 `正在运行`、`已暂停`、`昨天`。

## 默认提升/过滤规则

### 默认进入主 rail

- WorkIndex 中存在且 `hidden !== true` 的条目。
- 当前 active session 对应的 WorkItem。
- pinned 条目。
- We-Claw 创建的 top-level work。
- 用户从 Gateway Sessions 视图显式打开过的 session。

### 可选进入主 rail

这些条目只有在满足“用户打开过 / pinned / running top-level / 有清晰标题”时进入：

- channel direct/group conversation。
- Gateway existing session。

### 默认隐藏

- `global`。
- `unknown`。
- cron session。
- subagent session。
- plugin-owned/internal session。
- 没有可读标题、只有 raw key/id 的 session。
- 仅用于 checkpoint/compaction/fork/history compatibility 的 session。

## Gateway Sessions 入口

主 rail 底部或设置中保留一个低权重入口：

- `Gateway Sessions`
- `Debug Sessions`
- `运行时会话`

该视图展示全量 `sessions.list`，并支持：

- search/filter。
- raw key/sessionId copy。
- open/promote to Work。
- pin。
- hide from Work。
- inspect metadata。

这个视图可以复用现有 session row normalizer，但不要作为默认第一屏主导航。

## UI 改动

### 左侧

现有：

```text
Gateway Sessions
```

改为：

```text
Work
```

按钮：

```text
+ 新工作
```

空状态：

```text
还没有工作
```

### 顶部

顶部展示 active WorkItem 标题。

subtitle 可以显示：

```text
OpenClaw · local workspace
```

不要默认显示 raw session key。

### 调试信息

raw `sessionKey` 可以进入：

- tooltip。
- overflow menu。
- Debug Sessions view。
- diagnostics panel。

## 实施计划

## 当前实现状态

已落地第一阶段：

- 左侧主 rail 已从全量 `sessions.list` 改为 `WorkItem` 投影。
- `sessions.list` 仍作为 OpenClaw Gateway 状态补全来源，不再直接决定主导航全量条目。
- 新增本地 `WorkIndex`，V1 存储在 `localStorage` 的 `we-claw.workIndex.v1`。
- `+ 新工作` 会通过 `sessions.create` 创建 OpenClaw session，并写入本地 WorkIndex。
- 如果用户在无 active WorkItem 的空状态直接发送第一条 prompt，会先创建 WorkItem，再发送到对应 `targetSessionKey`。
- 首条 user message / 历史 user message 会生成 WorkItem 标题。
- 默认隐藏 global、unknown、cron、subagent、plugin/checkpoint 这类内部 session。
- 运行中的 top-level session 可作为临时 runtime WorkItem 出现。
- 全量 Gateway sessions 已移到左侧底部的 `运行时会话` 折叠调试入口，用户点击 `+` 后才会提升为 WorkItem。
- `chat.history`、`chat.send`、`chat.abort` 仍通过 `WorkItem.targetSessionKey` 调 OpenClaw Gateway。

已验证：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 本地浏览器打开 `http://127.0.0.1:5175/`，确认默认 rail 不再展示全量 Gateway sessions，调试入口折叠可展开。

尚未落地，留作后续：

- WorkItem rename UI。
- pin/bookmark UI。
- hide/remove WorkItem UI。
- 更完整的 Gateway Sessions 管理视图搜索、过滤、复制 raw key。
- launcher 侧持久化迁移，替代 browser `localStorage`。
- 多 runtime / 多 workspace namespace。

### Step 1: 引入 WorkItem 类型和投影函数

新增纯函数，便于测试：

```ts
normalizeWorkIndex(value: unknown): WorkIndex;
projectWorkItems(params: {
  workIndex: WorkIndex;
  sessions: SessionSummary[];
  activeSessionKey?: string;
}): WorkItem[];
promoteSessionToWorkItem(
  session: SessionSummary,
  reason: "open" | "pin" | "running"
): WorkIndexEntry;
```

测试：

- WorkIndex 条目能投影成 WorkItem。
- Gateway-only session 不自动进入主 rail。
- active/pinned/opened session 能进入主 rail。
- global/unknown/cron/subagent 默认隐藏。

### Step 2: 接入 AppState

`AppState` 增加：

```ts
workIndex: WorkIndex;
workItems: WorkItem[];
activeWorkId?: string;
activeSessionId?: string;
```

短期兼容：

- 保留 `activeSessionId`，但语义上把它当 `activeSessionKey`。
- 左侧点击 WorkItem 后设置 `activeWorkId` 和 `activeSessionId = work.targetSessionKey`。

### Step 3: 改左侧渲染

把 `renderSessions()` 改为 `renderWorkItems()`。

行点击：

```ts
selectWorkItem(work.id);
loadHistory(work.targetSessionKey);
```

空状态和标题文案同步调整。

### Step 4: 新建工作

把 `createSession()` 包装成 `createWork()`：

1. 调 `sessions.create`。
2. 创建 WorkIndexEntry。
3. 持久化 WorkIndex。
4. 切换到新 WorkItem。

### Step 5: Gateway Sessions 调试入口

可以先用最小版本：

- 左侧底部按钮。
- 点击后在 conversation 区域显示全量 Gateway Sessions 列表，或先做简单 modal/inline panel。
- 每个 row 提供 `Open in Work`。

如果暂时不实现完整视图，至少保留后续入口和 TODO，不要继续把主 rail 当 debug list。

### Step 6: 事件同步

`loadSessions()` 后：

1. 更新 `state.sessions`。
2. 用 `projectWorkItems()` 更新 `state.workItems`。
3. 如果 active work 的 session 不存在，保持 WorkItem，但显示 disconnected/missing 状态。

`session.message` 和 `chat` 事件仍按 sessionKey 处理。

### Step 7: 迁移现有标题优化

`session-history-rail-runtime-index.md` 中的标题逻辑迁移到 WorkItem 标题生成中。

不要再用它强化“所有 Gateway sessions 都进左侧”的旧假设。

## 测试要求

### Unit

- `projectWorkItems` 默认不展示 Gateway-only sessions。
- WorkIndex 中的 entry 正确绑定 session metadata。
- active session 能临时显示。
- pinned session 始终显示。
- hidden session 不显示，除非它是 active。
- subagent/cron/global/unknown 默认隐藏。
- 标题 fallback 顺序正确。

### App

- bootstrap 后左侧不再直接等于 `sessions.list`。
- 新建工作后出现一个 WorkItem。
- 点击 WorkItem 加载对应 `chat.history`。
- 发送消息使用 `targetSessionKey`。
- Gateway `sessions.changed` 能刷新 WorkItem 状态。
- Debug/Gateway Sessions 入口仍能看到完整 sessions。

### Regression

- 现有 `chat.history`、`chat.send`、`chat.abort` 流程不回退。
- raw `sessionKey` 不出现在普通左侧 row 主标题。
- 没有 WorkItem 时能正常开始第一条 prompt。

## 验收标准

- 左侧主 rail 不再默认列出 Gateway 的全部 `sessions.list`。
- 普通用户第一眼看到的是可继续的工作入口，不是 runtime/session key dump。
- 点击 `新工作` 或直接输入 prompt 后，左侧出现一个可读工作项。
- 刷新页面后，工作项恢复。
- 当前 active session 切换、`chat.history` 恢复、`chat.send` 发送不回退。
- subagent、cron、global、unknown、plugin-owned session 不再默认污染主 rail。
- 高级用户仍可打开 `Gateway Sessions` 查看完整 OpenClaw session index。
- 有测试覆盖主 rail 的 filtering/normalization 规则。

## 与现有 Issue 的关系

- `session-history-rail-runtime-index.md` 关注现有 session row 的标题展示。
- 本 issue 关注更上层的信息架构：左侧 rail 不应直接等于全量 Gateway session list。
- 如果本 issue 被采纳，标题优化仍有价值，但应作为 WorkItem 标题生成策略的一部分，而不是继续强化全量 session dump。

## 暂不解决的问题

- 多 WorkItem 绑定同一个 sessionKey 的冲突策略。
- 一个 WorkItem 下展示 subagent tree。
- WorkItem 手动重命名 UI。
- WorkItem 删除是否删除 OpenClaw transcript。
- 多 runtime 下 WorkItem 的 runtime namespace。
