# Foundation Bootstrap 需求规格

## 1. 背景

总体架构已在 `docs/specs/harness-platform-foundation/` 中确认。正式开发的第一步是建立可构建、可测试的pnpm workspace，并用最小实现证明厂商中立Adapter SPI能够承载CodeBuddy Agent SDK，而不会把其Preview API、消息类型和权限语义泄漏给上层SDK。

本阶段覆盖总体任务M0和M1，是后续Local Runtime、CLI、Web、Electron和云端Harness的协议基础。

## 2. 阶段目标

- 建立仓库、工具链、包边界和CI基线。
- 冻结第一版Harness核心类型、事件和错误语义。
- 建立Adapter SPI、能力协商、Reference Adapter和Conformance Kit。
- 完成首个生产Adapter `adapter-codebuddy` 的最小闭环。
- 通过真实CodeBuddy冒烟验证关键假设，并形成能力矩阵。
- 只设计Sidecar协议Schema和握手，不实现Sidecar进程管理。

## 3. 功能需求与验收标准

### FB-R1. Workspace基线

- 使用pnpm workspace管理 `apps/*`、`packages/*` 和 `examples/*`。
- 根命令统一提供format、lint、typecheck、test和build。
- 所有包采用TypeScript、ESM和NodeNext模块规则。
- `pnpm install --frozen-lockfile` 后可在Node 22环境完成全量校验。

### FB-R2. 公共协议

- 定义Adapter、Session、Run、Event、Interaction、Capability、Model、Usage和Error的Zod Schema与推导类型。
- 所有跨包、跨进程结构均可JSON序列化，并通过Schema往返验证。
- 公共类型不引用CodeBuddy的类型、字段名或枚举。
- 所有协议结构携带明确的 `protocolVersion`，破坏性变化必须升级主版本。

### FB-R3. Adapter SPI

- Adapter可被注册、探测、初始化、运行和释放。
- Adapter实例按用户、凭据和运行环境隔离，不依赖不可控全局会话状态。
- 所有Adapter至少支持启动Run、有序事件、最终状态、取消语义和资源释放。
- 可选能力通过 `native`、`emulated`、`unsupported` 声明。
- 调用未声明或未实现的能力时返回稳定的 `CAPABILITY_UNSUPPORTED`。

### FB-R4. Reference Adapter

- 不连接真实模型、不读取用户文件、不需要密钥。
- 根据测试脚本稳定生成文本、工具、Interaction、Usage、成功和失败事件。
- 支持人为控制延迟、取消点和错误类型。
- 可供自有SDK、CLI、UI和Worker后续端到端测试复用。

### FB-R5. Adapter Conformance Kit

- 以黑盒方式测试Adapter，不依赖其内部实现。
- 覆盖探测、初始化、事件顺序、成功、失败、取消、可选能力、重复释放和敏感信息检查。
- Reference Adapter必须在普通CI中通过全套测试。
- CodeBuddy Adapter的fixture测试必须在普通CI中通过；真实模型冒烟通过显式环境开关单独运行。

### FB-R6. CodeBuddy Adapter

- 依赖精确版本的 `@tencent-ai/agent-sdk`。
- 将 `query()` 的system、stream_event、assistant、tool_result和result消息转换为统一Harness Event。
- 支持会话ID映射、resume、中断、模型选择、maxTurns和用量字段。
- 将通用权限策略映射到CodeBuddy权限模式。
- 将通用配置作用域映射到显式 `settingSources`，默认不加载隐式文件系统配置。
- 通过厂商元数据保留必要诊断信息，但不得透传完整原始消息或敏感数据。

### FB-R7. CodeBuddy能力探针

- 在受控工作目录完成一次真实文本任务。
- 验证流式文本、最终结果、费用/用量字段和错误形态。
- 验证普通工具调用、权限允许、权限拒绝和 `AskUserQuestion`。
- 验证session resume与中断。
- 验证MCP、Skill、Agent、Hook、模型列表和配置来源的实际行为。
- 将实测结果、SDK版本、平台差异和已知限制记录为能力矩阵。

### FB-R8. Sidecar协议设计

