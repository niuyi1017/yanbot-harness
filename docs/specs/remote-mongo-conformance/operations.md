# Mongo 工程验证与索引升级

## 实际证据

[`b1d9038`](evidence/b1d9038/README.md) 使用 MongoDB 8.0.32 单节点副本集，8 项真实事务/索引测试全通过，无跳过。
本机没有 Mongo 时测试显式跳过；独立 CI 强制零跳过。只允许专用 loopback 测试 URI，使用随机 `harness_ci_` 数据库。
CI 最后删除专用容器；不连接现有业务数据库，不自动删除用户数据库。

## Run 幂等索引迁移

旧 `organizationId_1_sessionId_1_idempotencyKey_1` sparse unique 索引会把缺少 key 的文档也纳入约束，
导致同 Session 第二次不带 key 的 Run 失败。新 `run_idempotency_present` 只约束字符串幂等 key。

在部署已有 Cloud Server 的维护窗口，使用该部署的既有受信配置执行：

```sh
pnpm --filter @yanbot-harness/cloud-server sync:indexes
```

该显式运维命令先创建新 partial unique 索引，再移除精确匹配的旧索引，最后同步其余已声明索引。
如果旧名称的实际定义不同，会停止并保留原索引；不要绕过此检查手工删除约束。
生产启动仍保持 autoIndex 关闭。迁移不修改 Run 文档；应保留正常数据库备份与现有运维变更记录。

回退代码前需检查 Session 历史 Run：迁移后允许多个无 key 历史记录，旧 sparse 索引可能无法重建。
保留新索引仍可保护显式幂等键，不应为重建旧索引而删除用户 Run。先在测试环境验证回退版本与新索引兼容。

## Refresh 重放修复

复用旧 refresh token 会在事务内撤销整个 family，提交后返回认证失败。旧、新 access token 都失效。
这项修复不改变 token 格式，不要求复制或导出任何原始 token。

## 仍未认证

生产 TLS/身份与网络 ACL、多节点故障切换、备份恢复、厂商真实调用、credential broker、受控出网与持久厂商 Session。
