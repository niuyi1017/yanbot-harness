# Windows SDK/CLI 内测交付任务

当前状态：任务 1-5 的 Reference 构建与验证已在 Windows runner 通过；任务 6 的 Windows 实机 CodeBuddy
认证、最终文档冻结和 preview 标签仍待完成。

## 1. 建立 Windows Runtime 构建产物

- 文件：`scripts/build-runtime-bundle.mjs`。
- 前置：无。
- 内容：生成 `yanbot-harness-runtime.cmd`，使用 zip 作为 Windows Runtime 归档；保留 POSIX tar.gz 行为。
- 验收：Windows runner 上归档名包含 `win32-x64.zip`，解压后 `--version` 与 package version 一致。

## 2. 适配 SDK managed Runtime 的 Windows 生命周期

- 文件：`packages/sdk/src/managed-runtime.ts`、`packages/sdk/test/managed-runtime.test.ts`。
- 前置：任务 1 的启动器约定。
- 内容：安全调用 `.cmd`/`.bat`，实现有界 Windows 进程树终止，并保持 descriptor 所有权与幂等 close。
- 验收：单元测试通过；Windows clean-room managed SDK/CLI 运行后无 Runtime 残留、descriptor 和临时目录均已清理。

## 3. 让 release 校验和干净机测试识别 Windows 包

- 文件：`scripts/check-release-artifacts.mjs`、`scripts/test-release-clean-room.mjs`、`scripts/test-release-codebuddy.mjs`，必要时新增共享脚本模块。
- 前置：任务 1、2。
- 内容：支持 zip 查找、解压、启动器定位、文本扫描和 Windows 停机；保持现有 SDK/CLI 行为断言不降级。
- 验收：macOS/Linux 现有 release 测试继续通过；Windows Reference release build/check/test 通过。

## 4. 增加 Windows CI 与可下载交付物

- 文件：`.github/workflows/ci.yml`。
- 前置：任务 1-3。
- 内容：增加 `windows-2022` / `win32-x64` matrix，上传版本化 Windows release 目录。
- 验收：远端 Windows job 成功，CI 页面可下载名称明确的 Windows artifact，解压后校验文件完整。

## 5. 更新 Windows 交付文档和认证声明

- 文件：`docs/delivery/compatibility.md`、`docs/delivery/sdk-cli-quickstart.md`、`docs/delivery/handoff-checklist.md`、`CHANGELOG.md`、必要的 README。
- 前置：任务 1-4 的最终行为。
- 内容：写明 Windows 10/11 x64、Node 22、PowerShell 操作、Runtime 路径和 Key 边界；区分 Reference CI 通过与 CodeBuddy 实机认证。
- 验收：从零按文档能在 Windows 非仓库目录安装 SDK/CLI、校验并启动 Runtime；文档不含密钥或本机绝对路径。

## 6. 执行 Windows 实机 CodeBuddy 认证并冻结预览版

- 文件：`docs/delivery/handoff-checklist.md`、`CHANGELOG.md`、最终 `release/<version>/manifest.json` 与 `SHA256SUMS`。
- 前置：任务 1-5、专用限额内测 Key。
- 内容：在 Windows x64 实机对最终包执行初次运行、续跑、取消、CLI JSONL、managed/daemon 生命周期和残留进程检查；修订证据后从最终干净提交重建。
- 验收：全部门槛通过，manifest 为 `gitDirty: false` 且 commit 与标签候选一致，才创建并推送不可变 preview 标签。
