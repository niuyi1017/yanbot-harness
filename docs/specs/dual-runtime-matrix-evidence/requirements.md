# 双 Runtime 矩阵证据需求

## 1. 背景

Local Runtime 与 Remote Reference Fixture 已通过同一组四项 Runtime Conformance，但当前结果只存在于各包测试输出中，
无法回答“哪个提交、哪个操作系统、哪类后端、以什么传输方式通过了哪些断言”。`dual-runtime-compatibility` P3.8 要求把
Local macOS/Windows 与 Remote service 作为独立矩阵项输出证据。

正式 Remote service 尚未实现，因此本阶段建设可复现的证据生成器和 macOS/Windows CI 矩阵，并把 Remote Fixture 与
Remote service 分成不同证据身份。Fixture 结果用于验证公共契约和测试基础设施，不能使 Remote service 矩阵项变为通过。

## 2. 目标

- 在真实 Node 进程中依次运行四项共享 Conformance，并输出结构化 JSON 证据。
- 每份证据绑定 source commit、runner OS/arch、Node 版本、Runtime 身份、传输真实性和场景结果。
- Local Reference 必须使用真实 loopback HTTP/SSE `/v1` 路径；Remote Reference Fixture 必须明确记录为进程内
  injected fetch，不能标记为远程网络服务。
- macOS arm64 与 Windows x64 在 CI 中作为两个独立 runner 生成并上传证据。
- 提供严格聚合器：校验报告 Schema、source commit、目标唯一性、四场景齐全以及声明与 runner 一致。
- 聚合输出必须保留 `remoteService.status = not-run`，直到真实 HTTPS service 报告由后续阶段提供。

## 3. 验收标准

### ME1. 单目标证据

- CLI 接受 `--target darwin-arm64|win32-x64` 与 `--output <file>`，target 必须和当前 `process.platform/arch` 一致。
- 报告固定 `schemaVersion: 1`、source commit、生成时间、runner、Node 版本与 Harness release/protocol version。
- Local 与 Remote Fixture 分别运行 discovery/resources、run/idempotency、interaction/replay、cancellation 四项公共函数。
- 每项记录稳定 ID、`passed|failed`、耗时；失败时只记录错误名称和归一化摘要，不写 token、绝对临时目录或 HTTP header。
- 任一场景失败时仍写报告，但命令非零退出。

### ME2. 证据身份与真实性

- Local 条目固定为 `runtimeKind: local-reference`、`executionMode: local`、`transport: loopback-http-sse`。
- Remote Fixture 条目固定为 `runtimeKind: remote-reference-fixture`、`executionMode: remote`、
  `transport: injected-fetch`、`serviceEvidence: false`。
- 报告另有独立 `remoteService` 槽位；本阶段固定 `not-run` 并说明缺少正式 cloud-server。
- 聚合器拒绝把 Fixture 条目用作 Remote service、拒绝未知 target、重复 target、commit 不一致或伪造 runner 平台。

### ME3. 跨平台 CI

- GitHub Actions 使用 `macos-15` 生成 `darwin-arm64` 报告，使用 `windows-2022` 生成 `win32-x64` 报告。
- 两个 runner 均从同一 checkout 执行 frozen install、build、证据生成与报告自校验。
- 每个平台上传独立 artifact；聚合 job 下载两份报告并生成单一 matrix summary artifact。
- CI 不依赖真实模型、外网 Runtime、长期 token 或平台 Secret。

### ME4. 聚合与 P3.8 状态

- 聚合报告包含两个 Local 平台结果、两个 Remote Fixture 合约结果及一个独立 Remote service 缺口。
- Local 任一平台失败、Fixture 任一平台失败或报告不一致时聚合失败。
- `remoteService = not-run` 不使基础设施 CI 失败，但 aggregate 总体只能为 `incomplete`，不能为 `passed`。
- P3.8 保持未勾选，直到真实 Remote service 与实际 CI run URL/commit 一同归档；本阶段仅勾选其基础设施子任务。

## 4. 非功能要求

- **可移植**：脚本只依赖 Node 22 和仓库已构建 workspace，不使用 POSIX-only shell。
- **确定性**：场景使用 Reference Adapter、临时目录和进程内 Fixture，不访问真实模型或公网。
- **诚实性**：模拟传输、真实 loopback、真实 Remote HTTPS 三者在 Schema 中不可混淆。
- **可审计**：聚合器只接受严格字段，证据绑定完整 Git commit；dirty workspace 明确记录。
- **保密性**：报告不记录访问令牌、workspace 绝对路径、请求正文、环境变量值或完整异常堆栈。

## 5. 范围

- `scripts/run-dual-runtime-matrix.mjs` 单目标证据生成器。
- `scripts/aggregate-dual-runtime-matrix.mjs` 严格聚合器。
- 对应 Node 测试、root scripts 与 GitHub Actions workflow。
- `docs/specs/dual-runtime-compatibility/tasks.md` 的 P3.8 子任务状态说明。

## 6. 非目标

- 不实现或部署 `apps/cloud-server`、Remote 数据库、队列、对象存储、Worker 或沙箱。
- 不把 Remote Fixture 监听到公网，不为其签发生产 token。
- 不伪造 Windows 本机结果；本地 macOS 只能生成 darwin 证据，Windows 结果必须来自 Windows runner。
- 不更新交付兼容表为 Remote 可用，不完成 Phase 4/5/6。

## 7. 依赖

- `packages/testing` 的四项公共 Runtime Conformance。
- `apps/local-runtime`、`packages/remote-reference-fixture`、`packages/sdk` 与 Reference Adapter。
- `docs/specs/dual-runtime-compatibility/` P3.1-P3.7。
