# SDK/CLI Delivery Readiness Tasks

## 1. Status

- [x] SDR-T0：建立 SDK/CLI Delivery Readiness Spec。
- [x] SDR-T1：冻结交付版本、制品集合和兼容声明。
- [x] SDR-T2：修复 CodeBuddy smoke 成功后不退出的问题。
- [x] SDR-T3：完成真实 CodeBuddy 核心能力验收并更新能力矩阵。
- [x] SDR-T4：冻结 SDK/CLI 公共 API、错误和文档契约。
- [x] SDR-T5：完成 contracts、SDK、CLI 发布元数据和包级文档。
- [x] SDR-T6：生成可携带 Local Runtime companion bundle。
- [x] SDR-T7：实现 release build、manifest、checksum 与制品安全检查。
- [x] SDR-T8：建立最终制品 clean-room Reference E2E。
- [x] SDR-T9：建立最终制品真实 CodeBuddy E2E。
- [x] SDR-T10：完成消费者 quickstart、兼容矩阵、故障排查和 release notes。
- [x] SDR-T11：执行 Release Candidate 全量门禁、review、提交和打 tag。
- [x] SDR-T12：模拟第三方 SDK/CLI 调用并完成交付签收。

## 2. Priority and execution order

```text
P0 lifecycle
  T1 → T2 → T3 → T4

P0 artifacts
  T4 → T5 → T6 → T7 → T8 → T9

P0 handoff
  T8 + T9 → T10 → T11 → T12
```

T5 与 T6 可在 T4 完成后并行；T10 可在 T7 后开始，但必须在 T8/T9 结果出来后收口。任何 P0 失败都阻断“可交付”结论。

## 3. Task details

### SDR-T0. 建立交付子 Spec

**状态**：完成。

**文件**：

- `docs/specs/sdk-cli-delivery-readiness/requirements.md`
- `docs/specs/sdk-cli-delivery-readiness/design.md`
- `docs/specs/sdk-cli-delivery-readiness/tasks.md`

**内容**：定义 Local Preview 交付边界、artifact set、Runtime companion、安全模型、真实验收和 release exit criteria。

**验收**：三份文档在实现前存在，可独立 review；明确 SDK/CLI 不直接持有 CodeBuddy Key，且本期不包含 M4–M11。

### SDR-T1. 冻结版本、制品和兼容声明

**优先级**：P0。

**前置**：SDR-T0。

**文件**：

- 根 `package.json`
- `packages/contracts/package.json`
- `packages/sdk/package.json`
- `apps/cli/package.json`
- `apps/local-runtime/package.json`
- `docs/delivery/compatibility.md`（新增）
- 本 Spec（如评审调整）

**内容**：

1. 确认首个 RC 版本命名，例如 `0.1.0-preview.1`。
2. contracts、SDK、CLI 采用同一版本；Runtime bundle manifest 与其绑定。
3. 冻结 Node 22、pnpm 11.10.0、Harness protocol version 和 CodeBuddy SDK 0.3.254。
4. 明确首批认证平台：macOS arm64、Linux x64；Windows 标为未认证。
5. 确认交付渠道默认是离线 bundle，可选私有 Registry，不执行公网 npm 正式发布。

**验收**：所有包、protocol、Runtime 和 vendor 版本在 compatibility 文档中唯一可追踪；不存在互相矛盾的交付声明。

**建议提交**：`docs: freeze sdk cli preview delivery baseline`

### SDR-T2. 修复真实 smoke 成功后不退出

**优先级**：P0，发布阻断。

**状态**：完成。厂商 `Query.return()` 仅发送 interrupt，未推进其内部 iterator 的 cleanup；Facade 现保留并关闭实际 iterator。2026-09-09 真实 initial/resume/cancel smoke 在 12.1 秒内自然退出 0，诊断中无 `ChildProcess`。

**前置**：SDR-T1。

**主要文件**：

- `scripts/smoke-codebuddy.mjs`
- `packages/adapter-codebuddy/src/index.ts`
- `packages/adapter-codebuddy/src/sdk-facade.ts`
- `packages/adapter-codebuddy/test/codebuddy.test.ts`
- 必要的测试 fixture

