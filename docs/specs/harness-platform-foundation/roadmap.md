# Yanbot Harness 开发进度总纲

## 1. 文档定位

本文是 Yanbot Harness 后续开发的**唯一进度总纲**，用于统一阶段顺序、当前状态、关键依赖、验收门禁和模型切换节点。

- 本文回答“当前做到哪里、下一步做什么、什么条件下可以进入下一阶段”。
- 同目录的 `requirements.md`、`design.md` 和 `tasks.md` 分别保留总体需求、目标架构和原始里程碑定义。
- 各专项 `tasks.md` 是具体实施清单；专项状态变化后，必须同步更新本文。
- 架构图描述目标形态，不等于已经实现；交付能力只以测试证据和兼容矩阵为准。

状态标记：

- `[x]` 已完成并有验证证据。
- `[~]` 正在进行或仅部分完成。
- `[-]` 已完成内部准备，但被外部条件阻塞。
- `[ ]` 尚未开始。

**状态快照日期：2026-09-15。**

## 2. 当前产品基线

| 能力                  | 当前状态 | 已完成范围                                                | 尚缺内容                                            |
| --------------------- | -------- | --------------------------------------------------------- | --------------------------------------------------- |
| Local Runtime         | `[x]`    | loopback HTTP/SSE、认证、工作区授权、本地状态、Run 管理   | 后续需迁移到中立 `/v1/*` 协议                       |
| TypeScript SDK        | `[x]`    | Local Daemon/显式端点/Embedded、Session/Run/Event         | Remote Target、远端 Token Provider                  |
| 平台 CLI              | `[x]`    | 基于公共 SDK 的运行、会话、取消、JSONL 输出               | Local/Remote Profile 和远端登录                     |
| Reference Adapter     | `[x]`    | 离线黑盒测试与发布验收                                    | Remote Reference Conformance                        |
| CodeBuddy SDK Adapter | `[~]`    | macOS 真实初始运行、恢复、取消、文本流和用量              | 工具/权限/提问场景、Windows 实机、Remote Worker     |
| 双平台 Preview 包     | `[~]`    | macOS arm64 与 Windows x64 候选包、CI artifacts、交付文档 | Windows 真实 CodeBuddy 验收、最终冻结与 Pre-release |
| Adapter SPI           | `[x]`    | SDK 型 Adapter 接口、能力协商、Conformance 基线           | 与 Remote 和 CLI Sidecar 的完整认证                 |
| CLI Sidecar           | `[~]`    | JSON-RPC/JSONL Schema 与架构设计                          | Client、Supervisor、CLI Host、真实厂商 Adapter      |
| Remote Runtime        | `[ ]`    | 需求、设计和任务拆分                                      | Control Plane、Worker、Sandbox、远端工作区和认证    |
| 本地统一安装          | `[ ]`    | 已确认的 local/sdk/runtime/platform 分发草案              | 平台 npm 包、resolver、离线闭包、签名、新生命周期   |
| 产品界面与运营        | `[ ]`    | 总体设计                                                  | Local Web、Electron、Admin、市场与版本管理          |

当前可以对外准确声明的是：**Local Preview 已形成候选交付；Remote Runtime 和真实 CLI 型厂商尚未交付。**

## 3. 总体执行原则

1. **保护现有交付线**：冻结 `0.1.0-preview.2` 候选基线，不让后续协议重构污染本次 Windows 验收。
2. **协议先于产品层**：先完成 Runtime 中立协议，再开发 Remote、Local Web、Electron 和厂商 CLI 接入。
3. **Reference 先于真实凭据**：所有新通路先通过无凭据 Reference Conformance，再进入真实厂商门禁。
4. **两组维度保持正交**：Local/Remote 是部署形态，SDK/CLI 是厂商接入形态，客户端不感知厂商差异。
5. **完成必须有证据**：代码合并、Schema 存在或架构图完成都不能单独标记为交付完成。
6. **安全边界不降级**：厂商 Key 不进入产品 SDK、平台 CLI、普通事件、日志或队列正文。
   推荐由 Runtime 读取凭据文件；若宿主通过 `environment` 显式传入 Key，不能声称宿主内存不持有它。
7. **安装边界与执行边界分离**：普通本地用户统一入口，Remote-only 继续轻量 SDK；Runtime 保留独立模块、进程和分发。

## 4. 关键路径与并行工作流

