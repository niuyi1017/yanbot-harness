# 断网沙箱模型桥（Experimental）

验收：[固定源码与 CI 证据](evidence/be56b81/README.md)。

## 已实现的路径

应用 SDK → Cloud HTTP/Redis → Worker → Docker 内真实 Claude CLI → 容器 loopback → 私有 stdin/stdout 帧 → Worker → Run Model Broker。
响应沿相同管道回传；公共 Sidecar 事件不含私有模型帧。容器仍使用 `network=none`、非 root、只读根目录、无宿主 bind 与端口映射。

厂商 Key 只由 Broker 从私有文件读取；Worker 仅持有已 claim 的 execution grant；Guest 仅拿到在自身容器内使用的随机 loopback token。
Guest 请求不能指定 Run、attempt、worker、租户、Broker URL 或授权头。Worker callback 固定绑定当前队列任务，Broker 再执行租约/授权/策略检查与 Mongo 原子限额。

## 配置

先配置 [Run Model Broker](../run-model-broker/operations.md) 的组织、Claude 模型允许列表和私有 Key 文件。无 Key 时只能运行合成上游测试。
Worker 沿用现有 Redis/internal origin/工作区配置，并启用：

```sh
NODE_ENV=development
WORKER_EXECUTION_MODE=sandbox
WORKER_DOCKER_PATH=/usr/bin/docker
WORKER_SANDBOX_IMAGE=sha256:<已验证且包含固定 Claude 2.1.284 的镜像摘要>
WORKER_MODEL_BRIDGE_ENABLED=true
```

开关默认关闭，production 或非 sandbox 模式拒绝开启。Cloud 也必须显式启用 internal API、experimental Claude 和 Broker 策略文件。
创建 Run 时选择 `com.anthropic.claude-code-cli`、`permissionPolicy: read-only`，并显式提供同 Adapter 的完整 modelId，须与 Broker 策略完全匹配。
未获得 `model.invoke` 的任务不会启用模型传输。CodeBuddy/Reference 不使用该桥。

## 限制和失败行为

- 固定文本 Messages 接口；Guest 仅开放容器内 `127.0.0.1` 随机端口，验证本地 token，只接受 POST `/v1/messages`（兼容 CLI 的 `?beta=true`）。不转发其他路径、query 或 HTTP headers。
- Claude CLI 输出上限固定 1024 token，关闭 thinking 与工具；Broker 策略输出上限需至少 1024。原有 `--max-budget-usd 0.10` 是 CLI 自身保护，不替代服务端美元账单硬限额。
- 仅移除已知文本 cache_control、metadata、空 tools、disabled thinking 和基础 effort 元数据；非空工具、图片及未知厂商字段拒绝。Broker 仍二次校验原有文本白名单。
- 每容器只允许一个活动模型请求、最多 8 次 HTTP 尝试；Broker 的跨 attempt Run 配额可以更低。失败不会退还已预留额度。
- 请求最大 256 KiB；响应最大 8 MiB、块最大 32 KiB；每帧 ACK，消费不前进就停止读取上游。Broker 上游 30 秒，私有桥最多 35 秒。
- 客户端断开、Run 取消、租约失效、Worker 关闭或容器清理都终止活动请求。已产生的上游费用不能撤销。
- 上游错误不透传诊断正文；流开始后发生错误直接断开，不能伪造成功结束。脱敏需要保留有限尾部，因此短 SSE 事件可能等到后续数据或 EOF 才完整交付。
- 不支持持久 Session、工具、图片、thinking 或生产部署。真实 CLI 对合成上游计算出的 usage/cost 是模拟验收数据，不代表真实账单。

## 验收和回退

- `pnpm --filter @yanbot-harness/sandbox-model-channel test:unit`：HTTP/帧规范化、JSON/SSE、背压、限额、并发、断开、错误和畸形帧。
- `Remote sandbox containment` CI：真实 Docker、Mongo、Redis、独立 Worker 和固定 Claude CLI；完整远端套件强制 7 项通过、零跳过，其中新增成功和流式取消两项使用合成上游。
- `Remote Mongo persistence` CI 保留 Broker 授权/原子限额/租约/脱敏的 26 项实库验证。
- 关闭 Worker 开关并按部署流程重启可停止后续桥接；移除 Broker 策略配置并重启 Cloud 可停止授权和服务。保留 Mongo 请求计数与审计。

真实厂商 Key 调用与生产认证仍需独立证据；本阶段没有开放容器外网。
