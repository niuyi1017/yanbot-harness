# M3 TypeScript SDK 与 CLI 任务拆解

## 状态

- [x] M3-S0：建立 M3 子 Spec。
- [x] M3-S1：补齐客户端响应 contracts。
- [x] M3-S2：实现 TypeScript SDK transport、client 和 daemon 发现。
- [x] M3-S3：完成 SDK 单元及真实 Runtime 黑盒测试。
- [x] M3-S4：实现 CLI 命令、输出、交互和退出码。
- [x] M3-S5：完成 CLI 子进程 E2E 与离线第三方调用模拟。
- [x] M3-S6：改写 SDK 示例、README 和包边界门禁。
- [x] M3-S7：执行全量检查并记录 M3 结论。

## 完成结论（2026-09-08）

- `packages/sdk` 已覆盖显式端点、嵌入式 handle 和受保护 daemon descriptor，所有核心 HTTP 响应及 SSE 事件均经过公共 schema 校验。
- `apps/cli` 已提供 run/adapters/models/sessions/run-status/cancel、text/JSONL、TTY Interaction、权限策略、配置 scope、resume、稳定错误和退出码。
- SDK 真实 Runtime 黑盒测试、CLI 构建产物子进程 E2E、Session resume 及失败退出码测试均通过。
- `pnpm check` 全量通过，共 104 项测试；contracts 12、SDK 7、CLI 3，其余既有 82 项。
- contracts、SDK、CLI tarball 已在临时空目录通过 npm 安装，`node_modules/.bin/yanbot-harness --version` 返回 `0.1.0`。
- 已人工启动 Reference daemon，并由另一个 CLI 进程通过 descriptor + Bearer + HTTP/SSE 完成离线调用；收到 sequence 1–6 及 `run.completed`，退出码为 0。
- 临时测试目录、daemon 和打包目录均已清理，未写入真实凭据。
- 真实 CodeBuddy 探针仍 pending，继续作为生产发布门禁；该状态不影响 M3 Reference Adapter 离线验收。

## M3-S0. 建立 M3 子 Spec

**文件**：`docs/specs/sdk-cli/{requirements,design,tasks}.md`

**前置**：M2 完成。

**验收**：需求、技术边界、替代方案、任务和验证方式可独立 review，且实现前进入 Git 历史。

## M3-S1. 补齐客户端响应 contracts

**文件**：`packages/contracts/src/index.ts`、`packages/contracts/test/contracts.test.ts`

**前置**：M3-S0。

**内容**：为 health、adapter summary、有效配置摘要和 extension summary 增加严格 schema/type；复用已有 manifest/model/config/extension 公共定义。

**验收**：contracts 单测覆盖合法与未知字段/非法字段拒绝，`pnpm --filter @yanbot-harness/contracts test:unit` 通过。

## M3-S2. 实现 TypeScript SDK

**文件**：`packages/sdk/package.json`、`tsconfig.json`、`src/{index,client,transport,daemon}.ts`

**前置**：M3-S1。

**内容**：实现 `HarnessClient`、`RunHandle`、标准错误、JSON transport、SSE parser、显式/handle/daemon 三种连接方式及所有 M2 公共端点。

**验收**：SDK build/typecheck 通过，生产依赖仅 contracts，不含 Adapter 或厂商 SDK。

## M3-S3. SDK 测试

**文件**：`packages/sdk/test/{client,daemon,runtime-e2e}.test.ts`

**前置**：M3-S2。

**内容**：覆盖错误脱敏、响应 schema、SSE 分块/游标/取消、descriptor 安全检查；以 Reference Adapter 启动真实 Runtime 覆盖完整客户端流程。

**验收**：`pnpm --filter @yanbot-harness/sdk test:unit` 通过，包含至少一条真实 HTTP/SSE 黑盒链路。

## M3-S4. 实现 CLI

**文件**：`apps/cli/package.json`、`tsconfig.json`、`src/{index,main,arguments,output,interactions}.ts`

**前置**：M3-S2。

**内容**：实现 run/adapters/models/sessions/run-status/cancel，text/JSONL renderer，TTY Interaction，连接来源解析和稳定退出码。

**验收**：CLI build/typecheck 通过；无 `--token` 或权限绕过参数；CLI 生产依赖不包含 Runtime、Adapter 或厂商包。

## M3-S5. CLI E2E 与第三方模拟

**文件**：`apps/cli/test/cli-e2e.test.ts`、必要的测试 fixture。

**前置**：M3-S3、M3-S4。

**内容**：启动 Reference Adapter Runtime，以 CLI 构建后子进程通过 descriptor 调用，验证 text、JSONL、Session 续接和失败退出码。随后执行一次人工可复现的离线模拟命令。

**验收**：子进程只通过公开 SDK/HTTP/SSE 完成 Run；输出包含预期 assistant 文本和终态；无需网络凭据。

## M3-S6. 示例、文档与边界

**文件**：`examples/sdk-basic/*`、`README.md`、`scripts/check-package-boundaries.mjs`

**前置**：M3-S3、M3-S4。

**内容**：将示例改为只依赖 SDK；记录 API/CLI/daemon/凭据优先级/退出码/Reference 模拟；扩展 SDK/CLI 禁止厂商依赖和 CLI 禁止 Runtime 内部依赖门禁。

**验收**：示例 package 仅有 sdk workspace dependency，README 命令可执行，边界脚本能捕获违规 fixture 或有对应逻辑单测/静态断言。

## M3-S7. 全量验收

**文件**：本文件及必要的状态文档。

**前置**：M3-S1 至 M3-S6。

**内容**：执行 format、lint、boundary、build、typecheck、unit/E2E；检查 git diff 和敏感信息；更新任务状态和总体 README 阶段结论。

**验收**：`pnpm check` 通过；记录测试数量及离线模拟结果；明确真实 CodeBuddy 探针仍 pending 或给出本次受控探针证据。
