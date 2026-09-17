# Local / Remote Runtime 双形态兼容需求

## 1. 背景

平台总体设计已经分别描述 Local Runtime 与云端执行，也要求 SDK 能连接云端服务。但当前可交付实现是
Local Preview：公开 DTO 使用 `LocalSession`、`LocalRun`，HTTP 路由为 `/local/*`，工作区通过本机绝对路径
授权。`HarnessClient.connect({ origin, accessToken })` 只提供显式 HTTP 连接能力，并未覆盖远端认证、租户隔离、
远端工作区、持久化事件或沙箱调度。

产品要求不是“以后另做一个云端客户端”，而是：**同一套 SDK、CLI 与核心业务调用必须同时兼容 Local Runtime
和 Remote Runtime。** 本 Spec 将该要求升级为产品基线，并定义后续实现与验收边界。

## 2. 目标

- 一个 `@yanbot-harness/sdk` 和一套 CLI 命令连接两种 Runtime。
- 本地可通过 `@yanbot-harness/local` 统一安装入口复用同一 SDK；Remote-only SDK 不依赖 Runtime。安装分发见已确认的 [`unified-local-distribution`](../unified-local-distribution/requirements.md)。
- Session、Run、Event、Interaction、取消、恢复、幂等和错误分类在两种模式下语义一致。
- 部署差异通过连接配置、认证提供器、工作区来源和 capability 协商表达，不渗透到上层业务流程。
- Local 保持 loopback 与本机凭据边界；Remote 具备 HTTPS、身份与租户隔离、队列、沙箱和持久化能力。
- 建立双模式协议一致性测试，只有测试通过的能力才可以进入兼容矩阵。

## 3. 用户故事与验收标准

### DR1. 显式选择运行位置

- 集成方可以通过 SDK 连接配置选择 `local-managed`、`local-daemon` 或 `remote`。
- CLI 可以通过互斥参数或 profile 选择 Local/Remote，脚本模式不依赖交互式猜测。
- 同一段创建 Session、创建 Run、消费 Event、响应 Interaction 的代码切换目标后不需要改写。
- 连接失败时返回明确错误，不得静默切换模式或把任务发送到另一环境。

### DR2. 中立公共协议

- 公共资源名称使用 `Session`、`Run`、`RunEvent` 等部署形态中立语义；`Local*` 仅作为 Preview 兼容别名存在。
- 两种 Runtime 对核心资源使用相同 Schema、状态机、终端事件、SSE 游标、幂等键和错误码。
- Runtime 健康响应必须声明协议版本、运行形态和服务 capability。
- 客户端遇到不兼容协议主版本必须阻断，并给出升级提示。

### DR3. Local Runtime 安全边界

- Local Runtime 继续只监听 loopback，不通过修改监听地址充当 Remote Runtime。
- Local 认证继续使用受保护 descriptor 或受控进程句柄中的短期 token。
- 本机工作区必须通过路径作用域 Workspace Grant 授权，并阻止路径穿越与符号链接越界。
- CodeBuddy Key 只由 Local Runtime 读取，不进入 SDK/CLI 请求、输出或事件。

### DR4. Remote Runtime 安全边界

- Remote 只通过 HTTPS 暴露，并使用可过期、可撤销的用户/设备访问令牌；长期模型密钥只保留在服务端。
- 每个请求和持久化记录都必须绑定用户与组织上下文，跨租户访问默认拒绝并写入审计。
- 控制平面不直接执行 Agent；Run 进入队列，由 Worker 在受限沙箱中执行。
- Worker 只获取本次 Run 所需的短期凭据，沙箱不能访问平台数据库、Docker 控制接口或其他租户状态。

### DR5. 工作区输入兼容

- SDK 用统一的 `WorkspaceSource` 表达工作区意图，但不同模式只接受自身声明支持的来源。
- Local 支持本机路径授权；Remote 首期只支持授权 Git 引用或上传快照，不接受客户端本机绝对路径。
- 上传与 Git 凭据必须经过大小、类型、完整性、权限和保留策略校验；长期私有仓库凭据不进入首个 Preview。
- Runtime 不支持所选来源时，在创建 Run 前返回稳定的 capability 错误，不得上传后再静默忽略。

### DR6. 状态、事件与恢复

- Local 可使用文件型状态存储；Remote 使用持久化元数据、事件存储和队列，但对 SDK 暴露同一状态机。
- SSE 断线后可以使用 `afterEventId` 恢复；Remote 必须在声明的保留期内跨网关/Worker 重启重放事件。
- 同一 Session 同时只允许一个写入 Run；重复创建请求通过幂等键得到确定结果。
- 对声明支持恢复的 Adapter，Remote 容器销毁重建后仍能恢复 Session，且不会持久化执行凭据。

