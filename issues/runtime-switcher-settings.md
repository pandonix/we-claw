# Issue: 在前端设置中支持主动切换 Runtime

## 背景

Claude Agent SDK runtime 已经完成首期集成，但当前切换方式仍然是启动时通过环境变量选择：

- 默认或 `WE_CLAW_RUNTIME=openclaw`：连接 OpenClaw Gateway。
- `WE_CLAW_RUNTIME=claude-agent-sdk`：连接本地 Claude Agent SDK bridge。

这证明了 runtime bridge 的后端边界可行，但从用户视角仍然不够自然。用户在 We-Claw 前端里看到的是一个工作台，却不能在“本地设置”里主动选择当前要使用 OpenClaw 还是 Claude Agent SDK。切换 runtime 需要停止服务、重新设置环境变量、重启 launcher，再刷新页面。

## 问题

当前体验的问题：

- 设置入口已经出现在左侧 rail，但没有绑定实际设置视图。
- Runtime 选择隐藏在环境变量中，普通用户很难发现。
- 用户无法在 UI 中看到当前 runtime 的可选项、可用性、cwd、权限模式、工具白名单等关键信息。
- 切换 OpenClaw / Claude Agent SDK 会影响 session 列表、work index、history 加载和运行中任务，但 UI 没有明确的切换流程。
- 当前本地 `workIndex` / title cache 没有按 runtime 或 cwd 分区，切换后可能残留上一 runtime 的工作项。

## 目标

- 在前端“本地设置”中提供 runtime 选择入口。
- 用户可以主动选择 `OpenClaw` 或 `Claude Agent SDK`。
- 切换前展示当前 runtime 状态、版本、transport、可用性和主要配置。
- 切换后前端能重新 bootstrap、重连 `/api/runtime/ws`，并刷新当前 runtime 的工作列表。
- 处理 runtime 之间的工作列表隔离，避免 OpenClaw work item 混入 Claude SDK 视图。
- 对需要 launcher 重启才能生效的配置给出明确状态和操作路径。

## 非目标

- 不做多 runtime 同屏连接。
- 不在本 issue 内实现 Hermes 或 CLI process adapter。
- 不实现 Claude inline approval allow/deny UI；审批交互另开 issue。
- 不实现完整 OpenClaw 配置编辑器或 credential 管理器。
- 不把 We-Claw 变成通用 runtime 管理后台。
- 不切换正在运行中的任务；存在 active run 时应先阻止或要求停止。

## 产品设计建议

左侧 `本地设置` 打开一个设置面板或 modal，首期只需要一个 `Runtime` section。

建议展示：

- 当前 runtime：`OpenClaw` / `Claude Agent SDK`。
- 状态：connected / disconnected / error。
- 版本：OpenClaw version 或 Claude Agent SDK package version。
- Transport：`gateway-ws` / `library-sdk`。
- OpenClaw：Gateway URL、ownership、process state。
- Claude SDK：cwd、permission mode、allowed tools、model。
- 诊断：沿用 `/api/bootstrap.diagnostics` 的 message/detail。

切换控件建议使用 segmented control 或 select：

- `OpenClaw`
- `Claude Agent SDK`

当目标 runtime 不可用时，选项仍可见，但展示不可用原因，例如：

- OpenClaw executable missing。
- Gateway unreachable。
- Claude Agent SDK package missing。
- Claude auth 未确认或首条请求可能失败。

## 技术方向

当前 `WE_CLAW_RUNTIME` 是进程启动时配置。要支持 UI 主动切换，需要先决定配置生效边界。

### 方案 A: 进程内切换

新增 launcher API，例如：

```text
GET  /api/runtime/options
POST /api/runtime/select
```

`POST /api/runtime/select` 更新 `LauncherContext.config.runtimeKind`，关闭当前 runtime socket，后续 `/api/bootstrap` 和 `/api/runtime/ws` 按新 runtime 返回。

优点：

- 用户体验最好，不需要重启 We-Claw。
- 前端只需要重新 bootstrap/reconnect。

风险：

