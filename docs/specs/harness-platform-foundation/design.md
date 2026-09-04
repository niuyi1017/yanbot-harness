# Yanbot Harness 平台基座总体设计

## 1. 设计原则

1. **业务与厂商双解耦**：核心领域模型既不出现教师端业务概念，也不采用任一Harness的专有术语作为公共语义。
2. **Adapter隔离**：所有厂商SDK调用集中在对应Adapter包中，CodeBuddy是首个生产实现而非核心协议本身。
3. **协议优先**：先定义稳定的 Run、Session、Event、Interaction、Capability 和 Extension 协议，再开发各客户端。
4. **本地执行优先**：先跑通 CLI/SDK/local-runtime/local-web，再叠加账号、Electron和云端沙箱。
5. **默认安全**：权限、配置来源、工作区、凭据和日志均采用最小授权。
6. **复用而非复制耦合**：复用教师端已验证的机制，重新划分模块边界，不复制业务分支和业务 Schema。
7. **保持团队栈一致**：不为架构新颖性引入 PostgreSQL、Turborepo、Fastify或另一套前端框架。

## 2. 总体架构

```text
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ CLI          │  │ Local Web    │  │ Electron     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                 │
       └────────── @yanbot-harness/sdk ─────┘
                          │
                contracts / event stream
                          │
          ┌───────────────┴────────────────┐
          │ local mode                    │ cloud mode
  ┌───────▼────────┐            ┌─────────▼──────────┐
  │ Local Runtime  │            │ Cloud Control Plane│◄── Admin Web
  │ loopback       │            │ auth/session/quota │
  └───────┬────────┘            └─────────┬──────────┘
          │                               │ Redis queue
          │                     ┌─────────▼──────────┐
          │                     │ Cloud Worker      │
          │                     │ sandbox runtime   │
          │                     └─────────┬──────────┘
          └──────────── adapter-api ──────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
  CodeBuddy Adapter  Future Adapter  Sidecar Adapter
         │                │                │
  CodeBuddy SDK      DeepSeek/Pi等    JSON-RPC/stdio

Cloud Control Plane ── MongoDB / Redis / Ali OSS / new-api
```

## 3. Monorepo 结构

```text
yanbot-harness/
├── apps/
│   ├── cli/                  # 命令行入口，只使用 packages/sdk
│   ├── local-web/            # 浏览器工作台，连接 local-runtime
│   ├── desktop/              # Electron main/preload + 工作台壳
│   ├── local-runtime/        # loopback Runtime，可被 CLI/Web/Electron拉起
│   ├── cloud-server/         # NestJS控制平面和公共 API
│   ├── cloud-worker/         # 首期单机Docker Worker，后续可替换调度层
│   └── admin-web/            # 账号、额度、市场、版本、用量后台
├── packages/
│   ├── contracts/            # Zod Schema、DTO、SSE事件和错误码
│   ├── sdk/                  # 面向集成方的稳定 TypeScript SDK
│   ├── harness-core/         # Run/Session/Interaction/Extension领域逻辑
│   ├── adapter-api/          # 厂商中立SPI、能力与生命周期接口
│   ├── adapter-kit/          # Adapter开发工具和Conformance Kit
│   ├── adapter-codebuddy/    # 首个生产Adapter，封装CodeBuddy SDK
│   ├── adapter-reference/    # 确定性测试Adapter，不访问真实模型
│   ├── adapter-sidecar/      # 后续实现；首期只冻结JSON-RPC/stdio协议
│   ├── permission-engine/    # 权限模式、规则匹配和审批决策
│   ├── config-loader/        # 用户/项目/本地/组织配置合并
│   ├── workbench-ui/         # Local Web/Electron共享 React UI
│   ├── extension-kit/        # MCP/Skill/Agent/Hook扩展描述与校验
│   ├── client-auth/          # 客户端令牌、设备身份和安全存储抽象
│   └── testing/              # 假 Runtime、协议 fixtures、兼容性测试工具
├── examples/
│   ├── sdk-basic/
│   ├── sdk-permissions/
│   └── custom-extension/
├── infra/
│   ├── docker/
│   └── compose/
└── docs/specs/
```

### 包边界规则

