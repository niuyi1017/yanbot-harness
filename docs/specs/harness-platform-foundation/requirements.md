# Yanbot Harness 平台基座需求规格

## 1. 背景与目标

研bot教师端已经基于 `@tencent-ai/agent-sdk` 跑通了 Electron、本地 Runtime、MCP、Skill、工具权限、会话续接和云端账号协作，但当前实现与教师、择校报告、调剂报告、研招数据等业务深度耦合，无法作为其他产品的基础设施复用。

本项目要建设一套独立的多 Harness 产品化基座。它通过统一 Adapter 机制兼容不同厂商或开源 Harness，首个生产级实现基于 CodeBuddy Agent SDK；后续可接入 DeepSeek Harness、Pi 等实现。平台统一提供 CLI、TypeScript SDK、本地 Web、Electron、云端执行和管理后台，并将账号、用量、MCP、Skill、Agent、版本、权限和运行记录沉淀为通用能力。研bot教师端及后续业务产品只保留业务模块，通过稳定协议接入该基座。

一句话目标：**把已验证的 CodeBuddy 本地执行能力从教师业务中剥离，形成可独立交付、可嵌入、可运营的通用 Harness 平台。**

## 2. 产品定位

本项目的“通用”同时包含业务领域无关和 Harness 厂商可替换，但不要求首期一次性实现所有厂商。

- 首个生产级 Adapter：CodeBuddy Agent SDK。
- 核心层通过统一 Adapter SPI 隔离厂商API，避免 CodeBuddy、DeepSeek、Pi 等原始类型扩散到客户端与业务产品。
- Adapter 必须通过能力协商声明原生支持、平台模拟或不支持的功能，上层不得假设所有 Harness 能力完全一致。
- 首期需交付 CodeBuddy Adapter、测试用 Reference Adapter 和 Adapter Conformance Kit；Sidecar只完成协议设计，其他厂商的生产Adapter与Sidecar实现均不进入当前开发范围。
- 本项目是独立产品、独立仓库、独立数据库边界，不属于 `yanbot` 主业务服务的一个模块。

## 3. 目标用户

### 3.1 最终用户

- 在本地项目中使用 AI Agent 的开发者或知识工作者。
- 需要通过 CLI、本地 Web 或 Electron 使用同一会话和工具能力的用户。
- 使用组织分配账号、模型额度、MCP、Skill 或 Agent 模板的企业用户。

### 3.2 集成开发者

- 使用 `@yanbot-harness/sdk` 将 Agent 能力嵌入现有应用的研发人员。
- 为平台开发 MCP、Skill、Agent、Hook 或业务扩展包的开发人员。

### 3.3 平台管理员

- 管理用户、组织、角色、额度、模型、版本和市场内容。
- 查看运行量、Token、成本、失败率和审计记录。
- 发布和回滚客户端、Runtime、Skill、MCP、Agent 等版本。

## 4. 核心用户故事与验收标准

### R1. CLI 基础执行

- 用户可在指定工作目录启动一次 Agent 任务，并流式查看文本、工具调用、权限请求和最终结果。
- 用户可创建、继续、恢复和中断会话。
- CLI 可显式选择模型、权限模式、配置来源、MCP、Skill 和 Agent。
- 未配置有效认证时给出可操作的错误提示，不打印密钥或完整令牌。

### R2. 自有 TypeScript SDK

- 集成方只依赖平台定义的稳定类型，不直接依赖 CodeBuddy SDK 消息类型。
- SDK 支持启动、续接、中断运行，以及订阅统一事件流。
- SDK 可连接嵌入式本地 Runtime、独立 Daemon 或云端执行服务。
- 任一厂商 SDK 升级时，非对应Adapter包不应被迫同步修改。

### R2A. Harness Adapter机制

