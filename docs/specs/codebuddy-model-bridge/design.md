# 设计

## 已验证协议

本机隔离 HOME、合成 token 的实际 SDK 0.3.254 探针：POST /chat/completions，system 字符串与 user 文本块，stream_options.include_usage=true。CODEBUDDY_CODE_MAX_OUTPUT_TOKENS=1024 生效，tools=[]、thinking disabled、persistSession=false 后返回 success。当前文档所描述的 Anthropic 兼容行为不能替代固定版本实测。

## 模块

- adapter-codebuddy 增加仅部署构造参数 modelBridge（127.0.0.1 origin + 随机 token）；严格校验运行输入，固定禁用工具/思考/持久化，显式 Node executable，覆盖环境端点与输出限额；默认 SDK 用法不变。
- sandbox-model-channel 增加 CodeBuddy 文本请求归一化及 Anthropic → Chat 响应转换。只保留允许字段；实测消息级 agent 与 conversationRequestId 为字符串元数据，校验长度后移除；system 独立，tools/function/image 拒绝。SSE 增量 UTF-8 解码、有限缓冲、完整终止校验，保留 ACK 背压与取消。JSON 同样只接受文本响应。
- Guest boot、Docker Adapter、Worker 启用已有模型通道；授权仍由 Worker 绑定，不接受 Guest URL/真实凭据。
- Broker policy 扩展 cn.tencent.codebuddy；该 Adapter 必须显式 upstream: anthropic-messages，对应实验开关必须开启。固定上游与现有配额/脱敏/租约逻辑复用，不新建转发端点。

## 备选

不直接把 Chat JSON 发到 Messages 接口：固定 SDK 实测格式不同。不开容器网络或挂载供应商凭据：会破坏已有隔离边界。不升级 SDK 来推测协议兼容性：保留已认证版本并对明确的文本子集做转换。

## 验证与限制

新增协议正反例、断流/顺序/UTF-8 测试、Adapter 约束测试与 Broker policy 测试。扩展远端真实容器 E2E 为两个 Adapter 的成功与取消；CI 至少九项、零跳过。合成上游证明工程链路，不证明真实模型质量/计费。沿用请求额度与 token 上限，货币预算不是硬限额。

## 连续 Run 取消验收补充

远端验收必须在同一个 Worker 内连续运行取消场景，不能靠每条用例重启 Worker 隐藏生命周期异常。检查已撤销租约后的 Sidecar cancel 拒绝：后台心跳/超时停止任务必须收敛，错误不能成为进程级未处理拒绝；dispose 仍必须执行并由队列任务报告失败。测试保存有长度上限且脱敏的 Worker stderr 以定位故障。
