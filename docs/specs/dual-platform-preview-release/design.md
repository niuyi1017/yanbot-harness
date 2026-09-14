# macOS/Windows 双平台内测发布设计

## 发布拓扑

```text
common-packages job (one build)
  -> contracts/sdk/cli/zod tgz + package SHA256
  -> darwin-arm64 Runtime job
  -> win32-x64 Runtime job
  -> per-platform assembly/check/Reference clean-room
  -> protected CodeBuddy gates
       -> current Mac local gate
       -> manual GitHub Windows gate
  -> version freeze
  -> tag + GitHub Pre-release
```

公共包只构建一次，两个平台仅构建自己的 Runtime。组包过程复制公共 tgz，而不是在每个平台重新执行 `npm pack`。最终可以有不同的平台外围 zip，但同名同版本 SDK/CLI tgz 的 SHA256 必须一致。

## BYOK 设计

### 支持的凭证来源

- `CODEBUDDY_API_KEY`：现有临时环境变量，适合一次性命令和 CI。
- `CODEBUDDY_API_KEY_FILE`：新增路径配置，适合测试方持久维护自己的 Key。

两者互斥。Key 文件在 Runtime 启动早期读取，内容只允许一行非空文本，可接受一个结尾换行；拒绝 NUL、多行和超过 16 KiB 的文件。读取后的值仅传入 Runtime 的 Adapter context 和 redaction secrets，不写回 `process.env`，也不暴露在 public config summary。

macOS 默认建议路径：

```text
~/.config/yanbot-harness/codebuddy.key
```

并要求 mode `0600`。Windows 默认建议路径：

```text
%LOCALAPPDATA%\YanbotHarness\codebuddy.key
```

文档要求该文件仅当前 Windows 用户可访问。内测包不自动创建或修改凭证文件。

### 为什么不使用普通配置文件内联 Key

仓库现有 config-loader 主动拒绝 `apiKey`/`secret` 等内联敏感字段。保持这一边界能避免 Key 被提交到 Git、复制进交付包、进入配置摘要或诊断日志。Key 文件路径是配置，Key 内容仍是外部凭证。

## Runtime 改动

`apps/local-runtime/src/main.ts` 在启动 server 前解析凭证来源，并把解析后的只读 environment map 传给 `createEnvironmentContextProvider()`。新增独立凭证读取模块和单元测试，覆盖：

- 环境变量；
- Key 文件；
- 双来源冲突；
- 文件不存在、非普通文件、过大、空值、多行；
- POSIX 宽松权限；
- 日志、descriptor 和公共配置不含 Key。

`release:test:codebuddy` 保持通过环境变量接收 CI Secret；交付方本地 Mac 可以通过一个不回显的调用包装器从受保护文件或 Keychain 取得 Secret，再只注入测试进程。

## 公共包与平台组装

将当前 `scripts/build-release.mjs` 的职责拆分为可组合阶段：

1. `build-client-packages`：构建/打包 contracts、SDK、CLI 和 Zod。
2. `build-runtime-bundle`：在当前 OS 构建一个 Runtime archive。
3. `assemble-release`：复制公共包和指定平台 Runtime，生成文档、manifest、SHA256SUMS 和版本化外围 zip。

保留一个兼容的 `release:build` 入口供本地使用。CI 增加 common package artifact，平台 jobs 下载同一 artifact 后组装，最终额外校验公共 tgz SHA256 一致。

最终文件名：

```text
yanbot-harness-0.1.0-preview.2-darwin-arm64.zip
yanbot-harness-0.1.0-preview.2-win32-x64.zip
```

## 凭证化认证

### macOS

在当前 arm64 Mac 上从最终候选提交重新构建，执行：

- `pnpm release:check`
- `pnpm release:test`
- `pnpm release:test:codebuddy`

真实测试结果只记录版本、提交、平台、通过场景和子进程数，不记录 Key、请求正文或供应商原始敏感日志。

### Windows

新增独立 `workflow_dispatch` workflow，绑定受保护 Environment，例如 `internal-preview-codebuddy`。仅从 Environment Secret 注入 `CODEBUDDY_API_KEY`，不在 `pull_request` 或普通 `push` 中运行。job 在 `windows-2022` 上构建/下载最终候选并执行同一 `release:test:codebuddy`。

Windows Server 2022 的认证范围是 Node/Runtime/CLI/SDK/进程语义。Windows 10/11 桌面兼容性保留为内测验收，不扩大声明。

## 冻结与发布

双平台真实门槛通过后：

1. 更新 Changelog 日期和 handoff evidence。
2. 从最终干净提交重建外围包。
3. 校验 manifest、公共包 hash、平台 Runtime hash 和外层 zip hash。
4. 创建 `v0.1.0-preview.2` 标签。
5. 创建 GitHub Pre-release，上传两个外围 zip 和独立 checksum 文件。

CI 临时 artifact 只用于候选验证；正式内测下载入口使用 Pre-release，避免 14 天过期。

## 复用检查

- 复用 `createEnvironmentContextProvider()`，不把凭证能力下沉到 SDK/CLI。
- 复用现有 package allowlist、敏感文件扫描、Reference clean-room 和 CodeBuddy release test。
- 复用 Windows/macOS release matrix 与平台 Runtime builder。
- 复用现有 proprietary LICENSE，不在本期改变授权条款。

## 放弃的方案

- 不在测试包中放一个可编辑的 `config.json` 内联 Key：易泄露且违反现有 credential reference 边界。
- 不为没有 Windows 实机而宣称 Windows 10/11 已真实认证：Server CI 只能作为发布前自动门槛。
- 不让 macOS/Windows 分别重新打同版本公共包：同版本多字节来源不利于审计和回滚。
- 不在普通 CI 中自动使用供应商 Secret：fork/PR 触发和日志面扩大了凭证风险。