**内容**：

1. 使用脱敏 active-handle/阶段诊断定位成功后的未释放资源。
2. 核对 initial、resume、cancel 的 iterator return、abort、interrupt 和 dispose 顺序。
3. 仅使用厂商公共 API 修复资源释放，不调用私有成员或猜测 PID。
4. 增加外层 smoke deadline；成功必须自然退出 0，cleanup 超时必须失败而不是伪装成功。
5. 增加回归测试覆盖成功、取消、SDK cleanup 不响应和重复 dispose。

**验证**：

```bash
pnpm --filter @yanbot-harness/adapter-codebuddy test:unit
pnpm smoke:codebuddy
```

- smoke 在规定时间内自动退出 0。
- 成功 JSON 后无需人工 Ctrl-C。
- smoke、CodeBuddy CLI 和后代进程均无残留。
- 输出和诊断不包含 Key。

**建议提交**：`fix: close codebuddy runtime after successful smoke`

### SDR-T3. 真实 CodeBuddy 能力认证

**优先级**：P0。

**状态**：完成。initial/resume/cancel、文本、完整消息、token/cost usage 为 `real-verified`；tool、permission、question 为 `unverified`；模型发现虽返回 15 项，但公开关闭 API 仍残留 CLI 子进程，Preview 明确降级为 `unsupported`。

**前置**：SDR-T2。

**主要文件**：

- `scripts/smoke-codebuddy.mjs`
- 可新增 `scripts/smoke-codebuddy-scenarios.mjs`
- `docs/architecture/codebuddy-capability-matrix.md`
- `docs/specs/codebuddy-runtime-hardening/tasks.md`
- `README.md`

**内容**：

1. 保留 initial/resume/cancel 基线并记录本次有效 Key 的成功证据，不记录 Key 值。
2. 增加或分离 model list、tool lifecycle、permission Interaction、question Interaction 受控场景。
3. 每个场景断言事件顺序、唯一终态、Session ID、错误脱敏和 cleanup。
4. 无法稳定触发的厂商能力标记为 `unverified`；Adapter manifest 不得宣称超出证据的能力。
5. 更新旧的 401/pending 记录，保留历史故障作为 compatibility note。

**验证**：

- 核心 initial/resume/cancel 必须 `real-verified`。
- model/tool/permission/question 要么真实通过，要么在矩阵和 manifest 中一致降级。
- `pnpm check` 仍可在无凭据环境通过。

**建议提交**：`test: certify codebuddy delivery capabilities`

### SDR-T4. 冻结 SDK/CLI 公共契约

**优先级**：P0。

**状态**：完成。公共 exports、方法、SSE cursor/AbortSignal、Interaction、幂等键、CLI 命令/JSONL/退出码/连接优先级已记录在 compatibility 文档；构建 `.d.ts` 不引用 Adapter、Runtime 或厂商类型。

**前置**：SDR-T3。

**主要文件**：

- `packages/contracts/src/index.ts`
- `packages/sdk/src/index.ts`
- `packages/sdk/src/client.ts`
- `packages/sdk/src/transport.ts`
- `apps/cli/src/*`
- `docs/delivery/compatibility.md`

**内容**：

1. 审核所有公共 exports、`.d.ts`、method input/output 和错误类型。
2. 确认所有 Runtime HTTP/SSE 响应都经过 public schema；没有厂商/内部类型泄露。
3. 审核 SSE event cursor、AbortSignal、Interaction、幂等 key 和终态行为。
4. 冻结 CLI 命令、JSONL record、stdout/stderr、退出码和连接优先级。
5. 明确 Node 22 Preview 支持范围；不暗示浏览器 SDK 或云端多租户支持。
6. 如发现必须调整的 public contract，先更新本 Spec 和 protocol 兼容说明，再改实现。

**验证**：

```bash
pnpm --filter @yanbot-harness/contracts test:unit
pnpm --filter @yanbot-harness/sdk test:unit
pnpm --filter @yanbot-harness/cli test:unit
pnpm check:boundaries
```

- 构建后的 `.d.ts` 只引用允许的公共包。
- CLI 生产源码只引用 SDK。
- API 表与实现一致。