- 平台通过稳定SPI注册、发现、初始化和销毁Harness Adapter。
- Adapter至少实现运行启动、事件流、取消和错误归一化等核心能力。
- 会话恢复、MCP、Skill、Agent、Hook、工具权限、Worktree、Computer Use、用量等能力采用可协商能力声明。
- 每项能力声明为 `native`、`emulated` 或 `unsupported`，并可携带版本、限制和配置Schema。
- 上层SDK和UI根据能力动态启用功能；不支持的能力必须明确禁用，不得静默降级。
- Node/TypeScript Harness可使用进程内Adapter；Python、Rust或独立CLI可通过标准sidecar协议接入。
- 第三方Adapter可使用独立的 `adapter-kit` 开发和运行一致性测试，不需要依赖平台内部实现。

### R3. 本地 Web 工作台

- 用户可在浏览器中选择工作区、创建会话、发送任务、查看流式响应和工具执行状态。
- 用户可处理 `AskUserQuestion` 和工具权限请求。
- 页面刷新后可以恢复已持久化的会话与运行状态。
- Web 页面不得直接获得文件系统、模型密钥或 Node.js 权限。

### R4. Electron 客户端

- Electron 与本地 Web 复用主要工作台 UI 和协议。
- Electron 负责安全选择工作区、签发本地工作区授权并拉起 local-runtime 子进程。
- 保持 `contextIsolation: true`、`nodeIntegration: false`、renderer sandbox 和 IPC sender 校验。
- Refresh Token 使用系统安全存储；平台密钥不得进入 renderer 或生产安装包。

### R5. Local Runtime

- Runtime 只监听 loopback，并对本地接口执行来源校验。
- Runtime通过Adapter统一封装各Harness的认证、配置、会话、消息、权限和扩展能力；首期只装载CodeBuddy Adapter。
- 公共协议只表达用户、组织、项目和本地配置作用域；各Adapter负责翻译为厂商配置机制。首期CodeBuddy Adapter只有在产品策略明确允许时才设置 `settingSources`。
- Runtime 不包含教师、院校、择校、调剂等业务代码。

### R6. 云端执行

- 用户可使用相同协议创建云端运行，并获取流式事件。
- 每次运行具有隔离工作区、资源限制、超时、并发限制和可审计生命周期。
- 对声明支持会话恢复的Adapter，同一云端Session在容器销毁并重建后仍可恢复；凭据不得随Session状态持久化。
- 用户和组织数据严格隔离，运行容器不持有平台长期密钥。
- 云端执行失败后可以区分用户任务失败、模型失败、基础设施失败和策略拒绝。

### R7. 账号、组织与权限

- 支持用户、组织、成员、角色、状态和登录凭据管理。
- 支持管理员、运营人员、普通用户等最小角色集合。
- 敏感管理操作必须鉴权、鉴权失败默认拒绝，并写入审计日志。
- 本项目账号体系独立于研bot C端用户和教师账号；未来如需关联，通过显式外部身份绑定实现。

### R8. 模型、额度与用量

- 管理员可配置可用模型、默认模型、上游路由和用户/组织额度。
- 平台记录每次运行的模型、时长、轮数、Token/费用（以上游可提供字段为准）、结果状态和错误分类。
- 支持按用户、组织、模型和时间范围查询用量。
- 超额、并发受限或模型不可用时返回稳定错误码。

### R9. MCP、Skill 与 Agent 管理

- 支持用户级、组织级和项目级配置作用域。
- 支持安装、启停、配置、升级和卸载。
- 配置中敏感字段加密保存、脱敏展示，不进入普通日志。
- 运行前可计算本次实际生效的配置清单，并允许用户检查。

### R10. 市场与版本管理

- 管理员可维护 MCP、Skill、Agent 的元数据、版本、兼容范围、状态和发布渠道。
- 客户端只安装经过完整性校验且与当前 Runtime 兼容的版本。
- 支持草稿、灰度、正式、下架状态以及版本回滚。
- 市场内容与本地用户配置分离，升级不得覆盖用户已有配置。

### R11. 客户端版本发布