```text
P0 冻结 Local Preview 0.1.0-preview.2
  ├─ P1D 统一本地安装（先确认方案与打包探针；后续 Preview）
  │    └─ Mac/Windows 平台包 + resolver + 生命周期 + 离线/签名/回滚
  └─ P1 Runtime 中立协议与双目标 SDK/CLI
       ├─ P2 CLI Sidecar 基础设施
       │    └─ P3 首个真实 CLI 厂商 Adapter
       ├─ P4 Remote Reference Runtime 与控制平面
       │    └─ P5 Remote Worker/Sandbox + CodeBuddy
       └─ P7 Local Web → Electron

P3 + P5
  └─ P6 Local/Remote × SDK/CLI 四象限认证
       └─ P7 Admin、市场、版本与正式发布能力
```

P0 的 Windows 实机验收可以等待外部同事执行，但不应长期阻塞 P1。开始 P1 前应固定 P0 的提交、产物摘要和兼容声明，后续开发进入下一条 Preview 开发线；确切版本号在冻结门禁时决定，不提前虚构。

P1D 是独立的安装分发工作流，可在 P0 基线隔离、方案确认后先做探针并与 P1 按依赖推进；无需等待 Remote 实现。
两者修改 SDK managed/target 时必须共用一个生命周期与所有权 contract，避免分别实现自动启动。P7 Electron 的本地分发接入依赖 P1D 的相应门禁。

## 5. 阶段规划

### P0 `[~]` 冻结当前 Local Preview

**目标**：把已经实现的 Local Runtime、SDK 和 CLI 形成可追溯的 macOS/Windows 内测交付基线。

主要任务：

- `[x]` 生成 macOS arm64 与 Windows x64 候选包、checksums 和 CI artifacts。
- `[x]` 支持测试方通过 `CODEBUDDY_API_KEY_FILE` 自行配置内测 Key。
- `[x]` 完成 macOS 最终候选的真实 CodeBuddy 核心门禁。
- `[x]` 提供 Windows 从下载、安装到 SDK/CLI 实际接入的完整手册。
- `[ ]` 更新最终测试数量、兼容矩阵、证据和 Changelog 日期。
- `[ ]` 从冻结提交重新构建并验证双平台包。
- `[-]` 在真实 Windows 10/11 x64 环境完成 CodeBuddy SDK/CLI 验收。
- `[-]` 创建 `v0.1.0-preview.2` 不可变标签和 GitHub Pre-release。

完成门禁：

- macOS 与 Windows 交付物摘要可追溯到同一冻结提交。
- Windows 实机验收记录包含系统版本、Node 版本、包摘要、SDK/CLI 结果与已知限制。
- 兼容矩阵只声明已经取得证据的能力。

外部依赖：Windows 10/11 x64 机器、测试用 CodeBuddy Key、GitHub Environment Secret/Release 权限。

模型建议：`gpt-5.6-sol + high`。发布整理、文档和常规验证以性价比优先。

详细清单：[`dual-platform-preview-release/tasks.md`](../dual-platform-preview-release/tasks.md)。

### P1 `[ ]` Runtime 中立协议与 Local/Remote 双目标 SDK/CLI

**目标**：把当前 Local 专用语义迁移为一套可同时服务 Local 和 Remote 的稳定公共协议。

主要任务：

- 在 `packages/contracts` 定义中立 Session、Run、Event、Interaction 和 Runtime Profile。
- 增加 `/v1/*` 中立路由，保留已承诺的 `/local/*` 兼容别名与明确废弃周期。
- 在 SDK 中增加 `RuntimeTarget`：`local-daemon`、`local-managed`、`remote`。
- 增加远端 `AccessTokenProvider`、profile 握手和显式 transport 选择。
- CLI 增加 Local/Remote Profile，命令语义保持一致，禁止 token 命令行参数和静默 fallback。
- 抽取部署无关 Reference Conformance，验证旧客户端兼容和错误码边界。

完成门禁：同一套 SDK/CLI 用例可连接 Local Reference 与 Remote Reference；切换目标不改变业务调用语义；旧 Preview 客户端仍在承诺周期内可用。

前置依赖：固定 P0 冻结提交与协议兼容范围。

模型切换提醒：**开始实现前切换到 `gpt-6-astra + high`**。该阶段涉及公共协议、兼容迁移和跨包长链路改动。

