# We-Claw Development Task Breakdown

本文基于 `docs/openclaw-web-node-plan.md` 拆解开发任务。目标是先完成可运行的本地 Web + Node 垂直切片，再逐步扩展为可日常使用的 OpenClaw 会话工作台。

## 0. 执行原则

- 先交付聊天和会话闭环，再扩展工具、审批、产物、日志等富内容。
- OpenClaw Gateway 是运行时事实来源；We-Claw 只做本地启动、连接、展示和交互控制。
- Node 层保持薄：服务静态 UI、发现/启动 Gateway、提供安全 bootstrap/health API。
- 浏览器优先直连 loopback Gateway WebSocket；仅在明确的认证、CORS、传输限制出现时才加入受限代理。
- v1 只支持本机 loopback Gateway，不支持 LAN、远程、Tailscale、公网或 TLS 暴露。
- 桌面优先；本阶段不投入移动端适配。

## 1. Milestone 0: Chat And Session Probe

目标：证明 We-Claw 能启动本地 UI、发现或管理 OpenClaw Gateway，并完成最小聊天/会话调用链。

### 1.1 项目脚手架

- 建立单包 Vite + TypeScript 项目结构。
- 保留现有 `index.html`、`styles.css`、`app.js` 作为视觉参考，生产代码迁入 typed app 结构。
- 增加 Node 本地服务器入口，后续作为 `we-claw` CLI 的基础。
- 配置基础脚本：`dev`、`build`、`typecheck`、`test`。

验收：
- 本地可启动开发服务器。
- 生产构建输出可由 Node 服务器托管。
- 无 monorepo/workspace 结构。

### 1.2 Node Launcher 最小实现

- 检查当前 Node 版本是否满足 OpenClaw 需求。
- 发现 `openclaw` 可执行文件。
- 执行 `openclaw --version` 或等价命令，记录版本与失败原因。
- 探测 `127.0.0.1:18789` 是否已有兼容 OpenClaw Gateway。
- 无兼容 Gateway 时，以 loopback-only 方式启动 `openclaw gateway`。
- 等待 Gateway readiness。
- 跟踪 Gateway 所有权：`managed` 或 `external`。
- 进程退出时只停止 We-Claw 自己启动的 Gateway。

验收：
- 缺少 OpenClaw 时返回明确、可操作的错误。
- 端口已有兼容 Gateway 时复用，不杀进程。
- 端口被非 Gateway 占用时报告冲突，不杀进程。
- 退出 We-Claw 不会杀掉外部 Gateway。

### 1.3 本地 Bootstrap API

- 实现 `GET /api/bootstrap`。
- 返回安全状态：OpenClaw 可用性、版本、Node 兼容性、Gateway URL、Gateway ownership、进程状态、readiness、诊断信息。
- 不返回 Gateway token、长效凭证、敏感路径或认证材料。
- 增加 `GET /api/gateway/status` 或等价轻量状态接口。
- 增加 launcher 日志结构，并对敏感字段做 redaction。

验收：
- 浏览器可获得连接 Gateway 所需的非敏感状态。
- bootstrap 响应不包含 token、query-secret、认证材料。
- 错误能区分 OpenClaw 缺失、Gateway 启动失败、端口冲突、认证/setup 问题。

### 1.4 Gateway WebSocket RPC Client

- 实现 Gateway WebSocket 连接。
- 支持 `{ type: "req", id, method, params }` 请求帧。
- 实现 `request(method, params)` 与 request id 响应匹配。
- 支持 `connect`、`health`、`sessions.list`、`chat.history`、`chat.send`、`chat.abort`。
- 订阅并分发基础事件：`chat`、`sessions.changed`、`shutdown`、`health`、`tick`。
- 处理连接失败、断线、重连和方法缺失。
- 从 hello/features 中做 Gateway 方法能力判断。

验收：
- 可调用 `health`、`sessions.list`、`chat.history`、`chat.send`。
- Gateway 方法缺失时 UI 显示降级错误，不崩溃。
- 断线后显示 reconnecting/disconnected 状态。

### 1.5 最小 Workspace UI

- 实现桌面布局：左侧 session rail、紧凑 topbar、conversation column、composer、低强调 statusbar。
- 左侧 rail 显示 Gateway 状态点、新会话入口、Gateway session 列表、本地设置入口占位。
- Topbar 显示当前会话标题、简短副标题、连接状态、overflow menu。
- Conversation 加载并渲染 `chat.history` 文本消息。
- Composer 支持输入、发送、运行中 stop 状态。
- 发送走 `chat.send`，停止走 `chat.abort`。
- 只展示消息、运行/完成/错误状态和最小 session 状态。

验收：
- 用户能看到 Gateway session 列表。
- 用户能切换 session 并重新加载对应 `chat.history`。
- 用户能发送 prompt。
- 运行中 send 按钮切换为 stop。
- connected 状态只显示在 topbar/rail，不重复成大卡片。

