# We-Claw

We-Claw 是一个运行在本机的 OpenClaw 工作台前端。它提供浏览器 UI 和一层很薄的 Node launcher，用来创建、查看、切换和驱动 OpenClaw Gateway session；实际 agent 执行、会话状态、工具调用和运行时生命周期仍由 OpenClaw 负责。

当前项目重点是本地开发者机器上的桌面工作台，而不是托管服务或营销页面。

## 当前能力

- 本地浏览器工作台 UI。
- 启动时检测 Node.js、`openclaw` 可执行文件和本地 Gateway 状态。
- 在生产式启动路径中发现或管理 loopback OpenClaw Gateway。
- 通过 `/api/bootstrap` 暴露安全的启动快照和诊断信息。
- 通过 `/api/gateway/ws` 建立浏览器到 OpenClaw Gateway 的本地 WebSocket 桥接。
- 读取 Gateway session 列表并切换会话。
- 创建新 session（当 Gateway 暴露 `sessions.create` 时）。
- 读取 `chat.history`、发送 `chat.send`、停止 `chat.abort`。
- 展示连接状态、运行状态、诊断提示和聊天 transcript。

## 技术栈

- TypeScript
- Vite
- Vitest
- Node.js HTTP server
- OpenClaw Gateway WebSocket RPC

项目不引入独立 agent runtime。`src/launcher/*` 只负责本地启动、静态资源服务、Gateway 探测、认证注入和桥接；`src/app/*` 是浏览器工作台；`src/gateway/*` 是 Gateway 客户端协议封装；`src/shared/*` 放共享类型和数据归一化逻辑。

## 环境要求

- Node.js `>=22.12.0`
- npm
- 本机可用的 OpenClaw CLI（默认命令为 `openclaw`）

如果 OpenClaw 不在 `PATH` 中，可以通过 `WE_CLAW_OPENCLAW_BIN` 指定可执行文件路径。

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

Gateway token 由 Node 侧解析并在本地桥接握手中注入。`/api/bootstrap` 不会把 token 返回给浏览器。

## 目录结构

```text
src/app/          浏览器工作台 UI
src/gateway/      OpenClaw Gateway WebSocket 客户端
src/launcher/     本地 Node launcher、Gateway 探测和桥接
src/shared/       前后端共享类型和归一化逻辑
test/             Vitest 单元测试
docs/             设计、集成和任务拆分文档
issues/           项目问题和设计记录
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

前端改动还应在桌面宽视口下手动检查工作台，重点确认 session rail、顶部状态、Gateway 诊断、会话 transcript 和 composer 不会在流式更新时错位或溢出。

## 设计边界

- OpenClaw 是 agent runtime 和会话状态来源。
- We-Claw 是本地控制面和观察面，不实现自定义 agent planner。
- Gateway 只绑定 loopback，本阶段不支持 LAN、公网或远程 Gateway。
- Node launcher 保持薄层职责，不作为通用 Gateway RPC 代理，除非认证、CORS 或传输约束需要。
- UI 优先服务桌面工作台体验，当前阶段不做移动端优化。