- `apps/*` 不得互相导入源代码。
- 所有跨进程数据先进入 `packages/contracts`。
- `packages/sdk` 不暴露 CodeBuddy SDK 原始类型。
- `packages/harness-core` 不依赖 Express、NestJS、Electron或数据库。
- `packages/adapter-*` 不包含产品UI、业务数据库和领域持久化。
- `packages/harness-core` 只依赖 `adapter-api`，不能按厂商名称写条件分支。
- `packages/adapter-kit` 是第三方Adapter作者唯一需要依赖的开发包。
- 业务扩展只能通过 `extension-kit` 和公开 SDK 接入，不能向核心包添加领域分支。

## 4. 核心领域模型

### 4.1 Session

表示可持续的对话上下文。

```ts
type HarnessSession = {
  id: string;
  adapterId: string;
  adapterSessionId?: string;
  workspaceId?: string;
  ownerId?: string;
  status: 'active' | 'archived' | 'invalid';
};
```

平台 Session ID 与厂商 Session ID 必须分离。映射由 Runtime 或云端安全存储，客户端不把厂商 ID 当作业务主键。Session创建后固定其 `adapterId`；切换Harness时默认创建新Session。

### 4.2 Run

一次用户输入对应一次 Run。

```ts
type HarnessRun = {
  id: string;
  sessionId: string;
  mode: 'local' | 'cloud';
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  modelRef?: `${string}:${string}`;
  permissionPolicy: 'interactive' | 'auto-edit' | 'read-only';
  maxTurns?: number;
};
```

公共权限策略不复用CodeBuddy枚举。CodeBuddy Adapter负责映射：`interactive → default`、`auto-edit → acceptEdits`、`read-only → plan`。危险操作的最终决策仍受平台禁止规则和工作区边界约束。

### 4.3 Event

统一事件采用可判别联合，至少覆盖：

- `run.started`
- `session.initialized`
- `assistant.delta`
- `assistant.message`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `interaction.requested`
- `interaction.resolved`
- `usage.updated`
- `run.completed`
- `run.failed`
- `run.cancelled`

每个事件包含 `eventId`、`runId`、`sessionId`、`sequence`、`timestamp`、`payload` 和可选的命名空间化 `adapterMetadata`。厂商原始消息不能作为公共协议透传；确需诊断的信息只能进入显式开启、脱敏且不保证稳定的Adapter metadata。

### 4.4 Interaction

统一表示工具权限和 `AskUserQuestion`：

- `permission`：工具名、风险级别、经过脱敏的输入摘要、可选决策。
- `question`：问题、选项、多选标记和验证规则。

Interaction 有超时、取消和幂等响应语义。沿用教师端 FIFO 交互队列的思路，但移除中文业务默认值。

### 4.5 Extension

MCP、Skill、Agent、Hook 统一拥有：

- 唯一标识、类型、版本和兼容范围。
- 发布者、来源、完整性摘要和签名信息。
- 配置 Schema、敏感字段声明和权限声明。
- 用户级、组织级、项目级作用域。
- 草稿、灰度、正式、下架状态。

## 5. Harness Adapter机制

### 5.1 分层

```text
@yanbot-harness/sdk             面向产品和集成方
        ↓
harness-core + contracts        稳定公共语义
        ↓
adapter-api                     厂商中立SPI
        ↓
adapter-codebuddy / adapter-pi / adapter-sidecar
        ↓
具体SDK、CLI或远程Harness
```

自有SDK与Adapter Kit是两个不同产品面：

- `@yanbot-harness/sdk`：让业务应用运行任务、订阅事件和响应交互。
- `@yanbot-harness/adapter-kit`：让平台团队或第三方实现新的Harness Adapter。

### 5.2 Adapter SPI

```ts
interface HarnessAdapter {
  readonly manifest: AdapterManifest;

  probe(context: ProbeContext): Promise<AdapterProbeResult>;
  createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime>;
}

interface AdapterRuntime {
  capabilities(): Promise<HarnessCapabilities>;
  listModels?(input?: ListModelsInput): Promise<ModelDescriptor[]>;
  startRun(input: AdapterRunInput): AsyncIterable<AdapterEvent>;
  resumeRun?(input: AdapterResumeInput): AsyncIterable<AdapterEvent>;
  respondToInteraction?(input: AdapterInteractionResponse): Promise<void>;
  cancel(input: AdapterCancelInput): Promise<void>;
  dispose(): Promise<void>;
}
```

Adapter实例按用户、运行环境和凭据作用域创建，禁止使用不可控的进程级全局单例保存会话状态。
可选方法是否存在必须与能力声明一致；核心在调用前检查能力并对缺失方法返回统一的 `CAPABILITY_UNSUPPORTED`，不能依赖厂商异常猜测。