### DR7. 能力协商与兼容矩阵

- capability 必须区分 Adapter 能力与 Runtime/部署能力，例如工作区来源、持久化重放和交互等待时限。
- 非核心能力可以因部署形态返回 `unsupported`；核心 Session/Run/Event/取消与稳定错误语义不得分叉。
- Reference Adapter 必须同时运行 Local 与 Remote 黑盒套件；CodeBuddy 的每项能力另行记录真实环境证据。
- macOS、Windows 的 Local 交付认证与 Remote 服务认证分别记录，不能互相替代。

### DR8. 凭据与配置

- SDK 不接收 CodeBuddy Key；Local 从本机安全配置读取，Remote 从服务端凭据引用或短期令牌注入。
- Remote 访问令牌支持异步刷新提供器，CLI 不要求把 token 写入命令行参数或 shell history。
- 事件、错误、日志、descriptor、上传清单和审计记录都不得包含完整访问令牌或模型密钥。
- Local 与 Remote 配置作用域的合并规则一致；服务端强制策略优先级最高且在结果摘要中可解释。

## 4. 非功能需求

- **兼容性**：新增中立协议必须提供 Preview `/local/*` 与 `Local*` 类型的迁移说明；不做无提示破坏。
- **安全性**：Remote 上线前必须完成认证、租户越权、沙箱逃逸面、凭据泄漏和恶意工作区威胁测试。
- **可靠性**：Worker 崩溃、网关重启、重复投递、取消竞态与事件断流必须得到确定终态。
- **可观测性**：两种模式使用相同 `sessionId`、`runId`、`requestId`、事件序号和错误分类字段。
- **可移植性**：SDK/CLI 的核心调用不依赖 macOS/Windows 路径格式；平台差异留在 Local 启动与授权层。

## 5. 当前实施边界

本轮已完成第一批兼容基座：

- `packages/contracts` 的中立 Session、Run、创建请求与结果 Schema；现有 `Local*` 导出变为弃用别名。
- Runtime Profile、部署 capability、Workspace Source、认证模式和协议发现 Schema。
- Harness Protocol `1.0.0` 的版本判定，以及 `/v1/*` 与 `/local/*` 的明确兼容周期。
- Local Runtime 的 `/v1/*` 中立路由与 `/local/*` 兼容别名。
- SDK 的显式 `RuntimeTarget`、health/profile 握手和版本阻断；不依赖 404 猜测 transport。

下一批实现 CLI 连接层，但不提前声称 Remote 执行可用：

- 增加 `--profile`/`--profile-file` 与显式 `--remote`，并继续保留 Local descriptor、managed Runtime 和受限的
  Preview `--runtime` 兼容入口；所有目标选择参数互斥。
- profile 只保存 target 元数据和凭据环境变量名称，不保存 access token；CLI 不提供 `--token`。
- Remote profile 使用 SDK 的异步 token provider 和 `/v1/health` 握手；连接、认证或协议失败时不得回退到 Local。
- Remote 可以复用不需要工作区输入的中立命令；在 Git/upload workspace preparation 落地前，`run` 必须在任何
  Session、Grant 或 Run 请求发生前稳定拒绝，不能发送默认 cwd、`--workspace` 或其他本机路径。
- CLI Local 规范入口改用中立 `/v1` transport；`--runtime` 只作为 loopback legacy `/local` 迁移入口。

本轮不实现或部署 Remote Runtime、Remote CLI 交互式登录/刷新缓存、远端工作区准备、队列、Worker 或沙箱。当前交付仍是
Local-only Preview；正式签名/信任根、Registry scope、再分发许可、真实 Windows 10/11 和真实厂商认证继续作为
外部门禁单独跟踪，不阻塞上述兼容基座开发。完成 Remote 全链路之前，兼容矩阵必须保持
“Required, not implemented”。

## 6. 非目标

- 不在本阶段建设 Kubernetes、多区域调度、自动扩缩容或 microVM。
- 不把 Local Runtime 改成公网服务。
- 不为 Remote Runtime 复制独立 SDK、CLI 或厂商专用协议。
- 不在首个 Remote Preview 托管任意长期私有 Git 凭据。
- 不修改当前已交付 Local Preview 的能力声明或伪造远端认证结果。
- 不在本轮新增 `apps/cloud-server`、Remote fixture 或远端持久化实现。

## 7. 依赖

- 平台基座 R2、R5、R6 与 M3、M5、M10A、M10B。
- `packages/contracts`、`packages/sdk`、`apps/cli`、`apps/local-runtime`。
- 后续 `apps/cloud-server`、`apps/cloud-worker`、Redis、MongoDB、Docker/沙箱与客户端认证模块。
