# 设计

- 新建私有 packages/sandbox-model-channel：帧 schema、Host stdout 过滤器与 Guest loopback HTTP server。私有 model.request/ack/cancel 与 model.response 通过 Docker stdin/stdout 传输；不改变公开 Sidecar schema。
- Host 将 attach stdout 经过有界 Transform 后交给现有 SidecarClient；私有请求留在 Host callback，公共 JSONRPC 帧继续交给原校验器。逐响应帧 ACK，等待超时或异常销毁管道并清理容器。取消与 dispose 同时 abort Broker fetch。
- Guest 启动 loopback server；ClaudeDeployment 新增仅部署可用的 loopback endpoint/token 配置。wrapper 明确传递 ANTHROPIC_BASE_URL、输出 1024 token、关闭 thinking。已有 Local 配置默认不变。
- CLI HTTP 文本内容规范化：剥除已知 cache_control 与 metadata、空 tools、禁用 thinking/effort 控制字段；非空工具、非文本内容及未知字段拒绝。Broker 再验证所有语义、模型和额度。请求 URL/query/header 不转发上游。
- RunCoordinator 复用 claim 的 actions 和 InternalControlPlaneClient，给 AdapterFactory 一个绑定本次 job 的 modelRequest callback。WORKER_MODEL_BRIDGE_ENABLED 默认 false，仅 development/test sandbox 可开。
- 复用 ExecutionGrantService/model broker 授权、Mongo 请求计数、DockerSandboxAdapter 强制策略、Guest lease watchdog、ManagedAdapterRun 取消收敛；不改公开 SDK 请求结构。
- 放弃 host 网络/共享凭据/挂载 Unix socket：扩大网络或宿主文件系统边界；现有受控管道能满足首版文本流式需求。
- 不跨仓库修改。新增 package 通过 workspace exports 消费，Docker build 使用现有 pnpm deploy。

官方配置依据：https://code.claude.com/docs/en/env-vars 、https://code.claude.com/docs/en/llm-gateway 。实际兼容性以 pinned 2.1.284 CLI 探针为准。

固定 2.1.284 的真实合成上游探针观察到成功结束字段 `terminal_reason=completed`（subtype=success、is_error=false、进程退出 0）；Parser 将它纳入成功枚举，同时保留 API 错误、预算/轮次结束与 is_error 拒绝。