- 定义版本化JSON-RPC/stdio握手、运行、取消、Interaction响应、事件通知和关闭Schema。
- 握手返回Adapter版本、Harness版本、协议版本、能力与配置Schema。
- 只验证Schema序列化与版本不兼容错误，不拉起真实Sidecar进程。

### FB-R9. 安全与仓库卫生

- 仓库不提交真实API Key、OAuth Secret、MongoDB URI、JWT Secret或 `.env` 文件。
- 日志和测试快照不得包含凭据、完整环境变量、用户文件内容或绝对工作路径。
- 默认公共权限策略为 `interactive`，不暴露 `bypassPermissions`。
- CodeBuddy原始依赖只能出现在 `adapter-codebuddy`。

### FB-R10. 文档与示例

- README说明项目定位、开发命令、包边界和当前阶段限制。
- 提供使用Reference Adapter启动Run并消费事件的最小示例。
- 能力矩阵区分文档声称、fixture验证和真实冒烟验证。
- 所有后续模块可以引用本阶段协议而不读取CodeBuddy SDK类型。

## 4. 非功能要求

- 单元测试不访问公网，不消耗真实Token。
- Reference Adapter测试必须确定性执行，不依赖时间竞争。
- Adapter事件sequence从1开始严格递增，最终事件最多出现一次。
- `dispose()` 和取消操作必须幂等。
- 包之间使用公开exports，不通过相对路径跨包读取 `src/`。
- 构建产物不包含测试fixtures、`.env` 或源映射中的敏感内容。

## 5. 不在本阶段范围内

- Local Runtime HTTP/SSE服务。
- 完整CLI、本地Web、Electron、Admin和云端Worker。
- MongoDB、Redis、OSS、账号、额度和用量持久化。
- DeepSeek Harness、Pi或其他厂商的生产Adapter。
- Sidecar子进程拉起、监管和沙箱。
- MCP/Skill/Agent市场与安装流程。
- 教师端业务迁移。
- npm正式发布和Electron打包。

## 6. 技术约束

- Node.js：`22.22.0`。
- pnpm：`11.10.0`。
- TypeScript：`5.9.3`。
- `@tencent-ai/agent-sdk`：精确锁定教师端当前已验证的 `0.3.43`，升级另走兼容评审。
- Schema：Zod 4。
- 测试：Vitest 4；真实SDK冒烟不得加入默认测试命令。
- 构建：各包使用 `tsc`，根目录使用 `pnpm -r` 调度，不引入Turborepo或tsup。

## 7. 与现有仓库关系

只读参考：

- `yanbot-teacher/apps/local-runtime/src/index.ts`：CodeBuddy query、resume、消息流和模型探测。
- `yanbot-teacher/apps/local-runtime/src/sdk-tool-events.ts`：嵌入式tool_result处理。
- `yanbot-teacher/apps/local-runtime/src/interaction-manager.ts`：Interaction生命周期经验。
- `yanbot-teacher/apps/local-runtime/src/desktop-security.ts`：后续本地Runtime安全边界，不在本阶段迁移。

本阶段不修改 `yanbot-teacher`、`yanbot-admin`、`yanbot` 或 `yanbot-fe`。

## 8. 待验证而非预设的事项

- `unstable_v2_createSession()` 是否适合作为长期会话主路径。
- `query({ resume })` 对不同认证环境的恢复行为。
- CodeBuddy费用、Token和模型字段在不同版本/环境是否稳定。
- MCP、Skill、Agent、Hook和模型列表是否都能在无头环境可靠工作。
- 中断后最终事件、异常和SDK子进程退出的真实顺序。

如果探针结果与总体设计冲突，必须先更新Spec，再扩展实现。

## 9. 阶段完成定义

- 所有普通CI命令通过。
- Reference和CodeBuddy fixture Adapter通过Conformance Kit。
- 受控环境完成真实CodeBuddy冒烟并形成能力矩阵。
- 上层示例只依赖公共协议和Adapter API。
- `rg '@tencent-ai/agent-sdk'` 只命中 `adapter-codebuddy` 的依赖与源码。
- Sidecar协议Schema通过版本协商与序列化测试，但不存在生产Sidecar运行实现。
- README明确下一阶段是M2 Local Runtime。
