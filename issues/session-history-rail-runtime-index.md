# Issue: 优化左侧 Session Rail 的标题展示

## 背景

当前左侧 rail 展示 OpenClaw 的 `sessions.list`。这个方向是合理的：We-Claw 不自己维护一套会话事实来源，而是展示 OpenClaw 已有 session，并通过 session 切换恢复对应历史。

现在的问题是：部分 session row 可能直接展示 raw session id 或技术性 key。对用户来说，这类文本无法表达会话内容，也不像历史会话入口。

本 issue 只跟踪当前 OpenClaw session 的标题展示优化。暂不考虑：

- 项目/workspace 分组。
- Hermes 兼容。
- 多 runtime 切换。
- 左侧 rail 的整体信息架构重做。

## 目标

- 左侧 session row 默认展示可读标题，而不是 raw session id。
- 标题能尽量反映会话内容。
- 保留 OpenClaw session 作为事实来源。
- 不改变当前左侧 rail 的基本布局和交互。
- raw session id 仍可作为内部定位信息，但不作为默认主标题展示。

## 非目标

- 不新增 project/workspace 分组。
- 不接入 Hermes。
- 不引入本地独立会话系统。
- 不把左侧 rail 扩展成管理后台、文件树或插件面板。
- 不支持用户手动编辑标题；后续需要时单独开 issue。

## 标题生成优先级

session row 的 `title` 按以下优先级解析：

1. OpenClaw `sessions.list` 返回的 `displayName`。
2. OpenClaw `sessions.list` 返回的 `derivedTitle`。
3. OpenClaw `sessions.list` 返回的 `label`。
4. OpenClaw `sessions.list` 返回的 `lastMessagePreview`。
5. 从 `chat.history` 中提取第一条 user message 的截断摘要。
6. 从 `chat.history` 中提取最近一条 user message 的截断摘要。
7. `未命名会话`。

不要把 raw `key`、`sessionId` 或长 UUID 类字符串作为默认标题。

## 展示规则

- 标题单行展示，超长时省略。
- subtitle 可以继续展示辅助信息，例如 `OpenClaw Gateway`、模型、状态或最近摘要。
- 时间仍使用 `updatedAt` 渲染相对时间。
- 运行中/错误状态继续沿用当前 status dot 或 spinner。
- raw session id 只在后续调试视图、tooltip 或日志中使用。

## 实施建议

1. 调整 `normalizeSession` 的标题解析逻辑，优先读取 `displayName`、`derivedTitle`、`label`、`lastMessagePreview`。
2. 避免 fallback 到 `Session ${id.slice(...)}` 这类技术标题；改为 `未命名会话`。
3. 调用 `sessions.list` 时尽量请求可派生标题和最近消息摘要，例如：

```ts
gateway.request("sessions.list", {
  includeDerivedTitles: true,
  includeLastMessage: true
});
```

4. 如果 `sessions.list` 无法给出可读标题，可在加载 `chat.history` 后补充当前 active session 的标题。
5. 增加 focused tests 覆盖标题 fallback 顺序。

## 验收标准

- 左侧 session row 不再默认显示 raw session id。
- 有 `displayName` 时展示 `displayName`。
- 有 `derivedTitle` 时展示 `derivedTitle`。
- 没有标题但有 `lastMessagePreview` 时展示摘要。
- 没有任何可读文本时展示 `未命名会话`。
- 点击 session、加载 history、发送消息等现有 OpenClaw 流程不回退。

## 风险

- `derivedTitle` 或 `lastMessagePreview` 可能需要额外读取 transcript，session 数量多时要注意性能。
- 摘要文本可能过长或包含换行，需要统一截断和空白归一化。
- 某些旧 session 可能没有足够 metadata，只能展示 `未命名会话`。
