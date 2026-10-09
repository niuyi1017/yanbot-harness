# CodeBuddy 模型桥工程验收

固定源码：`e69f7cf49357b153f7e011425b586ecbbd9a3fe7`。

- [Remote sandbox containment 37869336346](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336346)：9 项完整远端 E2E，通过且零跳过。实际 Linux Docker、Mongo、Redis、HTTP/SDK、独立 Worker、Claude Code 2.1.284 与 CodeBuddy SDK 0.3.254。
- [Remote Mongo persistence 37869336433](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336433)：28 项通过，零跳过。包含 CodeBuddy 显式上游策略和跨 Adapter 拒绝，以及既有租户、grant、请求配额、租约和脱敏检查。
- 本机针对性回归 77 项通过，含 14 项 Worker 测试。格式、lint、包边界、构建和 typecheck 通过。CLI 单独复跑 4 项通过，机制探针 62 项通过。
- 本机隔离 HOME、仅合成 token 的实际 CodeBuddy SDK 探针：通过 Guest/Host 通道返回 SDK_BRIDGE_OK，只发生一次模型请求，max_tokens=1024，正常 run.completed 与进程退出。

## 验收发现及修复

SDK 0.3.254 实测发送 `/chat/completions`。需要 `CODEBUDDY_CODE_MAX_OUTPUT_TOKENS` 才能将默认 128000 限为 1024；消息级 `agent`、`conversationRequestId` 是已观察到的元数据，白名单校验后移除。仅依赖当前供应商文档不足以推断固定版本的机器协议。

初次完整远端验收的 CodeBuddy 成功路径通过，但连续取消失败。诊断源码 `296fca3` 的 [CI 37869042295](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869042295) 确认：前一条 Run 取消触发 Sidecar output pipe failure，未处理的 cancel Promise 使 Worker exit=1，下一条 Run 留在 queued。单元回归也复现了未处理拒绝。

`e69f7cf` 对停止操作复用同一个 Promise，接住 cancel 失败并执行 dispose；最终清理仍由队列任务等待，清理失败不会被宣告成功。租约撤销和超时场景均有回归。修复后原有同一 Worker 连续取消用例通过，没有通过重启 Worker 或放松断言规避问题。

本机全量并行 `pnpm check` 一次触发两个 CLI 用例原有 5 秒超时；同源码独立复跑 4 项 CLI E2E 全过，未修改超时阈值。最终代码检查以固定源码 CI 为准。

## 证据边界

模型上游为仅 test 环境可替换的合成 Anthropic JSON/SSE，全部凭据为合成值。真实 SDK、容器与控制面执行过，但未调用付费模型，不证明腾讯原生网关、供应商计费或真实输出质量。CodeBuddy 不公开该桥接模式的 SDK 费用估算。持久 Session、工具交互和生产认证仍未完成。

固定源码的 8 个工作流全部通过，均为 attempt 1。完整状态见 `workflows.json`。

- [Remote Mongo persistence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336433)：通过。
- [Native containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336370)：通过。
- [Claude CLI experimental probe](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336358)：通过。
- [Remote sandbox containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336346)：通过。
- [Dual Runtime Matrix Evidence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336355)：通过。
- [CI](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336360)：通过。
- [Distribution mechanism probes](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336345)：通过。
- [Unified local installation](https://github.com/niuyi1017/yanbot-harness/actions/runs/37869336356)：通过。
