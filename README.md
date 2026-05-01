# We-Claw

We-Claw 是一个运行在本机的 agent 工作台前端。它提供浏览器 UI 和一层很薄的 Node launcher，用来创建、查看、切换和驱动本机 runtime session；实际 agent 执行、会话状态、工具调用和运行时生命周期仍由所选 runtime 负责。

当前默认 runtime 仍是 OpenClaw Gateway。项目已经新增中性的 `/api/runtime/ws` 入口，并支持显式切换到 Claude Agent SDK；Hermes 和 CLI process fallback 是后续 adapter 方向。

当前项目重点是本地开发者机器上的桌面工作台，而不是托管服务或营销页面。

## 当前能力

- 本地浏览器工作台 UI。
- 启动时检测 Node.js、当前 runtime 和本地连接状态。
- 通过 `/api/bootstrap` 暴露安全的启动快照、runtime capability 和诊断信息。
- 通过 `/api/runtime/ws` 建立浏览器到当前 runtime 的统一本地 WebSocket 桥接。
- OpenClaw runtime 下复用 loopback OpenClaw Gateway，并保留 `/api/gateway/ws` 兼容路径。
- Claude Agent SDK runtime 下动态加载 `@anthropic-ai/claude-agent-sdk`，消费 SDK stream 并读取本地 Claude session history。
- 读取 runtime session 列表并切换会话。
- 创建新 session 或 pending work item。
- 读取 `chat.history`、发送 `chat.send`、停止 `chat.abort`。
- 展示连接状态、运行状态、诊断提示、聊天 transcript、compact tool row 和 runtime notice。

## Runtime 支持状态

| Runtime | `WE_CLAW_RUNTIME` | Transport | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| OpenClaw | `openclaw` 或未设置 | `gateway-ws` | 默认可用 | 继续使用 OpenClaw Gateway 作为 session 和 agent lifecycle 来源。 |
| Claude Agent SDK | `claude-agent-sdk` | `library-sdk` | 已接入首期 | 支持 list/create/history/send/abort、stream delta、tool/history 归一化；本机优先复用已登录的 Claude Code 认证态。 |
| Hermes | `hermes` | `stdio-jsonrpc` | 首期已接入 | 通过 Hermes `tui_gateway` adapter 接入，不嵌入 Hermes Dashboard；真实 E2E 依赖 Hermes 本地 Python venv。 |
| CLI process fallback | `cli-process` | `cli-process` | 未实现 | 仅作为 SDK 不适用时的实验性 fallback，不作为默认路径。 |

`WE_CLAW_RUNTIME=auto` 当前等价于 `openclaw`。显式配置 `claude-agent-sdk` 或 `hermes` 才会切换 runtime。

## 技术栈

- TypeScript
- Vite
- Vitest
- Node.js HTTP server
- OpenClaw Gateway WebSocket RPC
- Claude Agent SDK TypeScript package（optional dependency）

项目不实现自定义 agent planner。`src/launcher/*` 负责本地启动、静态资源服务、runtime 探测、OpenClaw 认证注入和 runtime bridge；`src/app/*` 是浏览器工作台；`src/gateway/*` 是 OpenClaw Gateway 客户端协议封装；`src/shared/*` 放共享类型和数据归一化逻辑。

## 环境要求

- Node.js `>=22.12.0`
- npm
- 默认 OpenClaw runtime：本机可用的 OpenClaw CLI（默认命令为 `openclaw`）
- Claude Agent SDK runtime：本机 Claude Code 已完成认证，或提供 SDK 支持的其他认证方式

如果 OpenClaw 不在 `PATH` 中，可以通过 `WE_CLAW_OPENCLAW_BIN` 指定可执行文件路径。

Claude Agent SDK runtime 在本机开发中优先复用同一用户的 Claude Code 登录态，包括 `~/.claude` / `~/.claude.json` 和 macOS keychain OAuth 凭据。`ANTHROPIC_API_KEY`、云供应商认证仍可作为 SDK 支持的可选路径。

Hermes runtime 需要使用 Hermes checkout 自己的 Python 环境。和 `next2next` 固定使用 `backend/.venv/bin/python` 类似，We-Claw 在未显式设置 `WE_CLAW_HERMES_PYTHON` 时会优先探测：

- `$WE_CLAW_HERMES_ROOT/venv/bin/python`
- `$WE_CLAW_HERMES_ROOT/.venv/bin/python`
- `python3`

若 Hermes checkout 尚未准备 venv，先在 Hermes 仓库中运行：

```bash
cd /Users/insunny/Documents/codespace/hermes-agent
./setup-hermes.sh
```

## 安装

```bash
npm install
```

## 本地开发

```bash
npm run dev
```

开发模式启动 Vite dev server，默认绑定到 `127.0.0.1`。开发模式主要用于前端迭代；生产式 launcher 能力请使用构建后启动路径。

## 构建和启动

```bash
npm run build
npm run start
```

`npm run build` 会先运行 TypeScript 构建，再生成 Vite 客户端产物。`npm run start` 会运行构建后的 launcher：

```bash
node dist/src/launcher/cli.js start
```

默认情况下，We-Claw 在 `127.0.0.1:4173` 提供本地 UI，并检查 `127.0.0.1:18789` 上的 OpenClaw Gateway。

使用 Claude Agent SDK runtime：

```bash
npm run build
WE_CLAW_RUNTIME=claude-agent-sdk npm run start
```

限制自动允许的 Claude 内置工具：

```bash
WE_CLAW_RUNTIME=claude-agent-sdk \
WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS=Read,Glob,Grep \
npm run start
```

