# Yanbot Harness 平台基座开发任务大纲

## 当前状态（2026-09-04）

- M0/M1的协议、Adapter、fixture、Sidecar Schema、文档和本地CI门禁已经实现并通过。
- M0尚待受控环境真实CodeBuddy探针，以及GitHub邀请处理后的远端Actions验证。
- 未开始M2；在真实探针结论写回能力矩阵前，不进入Local Runtime开发。

## 使用方式

本文件是总体任务基线，不是一次迭代全部执行的待办清单。

- 每个阶段开始前必须建立更细的子 Spec。
- 每个一级任务原则上对应一个可独立Review的里程碑；其中的大型模块应再拆为多个提交。
- 所有协议改动遵循“contracts → 生产者 → 消费者”的顺序。
- 完成一个阶段后更新本文状态、实际验证结果和偏差说明。

## 里程碑总览

```text
M0 仓库、Adapter SPI与SDK探针
 └─ M1 公共协议、Adapter Kit与首批Adapter
     ├─ M2 Local Runtime
     │   ├─ M3 自有SDK与CLI
     │   └─ M4 本地Web
     │       └─ M5 云端账号与控制平面
     │           ├─ M6 Electron
     │           └─ M7 Admin与运营能力
     │               ├─ M8 市场与版本
     │               └─ M9 Computer Use
     └─ M10A 云端Harness调研与单机PoC（可并行）
             └─ M10B 云端Preview与Admin联调（同时依赖M7）
                     └─ M11 教师端试点迁移与阶段发布
```

## 需求追踪矩阵

| 需求                     | 主要设计/实施里程碑 |
| ------------------------ | ------------------- |
| R1 CLI基础执行           | M2、M3              |
| R2 自有TypeScript SDK    | M1、M3              |
| R2A Harness Adapter机制  | M0、M1              |
| R3 本地Web工作台         | M2、M4              |
| R4 Electron客户端        | M4、M6              |
| R5 Local Runtime         | M1、M2              |
| R6 云端执行              | M5、M10A、M10B      |
| R7 账号、组织与权限      | M5、M7              |
| R8 模型、额度与用量      | M5、M7、M10B        |
| R9 MCP、Skill与Agent管理 | M2、M4、M8          |
| R10 市场与版本管理       | M8                  |
| R11 客户端版本发布       | M6、M8              |
| R12 可观测性与审计       | M2、M5、M7、M10B    |

## M0. 仓库初始化、Adapter SPI与CodeBuddy能力探针

**目标**：建立可持续开发的空白基线，并验证官方SDK关键能力。

**前置依赖**：总体 Spec 获得确认。

**主要文件**：

- 根目录 `package.json`、`pnpm-workspace.yaml`、`tsconfig*`。
- `.gitignore`、`.editorconfig`、ESLint/Prettier配置。
- `packages/adapter-api`、`packages/adapter-reference`。
- `packages/adapter-codebuddy` 探针。
- `docs/architecture/codebuddy-capability-matrix.md`。

**工作内容**：

- 固定Node、pnpm、TypeScript和CodeBuddy SDK精确版本。
- 建立 `apps/*`、`packages/*` workspace与根命令。
- 定义最小Adapter生命周期、核心能力、能力协商和版本化manifest。
- 建立不访问模型的Reference Adapter，供上层CI使用。
- 验证 `query()`、流式消息、结果统计、权限回调、MCP、Skill、Agent、Hook、Session恢复和中断。
- 冻结sidecar JSON-RPC握手和最小Run协议；不实现生产sidecar进程管理。
- 记录中国版、企业OAuth、API Key、本地已有登录凭据的差异，不提交真实凭据。
- 配置最小CI：安装、格式、类型检查、测试、构建和Secret扫描。

**验收方式**：

- `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`通过。
- 探针在假凭据模式可跑单元测试；在本地受控环境完成一次真实SDK冒烟。
- 仓库扫描确认无密钥、`.env`和数据库连接串。
- 同一探针客户端可切换Reference与CodeBuddy Adapter，无需修改调用代码。

## M1. 公共协议、Adapter Kit与首批Adapter

**目标**：建立稳定的Harness公共语言，隔离CodeBuddy Preview API。

**前置依赖**：M0。

**主要文件**：

- `packages/contracts`。
- `packages/harness-core`。
- `packages/adapter-api`。
- `packages/adapter-kit`。
- `packages/adapter-reference`。
- `packages/adapter-sidecar` 协议定义，不含生产运行实现。
- `packages/adapter-codebuddy`。
- `packages/testing`。

**工作内容**：

