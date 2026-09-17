# `@yanbot-harness/local` 单文件内测交付

面向无法访问 Registry 的内测同事，每个平台只发送一个对应 ZIP：

```text
yanbot-harness-0.1.0-preview.3-darwin-arm64-internal-test.zip
yanbot-harness-0.1.0-preview.3-win32-x64-internal-test.zip
```

使用者解压后运行 `node install.mjs`。最终业务入口只有 `@yanbot-harness/local`；ZIP 内多个 tgz 是其离线依赖闭包，不要求分别安装 SDK 或 Runtime。

生成命令：

```bash
pnpm build:internal-delivery -- \
  --common <current-commit-common-build> \
  --platform <current-commit-darwin-arm64-platform-build> \
  --output-dir delivery-output
```

生成器只接受同版本、同源提交、同 lock 摘要的 `darwin-arm64` 或 `win32-x64` 测试签名输入。Windows 最终 ZIP 必须由 `windows-2022` runner 原生构建，并由 `verify:internal-delivery` 在中文/空格路径中完成校验、离线安装与 Reference smoke 后交付。输出为测试候选，不含正式信任根，不可作为生产发布。完整需求、设计和验证任务见 [`internal-test-delivery-bundle`](../specs/internal-test-delivery-bundle/requirements.md)。

## Windows x64 已验证交付

- 下载入口：[GitHub Actions artifact `internal-test-delivery-win32-x64`](https://github.com/niuyi1017/yanbot-harness/actions/runs/35176486385/artifacts/10479605117)
- 流水线备用入口：[Unified local installation #35176486385](https://github.com/niuyi1017/yanbot-harness/actions/runs/35176486385)
- Actions artifact 名称：`internal-test-delivery-win32-x64`
- Actions artifact SHA-256：`96f55447a572c8993e531faae4cb0fc5596765f9f79f13573d5e04fc449e0916`
- Actions artifact 过期时间：`2026-10-17 11:07:50`（Asia/Shanghai）
- 内层交付文件：`yanbot-harness-0.1.0-preview.3-win32-x64-internal-test.zip`
- 内层交付文件大小：`56,759,852` 字节
- 内层交付文件 SHA-256：`b391e2ab948cbcb00a18a7723a126a9d9b18c302d9a3fc8380ab9b379b7cc906`
- 源提交：`19585c6ead7b8dc75222d65e98b9fb4da2f3448b`

下载需要登录并具备该 GitHub 仓库的访问权限。GitHub 下载的是一层 Actions artifact ZIP；解开后，把上述 `*-internal-test.zip` 作为唯一交付包发给内测同事，同时保留其中的 `internal-delivery-verification.json` 供复核。内测同事再解开交付包，在其目录中运行：

```powershell
node install.mjs
```

运行前提为 Windows x64、Node `22.22.0 <= version < 23` 与 npm `10.9.8`。顶层安装入口会先核对包内全部文件的 SHA-256，再使用空网络依赖的离线 kit 安装；该制品使用测试签名，只允许内部测试。

该候选已在 GitHub `windows-2022` runner 上通过 ZIP 路径安全、全文件摘要、中文/空格新路径、空 npm cache、离线安装、最终仅直接依赖 `@yanbot-harness/local`，以及 Reference `startup → health → run.completed → close` 验证。机器可读证据见 [`verification-evidence-win32-x64.json`](../specs/internal-test-delivery-bundle/verification-evidence-win32-x64.json)。
