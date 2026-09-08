# M3 TypeScript SDK 与 CLI 需求

## 1. 目标与背景

M2 已提供经过 Reference Adapter 黑盒验证的 loopback HTTP/SSE Runtime，但集成方目前只能手写 HTTP，且测试客户端不属于可交付 API。M3 要交付稳定的 TypeScript SDK 和以该 SDK 为唯一运行入口的 CLI，使第三方能够在不依赖 Adapter 或厂商 SDK 类型的前提下创建、续接、观察和中断 Harness 运行，并在完成后用 Reference Adapter 做一次真实进程边界的离线模拟调用。

## 2. 用户故事与验收标准

### R1. TypeScript SDK

- 集成方只安装 `@yanbot-harness/sdk`，即可连接显式 Runtime 端点、程序内启动得到的 Runtime handle，或本机 daemon 的 `runtime.json`。
- SDK 能签发和撤销 Workspace Grant，创建和读取 Session，创建、读取和取消 Run，响应 Interaction，并订阅带历史重放语义的统一事件流。
- SDK 暴露 Adapter、Model、有效配置和 Extension 查询能力，并重新导出集成所需的厂商中立公共类型。
- HTTP 非成功响应被转换成带状态码、请求 ID 和标准 `HarnessError` 的稳定 SDK 错误；无法解析的响应不回显访问令牌或完整响应体。
- SSE 客户端支持分块、CRLF、多行 `data`、注释心跳、游标和调用方取消；协议非法时明确失败。
- SDK 不导入 CodeBuddy SDK，不要求集成方理解 Adapter 原始消息。

### R2. CLI

- 用户可通过本机 daemon 描述文件或显式 Runtime 端点运行 prompt，并流式查看结果。
- `run` 支持选择 Adapter、Session、Model、Workspace、相对工作目录、权限策略、配置来源和是否 resume。
- CLI 支持人类可读交互输出和 `--json` JSONL 输出；JSONL 每行都是独立、可解析的对象。
- 交互终端能处理权限确认和问题回答；无头模式不会隐式放行权限。
- CLI 可列出 Adapter、Model、Session，可查询和取消 Run。
- 退出码区分成功、命令用法错误、用户取消/策略拒绝、认证失败、上游失败和 Runtime/协议失败。
- 凭据查找顺序、日志级别和退出码有文档；访问令牌不出现在正常输出、错误或调试日志中。

### R3. 示例与离线第三方模拟

- `examples/sdk-basic` 只依赖 `@yanbot-harness/sdk`，展示连接 Runtime、授权工作区、创建 Session/Run 和消费事件。
- SDK 和 CLI 均使用 Reference Adapter 通过真实 loopback HTTP/SSE 服务完成端到端测试，不需要网络、模型 Token 或费用。
- M3 完成后执行一次 CLI 子进程到 Reference Adapter 的离线模拟，保存可复现命令和结果说明。

### R4. 交付质量

- `pnpm check` 全量通过。
- SDK 和 CLI 的构建产物不包含厂商 SDK 导入；CLI bin 可在 Node 22 环境执行。
- README 清楚说明启动 Runtime、SDK 示例、CLI 用法、凭据优先级和 Reference 模拟方式。

## 3. 不在本期范围

- 不实现 M4 Local Web、Electron 或云端控制平面。
- 不新增 CodeBuddy 能力，不把真实 CodeBuddy 凭据纳入默认 CI。
- 不实现通用 OAuth、设备身份或云端账号体系。
- 不发布 npm 包或制作跨平台安装器；只验证可发布的包结构与本地构建产物。
- 不让 CLI 动态加载任意第三方代码；Adapter 装配仍由 Runtime 负责。

## 4. 约束与依赖

- 依赖 M2 的公开 HTTP/SSE 协议与 `@yanbot-harness/contracts`，不得绕过 Runtime 访问内部 Supervisor 或 Adapter。
- CLI 是 SDK 消费者，不直接依赖 `adapter-api`、`adapter-codebuddy` 或 `harness-core`。
- daemon 描述文件含敏感访问令牌，SDK 读取时必须拒绝权限过宽、过期、PID 无效或非 loopback 的描述文件。
- CLI 无头/JSONL模式遇到 Interaction 时只输出请求并等待外部响应或明确失败，绝不默认允许高风险操作。
- 真实 CodeBuddy 探针继续作为生产发布门禁，与本次 Reference Adapter 离线验收分开记录。