详细清单：[`dual-runtime-compatibility/tasks.md`](../dual-runtime-compatibility/tasks.md) Phase 1-3。

### P1D `[~]` 统一本地安装与 Runtime 平台包

**状态**：方案已获用户确认，T1 本机安装/deploy 探针已落地，跨平台与 payload 契约仍待收口；T2–T7 未开始。新增包仍不是已发布能力。

**目标**：本地只安装 `@yanbot-harness/local` 即可无路径 managed 启动；Remote-only 只安装轻量 SDK；Runtime 继续独立模块/进程并支持独立分发。

主要任务：

- T0：确认 Spec、包名和首轮平台矩阵，隔离 P0 版本线，登记 Registry/许可/签名外部条件。
- T1：先验证 npm/pnpm 平台筛选、离线空缓存、pack 内容与 frozen payload 依赖闭包。
- T2/T3：平台 payload、runtime meta、可取消校验/展开和 local facade；SDK 保持无 Runtime 依赖。
- T4：新增 managed IPC、整树回收、父进程死亡、Windows ACL 和持久状态保护。
- T5/T6：受信签名、私有 Registry、离线 kit、版本并存与手动升级回滚。
- T7：Mac/Windows 新安装路径认证、Linux Reference 回归和文档切换。

完成门禁：Mac arm64、Windows x64 的安装/离线/生命周期/回滚矩阵通过；轻量 SDK 无 payload；当前支持与真实 CodeBuddy 证据分开。共享 Daemon 命令、Electron 产品实现和自动更新另行交付。

前置依赖：固定 P0 源提交/产物/能力声明，确认 `unified-local-distribution`；无需等待 P4/P5。与 P1 共享 target/managed handle 契约。

模型建议：`gpt-6-astra + high`。常规说明整理可用 `gpt-5.6-sol + high`；平台生命周期/发布信任变化时先复核设计。

详细清单：[`unified-local-distribution/tasks.md`](../unified-local-distribution/tasks.md)。

### P2 `[ ]` CLI Sidecar 基础设施

**目标**：建立可复用、可跨平台测试的 CLI 型厂商进程边界。

主要任务：

- 在 `packages/adapter-sidecar` 实现 Sidecar Client、Supervisor、initialize 握手和请求关联。
- 实现增量 JSONL 分帧、Schema 校验、背压、输出限制、超时、脱敏和幂等关闭。
- 实现 POSIX 进程组与 Windows 进程树的可靠取消和清理。
- 新建通用 `packages/adapter-cli-host`，统一安全 spawn、版本探测、隔离环境和临时凭据目录。
- 建立 Fake Sidecar/Fake Vendor CLI，覆盖半帧、CRLF、噪声、崩溃、无终态、超时和僵尸进程。

完成门禁：Fake CLI 故障矩阵全部通过；Runtime、SDK 和平台 CLI 中没有厂商输出解析或厂商名条件分支。

前置依赖：P1 的中立公共协议和 Adapter 能力语义。

模型建议：`gpt-6-astra + high`。进程生命周期、跨平台清理和协议健壮性需要强推理。

详细清单：[`cli-harness-adapter/tasks.md`](../cli-harness-adapter/tasks.md) Phase 2-3。

### P3 `[ ]` 首个真实 CLI 厂商 Adapter

**目标**：验证类似 Claude 的“仅提供或主要依赖 CLI”厂商能够通过 Wrapper 接入统一架构。

主要任务：

- 先选定厂商和精确 CLI 版本，评审许可证、安装方式、平台支持和机器输出承诺。
- 探测无 TTY 运行、结构化 JSON/JSONL、session/resume/cancel、工具、权限、模型、usage 和退出码。
- 建立厂商能力矩阵、输出 fixtures 和独立厂商 Adapter 子 Spec。
- 实现 Vendor Wrapper，将命令、输出、会话、权限和错误翻译为 Sidecar 协议。
- 仅把已验证能力声明为 `native`，其余明确为 `emulated` 或 `unsupported`。
- 在 macOS、Windows Local 和 Linux Remote Worker 中复用同一 Adapter 实现。

完成门禁：真实 CLI Adapter 通过 Adapter Conformance；支持版本、安装形态、凭据边界、升级与回滚可追溯。

前置依赖：P2；厂商版本和许可证结论。

模型建议：`gpt-6-astra + high`。厂商探针结论如果影响产品兼容承诺，临时提升到 `xhigh` 复核。

