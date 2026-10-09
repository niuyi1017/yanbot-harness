# CodeBuddy 远端模型桥接

将已固定的 CodeBuddy SDK 0.3.254 接入断网 Sandbox 的模型通道，完成四模式路线中 Remote CodeBuddy 的文本执行闭环。用户已授权连续开发，沿用现有 Spec 与实验能力边界。

## 验收

- 实际 SDK 请求经 Guest、Docker attach、Worker、Server Broker 到固定 Anthropic Messages 上游，真实 Key 仅由 Server 私有文件读取。
- 显式模型、租户、Adapter、Run、attempt、Worker、有效执行授权和请求额度均校验；CodeBuddy policy 明确声明 upstream 为 anthropic-messages。
- 仅文本、只读、无工具、无设置来源、无恢复；输出上限 1024 tokens，最多一轮；未知请求字段、多模态及工具请求拒绝。
- 支持流式输出、取消、失联清理；不将截断 SSE 误判成功；现有 Claude 行为保持兼容。
- 实际 SDK + Docker + Mongo + Redis + 独立 Worker 的合成上游成功与取消验收，无跳过。无真实 Key 时不声明真实供应商验收。

## 范围

仅 yanbot-harness；不修改 Showcase。保持默认关闭和 production 禁用。不认证腾讯原生网关、原生计费、工具调用、持久 Session 或货币硬预算。复用 Anthropic 上游意味着 CodeBuddy 的模型价格/usage.cost 不能作为实际账单。