- 定义Session、Run、Event、Interaction、Usage、Error和Extension Schema。
- 定义Runtime接口、Adapter SPI、manifest和能力协商Schema。
- 实现CodeBuddy消息到Harness事件的无损归一化。
- 实现会话ID映射、恢复、中断、模型列表和错误分类。
- 建立Reference Adapter，并完成sidecar协议Schema、握手和生命周期设计。
- 建立公开Adapter Kit、固定SDK消息fixtures和黑盒Conformance Kit。
- 验证能力为native、emulated、unsupported时SDK和UI消费语义一致。

**验收方式**：

- 只有adapter-codebuddy中存在 `@tencent-ai/agent-sdk` 导入。
- 所有公开输入输出均可被Zod解析并通过序列化往返测试。
- SDK消息fixture覆盖成功、失败、工具调用、权限、提问、中断和费用统计。
- Reference和CodeBuddy Adapter通过同一Conformance Kit；Sidecar协议通过序列化和版本协商测试。
- 核心代码不存在按 `codebuddy`、`deepseek`、`pi` 分支处理运行语义的逻辑。

## M2. Local Runtime与安全边界

**目标**：提供业务无关、可独立运行的loopback Agent服务。

**前置依赖**：M1。

**主要文件**：

- `apps/local-runtime`。
- `packages/permission-engine`。
- `packages/config-loader`。
- `packages/extension-kit`。

**工作内容**：

- 实现health、models、sessions、runs、events、interactions和extensions接口。
- 实现SSE事件流、取消、超时、幂等和断连清理。
- 实现首期文件型LocalStateStore、Session元数据和JSONL事件恢复。
- 抽取教师端InteractionManager、workspace capability、MCP配置和Skill发现机制。
- 建立权限决策链、高风险工具分类和安全默认值。
- 实现厂商中立的配置作用域和合并规则；CodeBuddy专有 `settingSources` 映射留在Adapter内部。
- 确认Runtime中无教师业务代码和云端数据库依赖。

**验收方式**：

- 仅绑定loopback，未授权网页或进程不能调用运行接口。
- 路径穿越、伪造capability、过期令牌和重复Interaction响应测试通过。
- `rg`检查不出现教师、择校、调剂、报告等业务实现。
- 真实SDK冒烟覆盖一次运行、权限确认、用户提问、恢复和中断。

## M3. 自有TypeScript SDK与CLI

**目标**：形成第一个可交付的编程接口和终端产品。

**前置依赖**：M2。

**主要文件**：

- `packages/sdk`。
- `apps/cli`。
- `examples/sdk-*`。

**工作内容**：

- 实现嵌入式、本地Daemon连接方式和统一事件订阅。
- 提供创建、恢复、中断Session/Run的稳定API。
- CLI支持交互输出、JSONL、模型、工作区、权限模式和配置来源。
- 定义退出码、错误信息、日志级别和凭据查找顺序。
- 编写最小示例和API文档。

**验收方式**：

- 示例项目只依赖 `@yanbot-harness/sdk` 即可运行。
- CLI交互模式和无头JSONL模式通过端到端测试。
- 凭据不会出现在命令输出、错误堆栈或调试日志。
- 打包产物可在干净Node 22环境安装运行。

## M4. 本地Web工作台

**目标**：提供完整的本地可视化使用入口。

**前置依赖**：M2、M3。

**主要文件**：

- `apps/local-web`。
- `packages/workbench-ui`。

**工作内容**：

- 建立React/Vite/TDesign Chat界面。
- 实现会话列表、聊天、运行状态、工具时间线、权限弹窗和提问交互。
- 实现工作区授权、模型选择、MCP/Skill/Agent配置入口。
- 实现刷新恢复、断流提示和重新连接。
- 建立local-runtime一次性浏览器绑定流程。

**验收方式**：

- 从空目录启动Runtime后可以打开Web、授权工作区并完成一次任务。
- 页面刷新后会话和正在运行状态表现符合协议。
- 任意外部网页无法直接调用loopback运行接口。
- 浏览器端构建产物不包含Node API、平台密钥或服务端环境变量。

## M5. 云端账号、会话元数据与控制平面

**目标**：建立后续Electron、Admin和云端执行共享的服务端基础。

**前置依赖**：M1；开始前新增模块子Spec。

**主要文件**：

- `apps/cloud-server`。
- `packages/client-auth`。
- `infra/compose`。

**工作内容**：

- 建立NestJS、MongoDB、Redis、配置校验和health。
- 实现用户、组织、成员、设备、登录和RBAC。
- 实现Session/Run元数据、执行授权和设备绑定。
- 实现模型目录、额度预检、用量上报与审计基础。
- 定义本地模式和平台账号模式的凭据边界。

**验收方式**：

- API单元/集成测试覆盖跨用户、跨组织越权。
- 短期执行授权过期、重放、错设备和错工作区均被拒绝。
- MongoDB使用独立数据库或统一前缀，不访问研bot业务集合。
- Redis异常不会导致权限或额度绕过。

