# Run 级模型代理

## 目标

为 Remote 厂商执行建立服务端凭据与受控模型请求边界。首版支持 Claude 文本 Messages API，先完成内部服务端入口；用户暂无 Key，使用合成凭据和本地上游完成工程验收。

## 验收标准

1. 默认关闭。部署侧文件按 organizationId + adapterId 配置模型允许列表、私有 Key 文件、单 Run 请求次数和单请求输出 token 上限；请求不能指定凭据、上游 URL、headers 或租户。
2. 只有已 claim、未过期/撤销、绑定 Run/attempt/worker 的 execution grant 才能调用；租约、active attempt、Run 终态与 adapter 必须验证。普通用户 access token 不可调用。
3. 请求次数在 Mongo Run 记录原子扣减，跨重连/attempt 仍累计；失败请求不退款。该上限不是美元账单硬上限。
4. 上游固定 HTTPS Anthropic Messages endpoint，不跟随重定向；仅发送服务端固定请求头。Key 不进入客户端、Worker、队列、Session、审计或错误响应。
5. 只允许有界文本 JSON；模型、max_tokens、body 大小受限。支持 JSON/SSE，响应大小/总时限有界、处理背压，断开客户端或失去授权后取消上游。
6. 上游非成功响应不透传诊断正文；成功流精确脱敏服务端 Key 与当前 grant（含跨 chunk 匹配）；审计仅记录固定元数据。
7. 私有文件拒绝 symlink、非普通文件、超限与过宽权限；生产模式拒绝实验配置，Linux/macOS 工程候选。
8. HTTP 边界、恶意请求、限额、失效授权、流式脱敏和真实 Mongo 并发/重连计数全部有测试证据。

## 分期边界

本阶段交付 Cloud Server 内部代理，不改变公共 SDK/RunRequest。Sandbox 保留 network=none；下一阶段另建 Guest/Worker 私有传输桥，不能用开放容器网络替代。
CodeBuddy 上游协议策略、真实厂商调用、生产 TLS/容量与独立 Broker 服务部署、厂商 Session 恢复不属于本阶段。不得声称四模式生产完成。
