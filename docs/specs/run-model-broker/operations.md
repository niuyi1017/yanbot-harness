# Run 模型代理工程候选

## 当前范围

验收证据：[`558c962`](evidence/558c962/README.md)，真实 Mongo 与代理共 26 项通过、零跳过。

Cloud Server 内部模型代理支持 Claude 文本 Messages JSON/SSE。它持有 Key，Worker 只使用已 claim 的 execution grant。
Sandbox Guest 的可选模型传输桥见 [桥接说明](../sandbox-model-bridge/operations.md)。容器仍为 network=none，需另外显式开启 Worker 实验开关。
CodeBuddy 的显式 Anthropic 上游策略与文本桥见 [CodeBuddy 部署说明](../codebuddy-model-bridge/operations.md)。真实付费调用尚未认证；production 拒绝实验配置。

## 部署策略

Linux/macOS 上准备 owner-only（0600）的策略 JSON 和独立 Key 文本文件；路径及父目录由受信部署控制，不接受用户上传或公共请求参数。
Key 文件最大 8192 bytes，策略文件最大 256 KiB；拒绝最终文件符号链接、非普通文件、非当前 UID 或 group/other 可读写执行的权限。
Windows 服务端凭据读取暂未认证，明确拒绝。该限制不影响已有 Windows Local Adapter。

策略格式示例（模型 ID 和组织 ID 应替换为该部署实际允许值）：

```json
{
  "version": 1,
  "policies": [
    {
      "organizationId": "11111111-1111-4111-8111-111111111111",
      "adapterId": "com.anthropic.claude-code-cli",
      "models": ["YOUR_APPROVED_MODEL_ID"],
      "apiKeyFile": "/absolute/private/anthropic-credential",
      "maxRequests": 2,
      "maxOutputTokens": 1024
    }
  ]
}
```

沿用既有 Cloud Mongo/Redis/身份等配置，额外启用：

```sh
CLOUD_INTERNAL_API_ENABLED=true
CLOUD_EXPERIMENTAL_CLAUDE_CLI=true
CLOUD_MODEL_BROKER_POLICIES_FILE=/absolute/private/model-policies.json
```

策略在服务启动时加载；改策略需按部署流程重启。Key 在每次获授权请求时读取，受控原子替换文件可用于轮换。
没有配置文件时入口返回 404，不读取任何用户的现有环境凭据。

## 内部接口

`POST /internal/v1/runs/:runId/model?attempt=N`

- `Authorization: Bearer <claimed execution grant>` 与 `x-worker-id`；不接受普通用户 access token。
- body 只允许 model、messages、可选 system、max_tokens、可选 stream/temperature；messages 只允许 user/assistant 与 text 内容。
- 不接受 URL、headers、tools、文件、图片、扩展或任意厂商参数。上游固定为 HTTPS Anthropic Messages endpoint；不跟随重定向。
- 请求 256 KiB、响应 8 MiB、整体上游超时 30 秒，单服务进程最多 16 个活动请求；该并发上限不是分布式组织额度。
- 每 Run 最多 1–8 次请求，单次 max_tokens 受策略限制（最高 4096）。Mongo 原子计数跨连接/attempt 保留；上游失败、取消与断开不退款。请求次数和 token 限制不等于美元账单硬上限。
- 每秒检查 grant、租约和 Run 终态；取消中断尚在进行的连接，不能撤销上游已经发生的计费。
- 上游错误正文不会透传。成功流对当前 Key/grant 做跨数据块精确匹配脱敏；审计只记录 Run、动作、结果等元数据，不记录请求/响应正文。

`RunRecord.modelRequestCount` 是内部可选字段，无新增索引，公共 Run DTO 不暴露它。已有记录按零起算。

## 验证和回退

- 本机：`pnpm --filter @yanbot-harness/cloud-server exec vitest run test/model-broker-core.test.ts test/model-broker-http.test.ts`。
- CI `Remote Mongo persistence` 对同一 HTTP 套件使用真实 Mongo Store，强制零跳过；上游是 loopback fixture，Key 全为合成值，没有厂商付费证据。
- 移除策略文件配置并按部署流程重启，停止签发新 model.invoke action 并关闭代理。服务关闭时主动中断活动连接；保留 Run 计数和审计数据。
- Guest 私有传输桥沿用该授权与计数入口；真实付费厂商行为仍单独验收。
