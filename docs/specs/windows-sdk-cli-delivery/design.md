# Windows SDK/CLI 内测交付设计

2026-09-15 范围说明：本文件记录当前 Preview 的独立 ZIP/显式 launcher/强制树终止设计。
后续 `@yanbot-harness/local`、Runtime npm 平台包、正常关闭 IPC 和父死亡回收以
[`unified-local-distribution`](../unified-local-distribution/design.md) 已确认方案为准；不回写为当前已实现。

## 总体方案

保持 SDK、CLI、Runtime 的现有职责边界，新增一条 Windows 原生构建和验证路径：

```text
Windows runner
  -> pnpm build/check
  -> SDK/CLI npm tgz（平台无关）
  -> Runtime win32-x64 staging
       -> bin/yanbot-harness-runtime.cmd
       -> dist + production node_modules
       -> runtime-manifest.json
  -> Windows Runtime zip
  -> manifest + SHA256SUMS
  -> artifact check
  -> clean-room Reference tests
  -> CI artifact upload
```

Windows 交付仍是“Node Runtime bundle”，不是原生二进制。目标机必须预装受支持的 Node 22，这能复用现有编译产物和依赖边界，避免在内测阶段引入 pkg/SEA/MSI 的额外兼容与签名风险。

## Runtime 启动器与调用

### 归档格式

- POSIX 平台继续生成 `.tar.gz`。
- Windows 生成 `.zip`，便于资源管理器和 PowerShell 原生解压。
- 归档顶层目录名继续使用 `yanbot-harness-runtime-<version>-<platform>-<arch>`。

### Windows 启动器

Windows 包提供两个同名启动器：

- `bin/yanbot-harness-runtime.js`：managed SDK/CLI 的规范入口，由当前 Node 直接启动，因此 child PID 与 descriptor PID 精确一致。
- `bin/yanbot-harness-runtime.cmd`：PowerShell/cmd 人工调用的便捷入口，转发到同名 `.js`。

`.cmd` 内容为：

```bat
@echo off
setlocal
if defined NODE_BINARY (
  "%NODE_BINARY%" "%~dp0yanbot-harness-runtime.js" %*
) else (
  node "%~dp0yanbot-harness-runtime.js" %*
)
```

启动器不包含凭证，不修改用户级环境变量。

### SDK managed-runtime

`packages/sdk/src/managed-runtime.ts` 的启动命令解析需要识别 `.cmd`/`.bat`：

- `.js`/`.cjs`/`.mjs` 继续由 `process.execPath` 启动。
- Windows 收到本交付包的 `.cmd` 路径时，解析并验证同名 `.js` 后由 `process.execPath` 启动；不通过 shell 启动任意批处理文件。
- 其他路径继续直接 spawn。

Windows 上 `ChildProcess.kill()` 的信号并不具备 POSIX 等价语义，因此关闭逻辑以“受拥有子进程树退出 + 有界等待”为验收标准，不对外承诺具体信号。使用 Windows 系统自带 `taskkill /PID <pid> /T /F` 清理整个受拥有进程树；PID 必须来自刚刚 spawn 的子进程，不接受外部 PID。SDK 随后按 instance ID 清理自己拥有的 descriptor 和临时状态目录。

## 构建与归档

修改 `scripts/build-runtime-bundle.mjs`：

- 按平台生成 `.cmd` 或 POSIX shell launcher。
- Windows 使用系统 PowerShell `Compress-Archive` 生成 zip；POSIX 保持 `tar`。
- Windows 上的 npm pack/install 由当前 `node.exe` 直接执行随 Node 安装的 `npm-cli.js`，不使用无法被 `execFile` 直接启动的 `npm.cmd`，也不启用 `shell:true`。
- 对 PowerShell 路径和参数使用 `execFile` 参数数组，不拼接包含凭证的命令字符串。
- manifest 继续记录 `platform`、`arch`、Node 范围和 CodeBuddy SDK 版本。

修改 release artifact 检查和 clean-room 脚本，集中提供以下平台抽象：

