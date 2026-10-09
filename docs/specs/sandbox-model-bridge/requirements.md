# 断网沙箱模型传输桥

## 目标

连接已有 Run Broker 与远端 Claude CLI，用户无 Key 时使用真实固定版本 CLI、真实 Docker 与合成上游验证全链路。

## 验收

- 容器继续 network=none、无 host bind/端口映射；Guest 不接收厂商 Key、execution grant、Broker URL 或租户身份。
- 默认关闭；Worker 显式实验开关且 grant 有 model.invoke 才启用，仅 Claude；production 拒绝。Run 必须显式指定允许的模型。
- Guest 仅监听容器内 127.0.0.1 随机端口，用一次性本地 token 接受 CLI POST /v1/messages；仅文本，不支持工具、图片、thinking、Session 恢复。
- 私有进程管道复用 Docker attach，通过严格帧校验隔离公共 Sidecar 事件。Host 按绑定的 Run/attempt/worker 调 Broker，不接受 Guest 指定目标或授权。
- 请求 256 KiB、响应 8 MiB、块 32 KiB；单容器一个活动请求、最多 8 次尝试；逐帧 ACK 背压、有界超时，取消、断开、租约失效与清理中止转发。
- 合成上游 JSON/SSE、拒绝路径/格式/并发/超限、畸形帧与断开有自动化证据；真实 Docker 内 pinned Claude 成功响应走完整 SDK/HTTP/Redis/Worker/Broker 路径。

## 边界

不开放容器外网，不注入真实 Key，不扩大 Broker 文本白名单。真实 Anthropic 调用、费用、CodeBuddy 策略、持久 Session、生产部署另行验收。本阶段可以完整实现和验证，不等待 Key。