**建议提交**：`refactor: freeze preview sdk cli contract`

### SDR-T5. 发布元数据和包级文档

**优先级**：P0。

**状态**：完成。三个 tarball 已验证无 `private`/`workspace:*`，生产依赖边界分别为 contracts→Zod、SDK→contracts、CLI→SDK；文件仅含 dist、README、LICENSE 和 manifest metadata。

**前置**：SDR-T4。

**主要文件**：

- `packages/contracts/package.json`
- `packages/sdk/package.json`
- `apps/cli/package.json`
- `packages/sdk/README.md`（新增）
- `apps/cli/README.md`（新增）
- 根 `LICENSE`、`CHANGELOG.md`（新增或补齐）

**内容**：

1. 从三个交付包移除 `private: true`；内部包继续私有。
2. 补齐 engines、license、repository、bugs、homepage、publishConfig、exports、types、files。
3. 确保 package README 随 tarball 打包。
4. 验证 pnpm pack 把 `workspace:*` 转为精确 release version。
5. 确保 dev dependency 不影响消费者安装，生产依赖边界保持不变。

**验证**：

```bash
pnpm --filter @yanbot-harness/contracts pack
pnpm --filter @yanbot-harness/sdk pack
pnpm --filter @yanbot-harness/cli pack
```

- tarball manifest 不含 `private: true` 和 `workspace:*`。
- SDK 生产依赖只有 contracts；CLI 生产依赖只有 SDK。
- tarball 文件只包含 dist、README、LICENSE 和必要 metadata。

**建议提交**：`build: prepare public sdk cli package artifacts`

### SDR-T6. Local Runtime companion bundle

**优先级**：P0。

**状态**：完成。使用 workspace tarball + npm clean install 生成 portable bundle，避免 pnpm virtual-store 泄露本机绝对路径；launcher 的 help/version、Reference 启动、descriptor 0600、SIGINT 清理均已验证。

**前置**：SDR-T4。

**主要文件**：

- `apps/local-runtime/package.json`
- `apps/local-runtime/src/main.ts`
- `apps/local-runtime/README.md`（新增）
- `scripts/build-runtime-bundle.mjs`（新增）
- 必要的 launcher 模板

**内容**：

1. 为 Runtime 增加明确的 bin/launcher 和 `--version`、`--help`、`--reference` 行为。
2. 使用 `pnpm deploy --prod` 或验证后的等价方式生成 portable runtime。
3. bundle 中保留 CodeBuddy SDK/CLI 所需文件，不发布内部 workspace API。
4. 启动日志只输出必要状态；descriptor 保持 0600，关闭后清理。
5. 校验 bundle 不含 `.env`、凭据、state、测试、source map 和 Git 内容。

**验证**：

- 在 repo 外解压后可以启动 Reference Runtime。
- SDK/CLI 能通过生成的 descriptor 连接。
- SIGINT/SIGTERM 后 Runtime 自然退出，descriptor 删除。
- CodeBuddy mode 缺 Key 时给出脱敏、可操作错误。

**建议提交**：`build: produce portable local runtime companion`

### SDR-T7. Release build 与安全检查

**优先级**：P0。

**状态**：完成。release build 生成公共包、离线 Zod 依赖、portable Runtime、manifest 与全目录 SHA-256；实际 staging 已通过凭据、环境文件、证书、source map、workspace protocol、绝对路径和依赖边界扫描。

**前置**：SDR-T5、SDR-T6。

**主要文件**：

- `scripts/build-release.mjs`（新增）
- `scripts/check-release-artifacts.mjs`（新增）
- `scripts/check-package-boundaries.mjs`
- 根 `package.json`
- `.github/workflows/ci.yml`
- release manifest schema/fixture

**内容**：

1. 编排 check、pack、runtime deploy、artifact inspection、manifest 和 SHA-256。
2. 对实际 staging 目录执行 secret、`.env`、key/cert、source map、workspace protocol、禁止依赖扫描。
3. 记录 Git commit、版本、protocol、Node/pnpm、平台和 artifact checksum。
4. 默认 CI 生成 dry-run artifact 并运行 Reference clean-room gate。
5. credentialed job 只能手动/受控触发，禁止 fork PR 获取 secret。

