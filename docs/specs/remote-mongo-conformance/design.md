# 设计

- 复用 cloud-server 的 MongoService、MongoControlPlaneStore、ControlPlaneService、WorkspaceService 与 AuditService；新增专用集成测试。
- GitHub Ubuntu 使用官方 Mongo 8.0 镜像；启动前解析不可变 image ID/digest，专用单节点 replica set 仅 loopback 暴露。
- 测试只读取 `HARNESS_TEST_MONGODB_URI`；拒绝非 loopback、带用户信息的 URL，数据库名固定前缀加随机 UUID。清理只删除本轮测试创建的记录，不提供任意 dropDatabase 工具。
- 实际连接初始化全部索引。生产 autoIndex 仍关闭，索引更新通过已有 sync:indexes 运维入口显式执行。
- 当前 Run 复合 sparse 唯一索引存在语义风险：organizationId/sessionId 始终存在，缺失 idempotencyKey 仍会纳入索引。改为只匹配字符串 key 的 partial unique index，先创建新索引再移除旧索引；专用迁移入口避免在应用启动时自动修改生产索引。
- 所有事务竞态由实际测试确认。只修复可复现的失败，不将业务冲突泛化为无限重试。
- 不选择 mongodb-memory-server：它还需下载二进制，且名称易混淆内存替身与真实引擎；专用 Docker CI 已可复用。

官方索引语义：[partial indexes](https://www.mongodb.com/docs/manual/core/index-partial/)、[compound sparse indexes](https://www.mongodb.com/docs/v8.0/core/index-sparse/)。
