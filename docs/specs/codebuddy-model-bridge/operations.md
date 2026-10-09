# CodeBuddy 模型桥部署（Experimental）

本能力使用固定 SDK `@tencent-ai/agent-sdk@0.3.254`，通过现有固定 Anthropic Messages Broker 执行只读文本 Run。它不代表腾讯原生网关或计费认证。默认关闭，仅 development/test 可用。

## 开关与策略

沿用 [Sandbox 模型桥部署](../sandbox-model-bridge/operations.md) 的独立 Worker、固定镜像、Redis/Mongo、内部授权和私有文件权限要求：

- Server：`CLOUD_INTERNAL_API_ENABLED=true`、`CLOUD_EXPERIMENTAL_CODEBUDDY=true`、`CLOUD_MODEL_BROKER_POLICIES_FILE=/absolute/private/policies.json`。
- Worker：`WORKER_EXECUTION_MODE=sandbox`、固定镜像 digest、`WORKER_MODEL_BRIDGE_ENABLED=true`。
- 若同一策略文件还配置 Claude，必须同时启用 `CLOUD_EXPERIMENTAL_CLAUDE_CLI=true`。
- CodeBuddy 策略中的 `apiKeyFile` 是 **Anthropic Key 文件**，绝非 CodeBuddy Key。不得把真实 Key 放进 Worker、镜像、客户端、队列或 Run 配置。

```json
{
  "version": 1,
  "policies": [
    {
      "organizationId": "11111111-1111-4111-8111-111111111111",
      "adapterId": "cn.tencent.codebuddy",
      "upstream": "anthropic-messages",
      "models": ["claude-sonnet-4-6"],
      "apiKeyFile": "/absolute/private/anthropic-key",
      "maxRequests": 2,
      "maxOutputTokens": 1024
    }
  ]
}
```

Session/Run 选择 `cn.tencent.codebuddy`；Run 的 `model.adapterId` 同样为 CodeBuddy，`model.modelId` 必须匹配策略；权限设为 `read-only`。客户端不传凭据或供应商 URL。

## 固定边界

SDK 只访问容器内随机 loopback 端口，使用仅该容器可见的随机 token。Guest 将实测 Chat 文本请求转为 Messages 请求，移除 SDK 跟踪元数据；响应流转换保留文本与 token usage，校验完整终止后才发 Chat completion。全部外部网络仍关闭。

禁用工具、思考、设置来源、持久化和恢复；`maxTurns=1`，输出最多 1024 tokens。上游错误、未知字段/工具、多模态、断流、失联及取消按失败或取消收敛。SDK 的 turns 统计按其原始语义记录，不等同于 Broker 请求次数；配额以 Server 持久请求计数为准。

不公开 SDK 费用估算。SDK 的 `$0.10` 参数不能替代硬货币预算；部署仍须设置 Server 请求配额、token 上限与供应商侧预算。当前没有自有 Key，不包含真实费用、质量或生产认证。

## 回滚

停用 Worker 模型桥开关并移除对应 Server policy/实验开关后，恢复既有无凭据 Sandbox 行为。生产环境始终拒绝启用。持久 Session 与真实供应商全流程认证仍属后续阶段。