- 管理员可维护 CLI、SDK、Electron、Runtime 的版本、渠道、更新说明和下载地址。
- Preview 与 Production 构建、配置和发布产物严格区分。
- 发布前自动检查安装包中不存在 `.env`、平台密钥、数据库凭据、源码映射和禁止依赖。

### R12. 可观测性与审计

- 所有运行具有 `runId`、`sessionId`、`userId`、`deviceId` 和关联追踪标识。
- 记录结构化日志、运行指标、错误分类和关键管理审计事件。
- 默认不上传本地文件内容、工具输入输出、绝对工作区路径等敏感数据。
- 管理端可查看聚合运行状态，但不能无授权浏览用户本地内容。

## 5. 非功能需求

### 5.1 安全

- 默认权限模式不得使用 `bypassPermissions`。
- 所有文件访问必须限定在已授权工作区内，并防止路径穿越和符号链接越界。
- 高风险工具调用必须进入统一权限策略和交互流程。
- 平台密钥只存在于受控服务端；本地长期凭据应使用系统安全存储。
- 云端运行采用短期凭据，过期后不可继续调用上游模型。

### 5.2 稳定性

- CodeBuddy SDK 处于 Preview，必须锁定精确版本并建立兼容性测试。
- Runtime 进程异常不得导致客户端静默卡死；客户端应展示可恢复错误。
- 流式连接断开后允许重连并从可确认的事件位置恢复，或明确标识不可恢复。
- 队列、缓存和用量统计失败不能绕过权限与额度安全边界。

### 5.3 可维护性

- 应用之间只能通过 `packages/contracts`、`packages/sdk` 或其他明确公共包通信，禁止跨 app 直接导入源码。
- 厂商SDK只能由各自Adapter包直接依赖；核心、客户端和自有SDK不得引用厂商原始类型。
- 新Adapter必须通过统一Conformance Kit，不能通过在核心层增加厂商条件分支接入。
- 通用 Runtime 不得出现 `teacher`、`school`、`adjustment`、`report` 等领域概念。
- 协议和 Schema 变更先更新 contracts，再更新生产者和消费者。

### 5.4 性能基线

- 本地 Runtime 冷启动、首个流式事件延迟和内存占用须在基线测试中记录。
- 单用户并发、组织并发、运行超时和最大轮数均可配置。
- 管理端统计查询不得扫描或返回完整消息内容。

### 5.5 跨平台

- 首期至少支持团队当前主要交付平台和开发平台；具体矩阵在客户端基线任务中固化。
- 路径、Shell、进程拉起和安装包验证必须覆盖 Windows 与 macOS 差异。

## 6. 范围分期

### Phase 0：架构验证

- 锁定 CodeBuddy SDK 版本和能力矩阵。
- 建立 monorepo、contracts、adapter-api、adapter-kit、Reference Adapter和CodeBuddy Adapter最小骨架。
- 验证进程内Adapter；冻结sidecar Adapter协议Schema和握手边界，不实现sidecar运行时。
- 验证一次运行、流式事件、权限交互、会话恢复和中断。

### Phase 1：本地 MVP

- CLI、自有 SDK、本地 Web、local-runtime。
- MCP、Skill、Agent 基础配置。
- 本地会话与运行记录。
- 不依赖云端账号即可完成受限的开发调试模式。

### Phase 2：账号与 Electron

- 云端账号、设备、会话元数据和执行授权。
- Electron 安全边界、打包、Preview/Production 发布。
- Admin 用户、模型、额度和基础用量管理。

### Phase 3：平台运营能力

- MCP、Skill、Agent 市场。
- 版本管理、灰度、完整性校验、升级和回滚。
- 完整用量统计、告警和审计。

### Phase 4：Computer Use 与浏览器能力

- Chrome DevTools MCP 集成。
- Computer Use 能力、截图/操作权限、风险确认与审计。
- 能力必须以可插拔扩展接入，不能污染核心运行协议。

### Phase 5：云端 Harness