## M6. Electron客户端与发布基线

**目标**：复用本地Web能力形成安全桌面客户端。

**前置依赖**：M4、M5。

**主要文件**：

- `apps/desktop`。
- Electron构建和验证脚本。
- `packages/workbench-ui`。

**工作内容**：

- 实现main/preload、local-runtime拉起、窗口和导航安全。
- 实现工作区选择、capability签发、safeStorage和设备身份。
- 复用workbench-ui，不复制聊天页面。
- 建立Preview/Production配置与构建矩阵。
- 建立安装包资源、重复CLI、敏感文件和禁止依赖检查。

**验收方式**：

- Electron安全测试覆盖contextIsolation、sandbox、IPC sender和外链策略。
- Preview/Production解包构建均通过验证脚本。
- 安装包不存在 `.env`、模型Key、Mongo/JWT Secret、TypeScript源码和source map。
- Windows/macOS目标矩阵按确认范围完成冒烟。

## M7. Admin、模型、额度、用量和审计

**目标**：建立最小可运营后台。

**前置依赖**：M5。

**主要文件**：

- `apps/admin-web`。
- `apps/cloud-server/src/modules/{models,quotas,usage,audit}`。

**工作内容**：

- 复用yanbot-admin的React/Ant Design/NestJS/RBAC模式。
- 实现用户、组织、模型、额度、用量、运行状态和审计页面。
- 建立服务端分页、筛选、导出边界和脱敏规则。
- 接入Redis原子额度控制和幂等用量记录。

**验收方式**：

- 普通用户无法访问管理API；各管理角色权限符合矩阵。
- 用量重复上报不重复扣减，失败补偿有审计记录。
- 管理后台不显示Prompt、文件内容、工具输入输出和完整本地路径。
- Dashboard指标可由测试运行数据复现。

## M8. MCP、Skill、Agent市场与版本系统

**目标**：支持平台扩展能力的发布、安装、升级和治理。

**前置依赖**：M2、M5、M7；开始前新增市场子Spec。

**主要文件**：

- `packages/extension-kit`。
- `apps/cloud-server/src/modules/{extensions,marketplace,releases}`。
- `apps/admin-web`和工作台扩展页面。

**工作内容**：

- 冻结manifest、配置Schema、权限声明和兼容范围。
- 实现OSS不可变制品、摘要/签名校验和状态机。
- 实现安装、启停、升级、回滚和配置迁移。
- 实现客户端/Runtime版本渠道与兼容矩阵。
- 确保更新不覆盖用户已有MCP配置。

**验收方式**：

- 被篡改、下架、不兼容或无权限的扩展不能安装/加载。
- 灰度、正式、回滚流程可通过测试制品完整演练。
- Electron和Runtime版本不兼容时提供阻断和升级提示。

## M9. Chrome DevTools MCP与Computer Use

**目标**：以扩展形式接入浏览器和Computer Use能力。

**前置依赖**：M8；开始前新增安全威胁模型和能力子Spec。

**主要文件**：

- 独立extension包或MCP包。
- `permission-engine`能力策略。
- 工作台浏览器交互UI。

**工作内容**：

- 跑通Chrome DevTools MCP发现、连接、权限和工具事件。
- 定义截图、点击、输入、上传、下载和敏感数据传输风险级别。
- 实现动作前确认、会话授权、审计摘要和敏感信息脱敏。
- 与核心Runtime保持扩展边界。

**验收方式**：

- 浏览器能力关闭时核心Harness不受影响。
- 高风险动作未经确认不能执行。
- 截图、表单数据和浏览历史不进入普通日志或用量记录。
- 安全测试覆盖恶意网页内容和工具提示注入场景。

## M10A. 云端Harness调研与单机CodeBuddy PoC

**目标**：基于现有项目技术和服务器基础，验证CodeBuddy可在单机Docker沙箱中完成无头执行闭环。

**前置依赖**：M1；可与M2–M7并行，开始前建立轻量云端PoC子Spec。

**主要文件**：

- `apps/cloud-worker`。
- `apps/cloud-server/src/modules/runs`。
- `infra/docker`、`infra/compose`。
- `docs/architecture/cloud-harness-poc.md`。

**工作内容**：

- 验证CodeBuddy SDK/CLI在无头Linux容器中的认证、模型调用和退出行为。
- 使用Docker为每个Run创建临时工作区、非root用户和基础资源限制。
- PoC只使用受控fixture工作区，不引入私有Git凭据托管。
- 验证短期凭据注入、事件回传、权限请求、中断、超时和容器清理。
- 验证容器销毁重建后的CodeBuddy会话恢复，识别必须持久化的SDK状态目录和不能持久化的凭据。
- 记录冷启动、首事件延迟、内存、磁盘、网络和单机并发数据。
- 比较现有上游路由与独立new-api接入方式，给出当前Preview选择。
- 输出安全边界、已知风险和生产扩展建议；不在本任务引入Kubernetes或其他Adapter。

