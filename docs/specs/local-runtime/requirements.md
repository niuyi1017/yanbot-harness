# M2 Local Runtime 需求规格

## 1. 背景与目标

M0/M1已经建立厂商中立的contracts、Adapter SPI、Reference Adapter、CodeBuddy Adapter fixture闭环和Conformance Kit，但目前只有进程内示例，没有可供CLI、本地Web或Electron稳定连接的本地服务，也没有会话持久化、SSE重放、工作区授权和统一权限决策层。

M2要交付一个业务无关、只监听loopback的Local Runtime。它负责在受控工作区内管理Session与Run，通过统一Adapter执行任务，持久化可恢复的本地元数据与事件，并提供安全的HTTP/SSE协议。该阶段是M3 SDK/CLI和M4 Local Web的共同服务端基础。

## 2. 阶段目标

- 建立`apps/local-runtime`，提供版本化的HTTP与SSE接口。
- 扩展公共contracts，冻结本地Session、Run、状态、错误和传输Schema。
- 为长生命周期Run提供可取消、可响应Interaction的核心控制器。
- 建立短期本地访问凭据、Origin校验、一次性浏览器绑定和工作区Grant。
- 建立文件型`LocalStateStore`，支持Session/Run恢复和JSONL事件重放。
- 建立`permission-engine`、`config-loader`和`extension-kit`的首版公共边界。
- 使用Reference Adapter完成无网络端到端验证，并保持CodeBuddy差异只存在于Adapter内。

## 3. 功能需求

### LR-R1. Runtime启动与生命周期

- Runtime默认绑定随机端口和`127.0.0.1`，禁止默认绑定`0.0.0.0`、`::`或局域网地址。
- 启动时初始化Adapter Registry、LocalStateStore、安全上下文和Run Supervisor；任一初始化失败时不得残留监听端口或Adapter进程。
- `/local/health`只返回服务名、协议版本、进程状态和启动时间，不返回Token、绝对路径、环境变量或Adapter凭据。
- 收到正常关闭信号时停止接受新Run、取消或限时等待活动Run、刷新状态并幂等释放Adapter资源。

### LR-R2. 本地访问认证与网页隔离

- 每次启动生成高熵短期访问Token，或接受父进程显式注入的等强度Token；Token不得写入普通日志和Session/Event文件。
- 除health和一次性绑定交换外，所有接口必须使用Bearer Token或Runtime签发的HttpOnly会话Cookie。
- 浏览器绑定Token只能使用一次、具有短TTL并绑定精确Origin；交换成功后立即失效。
- 带`Origin`的请求必须匹配绑定Origin或显式allowlist；未带Origin的CLI/SDK请求仍须认证。
- Cookie请求使用`HttpOnly`、`SameSite=Strict`和受控Origin校验；状态变更接口拒绝跨站请求。
- Token比较使用常量时间算法；过期、伪造或重复使用返回稳定的401/403错误。

### LR-R3. 工作区授权

- 客户端不能仅通过提交任意`cwd`获得文件系统访问权。
- 持有特权Bearer的父进程、CLI或SDK可为真实存在的目录签发短期、不可伪造、可撤销的Workspace Grant；浏览器Cookie不能单独签发任意目录Grant。
- Runtime使用`realpath`记录授权根目录，解析运行目录时同时防止`..`穿越和符号链接越界。
- Run只能在有效Grant覆盖的根目录或其真实子目录中启动；Grant过期、被撤销、路径变化或越界时默认拒绝。
- Workspace Grant只在内存中保存路径映射，Runtime重启后必须重新授权；持久状态只保存不透明`workspaceRef`，不把绝对路径写入事件日志。

### LR-R4. Session与Run管理

- 支持创建、列出和读取Session；Session记录Adapter ID、可选Adapter Session ID、标题、时间戳和最后运行状态。
- 支持在Session下创建Run；Runtime负责生成`runId`并从Workspace Grant解析实际`cwd`。
- 创建Run支持幂等键；同一Session和幂等键的重复请求返回同一个Run，不重复调用Adapter。
- 同一Session默认只允许一个活动Run，冲突返回409；全局并发和Run超时可配置且具有安全默认值。
- 支持读取Run状态和幂等取消；终态Run重复取消不改变原终态。
- 具有`adapterSessionId`且Adapter声明`sessions.resume`时可续接；不支持时返回`CAPABILITY_UNSUPPORTED`，不得静默创建新会话。

