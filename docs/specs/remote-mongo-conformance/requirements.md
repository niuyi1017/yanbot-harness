# Remote Mongo 持久化认证

## 目标

在专用 CI Mongo replica set 上验证生产 Store 的真实事务与索引行为，补齐四模式 Remote 的持久化证据。
不依赖厂商 Key，不连接工作区业务库或用户现有数据库。

## 验收

1. 使用实际 MongoService/MongoControlPlaneStore、ControlPlaneService 和现有 Schema，不能替换为 MemoryStore。
2. 并发同幂等请求只产生一个 Run/Outbox/额度扣减；同 Session 不同请求只允许一个活动 Run。
3. 同组织不同 Session 的并发额度限制原子生效；事务失败不残留半成品或额度占用。
4. 同 Session 连续运行且不提供 idempotencyKey 时可正常创建多个历史 Run；指定 key 仍受唯一约束。
5. 关闭连接后重建 Service/Store，Run/事件/游标与租户隔离仍有效；并发终态只释放一次额度。
6. 专用数据库名由测试随机生成，CI 仅绑定 loopback，测试无数据库 URL 时显式跳过；专用 workflow 必须执行且零跳过。
7. CI 归档 Mongo 版本、镜像 digest、源提交和测试报告；不能将测试部署等同生产 TLS/认证/备份/故障切换认证。
8. Refresh token 重放必须持久化撤销整个 family；不能因抛出认证异常而回滚撤销事务。
9. 同一套完整 SDK/HTTP/Redis/Worker/Docker 用例可选择真实 Mongo Store，验证两个厂商的认证失败、Reference 成功/交互/取消持久化。

## 不在本次范围

生产部署、Mongo 多节点故障切换、外部服务凭据、厂商付费、broker/egress 和持久厂商 Session。