详细清单：[`cli-harness-adapter/tasks.md`](../cli-harness-adapter/tasks.md) Phase 1、4-6。

### P4 `[ ]` Remote Reference Runtime 与控制平面

**目标**：先用无真实模型凭据的 Reference Adapter 建立可验证的远端运行闭环。

主要任务：

- 建立 `apps/cloud-server` 子 Spec 和基础应用。
- 实现 HTTPS API、用户/设备认证、租户作用域、短期访问令牌和审计。
- 实现 Session/Run 持久化、幂等创建、SSE 事件重放和错误分类。
- 实现上传快照与受控 Git 引用、摘要校验、大小限制、TTL 和清理。
- 引入 Redis Queue 和 Reference Worker，验证排队、执行、取消与恢复。
- 完成跨租户拒绝、token 过期、恶意工作区清单和日志脱敏测试。

完成门禁：macOS/Windows 客户端使用同一 SDK/CLI 可连接 Remote Reference；租户、认证、工作区和事件重放安全用例通过。

前置依赖：P1；正式开发前必须建立独立 cloud-server 子 Spec。

模型建议：`gpt-6-astra + high`；认证、租户和令牌安全评审切换到 `xhigh`。

详细清单：[`dual-runtime-compatibility/tasks.md`](../dual-runtime-compatibility/tasks.md) Phase 3-4。

### P5 `[ ]` Remote Worker/Sandbox 与 CodeBuddy

**目标**：把 CodeBuddy SDK Adapter 安全地运行在远端隔离 Worker 中，形成首个真实 Remote Runtime。

主要任务：

- 建立 `apps/cloud-worker` 的队列领取、lease、心跳、取消、重试和孤儿任务收敛。
- 每个 Run 使用非 root 隔离容器和临时工作区，限制 CPU、内存、磁盘、进程、网络和挂载。
- 长期厂商凭据只留服务端，按 Run 向 Worker/Sandbox 注入短期或最小范围凭据。
- 实现 Session 写锁、隔离状态目录、TTL、容器重建恢复和运行后清理。
- 完成真实 CodeBuddy 初始运行、续接、交互、取消、超时、Worker 崩溃和恢复门禁。

完成门禁：远端真实 CodeBuddy 全流程通过；客户端、队列正文、事件和日志中均不存在厂商 Key；破坏性故障测试可自动收敛。

前置依赖：P4；可用的远端执行环境、凭据系统和安全评审资源。

模型建议：`gpt-6-astra + high`；Sandbox、凭据和隔离边界评审切换到 `xhigh`。

详细清单：[`dual-runtime-compatibility/tasks.md`](../dual-runtime-compatibility/tasks.md) Phase 5。

### P6 `[ ]` 四象限联合认证

**目标**：以统一证据确认两种 Runtime 与两种厂商接入模式能够自由组合。

| 组合                 | 执行环境                     | 必须验证                                               |
| -------------------- | ---------------------------- | ------------------------------------------------------ |
| Local + SDK Adapter  | macOS、Windows               | CodeBuddy SDK、Session/Run/Event、交互、取消、凭据保护 |
| Local + CLI Adapter  | macOS、Windows               | Wrapper、进程树、能力降级、安装/升级、凭据隔离         |
| Remote + SDK Adapter | Linux Worker；Mac/Win 客户端 | 认证、租户、远端工作区、事件重放、CodeBuddy            |
| Remote + CLI Adapter | Linux Worker；Mac/Win 客户端 | 镜像版本、Sidecar、Sandbox、取消/恢复、凭据注入        |

完成门禁：四象限都有固定版本、环境、用例和日志摘要；兼容矩阵、限制、回滚和测试方文档同步完成。

前置依赖：P3、P5，以及真实 Windows 10/11 x64 环境。

模型建议：`gpt-6-astra + high`。发布安全复核按风险临时提升到 `xhigh`。

详细清单：[`dual-runtime-compatibility/tasks.md`](../dual-runtime-compatibility/tasks.md) Phase 6。

### P7 `[ ]` 产品界面、运营与正式发布能力

**目标**：在稳定协议和运行底座之上完成面向用户与管理员的产品层。

可并行启动点：

