# Windows SDK/CLI 内测交付需求

## 背景与目标

`0.1.0-preview.2` 已具备 macOS arm64 与 Linux x64 的 SDK、CLI、Runtime 离线交付链路，但现有 Runtime 包只提供 POSIX shell 启动器和 `.tar.gz` 归档，Windows 也尚未经过真实的进程生命周期与干净机验证。

本期目标是在不改变 SDK/CLI/Runtime 协议和密钥边界的前提下，产出可在 Windows 10/11 x64 上安装、启动、停止和验收的内测交付包，并通过 Windows CI 的 Reference Adapter 干净机验证。

## 交付基线

- 操作系统：Windows 10/11 x64。
- Node.js：`>=22.22.0 <23`。
- Shell：PowerShell 5.1+ 或 PowerShell 7；CLI 也可由 `cmd.exe` 调用。
- 分发方式：离线文件包，不依赖私有 npm Registry。
- Runtime：随 Windows 交付包提供 Windows 启动器；Runtime 仍依赖目标机器已安装兼容 Node.js。
- 密钥：CodeBuddy Key 仅注入 Runtime 进程环境，不写入 SDK、CLI、归档、manifest 或日志。

## 验收标准

1. Given Windows x64 构建环境，When 执行 release build，Then 必须生成平台标识为 `win32-x64` 的 Runtime 归档，归档内容包含 managed 模式使用的 Node 启动器、人工调用使用的 `.cmd` 启动器和 `runtime-manifest.json`。
2. Given 解压后的 Windows Runtime，When 执行启动器的 `--version`，Then 输出必须与 SDK、CLI 和 manifest 版本一致。
3. Given Windows Runtime 启动器路径，When SDK 调用 `startManagedRuntime()` 或 CLI 使用 `--managed-runtime`，Then Runtime 必须成功启动、通过 health 检查，并在调用结束后退出且清理 descriptor 和临时状态目录。
4. Given Windows 干净目录和离线 tgz 包，When 安装 SDK/CLI 并执行 Reference Adapter 验证，Then SDK 的 managed/text/interaction/cancel 与 CLI 的 managed/text/JSONL/resume/cancel 全部通过。
5. Given Windows release 目录，When 执行 artifact check，Then校验和、manifest、依赖边界、敏感文件扫描与 Runtime 归档内容检查全部通过。
6. Given GitHub Actions 的 Windows runner，When push 或 PR 触发 CI，Then Windows release reference job 必须构建并通过 artifact check 与 clean-room test，并上传可下载的 Windows 交付物。
7. Given 最终候选提交与专用内测 Key，When 在 Windows 实机执行 CodeBuddy 认证，Then初次运行、续跑、取消、CLI JSONL 和退出后无残留进程均有可审计结果；完成前不得将 Windows 标为 CodeBuddy 已认证。

## 非功能要求

- Windows 适配不得破坏现有 macOS arm64 和 Linux x64 构建及测试。
- 进程停止必须有界；不得依赖 Windows 不支持的 POSIX 文件权限或信号语义。
- 归档生成与校验不得依赖未声明的第三方全局工具。
- 交付文档必须使用 Windows 路径与 PowerShell 示例，且不得引导用户把 Key 写入项目文件。

## 本期不做

- Windows arm64、Windows 7/8、32 位 Windows。
- 将 Node.js 打包进 Runtime，或生成原生 `.exe` 安装器/MSI。
- 自动下载/自动升级 Runtime。
- 代码签名、SmartScreen 声誉、企业级安装器和系统服务注册。
- 私有 npm Registry 发布。
- 在没有 Windows 实机凭证测试证据的情况下宣称 CodeBuddy Adapter 已在 Windows 认证。

## 依赖与风险

- `@tencent-ai/agent-sdk` 必须能在 Windows x64 + Node 22 上运行；Reference Adapter CI 只能证明 Harness 自身链路，不能代替真实 CodeBuddy 验证。
- Windows 对 `.cmd` 启动器和进程终止的语义不同于 POSIX，需要显式适配和测试。
- Windows 路径长度、反斜杠、临时目录清理和文件占用可能导致仅在 Windows runner 暴露的问题。
- 对外部内测人员不得发放共享生产 Key；应使用独立、限额、可撤销的内测 Key，或由对方提供 Key。
