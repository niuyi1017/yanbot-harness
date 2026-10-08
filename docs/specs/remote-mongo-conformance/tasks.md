# 任务

- [x] 建立 requirements/design/tasks，独立提交。
- [x] 实际副本集集成测试：幂等、Session 锁、并发额度、回滚、连续无 key Run、重连重放与跨租户拒绝。
- [x] partial unique index 修复、显式先建后删迁移与迁移幂等测试。
- [x] Refresh 重放撤销在事务提交后返回认证失败；真实 Mongo 验证整个 family 的新旧 token 失效。
- [x] 专用 Ubuntu Docker workflow，输出版本/digest/源提交/零跳过报告。Mongo 8.0.32 实际 8 项全通过，见 `evidence/b1d9038/`。
- [x] 完整 SDK/HTTP/Redis/Worker/Docker 使用实际 Mongo Store，5 项 E2E 全通过、零跳过；见 `../remote-sandbox-executor/evidence/1386dbb/`。
- [x] 修复已发现的问题并归档 Store 证据；索引迁移及回退限制见 `operations.md`。
