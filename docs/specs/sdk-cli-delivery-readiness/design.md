# SDK/CLI Delivery Readiness Design

## 1. Design goals

本设计把现有 M3 开发产物推进为可交付的 Local Preview，不改变 Harness 的核心边界：SDK/CLI 始终调用 Harness Runtime，只有 Runtime 装配 Adapter 并持有厂商凭据。

设计优先级依次为：

1. 消除进程生命周期缺陷。
2. 使用真实 CodeBuddy 证据冻结能力声明。
3. 让制品脱离 workspace 后仍能安装和运行。
4. 让消费者不接触 CodeBuddy Key 或内部包。
5. 建立可重复、可审计、可回滚的 release gate。

## 2. Delivery topology

```text
Consumer Node.js app                Consumer terminal
          │                                 │
          │ @yanbot-harness/sdk             │ yanbot-harness CLI
          └──────────────┬──────────────────┘
                         │ Bearer + HTTP/SSE
                         ▼
              Harness Local Runtime bundle
                         │
                 Adapter registry/SPI
                 ┌───────┴────────┐
                 ▼                ▼
          Reference Adapter   CodeBuddy Adapter
                                    │ SDK 0.3.254
                                    ▼
                            CodeBuddy CLI/runtime
                                    │ HTTPS
                                    ▼
                            CodeBuddy cloud service
```

SDK/CLI 制品不包含厂商 Key。Local Runtime bundle 是交付可用性的 companion artifact；没有它或兼容的远端 Harness Runtime，SDK/CLI 只能安装，不能执行任务。

## 3. Artifact set

一个 release candidate 目录包含：

```text
release/<version>/
├── packages/
│   ├── yanbot-harness-contracts-<version>.tgz
│   ├── yanbot-harness-sdk-<version>.tgz
│   └── yanbot-harness-cli-<version>.tgz
├── runtime/
│   └── yanbot-harness-runtime-<version>-<platform>-<arch>.tar.gz
├── examples/
│   └── sdk-basic/
├── QUICKSTART.md
├── RELEASE_NOTES.md
├── manifest.json
└── SHA256SUMS
```

### 3.1 Public installable packages

- `@yanbot-harness/contracts`：协议 schema 与公共类型。
- `@yanbot-harness/sdk`：HTTP/SSE 客户端和 daemon descriptor 发现。
- `@yanbot-harness/cli`：仅依赖 SDK 的命令行客户端。

三个包共享 release version，tarball 内 workspace dependency 由 pnpm 转换为精确版本。`private` 仅从这三个交付包移除；内部 Adapter/Core 包仍保持私有。

### 3.2 Portable Runtime bundle

复用 `apps/local-runtime`，通过 `pnpm deploy --prod` 或等价的 workspace-aware deploy 生成带生产依赖的 portable 目录，再归档为平台制品。这样无需公开所有 Adapter/Core 内部包，也避免将 CodeBuddy SDK 强行打成单文件 bundle。

Runtime bundle 包含：

- 编译后的 `apps/local-runtime/dist`。
- deploy 解析后的生产 `node_modules`。
- 无凭据的启动脚本和 `.env.example`/配置说明。
- release manifest 中的 Node、OS、arch、Harness protocol、CodeBuddy SDK 版本。

Runtime bundle 不包含：

- `.env` 或真实 Key。
- state、Session、运行日志和 descriptor。
- 测试、源码映射、Git 元数据。
- 教师端或其他业务仓库代码。

## 4. Runtime and credential model

### 4.1 CodeBuddy mode

操作员在启动 Runtime 时通过进程环境提供：

```text
CODEBUDDY_API_KEY
CODEBUDDY_INTERNET_ENVIRONMENT=internal
```

可选项保持既有 allowlist：`CODEBUDDY_MODEL` 只用于受控 smoke；专享/私有化场景需要另立 Spec，不在本交付中扩张 base URL 语义。

SDK/CLI 只读取 `YANBOT_HARNESS_ACCESS_TOKEN` 或 mode-0600 descriptor。HTTP API 继续拒绝上传 Adapter credential。

### 4.2 Reference mode

`--reference` 启动零凭据 Runtime，用于安装验证、集成开发和默认 CI。Reference 模式与 CodeBuddy 模式使用相同的 public HTTP/SSE protocol，不能为 release 测试引入旁路接口。

## 5. Lifecycle hardening

真实 smoke 成功后不退出，说明仍存在 active handle、timer、stream reader 或 vendor runtime cleanup 未收口。修复流程：