### 1.6 Milestone 0 验证

- 单元测试：
  - Gateway frame parsing。
  - request id 映射。
  - 方法能力判断。
  - session row normalization。
  - chat event reducer。
  - launcher config resolution。
- 集成测试：
  - mock Gateway WebSocket server。
  - bootstrap -> health -> sessions.list。
  - chat.send -> chat event -> transcript update。
  - chat.abort active run。
- 手动测试：
  - 无 Gateway 时启动 We-Claw。
  - 已有 Gateway 时启动 We-Claw。
  - 缺少 OpenClaw 时错误展示。
  - 代表性桌面视口视觉检查。

## 2. Milestone 1: Usable Chat Workspace

目标：让核心聊天和会话工作台达到日常本地使用的可靠度。

### 2.1 Transcript 可靠渲染

- 规范 user/assistant/system/error 消息模型。
- 渲染 `message.text` 与基础多段文本。
- 对未知 content part 做安全省略或摘要。
- 保持滚动行为稳定：新消息跟随、用户上滚后不强制抢焦点。
- 处理空历史、加载中、历史加载失败、恢复成功状态。

验收：
- 刷新页面后能从 `chat.history` 恢复 transcript。
- 未知内容不会导致 UI 崩溃或 raw payload 泄露。
- 长文本不横向撑破 conversation column。

### 2.2 Streaming 状态

- 将 live `chat` events 合并到当前 assistant 输出。
- 区分 running、final、error、aborted。
- 对重复或乱序事件做保守处理。
- 在 composer 或 stream 中显示轻量运行状态。

验收：
- assistant response 能流式或增量更新。
- 运行状态不造成布局跳动。
- error/aborted 能显示可恢复 inline 状态。

### 2.3 Send / Stop 交互

- Composer 支持 compact 默认高度和有上限的多行扩展。
- 禁用条件：未连接、只读/无写能力、正在启动、prompt 为空。
- Stop 调用 `chat.abort` 并更新本地运行状态。
- 发送失败可重试或保留输入。

验收：
- 断线时不能误发送。
- stop 只在 active run 中出现。
- 发送失败后用户输入不会丢失。

### 2.4 错误与连接恢复

- 实现 Gateway starting、disconnected、reconnecting、auth needed、method unsupported、port conflict 等状态展示。
- 错误使用 conversation inline block，不使用大型持久 banner。
- 连接恢复后重新拉取必要历史和 session 状态。

验收：
- 常见故障能定位为 We-Claw、OpenClaw、Gateway auth、model/provider setup 或端口冲突。
- 连接恢复后 transcript 与 session rail 一致。

## 3. Milestone 2: Session Workspace Polish

目标：完善 session rail，但不扩展成 OpenClaw 管理后台。

### 3.1 Session Rail 数据模型

- 标准化 session id、title、subtitle、updatedAt、status、active run 标记。
- 监听 `sessions.changed` 并局部刷新。
- 切换 session 时保留本地 UI 偏好。
- 支持 session count 较大时的基础过滤/搜索。

验收：
- session 列表变化能及时反映。
- active run 与 completed session 可区分。
- 切换 session 不丢失本地 UI 状态。

### 3.2 Session Create / Reset

- 通过 capability probing 判断 `sessions.create` 是否可用。
- 支持 new session action。
- reset 仅在 Gateway 支持且语义明确时加入。
- 不加入 project tree、plugin browser、automation list、OpenClaw admin surface。

验收：
- Gateway 支持时可新建 session。
- Gateway 不支持时 UI 降级隐藏或禁用入口。
- rail 仍然只承担 session 选择和状态展示。

## 4. Milestone 3: Local Install UX

目标：让本地启动路径稳定、可诊断、可文档化。

### 4.1 CLI Entrypoint

- 实现 `we-claw` 与 `we-claw start`。
- 启动 Node server，托管构建后的 Vite UI 与 `/api/*`。
- 自动选择 We-Claw HTTP 端口并打开本地 URL。
- 明确区分 We-Claw port 与 OpenClaw Gateway port。

验收：
- 用户执行一个命令即可打开 UI。
- 生产模式不要求用户同时管理 Vite dev server 和 Node API server。

### 4.2 配置与日志

- 定义最小配置来源：OpenClaw executable path、We-Claw HTTP port、Gateway 默认端口。
- 提供 launcher 日志文件，和 OpenClaw 日志分离。
- 日志默认 redaction token、secret、auth material。
- UI 设置页只展示 v1 诊断信息，不提供完整 OpenClaw 配置编辑器。

验收：
- 失败日志能用于定位问题。
- UI 不暴露模型/provider credential 编辑。
- 不支持远程 Gateway 配置。

### 4.3 打包准备

- 明确 Node 版本要求。
- 明确 OpenClaw 版本要求和发现策略。
- 形成 README 的本地安装/启动/排障章节。

验收：
- 新用户可按文档完成安装和启动。
- 常见失败有对应排障路径。

