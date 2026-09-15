# Managed Local Runtime 任务

2026-09-15 同步：任务 1–3 为已有显式路径 Preview 原语；任务 4 的统一安装细化到
[`unified-local-distribution/tasks.md`](../unified-local-distribution/tasks.md)（已确认，未实现）。任务 5–8 保留高级 Runtime Manager 的后续范围。

## 1. SDK-owned Runtime 核心原语

- 状态：完成。
- 文件：新增 `packages/sdk/src/managed-runtime.ts` 和 `packages/sdk/test/managed-runtime.test.ts`；修改 `packages/sdk/src/index.ts`、SDK README。
- 前置：无。
- 内容：实现可执行文件解析、专用 stateRoot、子进程启动、descriptor + health 就绪、启动超时、提前退出、幂等关闭和 SDK-owned 临时目录清理。
- 验收：`pnpm --filter @yanbot-harness/sdk test:unit`、`pnpm --filter @yanbot-harness/sdk typecheck`；测试覆盖 Reference Runtime 成功请求、无可执行文件、提前退出、超时、多次 close 和临时目录清理。

## 2. CLI ephemeral managed 模式

- 状态：完成。
- 文件：修改 `apps/cli/src/arguments.ts`、`apps/cli/src/index.ts`、CLI README 和对应测试。
- 前置：任务 1。
- 内容：在不改变 `--runtime`/`--descriptor` 优先级的前提下，为已安装 Runtime 增加显式 `--managed-runtime PATH` 或等价入口；CLI 命令结束时必须关闭自己启动的 Runtime，并保留原有 JSONL/stdout 与退出码语义。
- 验收：CLI E2E 覆盖 text、JSONL、cancel/超时清理和启动失败；`pnpm --filter @yanbot-harness/cli test:unit`。

## 3. 脱离仓库的 managed clean-room 验收

- 状态：完成。
- 文件：修改 `scripts/test-release-clean-room.mjs`、`docs/delivery/sdk-cli-quickstart.md`、`docs/delivery/handoff-checklist.md`。
- 前置：任务 1、2。
- 内容：使用 release Runtime archive 中的可执行文件，验证 SDK-owned 和 CLI ephemeral 路径，确认无 repo `node_modules` 解析、descriptor 清理和无残留子进程。
- 发布脚本约束：`--skip-check` 只能跳过 lint/typecheck/test 等门禁，不能跳过 public package 和 Runtime 的构建，避免把陈旧 `dist` 打入新版本 tarball。
- 离线第三方依赖必须先从 pnpm store 解引用复制到普通 staging 目录再 pack，避免不同平台对虚拟存储路径打包不完整。
- 验收：`pnpm release:build --skip-check`、`pnpm release:check`、`pnpm release:test`。

## 4. Runtime 平台包与解析器

- 状态：未实现；以新分发 Spec T0–T7 为实施清单。

- 文件：新增 Runtime meta/platform package 目录；修改 `pnpm-workspace.yaml`、`scripts/build-runtime-bundle.mjs`、`build-release.mjs`、`check-release-artifacts.mjs`、SDK/CLI package manifests。
- 前置：任务 1；已确认私有 Registry 和 package naming。
- 内容：local facade 组合 SDK 与 runtime meta/platform；SDK 保持轻量，默认 resolver 本机校验/展开，保留显式 executable override。
- 验收：Mac arm64 与 Windows x64 私有 Registry/空缓存离线安装后无路径启动；Linux x64 glibc Reference 回归；错误平台/optional 缺失稳定报错。

## 5. 显式安装、更新和回滚

- 文件：新增 Runtime Manager 安装模块；修改 CLI argument/command/output 层、release manifest 与文档。
- 前置：任务 4；签名/来源证明机制和分发端点已确定。
- 内容：实现 `runtime install/update` 的显式操作，签名与 checksum 验证、原子切换、前一版保留和失败回滚。
- 验收：正常安装/升级、签名错误、checksum 错误、断网、磁盘失败、并发安装与回滚测试。

## 6. 共享 Daemon 命令与单实例

- 文件：修改 CLI、SDK Runtime Manager 和 Runtime main/server；新增单实例锁与状态诊断模块。
- 前置：任务 1、4。
- 内容：实现 `runtime start/status/stop/restart/logs/doctor`，防止并发启动覆盖 descriptor，处理孤儿 descriptor、异常退出与版本不兼容。
- 验收：多进程并发启动、崩溃恢复、重启、descriptor 拥有者保护和日志轮转测试。

## 7. OS 凭据 Provider

- 文件：修改 `apps/local-runtime/src/adapters.ts` 及 Runtime 启动配置；新增平台 credential provider 包和文档。
- 前置：任务 1；各平台密钥存储选型已通过安全评审。
- 内容：Runtime 按 credential reference 从 Keychain/Credential Manager/Secret Service 取得 Key；SDK/CLI 不读取或返回凭据值。
- 验收：成功获取、缺失、拒绝、轮换和日志/持久化扫描；证明 SDK/CLI 子进程环境不含 Key。

## 8. 跨平台发布与正式门禁

- 状态：部分完成。当前已有 `ubuntu-24.04` x64、`macos-15` arm64、`windows-2022` x64 Reference matrix 和受保护 Windows CodeBuddy workflow；Windows 10/11 真实验收仍待完成。正式签名/provenance、Intel Mac 和新统一安装认证未完成，证据以交付矩阵为准。
- 文件：GitHub Actions workflow、release 脚本、compatibility/handoff/capability 文档。
- 前置：任务 3–7；发布凭据、license 和签名身份就绪。
- 内容：CI matrix 构建、聚合、签名、生成 provenance，在各目标运行 clean-room Reference，并在受控环境完成 CodeBuddy 验证。
- 验收：`pnpm check`、全部 release gates、目标平台无残留进程；最终 compatibility matrix 只标记有完整证据的平台和能力。