### 5.3 能力协商

每个能力声明以下状态：

```ts
type CapabilitySupport = {
  level: 'native' | 'emulated' | 'unsupported';
  version?: string;
  limits?: Record<string, number | string | boolean>;
  configSchema?: JsonSchema;
  reason?: string;
};
```

首批标准能力：

- `sessions.resume`
- `runs.cancel`
- `streaming.text`
- `streaming.toolEvents`
- `interactions.permissions`
- `interactions.questions`
- `extensions.mcp`
- `extensions.skills`
- `extensions.agents`
- `extensions.hooks`
- `workspace.worktrees`
- `workspace.sandbox`
- `models.list`
- `usage.tokens`
- `usage.cost`
- `computerUse`

`native`表示Harness原生支持；`emulated`表示平台可通过历史重放、配置翻译或外围组件提供等价语义；`unsupported`必须让SDK/UI明确禁用。能力快照记录在Run开始事件中，便于审计和复现。

### 5.4 核心能力与可选能力

所有Adapter必须满足的最小核心：

- 探测可用性和版本。
- 启动一次运行并产生有序事件。
- 返回最终成功或失败状态。
- 支持取消，若底层不能硬中断则必须停止事件转发并报告降级语义。
- 归一化认证、配置和上游错误。
- 安全释放进程、连接和临时资源。

会话恢复、MCP、Skill、Agent、Hook和Computer Use均为可选能力，不能为了统一接口而伪造支持。

### 5.5 Adapter装载形态

#### 进程内Adapter

适用于Node/TypeScript SDK，例如CodeBuddy和未来可直接嵌入Node的Harness。优点是低延迟和强类型；必须限制依赖泄漏并提供显式dispose。

#### Sidecar Adapter（首期只设计）

适用于Python、Rust、独立CLI或需要进程隔离的Harness。采用版本化JSON-RPC over stdio协议，事件使用JSONL通知。标准方法映射到同一SPI，stderr只用于诊断且必须脱敏。

Sidecar握手返回协议版本、Adapter版本、Harness版本、能力和配置Schema。协议不兼容时启动失败，不做静默猜测。

首期不实现可用于生产的Sidecar进程管理，只冻结消息Schema、握手和生命周期语义，避免影响CodeBuddy本地与云端MVP进度。

### 5.6 Adapter注册与选择

- 内置Adapter通过静态注册表加载。
- 市场Adapter通过签名manifest、允许列表和隔离策略加载。
- 用户或组织选择 `adapterId + modelId`，公共 `modelRef` 使用 `<adapterId>:<modelId>`，避免跨厂商冲突。
- Session固定其Adapter；迁移到另一Adapter默认创建新Session。跨Harness上下文迁移属于显式导入/导出能力，不伪装成原生resume。

### 5.7 Conformance Kit

每个Adapter必须运行同一套黑盒测试：

- 探测、初始化、释放和重复释放。
- 最小Run及事件sequence单调性。
- 成功、上游失败、认证失败、配置错误和超时。
- 取消、断流和进程退出。
- 能力声明与实际行为一致。
- Interaction幂等和不支持能力的稳定错误。
- 敏感字段不进入事件、日志和异常。

Reference Adapter提供确定性脚本，用于SDK、CLI、UI和云端Worker的CI，不消耗真实Token。

## 6. CodeBuddy Adapter

### 6.1 职责

- 封装 `query()` 和 `unstable_v2_createSession()`。
- 统一处理认证环境、endpoint、模型和 fallbackModel。
- 将 SDK消息转换为 Harness Event。
- 管理会话恢复、中断、模型列表和结果统计。
- 将 Harness权限策略转换为 `canUseTool`。
- 将扩展配置转换为 `mcpServers`、`agents`、`hooks` 和 `settingSources`。
- 将 SDK Preview 兼容差异限制在包内。

### 6.2 版本策略

- `@tencent-ai/agent-sdk` 使用精确版本，不使用 `^` 或 `~`。
- Renovate/Dependabot 不自动合并 SDK升级。
- 每次升级必须通过消息 fixtures、会话恢复、权限、MCP、Skill、Hook、中断和打包兼容性测试。
- 对 `unstable_*` API 使用独立 facade；若发生破坏性变化，可退回 `query()` + session ID 恢复路径。

### 6.3 配置来源

