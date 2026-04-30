# Claude SDK Integration Plan

本目录用于跟进 Claude Agent SDK runtime 的独立开发，结构参考 `../next2next/plan/<专项>/`：先沉淀实施建议，再维护 TODO，最后用验收清单收口。

当前文档分工：

- [`01-集成基线与实施建议.md`](/Users/insunny/Documents/codespace/we-claw/plans/claude-sdk-integration/01-集成基线与实施建议.md)：记录本轮基线、边界与首期实现选择
- [`02-实施TODO.md`](/Users/insunny/Documents/codespace/we-claw/plans/claude-sdk-integration/02-实施TODO.md)：按可合并粒度跟踪实现任务
- [`03-验收清单.md`](/Users/insunny/Documents/codespace/we-claw/plans/claude-sdk-integration/03-验收清单.md)：记录自动化与手动验收口径

上位输入：

- [`docs/hermes-integration-impact-analysis.md`](/Users/insunny/Documents/codespace/we-claw/docs/hermes-integration-impact-analysis.md)
- Claude Agent SDK TypeScript 官方文档：`query()`、`listSessions()`、`getSessionMessages()`、`includePartialMessages`、`abortController`

当前结论：

- 首期优先实现 `WE_CLAW_RUNTIME=claude-agent-sdk` 的单 runtime 模式
- 前端继续使用 We-Claw 内部 `{ type: "req", method, params }` WebSocket 协议
- Node launcher 负责把 We-Claw 会话/聊天方法翻译成 Claude Agent SDK 调用
- OpenClaw Gateway 路径保持兼容，不作为本专项重构对象