- 当前 `installRuntimeBridge` 创建了单个 `ClaudeAgentSdkRuntime` 实例；切换时需要明确 local session、active run、subscribers 如何清理。
- OpenClaw Gateway 管理逻辑只在 server start 时运行；切回 OpenClaw 时可能需要补一次 `ensureGateway` 或降级为手动诊断。
- 需要阻止 active run 中切换。

### 方案 B: 设置持久化 + 提示重启

新增本地配置文件或 launcher storage，前端写入目标 runtime。写入后 UI 显示“需要重启 We-Claw 生效”。

优点：

- 实现风险较低。
- 避免进程内 runtime 清理和 Gateway 生命周期复杂度。

风险：

- 用户仍然需要重启，体验只比环境变量略好。
- `./start.sh` / `npm run start` 需要读取同一份本地配置，避免环境变量和设置文件优先级不清。

### 推荐首期

先做方案 B，明确配置来源和重启提示；随后再评估方案 A。

原因：

- 当前 runtimeKind 是 launcher 启动配置，强行热切换会影响 socket、active run、Gateway 管理和 local Claude session cache。
- 首期目标是让用户可以在 UI 发现和选择 runtime，而不是马上实现无缝热切换。
- 可以把设置持久化、runtime-scoped work index、设置面板状态先打牢。

## 数据与状态隔离

切换 runtime 后，前端本地状态应按 runtime scope 隔离。

建议 key：

```text
runtimeScope = runtime.kind + ":" + runtime transport + ":" + workspace/cwd
```

用于：

- `we-claw.workIndex.v1`
- `we-claw.sessionTitleCache.v1`
- active work/session cache

首期可以改成：

```text
we-claw.workIndex.v1:<runtimeScope>
we-claw.sessionTitleCache.v1:<runtimeScope>
```

OpenClaw scope 可使用 Gateway URL 或 workspace 信息。Claude SDK scope 至少包含 `WE_CLAW_CLAUDE_SDK_CWD`。

## 实施建议

1. 为 `本地设置` 按钮补齐设置面板 UI。
2. 在 shared type 中补 runtime option / runtime settings 类型。
3. 在 launcher 增加只暴露安全字段的 runtime options API。
4. 增加 runtime selection 的持久化来源，并明确优先级：
   - env override 优先。
   - 本地设置文件次之。
   - 默认 `openclaw`。
5. 前端展示 env override 状态；当 env 强制指定 runtime 时，选择控件应显示 locked 状态。
6. 切换 runtime 后清空当前连接、active work、chat state，并重新 bootstrap。
7. 将 work index 和 title cache 改为 runtime-scoped storage key。
8. 对 active run 中切换做保护：禁用切换控件或提示先停止当前运行。
9. 更新 README 的配置说明，补充 UI 设置与环境变量优先级。
10. 增加 focused tests 覆盖 config 优先级、runtime scope key 和 settings API。

## 验收标准

- 点击 `本地设置` 能打开设置面板。
- 设置面板能展示当前 runtime、版本、transport、状态和诊断。
- 用户能在 UI 中选择 OpenClaw 或 Claude Agent SDK。
- 如果当前由 `WE_CLAW_RUNTIME` 强制指定，UI 明确显示 runtime 选择被环境变量锁定。
- 切换配置后，UI 明确说明是否已生效或需要重启。
- 切换到 Claude Agent SDK 后，工作列表不混入 OpenClaw work items。
- 切换回 OpenClaw 后，OpenClaw work items 和 Gateway sessions 正常恢复。
- active run 期间不能切换 runtime，或必须先停止当前 run。
- `npm run typecheck`、`npm test`、`npm run build` 通过。

## 风险

- Runtime 热切换如果做得过早，容易留下 stale WebSocket subscriber、active run 或 local Claude pending session。
- 环境变量、本地设置文件和未来 CLI 参数的优先级需要非常清楚，否则会出现“UI 选择了但没生效”的困惑。
- Runtime-scoped localStorage 迁移要避免丢失用户现有 work index。
- Claude SDK 的认证状态目前不是 bootstrap 强校验，设置页只能展示“包可用/配置存在”，不能保证首条 prompt 一定成功。