SDK 默认不加载文件系统配置。平台显式计算：

```text
平台强制策略
  > 组织策略
  > 项目配置
  > 用户配置
  > 本地覆盖
```

只有配置解析结果明确允许时，才向 CodeBuddy 设置 `settingSources`。运行开始事件应包含经过脱敏的“实际生效配置摘要”。

## 7. 本地执行设计

### 7.1 Local Runtime

- 基于现有教师端 Express Runtime 演进，监听随机或配置的 `127.0.0.1` 端口。
- 提供 `/local/health`、sessions、runs、interactions、models、config、extensions 等接口。
- 运行事件使用 SSE；终端、语音等真正双向流能力才使用 WebSocket。
- 每次启动生成短期本地访问凭据；浏览器模式通过一次性启动令牌完成绑定。
- 不连接云端 MongoDB，不持有 JWT Secret、数据库凭据或长期平台模型密钥。
- 定义可替换的 `LocalStateStore`；首期使用用户数据目录下的按Session分文件元数据与JSONL事件日志，采用原子写入和版本字段，不引入SQLite或本地MongoDB。
- 本地状态只保存恢复会话和重放UI所需的数据；凭据、完整环境变量和未获授权的工具输入输出不得写入事件日志。

### 7.2 CLI

- CLI 是 SDK消费者，不直接调用 CodeBuddy SDK。
- 支持交互输出与 `--json`/JSONL 机器输出。
- 非交互模式必须能显式配置权限策略，禁止隐式使用 `bypassPermissions`。
- 退出码区分成功、用户取消、策略拒绝、认证失败、上游失败和 Runtime失败。

### 7.3 Local Web

- React + Vite + TDesign Chat/AIGC。
- 通过 local-runtime 获取数据，不直接访问 Node API。
- 本地网页由 Runtime 生成一次性连接地址，防止任意网页调用 loopback Agent。
- 浏览器工作区选择使用明确授权流程，不接受页面直接提交任意绝对路径。

### 7.4 Electron

- 复用 `packages/workbench-ui`，Electron只增加平台能力桥接。
- 参考教师端的子进程拉起、`safeStorage`、IPC sender校验和工作区签名。
- local-runtime 作为独立构建产物打包，保留安装包敏感文件扫描。
- Preview和Production使用独立配置、应用标识、更新渠道和签名流程。

## 8. 云端控制平面

### 8.1 技术栈

- NestJS 11、Mongoose、MongoDB。
- Redis用于会话缓存、额度原子扣减、限流、队列协调和幂等键。
- 阿里云 OSS用于发布包、扩展包、图标和非敏感工件。
- `new-api` 独立部署，用作上游模型路由或Token中转，不嵌入主服务进程。

### 8.2 模块划分

```text
auth
users
organizations
devices
sessions
runs
execution-grants
models
quotas
usage
extensions
marketplace
releases
audit
health
```

### 8.3 数据边界

- 使用独立 MongoDB database；若基础设施限制必须同库，则所有集合使用 `yanbot_harness_` 前缀。
- 不读取或写入研bot主业务集合。
- 不复用教师账号集合；外部系统通过 `externalIdentities` 建立可撤销绑定。
- 运行元数据与消息内容分离，便于制定不同保留和隐私策略。

### 8.4 核心集合

- `users`、`credentials`、`organizations`、`memberships`
- `devices`、`sessions`、`runs`、`run_events`
- `models`、`quota_policies`、`usage_records`
- `extensions`、`extension_versions`、`installations`
- `client_releases`、`release_channels`
- `execution_grants`、`audit_logs`

具体字段和索引在各模块实施 Spec 中单独定义；总体 Spec 不提前冻结所有 Schema。

## 9. 云端运行与沙箱

### 9.1 当前阶段实现范围

当前阶段不是建设最终的弹性云沙箱平台，而是基于现有项目技术基础完成可供内部使用的CodeBuddy云端Preview：

- `cloud-server`：沿用yanbot-teacher/yanbot-admin的NestJS模块化、JWT/RBAC、MongoDB和Redis模式。
- `cloud-worker`：单机常驻Worker，从Redis/BullMQ领取任务。
- `sandbox`：每个Run创建独立Docker容器和临时工作目录。
- `runtime`：容器内只运行通用Runtime与CodeBuddy Adapter。
- `stream`：Worker将统一事件写入Redis，Cloud Server通过SSE转发给客户端。
- `artifact`：用户明确允许保留的产物进入OSS，其余临时工作区运行后销毁。
- `admin`：只展示Run状态、用户、模型、时长、用量和错误分类。
- `workspace input`：PoC使用受控fixture；Preview只接受经授权的Git引用或上传快照，不保存任意私有仓库长期凭据。
- `session state`：容器按Run销毁，但Session级工作区和Adapter恢复状态保存在隔离目录或受控Volume中；每个Session同一时刻只允许一个写入Run，并设置TTL与显式清理策略。

