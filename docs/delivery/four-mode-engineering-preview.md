# 四模式工程候选

Harness 基座仍为 Experimental/Preview。Local/Remote 决定执行位置，SDK/CLI 决定厂商接入方式；应用使用同一套 Session、Run、Event API。

| 执行位置 | SDK 型                                                     | CLI 型                                                  |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Local    | CodeBuddy SDK Adapter                                      | Claude Code 2.1.284 Wrapper + CLI Host                  |
| Remote   | Docker Guest 中的 CodeBuddy SDK，经私有模型通道访问 Broker | Docker Guest 中的 Claude Wrapper，经同一通道访问 Broker |

## 本轮补齐

1. CLI Remote 登录、私有凭据、串行 refresh、状态查询、logout/token family 撤销。
2. 公开 GitHub 固定 commit 下载为不可变工作区，经过路径、文件类型、容量和 allowlist 校验后进入 Docker 执行。
3. 成功 Run 的工作区与历史 checkpoint 持久化、TTL 清理、Worker/容器重建后的 emulated resume。取消/失败保留前一成功状态。
4. 两家厂商的工具调用、权限允许/拒绝、提问和回答。Broker 对工具、模型、请求次数和输出进行限制。
5. 生产 TLS、Mongo 认证/replica set、Redis 命名 ACL、代理 CIDR、固定镜像声明校验与 preflight；过期 Worker 无权提交状态，已开始的任务不自动重放副作用。

具体配置、资源限制、恢复和回滚见 [四模式运维说明](../specs/four-mode-completion/operations.md)。CLI 使用见 `apps/cli/README.md`，开发任务与最终证据见 [本轮 Spec](../specs/four-mode-completion/tasks.md)。

## 使用约定

Local Claude 需要部署侧配置 `YANBOT_HARNESS_ADAPTER=claude-code-cli`、`CLAUDE_CODE_EXECUTABLE`；有授权 Key 时配置 `ANTHROPIC_API_KEY_FILE`。Windows 额外配置编译后的 `HARNESS_CLI_JOB_HOST`。不隐式安装/更新厂商 CLI。

Remote Worker 设置 `WORKER_EXECUTION_MODE=sandbox`、绝对 Docker 路径、不可变镜像 digest 和模型桥开关。Guest 非 root、断网、只读根文件系统、受限 tmpfs，不接收模型 Key、Docker socket 或宿主目录挂载。服务端持有模型凭据。

SDK 使用 `prepareWorkspaceSnapshot` 或 `prepareGitWorkspace({ repository, commit })`，选择 `cn.tencent.codebuddy` / `com.anthropic.claude-code-cli` 创建 Session。文本用 `read-only`；工具用 `interactive`，通过 `handle.respond()` 回应权限/问题。Remote 成功运行后，在同一 Session、同一原始 workspace 上使用 `resume: true`。厂商桥最多 8 turns，extensions/config scopes/厂商原生会话恢复不在本轮支持范围。

## 验证边界

- `pnpm check` 验证类型、边界、单元和离线 probes；专用 CI 执行真实 Mongo replica set、Redis、Docker 和固定厂商进程。
- 厂商工具探针使用合成上游，验证真实进程/协议/工具和权限，不消费模型费用。
- 用户尚无 Anthropic Key，真实模型成功、费用和真实上游取消仍未验收。
- Windows Server CI 不替代 Windows 10/11 实机验收；生产 TLS/ACL/高可用拓扑、签名、registry 与许可证仍是外部发布门禁。
- 生产配置可用不代表已部署。本任务不修改生产服务。
