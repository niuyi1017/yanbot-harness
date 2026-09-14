# macOS/Windows 双平台内测发布任务清单

状态说明：`[ ]` 未开始，`[-]` 被外部条件阻塞，`[x]` 已验证完成。

## A. 已有基线

- [x] A1. macOS arm64 Reference release build/check/clean-room 通过。
- [x] A2. Windows x64 Reference release build/check/clean-room 通过。
- [x] A3. CI 可下载 `darwin-arm64` 与 `win32-x64` 临时 artifacts。

## B. 测试方 BYOK 配置

- [x] B1. 新增 `CODEBUDDY_API_KEY_FILE` 安全读取与双来源冲突检查。
  - 执行：Codex。
  - 文件：`apps/local-runtime/src/main.ts`、新增凭证模块及测试。
  - 验收：文件边界、权限、格式、脱敏与环境变量回归测试全部通过。
- [x] B2. 更新 macOS/Windows Quickstart，提供测试方自行配置 Key 的步骤。
  - 执行：Codex。
  - 验收：文档不包含真实 Key，不要求修改交付包内文件。

## C. 公共包单次构建与双平台组包

- [x] C1. 拆分公共 SDK/CLI 打包、平台 Runtime 构建和 release 组装脚本。
  - 执行：Codex。
  - 验收：现有 `pnpm release:build/check/test` 兼容，公共 tgz 只构建一次。
- [x] C2. 调整 CI，使 macOS/Windows 使用同一份公共 tgz。
  - 执行：Codex。
  - 验收：两个平台内同名 tgz SHA256 完全一致。
- [x] C3. 生成两个版本化外围 zip 和独立 checksums。
  - 执行：Codex。
  - 验收：可在仓库外解压、离线安装并完成 Reference clean-room。

验证证据：提交 `df6b152` 的 [CI run 34820862814](https://github.com/niuyi1017/yanbot-harness/actions/runs/34820862814)
通过 Linux/macOS/Windows 平台组装与 clean-room，最终 common-package hash 汇总校验通过。

## D. 真实 CodeBuddy 认证

- [-] D1. 在当前 Mac 执行最终候选的真实 CodeBuddy 认证。
  - 执行：Codex。
  - 阻塞：当前 Codex 进程没有 Key；用户需在受保护文件或 macOS Keychain 中提供，不能发到聊天。
  - 验收：SDK initial/resume/cancel、CLI JSONL、子进程数 0。
- [x] D2. 新增受保护的手动 Windows CodeBuddy workflow。
  - 执行：Codex。
  - 验收：仅 `workflow_dispatch`，绑定 Environment，普通 push/PR 不接触 Secret。
- [-] D3. 配置 GitHub Environment Secret 并执行 Windows CodeBuddy gate。
  - 执行：用户配置 Secret；Codex 触发、监控和修复。
  - 阻塞：需要仓库管理员权限和专用内测 Key。
  - 验收：SDK/CLI 与残留进程检查通过；证据只记录非敏感摘要。
- [-] D4. Windows 10/11 首位测试方实机验收。
  - 执行：测试方；Codex 提供验收脚本并分析结果。
  - 阻塞：当前没有 Windows 10/11 实机。

## E. 冻结与发布

- [ ] E1. 更新测试数量、兼容矩阵、CodeBuddy 证据和 Changelog 日期。
  - 执行：Codex。
- [ ] E2. 从最终干净提交重建并验证双平台外层包。
  - 执行：Codex + CI。
  - 验收：`gitDirty: false`，manifest commit 一致，所有 checksum 通过。
- [-] E3. 创建不可变 `v0.1.0-preview.2` 标签。
  - 执行：Codex。
  - 阻塞：D1、D3 与 E1、E2 完成后，由用户确认冻结。
- [-] E4. 创建 GitHub Pre-release 并上传两个平台包。
  - 执行：Codex。
  - 阻塞：E3 和用户确认发布。

## F. 可延后项

- [ ] F1. Intel Mac 支持，仅在确认存在 `darwin-x64` 测试方时立项。
- [ ] F2. MSI/EXE/DMG、签名与 notarization，仅在设备策略阻塞时立项。
- [ ] F3. 私有 npm Registry 与 Runtime 自动更新，不阻塞离线内测。