1. 在 smoke 末尾采集脱敏的 active handle 类型和阶段时间，不输出环境值、文件内容或完整对象。
2. 分别对 initial、resume、cancel 三段执行后检查 runtime/query/iterator 是否完成 dispose。
3. 将退出问题归因到 Adapter、SDK facade、smoke 脚本或厂商 SDK；优先通过公共 `abort`、`interrupt`、iterator `return` 和 `dispose` 收口。
4. 不调用厂商 SDK 私有方法，不通过猜测 PID 杀进程来掩盖资源泄漏。
5. smoke 设置外层最大时限，成功 JSON 写出后必须自然退出；只有失败清理路径才允许有界强制退出，并返回非零。
6. 增加离线 regression fixture，模拟不释放 iterator/timer 的路径，确保 Adapter 自身不无限等待。

验收以“命令退出码 0 + 规定时限内自然退出 + 进程树无残留”为整体成功信号，不能只根据 JSON 中的 `ok: true` 判定。

## 6. Capability certification

能力矩阵区分四种状态：

- `documented`：厂商公共声明或类型存在。
- `fixture`：离线 deterministic 测试覆盖 Harness 映射。
- `real-verified`：最终制品和真实账号完成受控验收。
- `unsupported/unverified`：当前不承诺。

真实场景采用下表：

| 场景                   | 必须观察的结果                                    | 失败处理                  |
| ---------------------- | ------------------------------------------------- | ------------------------- |
| Initial run            | started、session、delta/message、usage、completed | 阻断发布                  |
| Resume                 | 使用前次 adapterSessionId，返回 completed         | 阻断发布                  |
| Cancel                 | started 后取消，唯一 cancelled，及时退出          | 阻断发布                  |
| Model list             | 返回至少一个 schema 合法模型或明确 unsupported    | 阻断错误声明              |
| Tool lifecycle         | tool started/completed 成对且终态唯一             | 未稳定触发则标 unverified |
| Permission Interaction | request、显式 allow/deny、resolved                | 未稳定触发则标 unverified |
| Question Interaction   | question request、答案映射、resolved              | 未稳定触发则标 unverified |

工具、权限和问题场景不得通过宽权限自动批准来伪造；受控 workspace 只放置无敏感内容的临时 fixture。

## 7. SDK API freeze

本期不为追求便利大规模扩张 API，先冻结现有公共面：

- `HarnessClient`
- `RunHandle`
- `readRuntimeDescriptor`
- `HarnessSdkError`
- 从 contracts 重新导出的公共协议类型

冻结动作包括：

1. 为每个公共方法写 API 表、输入/输出、错误和最小示例。
2. 生成/检查 `.d.ts`，确保没有内部绝对路径、Adapter 或厂商类型。
3. 明确 Preview semver：同一 `0.x` minor 可包含显式记录的破坏变更；protocol major 不兼容必须拒绝连接。
4. 检查 Node-only 的 daemon 导出与纯 HTTP 客户端导出；若浏览器兼容不是本期目标，README 必须明确 Node 22 环境，不能暗示浏览器支持。
5. 不新增自动无限 SSE 重连；消费者使用最后 eventId 显式恢复，避免隐藏重复执行。

## 8. Package metadata and publishing

交付包补充：

- `engines.node`。
- `license` 与根许可证文件。
- `repository`、`bugs`、`homepage`。
- 包级 README。
- `publishConfig`，默认指向团队确认的私有 Registry；离线 bundle 不依赖实际 publish。
- 明确 `exports`/`types`/`files`，禁止默认包含源码与测试。

release build 在 pack 后检查实际 tarball，而不是只检查源 `package.json`：

- `private` 不得为 true。
- 不得出现 `workspace:*`。
- SDK 生产依赖只能包含 contracts。
- CLI 生产依赖只能包含 SDK。
- 不得出现 vendor SDK、Runtime/Core/Adapter 依赖。
- tarball 文件清单只能属于 allowlist。

## 9. Release pipeline

新增统一 release 脚本，逻辑顺序固定：

```text
validate clean inputs
  → pnpm install --frozen-lockfile
  → pnpm check
  → build public packages
  → pack contracts/sdk/cli
  → deploy portable runtime
  → inspect package manifests and file allowlists
  → scan secrets/source maps/.env/workspace protocols
  → generate manifest + SHA256SUMS
  → clean-room Reference install/E2E
  → optional credentialed CodeBuddy E2E
```

默认 CI 执行到 clean-room Reference E2E。真实 CodeBuddy gate 由受控环境显式触发，不保存 Key，不在 fork PR 上运行。

`manifest.json` 至少记录：

- release version、Git commit、构建时间。
- Node/pnpm 版本。
- Harness protocol version。
- 各 artifact 文件名、SHA-256、大小。
- SDK/CLI/contracts/Runtime/CodeBuddy SDK 版本。
- 认证平台和能力矩阵文档路径。