## 5. Milestone 4: Cowork-like Controls

目标：在聊天/会话闭环稳定后，加入更接近协作代理工作台的控制和可观察性。

### 5.1 运行中 Steering

- 支持 active run 期间追加 steer/follow-up message。
- 明确 Gateway 支持的队列或中断语义。
- UI 显示 queued/sent/failed 状态。

验收：
- 用户能对长任务做中途补充或转向。
- 不伪造 Gateway 不支持的运行语义。

### 5.2 Inline Approvals

- 能力探测 approval RPC 与事件。
- 渲染 `approval.request` inline card。
- 支持 approve/reject。
- 可选 approval inbox 只在 inline flow 工作后考虑。

验收：
- approval 请求可见且可操作。
- 操作结果回写 Gateway。
- 不使用模糊的 “Full Access” 权限语言。

### 5.3 Tool And Artifact Stream Blocks

- 渲染 `tool.call`、`tool.output.text`、`media.image`、`artifact.file`、`artifact.diff` 等 compact block。
- 同一 tool call 生命周期更新同一行，避免重复刷屏。
- 大日志、大 diff、大 JSON、媒体默认 preview-first。
- 支持显式 open、copy path、show raw payload。

验收：
- 用户无需读 raw logs 就能理解代理正在做什么。
- 富内容不撑破 conversation column。
- 本地路径和 auth URL 不进入浏览器 history、route 或日志。

### 5.4 Agent / Model Selectors

- 仅在 Gateway 报告支持时展示。
- 不硬编码模型标签。
- 选择行为通过 Gateway 支持的字段或方法执行。

验收：
- 不展示虚假的 model/provider 能力。
- 不绕过 OpenClaw 配置和权限模型。

## 6. 横切任务

### 6.1 安全与数据处理

- 所有 Gateway/tool/media payload 视为不可信。
- 不把 token 放入 URL、query、localStorage、console logs 或 bootstrap。
- 本地路径默认显示 basename，完整路径只放二级详情。
- 远程 URL 显示 origin/host，打开必须显式操作。
- 禁止音视频 autoplay。

### 6.2 Typed Adapter Boundary

- Gateway 相关类型集中定义。
- 所有 Gateway method 调用走 typed adapter。
- UI 不直接拼 WebSocket frame。
- version/capability probing 集中处理。

### 6.3 状态管理

- Gateway transcript/history 是事实来源。
- 本地 cache 可丢弃、可从 Gateway 恢复。
- 本地只持久化 UI preferences、最近打开 session 等非权威状态。

### 6.4 视觉与交互约束

- 首屏是工作台，不是 landing page。
- Topbar 默认不超过 56px。
- Composer 默认紧凑，扩展高度有上限。
- 左 rail 是 session rail，不是文件树或 admin 面板。
- 不做嵌套卡片。
- 桌面常见宽度下文本不重叠、不溢出。

## 7. 建议开发顺序

1. 搭建 Vite + TypeScript + Node server 单包结构。
2. 实现 Node launcher 的 OpenClaw/Gateway 探测，不先做 UI 复杂交互。
3. 实现 `/api/bootstrap` 与最小诊断 UI。
4. 实现 Gateway WebSocket typed client 和 mock Gateway 测试。
5. 实现 session rail + `sessions.list`。
6. 实现 `chat.history` transcript。
7. 实现 `chat.send` 和 streaming reducer。
8. 实现 `chat.abort` stop 控制。
9. 补齐断线、错误、恢复、方法缺失状态。
10. 跑真实 OpenClaw 手动 E2E。
11. 再进入 session polish、CLI install UX、rich controls。

## 8. 明确延期项

- WeChat/iLink 插件集成。
- OpenClaw 完整配置编辑器。
- 模型/provider credential 管理。
- 远程 Gateway、LAN、Tailscale、公网、TLS 暴露。
- 完整 admin/control UI。
- 项目文件树、插件浏览器、自动化/cron/device 管理。
- 默认右侧详情面板。
- 富 artifact inspector 和内置代码编辑器。
- 移动端/窄屏适配。

## 9. 首个可执行任务包

建议第一个开发 PR 只覆盖以下内容：

- 初始化 Vite + TypeScript 单包项目。
- 新增 Node server 入口，能托管静态 UI。
- 新增 launcher 检测模块：Node version、OpenClaw executable、OpenClaw version、Gateway port probe。
- 新增 `/api/bootstrap`。
- 新增最小桌面工作台壳：rail、topbar、conversation empty/loading/error、composer disabled state。
- 新增 launcher 与 bootstrap 单元测试。

首个 PR 不包含：
- 真实 chat.send。
- streaming UI。
- approvals/tools/artifacts/logs。
- CLI 打包。
- OpenClaw 配置编辑。

这样能先锁定本地运行边界和诊断路径，再用后续 PR 接入 Gateway RPC 与聊天闭环。