### LR-R5. SSE事件流与重放

- 每个Run提供SSE事件流，事件数据必须通过公共`adapterEventSchema`校验。
- 事件先持久化成功再广播给订阅者，避免客户端看到无法重放的事件。
- 客户端可通过`Last-Event-ID`或显式游标从已确认事件之后恢复；历史事件重放完成后无缝切换到实时流。
- SSE断开只清理订阅者，不自动取消Run；Run由显式取消、超时、关闭流程或Adapter终态结束。
- Runtime发送不含业务数据的心跳注释，防止中间层误判连接空闲。
- 每个Run只有一个终态事件；Runtime重启发现未完成Run时追加安全的中断终态并更新元数据。

### LR-R6. Interaction生命周期

- `interaction.requested`必须在客户端可见前完成Pending注册，避免即时响应竞态。
- 支持permission的allow/deny和question的submit/deny，并使用公共`interactionResponseSchema`验证。
- 相同响应的重复提交返回首次结果；同一`requestId`的冲突响应返回409，不重复调用Adapter。
- Interaction具有可配置超时；过期、Run取消或Runtime关闭时默认deny，并产生对应`interaction.resolved`事件。
- 只有拥有当前Runtime访问权且Run/Session匹配的调用方可以响应Interaction。

### LR-R7. 文件型LocalStateStore

- 定义可替换的`LocalStateStore`接口，Runtime不得直接把存储细节散落在路由中。
- 首版使用用户数据目录下的版本化JSON元数据和JSONL事件文件，不引入SQLite、MongoDB或云端数据库。
- JSON元数据采用临时文件、限制权限和原子rename；同一Run的事件append必须串行。
- 启动时允许恢复完整行并处理尾部不完整行；中间损坏不得静默忽略，应返回可诊断但脱敏的状态错误。
- Session与Run文件权限遵循最小可读写原则。状态中不得保存模型凭据、完整环境变量、访问Token或未脱敏的工具输入输出。
- 默认保存用户Prompt和统一事件以支持本地历史；这是本机持久化数据，M2不上传云端，也不提供遥测上报。

### LR-R8. 权限决策引擎

- `packages/permission-engine`提供厂商中立的工具风险分类和决策结果，不导入任何厂商SDK类型。
- `read-only`拒绝写入、命令执行和其他有副作用工具；`interactive`要求显式处理permission；`auto-edit`只自动允许低风险且位于已授权工作区内的编辑类操作，高风险命令仍需确认。
- 未识别工具默认按较高风险处理，不因名称未知而自动放行。
- Runtime可自动响应明确deny或allow的Interaction；需要用户判断时保持Pending并通过SSE暴露。
- 公共API永远不提供`bypassPermissions`。

### LR-R9. 配置解析

- `packages/config-loader`定义`local`、`user`、`project`、`organization`和平台强制层的解析与合并语义。
- 优先级固定为：平台强制 > organization > project > user > local；平台强制层始终生效。
- 对象深合并、数组整体替换、显式null删除可选值；类型冲突或未知敏感字段返回`CONFIGURATION_INVALID`。
- project/local配置只能从已授权工作区内读取；读取前后均验证真实路径边界。
- 解析结果区分可公开摘要、Adapter配置和凭据引用。HTTP接口不得接收或返回真实凭据。
- CodeBuddy的`settingSources`仍只在`adapter-codebuddy`内部映射。

### LR-R10. Extension发现与能力协商