## 10. Clean-room test topology

测试不得从 repo 的 `node_modules` 或 workspace link 解析依赖：

1. 创建 mode-0700 临时目录。
2. 将三个 tarball 同时安装到 consumer fixture。
3. 解压 portable Runtime 到独立目录。
4. 以独立进程启动 Reference Runtime，等待 descriptor/health。
5. 运行打包后的 SDK 示例和 CLI text/JSONL/resume/cancel。
6. 关闭 Runtime，断言 descriptor 删除和进程退出。
7. 受控真实 gate 重复相同流程，仅把 CodeBuddy Key 注入 Runtime 进程环境。
8. 清理临时目录，失败时只保留脱敏诊断摘要。

## 11. Documentation structure

```text
packages/sdk/README.md
apps/cli/README.md
apps/local-runtime/README.md
docs/delivery/sdk-cli-quickstart.md
docs/delivery/compatibility.md
CHANGELOG.md
```

Quickstart 按以下顺序说明：验证校验和、启动 Runtime、连接 SDK、运行 CLI、处理 Interaction、取消/恢复、关闭 Runtime、故障排查。示例使用占位符，不出现任何真实 Key。

## 12. Security checks

- 扩展现有 package-boundary 脚本，扫描所有 release staging 文件。
- 检查 `.env`、`.pem/.key/.p12/.pfx`、source map、Git metadata 和常见 credential pattern。
- 检查 SDK/CLI stdout、stderr 和错误堆栈脱敏。
- 检查 CLI 没有 `--token`，Runtime 没有接收 `CODEBUDDY_API_KEY` 的 HTTP 字段。
- release CI 只传递凭据到目标 Runtime 子进程，不传递到 SDK/CLI consumer 进程。
- 由于本次有效 Key 曾被粘贴到对话，真实 release 前应使用新 Key 或明确将其限定为开发凭据；该安全操作由凭据所有者执行。

## 13. Versioning, compatibility, and rollback

- contracts、SDK、CLI 同版本发布；Runtime 可以同版本但以 manifest 显式关联。
- SDK 连接后读取 health/protocol version；不兼容 major 立即返回稳定 protocol error。
- release candidate 使用 `0.1.0-preview.N` 或团队确认的内部版本，不覆盖已有制品。
- 回滚保留最近一个已通过全部门禁的 bundle 和 checksums。
- 如果发现制品问题，停止分发当前 candidate，恢复前一 manifest；如果发现凭据泄露，另行撤销/轮换凭据，不能靠删除制品代替轮换。

## 14. Reuse decisions

- 复用 `packages/sdk` 的 `HarnessClient`、`RunHandle`、HTTP/SSE transport 和 daemon 校验，不新建第二套客户端。
- 复用 `apps/cli` 现有命令和输出层，不让 release CLI 直接调用 Adapter。
- 复用 `apps/local-runtime` 的 loopback/auth/workspace grant/descriptor 逻辑，通过 deploy 形成 companion bundle。
- 复用 `packages/adapter-reference` 做默认 CI 和 clean-room 验收。
- 复用 `scripts/smoke-codebuddy.mjs`，但将其升级为可自然退出、可选择场景、只输出脱敏摘要的真实 gate。
- 复用 `scripts/check-package-boundaries.mjs`，扩展到 tarball 和 release staging 检查。

## 15. Rejected alternatives

### 15.1 只交付 SDK tarball

拒绝。当前 SDK 是 Harness Runtime 客户端；没有 Runtime endpoint 或 companion bundle，消费者无法执行任务，属于不可用交付。

### 15.2 让 SDK 直接调用 CodeBuddy SDK

拒绝。这会泄露厂商 API、要求客户端持有 CodeBuddy Key，并绕过 Harness 的认证、workspace grant、持久化、超时、权限和错误标准化。

### 15.3 把所有内部 workspace 包都发布给消费者

拒绝。内部 Adapter/Core 包不是稳定 API。Runtime 使用 portable deploy bundle，消费者只安装 contracts/SDK/CLI。

### 15.4 将 CodeBuddy Key 写进 release bundle 或示例 `.env`

拒绝。Key 必须由操作员在 Runtime 启动时注入，release artifact 只能包含变量名和占位符。

### 15.5 以 smoke JSON 成功作为唯一门禁

拒绝。本次已经证明 JSON 成功后进程仍可能挂起。必须同时验证退出码、自然退出时限和无残留进程。

### 15.6 等待 M5 云端控制面后再交付

拒绝。本期可以形成有明确边界的 Local Preview；将云端多租户能力纳入会显著扩大范围并延迟 SDK/CLI 的真实用户反馈。