- 直接复用现有NestJS、MongoDB、Redis、Docker、OSS、执行授权和SSE经验，先完成CodeBuddy单机Docker Preview。
- 第一项先验证CodeBuddy无头运行、单机容器隔离、凭据注入、事件回传、中断和清理。
- 第二项再接入云端队列、Run生命周期、基础资源限制，并与Admin的账号、额度和运行状态联调。
- 上游模型路由可接现有基础设施或独立部署的 `new-api`，不在Harness进程内重造中转服务。
- 当前阶段不建设多机调度、Kubernetes、microVM、多地区容灾和其他厂商云端Adapter。
- Preview工作区输入只支持受控测试仓库、经授权的Git引用或上传快照；任意私有仓库凭据托管不进入当前范围。

### Phase 6：业务迁移与全栈优化

- 选择教师端一个低风险通用会话场景试点接入 Harness。
- 逐步迁移教师端通用 Runtime，业务报告工具继续保留在教师端扩展包中。
- 完成性能、稳定性、安全和运维优化。

## 7. 明确不在首期范围内

- 重写研bot教师端全部业务。
- 将研bot、教师端或管理端现有业务数据库迁入本项目。
- 除CodeBuddy外，首期不交付其他厂商的生产级Adapter，只保证机制、Reference Adapter和兼容测试成立。
- 实现DeepSeek Harness、Pi或其他厂商的生产级Adapter。
- 实现Sidecar Adapter运行时；当前只冻结协议边界和版本握手设计。
- 自研基础大模型或推理平台。
- 首期实现复杂计费结算、支付、发票和渠道分成。
- 首期建设 Kubernetes/Firecracker 生产集群、多机调度或多地区容灾；先完成单机Docker Preview和接口抽象。
- 把 ASR、择校报告、调剂报告等业务能力放入核心包。

## 8. 约束与依赖

- Node.js 统一使用 22.x，包管理器使用 pnpm workspace。
- 首个生产Adapter使用 `@tencent-ai/agent-sdk`，其 Preview 状态要求精确锁版。
- Adapter SPI必须保持厂商中立，不能把CodeBuddy权限模式、消息类型或配置文件命名定义成公共协议。
- 延续团队 React、Vite、Electron、NestJS、Mongoose、Redis、阿里云 OSS、Docker 和 GitHub Actions 技术体系。
- 参考 `yanbot-teacher/apps/local-runtime` 的运行与安全模式，但以重构抽取为主，不直接整目录复制。
- 参考 `yanbot-admin` 的账号、角色、用量、版本和管理端模式，但新项目使用独立数据库边界。
- 任何真实 CodeBuddy Key、OAuth Client Secret、MongoDB URI、JWT Secret 均不得提交到仓库。

## 9. 待确认项

以下问题不阻塞 Phase 0，但必须在对应阶段开始前确认：

- Electron 首发平台矩阵及自动更新渠道。
- 本地模式是否允许使用用户自己的 CodeBuddy 登录凭据，还是只允许平台账号授权。
- CodeBuddy 企业 OAuth、API Key 和自建 `new-api` 各自适用的环境与商业授权边界。
- 单机Docker Preview之后，生产沙箱采用Kubernetes、轻量虚拟机还是第三方服务。
- 市场内容是否允许第三方作者发布，以及是否需要审核、签名和分成。
- 用量是仅用于额度控制，还是进入真实计费结算。

## 10. 完成定义

本平台总体目标完成需满足：

- CLI、本地 Web、Electron 和云端均通过同一 contracts/sdk 驱动运行。
- 厂商SDK只存在于各自Adapter层，业务产品不直接处理原始消息。
- 同一CLI/SDK/UI至少能无代码改动地在CodeBuddy Adapter和Reference Adapter之间切换。
- Adapter Conformance Kit能够验证核心能力、能力协商、事件顺序、错误和取消语义。
- 本地与云端的会话、权限、配置和事件语义一致。
- Admin 可管理账号、额度、用量、市场和版本。
- 教师端至少一个试点场景成功接入，且 Harness 核心不存在教师业务代码。
- 安全、兼容性、打包和端到端验证进入 CI。
