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