现有教师端的执行授权、SDK事件转换、会话映射和权限交互可作为参考；现有Admin的账号、用量、版本和列表模式可作为参考。代码应迁入新仓库的通用模块，不能让云端Worker依赖教师业务服务。

Cloud Server不访问Docker Socket。只有部署在执行节点的Worker Supervisor具有创建和销毁容器的最小权限；Docker Socket不得挂载进用户沙箱容器。若单机Docker权限无法满足该边界，M10A必须给出阻断结论，而不是降低隔离要求。

Session持久状态与执行凭据分离：工作区、平台Session映射和经确认可保存的Adapter状态可在Run之间保留；CodeBuddy Key、OAuth Client Secret和短期Token每次运行重新注入，绝不写入Session Volume。M10A必须验证容器重建后的CodeBuddy resume行为，再决定保存哪些SDK状态目录；不能先假设只保存 `session_id` 就足够。

### 9.2 当前阶段运行流程

控制平面不直接执行 Agent。运行流程：

```text
客户端创建 Run
  -> 鉴权、额度和策略预检
  -> 写入队列
  -> Worker领取
  -> 获取Session互斥锁并挂载隔离状态目录
  -> 创建沙箱容器
  -> 注入短期凭据与只读配置
  -> 按adapterId启动对应Adapter
  -> 流式上报事件与用量
  -> 结束、释放锁、清理容器、按策略保留或销毁Session状态、结算额度
```

首个验证版本可使用单机 Docker Worker，但控制平面和 Worker 协议从一开始分离。后续可替换为 Kubernetes、轻量虚拟机或第三方沙箱，而不改变客户端协议。

沙箱至少限制：CPU、内存、磁盘、运行时长、网络出口、进程数和可挂载目录。

### 9.3 当前阶段不实现

- Kubernetes调度和自动扩缩容。
- Firecracker、microVM或第三方沙箱切换。
- 多机Worker租约和跨机容灾。
- DeepSeek Harness、Pi等其他Adapter的云端执行。
- 多地区部署、复杂计费和SLA体系。

这些能力由当前Worker/Sandbox接口预留替换点，但不创建空实现或提前引入基础设施依赖。

## 10. 权限与安全设计

### 10.1 权限决策顺序

```text
平台禁止规则
  -> 组织策略
  -> 工作区能力边界
  -> permissionPolicy
  -> Hook/扩展策略
  -> 用户交互确认
```

任一层拒绝即拒绝，后续层不能放宽上层限制。

### 10.2 凭据分类

- 平台长期密钥：只在云端Secret Store/部署环境。
- CodeBuddy企业OAuth凭据：只在服务端换取短期Token。
- 用户个人登录凭据：仅在明确支持的本地模式读取，不能上传云端。
- Electron Refresh Token：使用系统 `safeStorage`。
- Runtime访问令牌、执行授权、工作区Capability：短期、带作用域、可撤销或自然过期。

### 10.3 日志策略

默认允许记录：ID、状态、耗时、模型、Token/费用、错误分类、工具名称。

默认禁止记录：Prompt全文、文件内容、工具输入输出、环境变量、绝对工作区路径、完整命令、密钥和令牌。

## 11. 管理后台

- 前端复用 `yanbot-admin` 的 React + Vite + Ant Design + Tailwind模式。
- 后端仍属于本项目 `cloud-server`，不把模块塞入现有 `yanbot-admin`。
- 首批页面：登录、Dashboard、用户、组织、模型、额度、用量、运行状态、扩展、版本、审计。
- 所有列表采用服务端分页和过滤；统计接口返回聚合数据，不返回用户内容。

## 12. 市场与发布

### 12.1 扩展包

- 扩展包包含 manifest、配置Schema、权限声明、兼容范围、完整性摘要和资源文件。
- 服务端保存元数据，OSS保存不可变版本包。
- 安装时校验摘要、兼容性和状态；运行时只加载已安装且启用的版本。

### 12.2 客户端发布