**验证**：

```bash
pnpm release:build
pnpm release:check
```

- 失败会阻止生成“通过”manifest。
- 修改 tarball 任意字节会导致 checksum 验证失败。
- 注入禁止 fixture 时安全检查能失败。

**建议提交**：`ci: add sdk cli release artifact gates`

### SDR-T8. Clean-room Reference E2E

**优先级**：P0。

**状态**：完成。临时 repo 外 consumer 使用 `npm --offline` 安装最终 tarball，最终 Runtime archive 完成 SDK text/interaction/cancel 与 CLI text/JSONL/resume/cancel；descriptor 创建/权限/关闭删除均已断言。

**前置**：SDR-T7。

**主要文件**：

- `scripts/test-release-clean-room.mjs`（新增）
- `examples/sdk-basic/*`
- `apps/cli/test/*` 或 release fixture
- `.github/workflows/ci.yml`

**内容**：

1. 在 mode-0700 临时目录同时安装 contracts/SDK/CLI tarballs。
2. 解压 portable Runtime，启动 Reference mode。
3. 用打包后的 SDK 运行完整 grant/session/run/event/interaction 流程。
4. 用打包后的 CLI 验证 help/version、text、JSONL、resume、cancel 和失败退出码。
5. 关闭 Runtime 并检查 descriptor、临时目录和进程清理。

**验收**：测试过程不存在 workspace symlink 或 repo `node_modules` 解析；默认 CI 稳定通过且无需网络凭据。

**建议提交**：`test: verify release artifacts in clean room`

### SDR-T9. 最终制品真实 CodeBuddy E2E

**优先级**：P0，发布阻断。

**状态**：完成。2026-09-10 最终 tarball + Runtime archive 在 repo 外 consumer 中通过 SDK initial/resume/cancel 与 CLI JSONL；SDK/CLI 环境不含 CodeBuddy Key，Runtime 下游子进程为 0，退出后 descriptor 删除。

**前置**：SDR-T8。

**主要文件**：

- `scripts/test-release-codebuddy.mjs`（新增或复用 smoke）
- `docs/architecture/codebuddy-capability-matrix.md`
- release evidence 摘要（不含凭据）

**内容**：

1. 使用 T7 生成的最终 tarball 和 Runtime bundle，不使用 workspace 源码。
2. 只把有效 Key 和 `internal` 路由注入 Runtime 子进程。
3. SDK consumer 完成 initial/resume/cancel；CLI 至少完成一个 JSONL run。
4. 验证 SDK/CLI 进程环境不包含 CodeBuddy Key。
5. 验证所有进程自动退出、无残留，输出只有脱敏事件摘要。

**验收**：最终制品链路成功，命令退出 0；失败时 release candidate 不进入 T11。

**建议提交**：`test: validate packaged codebuddy delivery path`

### SDR-T10. 消费者文档和 release notes

**优先级**：P0。

**状态**：完成。Quickstart、包级 README、Runtime 运行手册、compatibility、capability matrix、CHANGELOG/release notes 已覆盖离线安装、SDK/CLI、Interaction、SSE resume、cancel、退出码、CodeBuddy Key 边界、故障排查和回滚。

**前置**：SDR-T7；收口依赖 SDR-T8、SDR-T9。

**主要文件**：

- `docs/delivery/sdk-cli-quickstart.md`（新增）
- `docs/delivery/compatibility.md`
- `packages/sdk/README.md`
- `apps/cli/README.md`
- `apps/local-runtime/README.md`
- `README.md`
- `CHANGELOG.md`
- release `QUICKSTART.md`、`RELEASE_NOTES.md`

**内容**：

1. 提供 SDK 与 CLI 两条从零安装路径。
2. 说明 Runtime companion、descriptor、端口、workspace grant 和关闭流程。
3. 提供 Interaction、SSE cursor/resume、cancel 和错误处理示例。
4. 记录退出码、故障排查、有效能力、未认证能力和安全边界。
5. 把旧的 401/pending 文档更新为真实成功结论，同时记录历史兼容问题。
6. 明确 Key 只进入 Runtime 进程，不要求用户把 Key 粘贴到命令、代码或文档。

