# 设计

- 新增 `apps/cloud-server/src/model-broker/`，包含私有文件读取、策略/文本请求校验、固定目标转发、跨块脱敏、Service 与 Controller。
- `CLOUD_MODEL_BROKER_POLICIES_FILE` 显式开启；必须启用 internal API 和 Claude 实验入口，production 拒绝。JSON 仅包含元数据与凭据路径，不包含 inline Key；启动时解析，变更需重启服务。
- 内部 `POST /internal/v1/runs/:runId/model?attempt=N`，Bearer execution grant 与 x-worker-id；body 是受限文本 Messages 请求。公共 DTO 不新增厂商字段。
- 复用 ExecutionGrantService、Mongo/MemoryControlPlaneStore、AuditService；新增 `model.invoke` action，新增专用授权方法检查 Run/active attempt/lease。按组织/Adapter 查策略；模型还须匹配 Run 已显式选择的 modelId。
- 在事务中重新授权并原子预留 Run `modelRequestCount`。为防止全记录替换覆盖并发计数，所有已有 Run 更新仍依赖事务冲突重试；Mongo 集成验证计数保存。
- 上游固定 `https://api.anthropic.com/v1/messages`，POST、x-api-key、anthropic-version=2023-06-01、content-type=application/json；redirect=error，不接受用户 headers/URL。测试仅通过 DI 替换 transport，部署配置没有上游覆盖项。
- 默认请求 256 KiB、响应 8 MiB、总超时 30 秒；每秒复核授权。先验证再读 Key/预留请求，再请求上游。并发中的请求可能在撤销前已产生费用；撤销不能追溯退款。
- 使用 Node stream/fetch 增量消费；保留最长 secret 长度减一的尾部完成跨 chunk 精确替换，限制 secret 数量/长度。SSE 正文按字节透传脱敏，非 200 或非 JSON/SSE 类型返回稳定错误，不复制上游响应头。
- 私有文件通过 O_NOFOLLOW + fstat/UID/mode/大小验证；Windows 首版 fail closed，等待独立 ACL 设计。Key 只存在 Broker 内存与 TLS 上游头部。
- 复用既有 90 MiB snapshot parser，但模型路由在生产入口单独使用 256 KiB JSON parser；Service 二次限额保护测试与内部调用。

## 备选与后续

不把长期 Key 注入 Worker/Sandbox；不启用 bridge/host 网络来获得模型连通性；不接受客户端任意上游代理配置。
先实现可独立验证的 Broker 服务边界，再由私有传输桥把隔离 Guest 的模型请求送到此入口。该顺序避免同时引入容器网络、凭据分发和厂商协议三个未经验证的边界。

官方依据：[Messages](https://platform.claude.com/docs/en/api/messages/create)、[API overview](https://platform.claude.com/docs/en/api/overview)。
