# 四模式后续能力与部署约定

## 能力

- Local SDK：CodeBuddy SDK；Local CLI：固定 Claude Code 2.1.284。Remote 两种入口使用同一 SDK / HTTP / Redis / Worker / Docker 链路。
- `interactive` 支持 Read、Write、Edit、Glob、Grep、Bash、AskUserQuestion；权限允许/拒绝、问题回答及工具结果转换为公共事件。`read-only` 的厂商桥只执行文本。厂商桥最多 8 turns；Broker 单 Run 最多 8 请求，输出 token 上限由策略限定。
- Remote `resume: true` 恢复最近成功 Run 的工作区与引用形式的历史记录，属于 emulated 能力，不是厂商原生会话恢复。重新创建 Worker/容器不丢失已提交状态。取消/失败不提交新状态，运行中的副作用不能自动重放。
- 状态最多 2048 文件、16 MiB 内容、64 KiB 历史；合并后的厂商提示最多 65536 字符。超过上限明确失败，不静默丢弃历史。TTL 沿用 `CLOUD_WORKSPACE_TTL_SECONDS`；清理命令同时清理过期状态引用。恢复必须使用相同原始 workspace digest。
- `prepareGitWorkspace({ repository, commit })` 支持部署 allowlist 内的公开 GitHub 仓库、完整 40 位 commit。通过固定 codeload HTTPS 导出生成内容快照；不执行 Git hooks，不支持私有凭据、LFS、submodule、symlink。下载/解压/文件数均有限额。执行只能进入 Docker Worker。
- CLI `login` / `auth-status` / `logout` 使用 Remote profile，私有凭据按 origin 隔离，刷新串行化。具体命令见 `apps/cli/README.md`。

## 生产配置

生产配置已可验证，但配置通过不代表生产环境验收完成。以下变量通过部署系统注入，不要把真实值提交到仓库。

| Cloud Server                                        | 要求                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`                                          | `production`                                                                      |
| `MONGODB_URI`                                       | 带认证、校验证书的 TLS replica set；启动实际检查 replica set                      |
| `CLOUD_TLS_TERMINATED`, `CLOUD_TRUST_PROXY`         | 都为 `true`；反向代理必须覆盖转发头                                               |
| `CLOUD_TRUST_PROXY_CIDRS`                           | 仅受信代理 IP/CIDR，禁止 `/0`；loopback 监听可默认信任 loopback                   |
| `CLOUD_REDIS_URL`                                   | `rediss://`，非 default 的命名 ACL 用户与密码                                     |
| `CLOUD_ENABLED_VENDOR_ADAPTERS`                     | 显式列出 `com.anthropic.claude-code-cli,cn.tencent.codebuddy`；生产不使用实验开关 |
| `CLOUD_VENDOR_SANDBOX_IMAGE`                        | 完整不可变镜像 digest；领取厂商任务时校验 Worker 声明的镜像                       |
| `CLOUD_INTERNAL_API_ENABLED`, `CLOUD_RELAY_ENABLED` | 都为 `true`                                                                       |
| `CLOUD_MODEL_BROKER_POLICIES_FILE`                  | 绝对路径、当前用户拥有、0600 的策略文件                                           |
| `CLOUD_WORKSPACE_ROOT`                              | 专用持久共享存储，服务端可写；Worker 只读挂载                                     |
| `CLOUD_GIT_ALLOWED_HOSTS`                           | 需要 Git 时设置 `github.com`                                                      |

Broker 策略格式延续 [Model Broker 运维说明](../run-model-broker/operations.md)。每个 organization + adapter 独立声明模型 allowlist、私有 Key 文件、`maxRequests`、`maxOutputTokens`；工具需要显式 `allowTools: true`。CodeBuddy 额外声明 `upstream: "anthropic-messages"`。Key 只留服务端；Worker/容器只见短期 Run grant / loopback token。

Worker 使用 `WORKER_EXECUTION_MODE=sandbox`、绝对 `WORKER_DOCKER_PATH`、与服务端完全一致的 `WORKER_SANDBOX_IMAGE`、`WORKER_MODEL_BRIDGE_ENABLED=true`、HTTPS `WORKER_INTERNAL_ORIGIN`。Redis URL 与 queueName 对齐，Worker ID 必须唯一；心跳间隔必须小于服务端 Run lease。反向代理仅对 Worker 网段开放 internal 路由；Docker socket 仅 Worker 可用，不能挂进 Guest。镜像声明校验是受信 Worker 协议，不是硬件远程认证。

Redis 使用专用实例/命名 ACL，只允许 Harness 队列前缀（BullMQ 默认 `bull:<queue>:*`）和所需 Lua、stream、list、hash、sorted-set、连接命令；禁止管理命令与其他应用 key。上线前在同版本 Redis 上执行真实 enqueue/consume/reconnect 验证 ACL，避免误删脚本执行所需权限。服务端验证认证/TLS 配置，不声称从 URL 推断实际 ACL 规则。

构建后执行：

```sh
pnpm --filter @yanbot-harness/cloud-server preflight
pnpm --filter @yanbot-harness/cloud-server sync:indexes
pnpm --filter @yanbot-harness/cloud-server reconcile:admission
```

`preflight` 只校验本地生产配置、私有文件及策略，不连模型、不回显配置值。索引同步、身份 provision 和 `reconcile:admission --apply` 是显式部署操作。启动顺序：数据库/Redis、服务端、Worker。不要把测试 transport override 带入生产。

## 故障恢复和回滚

- 未开始执行的丢失任务可以换 attempt/grant 重试；已有 startedAt/事件的 Run 在 Worker 丢失后失败，防止自动重复文件或命令副作用。用户可以从前一成功 checkpoint 显式恢复。
- attempt lease、grant 撤销、事件追加与 checkpoint 提交通过 Mongo 事务及同一 attempt 写入进行隔离。旧 Worker 不能提交迟到状态。仅完成事件可提升候选 checkpoint。
- 多服务端共享 Mongo、token pepper、Redis queue 与同一 workspace 存储；不得为不同 Worker 分配相互不可见的状态目录。
- 清理过期状态用 `cleanup:workspaces`，备份同时包含 Mongo 和 workspace 存储。回滚前停止新任务并收敛运行中任务，保留新字段与快照；旧程序不具备恢复新 checkpoint 的能力。
- 回滚厂商入口时清空 enabled-adapters，删除 Broker/vendor image 配置，关闭实验开关；先取消在途任务，再切换旧镜像与 Wrapper 版本。

## 验证边界

本次目标是工程能力闭环。真实厂商付费成功/费用/取消尚缺 Key；Windows 10/11 实机、生产 TLS/ACL/高可用部署、签名/registry/厂商许可证仍须外部验收。合成上游使用真实固定厂商进程，不会消费模型费用。最终 CI 记录见本 Spec 的 evidence。