**验收**：由未参与实现的人仅按 Quickstart 能在空目录跑通 Reference 路径；所有命令与最终制品一致。

**建议提交**：`docs: add sdk cli delivery and operations guide`

### SDR-T11. Release Candidate 门禁与版本提交

**优先级**：P0。

**状态**：完成。frozen install 与 `pnpm check` 通过，共 111 项测试；release build/check、Reference 与真实 CodeBuddy 最终制品 E2E 通过；diff、tar 内容和敏感信息已检查，版本提交与 RC tag 同步创建。

**前置**：SDR-T8、SDR-T9、SDR-T10。

**文件**：所有本期修改、lockfile、Spec 状态、release manifest。

**执行**：

1. 检查并处理当前未提交 CodeBuddy hardening 改动，不覆盖无关用户修改。
2. 执行 frozen install、`pnpm check`、release build/check、Reference E2E、真实 CodeBuddy E2E。
3. 检查 git diff、tarball 文件清单和敏感信息。
4. 更新 tasks 状态、测试数量、平台和已知限制。
5. 独立 review 后提交 release commit；按确认的版本创建 RC tag。

**验收命令**：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm release:build
pnpm release:check
pnpm release:test
```

**验收**：所有命令通过；Git commit、tag、manifest 和 checksums 一致；工作树无未解释修改。

**建议提交**：`release: sdk cli local preview <version>`

### SDR-T12. 第三方模拟与交付签收

**优先级**：P0。

**状态**：完成。repo 外 consumer 仅从最终 tarball 安装公共包，通过 descriptor 调用 release Runtime；SDK/CLI 均不访问 workspace 源码、不导入内部包、不持有 CodeBuddy Key。签收清单位于 `docs/delivery/handoff-checklist.md`。

**前置**：SDR-T11。

**场景 A：SDK**：

- 新建独立 consumer 目录。
- 仅安装 contracts/SDK tarballs。
- 连接 release Runtime，创建 grant、Session、Run，消费事件并取消/恢复。

**场景 B：CLI**：

- 仅安装 contracts/SDK/CLI tarballs。
- 通过 descriptor 调用 release Runtime。
- 验证 text 和 JSONL 输出及退出码。

**签收材料**：

- artifact 下载/本地路径和 SHA-256。
- Quickstart 与 API/CLI 文档。
- compatibility/capability matrix。
- Reference 与真实 CodeBuddy 脱敏验收摘要。
- 已知限制和回滚步骤。

**验收**：模拟调用方不访问 workspace 源码、不持有 CodeBuddy Key、不导入内部包即可完成任务；签收人确认交付材料完整。

## 4. Definition of done

- [x] T1–T12 全部完成。
- [x] `pnpm check` 通过，共 111 项测试。
- [x] smoke 成功后自然退出，无残留进程。
- [x] clean-room Reference 和真实 CodeBuddy 均使用最终制品通过。
- [x] SDK/CLI/contracts tarball 可安装，Runtime bundle 可启动。
- [x] manifest、SHA256SUMS、Quickstart、release notes 完整。
- [x] release staging 不含凭据、`.env`、source map、内部状态或 workspace link。
- [x] capability matrix 不存在超出证据的能力声明。
- [x] release commit/tag/版本/lockfile/manifest 一致。

## 5. Estimated effort

在不出现厂商 SDK 新兼容问题的前提下：

| 工作组                                | 预计投入 |
| ------------------------------------- | -------- |
| T1–T3 生命周期与真实能力              | 1–2 天   |
| T4–T6 API、包与 Runtime bundle        | 1–2 天   |
| T7–T9 release/clean-room/真实制品 E2E | 1–2 天   |
| T10–T12 文档、RC 与签收               | 0.5–1 天 |

总计约 3.5–7 个开发日。若 model/tool/permission/question 场景无法被厂商稳定触发，可以按证据降级声明而不阻断核心 Local Preview；initial/resume/cancel、自然退出和最终制品 E2E 不能降级。