- P1 完成后：Local Web、Local/Remote 连接选择、Adapter/模型选择。
- Local Web 稳定后，且 P1D 相关分发门禁通过：Electron 外壳、专用宿主生命周期、安装与升级。
- P4 完成后：Admin 用户/组织、Run、额度、用量和审计。
- P2/P3 版本模型稳定后：Adapter 市场、签名、安装、升级和回滚。
- P6 完成后：统一兼容声明、签名发布、正式版本冻结。

完成门禁：产品 UI 不绕过 SDK/公共协议；Admin 不直接操控厂商进程；安装、签名、升级、回滚和审计链路通过目标平台验收。

模型建议：常规产品开发使用 `gpt-5.6-sol + high`；涉及架构边界或发布安全时切换 `gpt-6-astra + high`。

## 6. 当前进度汇总

| 阶段                      | 状态  | 当前结论                                            | 下一动作                                           |
| ------------------------- | ----- | --------------------------------------------------- | -------------------------------------------------- |
| P0 Local Preview 冻结     | `[~]` | 候选包和 macOS 核心门禁已完成，Windows 实机外部阻塞 | 固定候选提交和摘要；并行等待 Windows 验收          |
| P1 中立协议与双目标客户端 | `[ ]` | 设计已完成，尚未实现                                | 建立/确认实施子 Spec 后开始 contracts 与兼容迁移   |
| P1D 统一本地安装          | `[~]` | T1 Mac 安装/deploy 探针通过，未完成跨平台门禁       | 共享 tgz/跨系统 lock、link-free payload 与契约冻结 |
| P2 CLI Sidecar 基础设施   | `[ ]` | 只有 Schema                                         | 在 P1 公共语义稳定后实现 Supervisor 和 Fake CLI    |
| P3 首个 CLI 厂商          | `[ ]` | 未选定精确厂商版本                                  | 先做能力与许可证探针，不直接写 Wrapper             |
| P4 Remote Reference       | `[ ]` | 只有设计                                            | 建立 cloud-server 子 Spec 和 Reference 闭环        |
| P5 Remote CodeBuddy       | `[ ]` | 未实现                                              | P4 通过后建设 Worker/Sandbox                       |
| P6 四象限认证             | `[ ]` | 未开始                                              | 等待 P3、P5 和 Windows 实机条件                    |
| P7 产品/运营              | `[ ]` | 未脚手架化                                          | Local Web 可在 P1 后并行，其余按依赖进入           |

## 7. 最近两个执行节点

1. **收口 P0**：固定 `0.1.0-preview.2` 候选提交、产物摘要和交付声明；不因暂时缺少 Windows 机器停止后续开发。
2. **推进后续 Preview 工作流**：P1D Spec 已确认并启动 T1，继续补齐跨平台、link-free payload 与安全契约探针；P1 中立协议按已有子 Spec 推进，共同冻结 managed target/handle 契约。建议 `gpt-6-astra + high`。

P1 完成后，再在 P2 CLI Sidecar 与 P4 Remote Reference 两条工作流之间并行推进；Local Web 也可在协议稳定后单独立项。

## 8. 进度维护规则

- 每个里程碑验收后更新：状态、完成日期、证据链接、已知限制和相对原计划的偏差。
- 专项 `tasks.md` 保存逐项事实；本文同步阶段级结论，不复制每日工作日志。
- 只有自动化测试、真实环境记录或已审核交付物可以支持 `[x]`。
- 等待设备、账号、Secret、许可证或外部同事时标为 `[-]`，并写明解除条件。
- “已设计”“已建 Schema”“已合并代码”和“已交付认证”必须严格区分。
- 阶段范围或风险明显变化时，重新评估模型与推理强度，并在开始实质工作前提醒。

## 9. 关联文档

- 总体需求：[`requirements.md`](./requirements.md)
- 总体架构设计：[`design.md`](./design.md)
- 原始里程碑任务：[`tasks.md`](./tasks.md)
- 统一系统架构：[`system-architecture.md`](../../architecture/system-architecture.md)
- 双 Runtime 专项：[`dual-runtime-compatibility`](../dual-runtime-compatibility/tasks.md)
- CLI 厂商接入专项：[`cli-harness-adapter`](../cli-harness-adapter/tasks.md)
- 统一本地分发专项：[`unified-local-distribution`](../unified-local-distribution/tasks.md)
- 双平台 Preview 发布：[`dual-platform-preview-release`](../dual-platform-preview-release/tasks.md)
- 当前交付兼容矩阵：[`compatibility.md`](../../delivery/compatibility.md)