- `packages/extension-kit`定义MCP、Skill、Agent和Hook的厂商中立Descriptor与校验器。
- M2提供只读发现、状态展示和Run前有效配置计算，不实现市场安装、在线下载或自动更新。
- Skill发现只读取受信配置根或授权工作区中的显式目录；`SKILL.md`正文不作为Runtime指令执行。
- MCP配置敏感字段只保留凭据引用或脱敏摘要，不进入普通接口和日志。
- Adapter声明extension能力为`unsupported`时，选择该扩展的Run必须明确失败；当前CodeBuddy Adapter的扩展执行仍保持deferred，不能伪装成功。

### LR-R11. Adapter、模型与能力接口

- Runtime可列出已注册Adapter的manifest和能力，UI/SDK无需按厂商名分支。
- 模型列表通过Adapter可选能力获取；不支持、未认证和上游失败使用稳定错误码区分。
- 普通CI默认注册Reference Adapter完成端到端测试；CodeBuddy使用fixture/facade测试，不访问公网。
- Adapter Runtime按Run隔离，凭据通过进程内Provider注入，不允许API调用方提交任意环境变量。

### LR-R12. 错误、日志与可观测性

- HTTP错误使用统一Envelope，包含稳定错误码、可安全展示的message、retryable和请求追踪ID。
- 日志至少关联requestId、runId、sessionId和事件类型，但不得记录Token、Cookie、凭据、完整Prompt、完整工具输入输出或绝对工作区路径。
- 对路径、Token和常见敏感键执行统一脱敏；错误堆栈只进入受控开发日志。
- M2不接入远程遥测。后续云端可观测性必须另行Spec并采用显式用户策略。

## 4. 非功能要求

- 普通测试无网络、无真实模型费用、无用户凭据。
- 所有时间、ID、文件系统根和Token生成器可注入，以保证确定性测试。
- 默认请求体大小、并发数、Run时长、SSE订阅数和事件行大小均有限制。
- Runtime终止、取消、Interaction响应和资源释放均幂等。
- Runtime与公共包不得出现教师、院校、择校、调剂、报告等业务实现。
- Windows与macOS路径语义通过平台无关测试覆盖；符号链接能力不可用的平台必须默认拒绝不确定路径。

## 5. 不在M2范围内

- 完整CLI命令与可发布SDK客户端（M3）。
- React Local Web和工作台UI（M4）。
- Electron进程拉起、安全存储与安装包（M6）。
- 云端账号、MongoDB、Redis、队列、用量计费与远程执行。
- MCP、Skill、Agent、Hook的市场安装、下载、更新和生产执行闭环。
- CodeBuddy扩展能力实现；当前只提供能力协商与明确拒绝。
- ASR、Computer Use、教师报告或任何研bot业务工具。
- 本地状态加密、跨设备同步和长期归档策略。

## 6. 依赖与约束

- 引用总体Spec `docs/specs/harness-platform-foundation/` 和基础Spec `docs/specs/foundation-bootstrap/`。
- 复用现有`contracts`、`adapter-api`、`harness-core`、Reference Adapter和CodeBuddy Adapter，不绕过公开exports。
- 只读参考`yanbot-teacher/apps/local-runtime/src/desktop-security.ts`和`interaction-manager.ts`的经验，不复制其业务端点、云端执行Grant、`bypassPermissions`或报告工具。
- Node.js、pnpm、TypeScript、Zod和测试版本继续使用仓库已锁定版本。
- 真实CodeBuddy探针当前pending。它不阻塞M2离线实现，但仍阻塞生产可用声明。

## 7. 阶段完成定义

- `pnpm check`和远端CI在干净检出中通过。
- Reference Adapter端到端覆盖Session创建、Run、SSE重放、Interaction、恢复、取消、超时和重启恢复。
- 安全测试覆盖非loopback绑定、Origin绕过、Token伪造/过期、Workspace Grant伪造/过期、路径穿越、符号链接越界和重复响应。
- 文件状态可从完整JSONL恢复，且敏感数据扫描通过。
- CodeBuddy Adapter仍只在自身包中引用厂商SDK，Runtime无厂商条件分支和业务概念。
- README和总体任务状态更新为M2完成，M3 SDK/CLI可以仅依赖公开协议开始开发。
- 在没有真实凭据的情况下，阶段结论必须写明“离线验证通过、真实CodeBuddy待验证”。