**验收方式**：

- 能通过API触发一次CodeBuddy容器任务并实时接收统一事件。
- 任务完成、取消和超时后容器与临时工作区被清理。
- 同一Session在容器重建后可继续运行，且不会跨Session读取状态。
- 容器不能读取宿主敏感目录、Docker控制接口或平台长期密钥。
- 形成实测报告，明确Preview可接受限制和进入M10B的条件。

## M10B. 单机云端Preview与Admin联调

**目标**：把M10A PoC产品化为内部可用的单机CodeBuddy云端Harness，不建设后续扩展类型。

**前置依赖**：M7、M10A。

**主要文件**：

- `apps/cloud-server/src/modules/{runs,execution-grants,usage}`。
- `apps/cloud-worker`。
- `apps/admin-web`运行管理页面。
- `infra/compose`预发部署文件。

**工作内容**：

- 使用Redis/BullMQ实现单机队列、Worker心跳、重试、取消和幂等完成。
- 固化工作区准备、CodeBuddy Adapter启动、事件上报和清理流程。
- 工作区输入仅支持经授权的Git引用或上传快照；长期私有仓库凭据托管另行设计。
- 实现Session级隔离Volume、单Session写入锁、TTL、归档清理和孤儿Volume巡检。
- 接入账号、模型、并发、额度预检和基础用量结算。
- Admin增加Run列表、状态、用户、模型、耗时、用量和错误分类。
- 建立失败任务与残留容器清理命令、告警和运维手册。
- 仅部署CodeBuddy Adapter；不实现DeepSeek、Pi、Sidecar、Kubernetes或microVM。

**验收方式**：

- 同一CLI/Web协议可以选择本地或云端CodeBuddy运行。
- 跨用户工作区、凭据、事件和缓存隔离测试通过。
- Worker崩溃、网络失败、取消、超时和重复投递均有确定结果。
- Session并发写入被阻止，容器重建恢复和过期状态清理通过端到端测试。
- Admin可查看运行与用量元数据，但看不到默认禁止采集的用户内容。
- Preview环境完成一次真实端到端和一次故障恢复演练。

## M11. 教师端试点迁移、全栈联调与阶段发布

**目标**：用真实业务验证基座边界，并完成本地产品与云端Preview的可发布闭环；本任务不把单机云端Preview宣称为最终生产级多租户沙箱。

**前置依赖**：至少M6、M7；云端试点还依赖M10B。

**跨仓库要求**：

- 在 `yanbot-teacher/docs/specs/` 建立独立迁移Spec。
- 若Admin需要跨产品入口，再在 `yanbot-admin/docs/specs/` 建立对应Spec。

**工作内容**：

- 选择普通助手会话作为首个低风险试点，不先迁移复杂报告工作流。
- 教师端通过Harness SDK/Runtime运行，业务数据和报告扩展仍留在教师端。
- 对比迁移前后的会话恢复、权限、MCP、Skill、性能和错误表现。
- 完成部署、监控、备份、回滚、密钥轮换和应急手册。
- 再逐步评估报告类业务扩展迁移。

**验收方式**：

- 试点场景不直接依赖CodeBuddy SDK，且功能不回退。
- Harness仓库无教师业务Schema、数据库访问和业务工具。
- 完成端到端、性能、安全、故障注入和回滚演练。
- CI/CD可从main/预发分支生成可追踪制品并部署到对应环境。

## 全程质量门禁

每个里程碑至少满足：

- Spec与实现同步更新。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`通过。
- 新协议有Schema验证、序列化测试和向后兼容说明。
- 新权限边界有拒绝路径测试。
- 新日志确认不包含密钥、令牌和用户本地内容。
- 涉及Electron时执行安装包验证。
- 涉及真实SDK时执行受控冒烟并记录SDK精确版本。
- 涉及跨仓库时按各仓库依赖顺序实施和验证。

## 首批建议执行顺序

总体Spec确认后，第一轮只进入M0和M1：

1. 建立 `foundation-bootstrap` 子Spec。
2. 初始化workspace和CI。
3. 建立厂商中立能力模型和Adapter SPI。
4. 建立Reference Adapter与sidecar协议Schema，不实现sidecar运行时。
5. 建立CodeBuddy能力矩阵及真实SDK探针。
6. 冻结Harness最小事件协议。
7. 完成Adapter Kit、CodeBuddy Adapter与Conformance fixtures。
8. 评审通过后再进入Local Runtime，不提前开发Web、Electron或Admin。
