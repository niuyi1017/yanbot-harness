# macOS/Windows 双平台内测发布需求

## 背景与目标

`0.1.0-preview.2` 已在 macOS arm64 和 Windows x64 完成 Reference Adapter 的离线构建与干净机验证，但真实 CodeBuddy 仍待重新认证，两个平台也尚未从同一份公共 SDK/CLI 制品组装并冻结为不可变内测版本。

本期目标是交付两个版本一致、可校验、由测试方自带 CodeBuddy Key 的内测包：

- `darwin-arm64`
- `win32-x64`

## 凭证要求

1. 测试方必须能够使用自己的 CodeBuddy Key，不依赖交付方把共享 Key 固化进包。
2. Runtime 继续支持临时环境变量 `CODEBUDDY_API_KEY`。
3. Runtime 新增 `CODEBUDDY_API_KEY_FILE`，只保存测试方本机受保护凭证文件的路径；Key 文件不进入交付包、仓库、manifest、日志或 Runtime descriptor。
4. 同时设置环境变量与 Key 文件时必须拒绝启动，避免来源优先级不明确。
5. Key 文件必须是普通文件、非空、大小受限；POSIX 平台必须拒绝组/其他用户可读写的权限。Windows 依赖当前用户目录和 ACL，并在文档中明确限制。
6. SDK/CLI 进程不得接收或读取 CodeBuddy Key；只有 Runtime 读取凭证。

## 交付验收标准

1. SDK、CLI、contracts 和离线 Zod tgz 必须只构建一次，并原样用于 macOS/Windows 两个交付包；相同版本不得出现未验证的不同字节制品。
2. macOS 与 Windows Runtime 必须分别在对应 runner 构建，并与公共包组装成版本化外围交付包。
3. 每个平台交付包必须包含平台 Runtime、公共包、Quickstart、Release Notes、manifest 和 SHA256SUMS。
4. macOS arm64 必须在当前 Mac 上使用最终候选包通过真实 CodeBuddy SDK initial/resume/cancel、CLI JSONL 和无残留子进程验证。
5. Windows x64 必须在受保护、仅手动触发的 GitHub-hosted Windows job 中使用最终候选包通过同等真实 CodeBuddy 验证；Secret 不得在 PR/fork 自动流程中使用。
6. Windows 10/11 桌面实机因当前不可用，必须标为首位测试方验收项，不得用 Windows Server 2022 CI 冒充桌面实机证据。
7. 最终候选必须来自干净提交，manifest 为 `gitDirty: false`，版本、提交、目标平台与校验和一致。
8. 只有双平台发布门槛全部通过后才能更新发布日期、创建不可变 preview 标签并发布长期可下载的 Pre-release。

## 本期不做

- Intel Mac、Windows arm64、32 位 Windows。
- MSI/EXE/PKG/DMG 安装器。
- 将 Node.js 打包进 Runtime。
- 公共 npm 或私有 npm Registry 发布。
- 自动升级和自动下载 Runtime。
- 把静态 CodeBuddy Key 写进 SDK、CLI、Runtime 包或普通项目配置文件。
- Windows Authenticode 与 macOS notarization；如果内测设备策略强制要求，再单独立项。

## 外部依赖与阻塞

- Mac 真实认证需要用户通过环境变量、受保护 Key 文件或 macOS Keychain 在本机提供专用内测 Key，不能通过聊天发送。
- Windows 凭证化 CI 需要仓库管理员配置受保护 GitHub Environment Secret。
- 如果测试方包含公司外部人员，现有 proprietary LICENSE 要求另有书面授权协议。
- 最终创建 tag/Pre-release 属于对外可见的不可变发布动作，需要在执行节点由用户确认版本冻结。