- CLI/SDK走npm或私有Registry。
- Electron发布到OSS，Admin维护版本和渠道。
- Runtime版本与客户端版本建立兼容矩阵。
- Preview、灰度、Production分别配置，禁止覆盖同一不可变制品。

## 13. 可观测性

- 结构化日志统一字段：`traceId`、`userId`、`organizationId`、`deviceId`、`sessionId`、`runId`。
- 指标包括运行量、成功率、排队时间、首事件延迟、总耗时、并发、Token、费用、权限拒绝和SDK错误。
- SDK兼容错误与普通上游错误分开统计。
- Phase 0先建立日志和基础指标接口，后续接入现有服务器监控体系。

## 14. 与现有仓库的复用关系

### 14.1 `yanbot-teacher`

参考并重构复用：

- `apps/desktop/electron`：进程拉起、安全存储、IPC和导航安全。
- `apps/local-runtime/src/desktop-security.ts`：工作区Capability模式。
- `apps/local-runtime/src/interaction-manager.ts`：交互队列和超时。
- `apps/local-runtime/src/sdk-tool-events.ts`：SDK工具事件归一化思路。
- `scripts/build-electron-release.mjs`、`scripts/verify-electron-package.mjs`：构建矩阵和敏感内容校验。

明确不迁移：

- `school-report-rewrite.ts`、`adjustment-report-rewrite.ts`。
- 报告MCP工具、研招数据调用、教师Workflow和报告Schema。
- 教师账号、教师数据库集合和教师端云端业务接口。
- ASR默认不进入核心；未来作为可选扩展评估。

### 14.2 `yanbot-admin`

复用React/Ant Design页面模式、NestJS模块化、JWT/RBAC、Mongoose、Redis、版本管理和用量管理经验。代码不直接依赖现有Admin仓库，避免把两个产品部署生命周期绑在一起。

### 14.3 `yanbot` 与 `yanbot-fe`

- 复用MongoDB、Redis、OSS、Docker和CI/CD运维经验。
- 不复用Koa作为新控制平面；团队新服务已统一采用NestJS。
- 不采用Vue/Vant；其定位是移动H5和微信WebView，不匹配桌面工作台。

## 15. 被放弃的方案

### 15.1 直接从教师端复制整个仓库

放弃原因：复制会保留业务Schema、业务MCP、教师账号和大文件Runtime，后续仍然难以维护。正确方式是先定义公共协议，再按职责迁移通用代码。

### 15.2 把 Harness 直接做进 `yanbot-teacher`

放弃原因：无法形成独立版本、SDK、CLI、市场和云端交付边界，也会继续强化业务耦合。

### 15.3 为所有Harness设计完全相同的最低公分母接口

放弃原因：不同Harness对Session、MCP、Skill、Hook、权限和Computer Use的支持不等。强行统一会丢失能力或制造虚假兼容。采用“稳定核心 + 能力协商 + 命名空间化扩展”模型。

### 15.4 让上层SDK直接兼容每家厂商SDK

放弃原因：这会让自有SDK暴露厂商类型、异常和生命周期，业务方仍需理解每家Harness。厂商差异必须终止于Adapter SPI。

### 15.5 只支持进程内Node Adapter

放弃原因：未来Harness可能只有Python/Rust SDK或CLI。Sidecar协议从第一版设计，可避免为接入非Node实现重构Runtime。

### 15.6 引入PostgreSQL、Drizzle、Turborepo或Next.js

放弃原因：现有团队与基础设施主要使用MongoDB/Mongoose、pnpm workspace和Vite；新工具不能为首期带来足够收益。

### 15.7 控制平面进程直接执行Agent

放弃原因：Agent需要文件系统、Shell、MCP和较长生命周期，必须与账号/API服务隔离，避免资源争抢和扩大安全攻击面。

## 16. 演进规则

- 后续每个 Phase 或跨模块能力必须建立自己的子 Spec，并引用本总体 Spec。
- 如果实施发现本设计不成立，先更新本文档并记录决策，再修改代码。
- 总体 Spec 定义边界和顺序，子 Spec 负责冻结具体 API、Schema、页面和测试用例。
- 教师端迁移必须单独在 `yanbot-teacher/docs/specs/` 建立跨仓库 Spec，不能只在本仓库记录。
- 每新增一个生产Adapter，都必须建立独立子Spec，记录能力映射、缺失能力、认证方式、版本兼容和安全边界。
