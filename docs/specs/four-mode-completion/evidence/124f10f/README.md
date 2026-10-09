# 四模式剩余开发验收

固定源码：`124f10f582c492518ccb3d3e7d01e0c188abb0b9`。

- [Remote Docker E2E](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110438)：**15 passed / 0 skipped**。实际 GitHub 固定 commit、Mongo replica set、Redis、SDK/HTTP/SSE、独立 Worker、Docker Guest、Claude Code 2.1.284 与 CodeBuddy SDK 0.3.254。
- [Mongo 与 Broker](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110498)：**29 passed / 0 skipped**。包含 checkpoint 事务回滚/提交/TTL、服务替换恢复、过期 Worker 拒绝、同毫秒 heartbeat fencing、租户/索引/认证/预算/取消。
- [三平台厂商探针](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110474)：macOS arm64、Linux x64、Windows Server x64 均通过。每个平台验证真实 Claude 无凭据认证失败，以及 Claude/CodeBuddy 各自的权限允许、拒绝、工具事件和提问回答，共 **12 项真实进程工具用例**。固定厂商归档 SHA512 随 JSON 保存。

完整 Docker 用例验证两家厂商的成功 checkpoint，替换 Worker 后通过真实 Read 读回 `PERSISTED_TOOL_OK`；拒绝写入仍可继续回答问题。强杀 Worker 后，旧 Run 失败且不自动重放副作用，替换 Worker 可继续执行显式新任务。模型流取消沿用同一 Worker 验证。

## 修复记录与边界

本机回归及验收中发现的协议、派发竞争、同毫秒租约、交互 ID 和 CI 初始化竞争详见 [验证记录](../../verification.md)。失败版本没有被当成通过证据；最终报告绑定以上源码 SHA。

上游为仅 test 可替换的合成 Anthropic JSON/SSE，所有模型凭据为合成值。未调用付费模型，未部署生产。Windows Server CI 不替代 Windows 10/11 实机；真实模型 Key、生产 TLS/ACL/高可用环境、签名、registry 与许可证是外部发布门禁。

## 固定源码的完整 CI

8 个工作流全部通过，均为 attempt 1。完整机器记录见 `workflows.json`。

- [Remote Mongo persistence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110498)：通过。
- [Unified local installation](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110460)：通过。
- [Native containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110462)：通过。
- [Claude CLI experimental probe](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110474)：通过。
- [Dual Runtime Matrix Evidence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110428)：通过。
- [Remote sandbox containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110438)：通过。
- [Distribution mechanism probes](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110430)：通过。
- [CI](https://github.com/niuyi1017/yanbot-harness/actions/runs/37877110522)：通过。