使用 Hermes runtime：

```bash
npm run build
WE_CLAW_RUNTIME=hermes \
WE_CLAW_HERMES_ROOT=/Users/insunny/Documents/codespace/hermes-agent \
WE_CLAW_HERMES_CWD=/Users/insunny/Documents/codespace/hermes-agent \
npm run start
```

如果不想使用 Hermes checkout 下的默认 `venv/bin/python`，可以显式覆盖：

```bash
WE_CLAW_HERMES_PYTHON=/path/to/hermes/venv/bin/python
```

项目还提供本地生命周期脚本：

```bash
./start.sh
./stop.sh
```

`start.sh` 会构建项目、后台启动 We-Claw 本地服务，并把 pid/log 写入 `.runtime/dev`。`stop.sh` 只停止脚本记录的 We-Claw 进程，不会停止不属于它的 OpenClaw Gateway 监听进程。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WE_CLAW_OPENCLAW_BIN` | `openclaw` | OpenClaw 可执行文件路径或命令名 |
| `WE_CLAW_GATEWAY_PORT` | `18789` | OpenClaw Gateway loopback 端口 |
| `WE_CLAW_HTTP_PORT` | `4173` | We-Claw 本地 HTTP 服务端口 |
| `WE_CLAW_MANAGE_GATEWAY` | enabled | 设为 `0` 时禁用自动启动/管理 Gateway |
| `WE_CLAW_RUNTIME` | `openclaw` | runtime 选择：`openclaw`、`claude-agent-sdk`、`hermes`、`cli-process`、`auto` |
| `WE_CLAW_CLAUDE_SDK_CWD` | `process.cwd()` | Claude Agent SDK session 工作目录 |
| `WE_CLAW_CLAUDE_SDK_PERMISSION_MODE` | `dontAsk` | Claude Agent SDK permission mode |
| `WE_CLAW_CLAUDE_SDK_ALLOWED_TOOLS` | empty | 逗号分隔的 Claude 工具自动允许列表，例如 `Read,Glob,Grep` |
| `WE_CLAW_CLAUDE_SDK_MODEL` | unset | 可选 Claude 模型覆盖 |
| `WE_CLAW_HERMES_ROOT` | unset | 本地 Hermes checkout 路径 |
| `WE_CLAW_HERMES_CWD` | `WE_CLAW_HERMES_ROOT` 或 `process.cwd()` | Hermes 子进程工作目录 |
| `WE_CLAW_HERMES_PYTHON` | auto | Hermes Python 解释器；未设置时优先使用 `venv/bin/python`、`.venv/bin/python`、再回退 `python3` |
| `WE_CLAW_HERMES_STARTUP_TIMEOUT_MS` | `15000` | Hermes TUI Gateway import/startup 超时 |

Gateway token 由 Node 侧解析并在本地桥接握手中注入。`/api/bootstrap` 不会把 token 返回给浏览器。

Claude SDK 凭据也不会通过 `/api/bootstrap` 返回给浏览器；We-Claw 只在 Node 侧调用 SDK。

## 目录结构

```text
src/app/          浏览器工作台 UI
src/gateway/      OpenClaw Gateway WebSocket 客户端
src/launcher/     本地 Node launcher、Gateway 探测和桥接
src/shared/       前后端共享类型和归一化逻辑
test/             Vitest 单元测试
docs/             设计、集成和任务拆分文档
issues/           项目问题和设计记录
plans/            分 feature 的实施计划、验收清单和风险跟踪
```

生成物和本地状态目录：

```text
dist/             构建产物
.runtime/         本地启动 pid 和日志
.omx/             OMX 本地状态、日志和计划
.tmp-screens/     浏览器截图验收产物
```

这些目录已在 `.gitignore` 中忽略。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

前端改动还应在桌面宽视口下手动检查工作台，重点确认 session rail、顶部状态、runtime 诊断、会话 transcript 和 composer 不会在流式更新时错位或溢出。

Runtime 集成改动还应至少覆盖：

- 默认 OpenClaw：`/api/bootstrap` 返回 `runtime.kind=openclaw`，`/api/gateway/ws` 和 `/api/runtime/ws` 都能连到 Gateway。
- Claude Agent SDK：`WE_CLAW_RUNTIME=claude-agent-sdk` 下能完成 `sessions.list`、`sessions.create`、`chat.send`、stream delta/final、`chat.history` 和 `chat.abort`。
- Hermes：`WE_CLAW_RUNTIME=hermes` 且 `WE_CLAW_HERMES_ROOT` 指向可用 checkout 时，`/api/bootstrap` 应显示 `stdio-jsonrpc`，并通过 `/api/runtime/ws` 完成 `sessions.list`、`sessions.create`、`chat.send`、stream delta/final、`chat.history` 和 `chat.abort`。

## 设计边界

- OpenClaw 是默认 agent runtime 和会话状态来源。
- Claude Agent SDK 是显式启用的本机 runtime，首期不替代 OpenClaw 默认路径。
- Hermes 和 CLI process fallback 通过独立 adapter 接入；不要把 runtime 差异散落到 UI 组件里。
- We-Claw 是本地控制面和观察面，不实现自定义 agent planner。
- Runtime bridge 只绑定 loopback，本阶段不支持 LAN、公网或远程 runtime。
- Node launcher 保持薄层职责，不作为通用 RPC 代理，除非认证、CORS 或传输约束需要。
- UI 优先服务桌面工作台体验，当前阶段不做移动端优化。