- 查找当前平台唯一 Runtime 归档。
- `.zip`/`.tar.gz` 解压。
- 查找 `.cmd`/无扩展名启动器。
- 以平台正确方式启动和终止 Runtime。
- 文本扫描识别 `.cmd` 文件。

## CI 与交付物

在 `.github/workflows/ci.yml` 的 release matrix 增加：

- `windows-2022` / `win32-x64`。
- 与现有平台一致运行安装、build、artifact check、clean-room test。
- Windows job 成功后上传 `release/<version>/`，artifact 名包含 `win32-x64`。

CI artifact 是内测候选的来源，但最终发布仍需满足：同一干净提交、`gitDirty: false`、Windows Reference 通过、Windows 实机 CodeBuddy 通过、checksum 可核验。

## 文档与认证状态

- `docs/delivery/compatibility.md` 增加 Windows x64 的认证层级和 Node/PowerShell 前置条件。
- `docs/delivery/sdk-cli-quickstart.md` 增加 PowerShell 离线安装、解压、managed Runtime 与 daemon Runtime 示例。
- `docs/delivery/handoff-checklist.md` 单独记录 Windows Reference 与 Windows CodeBuddy 两类证据；不能用前者替代后者。
- `scripts/build-release.mjs` 仅在 Windows Reference CI 通过后将 `win32-x64` 纳入 reference-certified targets；CodeBuddy 认证状态继续由交付清单表达。

## 复用检查

- 复用 `scripts/build-runtime-bundle.mjs` 的 workspace 包收集、生产依赖安装和敏感文件剔除逻辑。
- 复用 `scripts/test-release-clean-room.mjs` 的 SDK/CLI 行为验收集合，避免 Windows 使用较弱的测试标准。
- 复用 `packages/sdk/src/managed-runtime.ts` 的 descriptor 所有权、health、超时与幂等 close 逻辑，只替换平台调用/终止细节。
- 复用 `.github/workflows/ci.yml` 的 release matrix，不创建独立且容易漂移的 Windows workflow。

## 为什么不采用其他方案

- 不在本期生成 `.exe`/MSI：这会引入 Node SEA 或第三方打包器、原生模块兼容、签名证书与 SmartScreen 验证，超出内测包的必要范围。
- 不继续给 Windows 发 `.tar.gz` + shell 脚本：即使现代 Windows 带 `tar.exe`，shell 启动器仍不能作为标准 Windows 入口，用户体验和 SDK managed mode 都不可靠。
- 不把 Runtime 自动塞入 SDK optionalDependencies：当前是离线内测，显式交付和校验更可控；平台包自动解析可在后续 Registry 方案中完成。
- 不把 CodeBuddy Key 固化进 Runtime：本地交付物无法安全隐藏静态密钥，且会扩大泄露与额度滥用风险。

## 关键文件

| 文件                                        | 变更                             |
| ------------------------------------------- | -------------------------------- |
| `scripts/build-runtime-bundle.mjs`          | Windows launcher 与 zip 构建     |
| `scripts/check-release-artifacts.mjs`       | zip 内容、解压和扫描             |
| `scripts/test-release-clean-room.mjs`       | Windows 解压、调用和进程清理     |
| `scripts/test-release-codebuddy.mjs`        | Windows 解压、调用和进程清理     |
| `packages/sdk/src/managed-runtime.ts`       | `.cmd` 调用与 Windows 进程树终止 |
| `packages/sdk/test/managed-runtime.test.ts` | 平台调用/关闭回归测试            |
| `.github/workflows/ci.yml`                  | Windows x64 job 与交付物上传     |
| `docs/delivery/*`                           | Windows 安装、兼容性和认证证据   |

## 验证策略

1. macOS/Linux 本地或 CI：全量 `pnpm check`，保证非 Windows 回归。
2. Windows GitHub-hosted runner：release build、artifact check、clean-room Reference。
3. Windows 10/11 x64 实机：从 CI 下载并校验 zip，在非仓库目录离线安装与运行。
4. Windows 实机 + 专用内测 Key：执行最终 CodeBuddy 初次运行、续跑、取消、CLI JSONL 和残留进程检查。
