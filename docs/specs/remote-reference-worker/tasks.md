# Remote Reference Worker 任务

## 当前状态（2026-09-21）

- [x] 复核 Cloud Control Plane、execution grant、outbox、Adapter API/Core 与路线图边界。
- [x] 冻结 Remote Reference Worker 范围与威胁模型。
- [ ] 实现进行中；真实 CodeBuddy 与 Docker Sandbox 明确不属于本 Spec。

## T1. Spec 门禁

- [x] 新增 requirements/design/tasks。
- [x] 自检后独立提交，随后才开始实现。

验收：Spec 明确 Reference Worker 与 P5 CodeBuddy Sandbox 的边界，不把本机进程执行描述为容器隔离。

## T2. Queue 公共包

- [ ] 新增 `packages/cloud-queue`，定义 strict job schema、确定性 job ID 和 BullMQ factory。
- [ ] 配置 Redis URL/queue prefix，不允许把连接 secret 写入 job/log/error。
- [ ] 增加 schema、重复 job、Redis restart/cleanup 定向测试。

验收：queue payload 只有 schemaVersion/runId/attempt/executionGrant；重复 add 只存在一个 job。

## T3. Outbox 与 RunAttempt 持久化

- [ ] 扩展 outbox lease/attempt/queue 字段，新增 `run_attempts` Schema 和索引。
- [ ] 增加 tenant-first dispatch store：claim/release/publish/reconcile/attempt terminal。
- [ ] memory 与 Mongo 实现保持同一状态机；新增并发、lease expiry 和唯一 active attempt 测试。

验收：relay 崩溃点可判定恢复；Mongo transaction/index 真实证据仍单列外部门禁。

## T4. Relay 与 Reaper

- [ ] 实现 Cloud Server relay lifecycle、deterministic enqueue 和 audit。
- [ ] 实现 expired lease reaper、retry backoff/max attempt 与 exhaustion terminal。
- [ ] Redis unavailable、crash-before/after-add、job missing、terminal/cancelled Run 全部 fail closed。

验收：API 不执行 Adapter；outbox 可重建 Queue；每个 Run 同时最多一个 active attempt。

## T5. Grant、Run 与 Lease 内部 API

- [ ] execution grant 增加 run.read 与 worker binding。
- [ ] claim transaction 同时领取 attempt；增加 run/workspace/interaction/heartbeat/attempt-complete endpoint。
- [ ] 覆盖 access token 替代、错误 worker/run/attempt、重复 claim、过期/revoke/terminal 和 secret marker。

验收：Worker只能访问一个 Run，raw grant只在 queue/Worker内存出现。

## T6. Reference Worker

- [ ] 新增严格配置、grant-only internal client、BullMQ worker lifecycle。
- [ ] 通过 adapter-api/harness-core 执行 Reference Adapter，顺序上报 Event。
- [ ] 实现 heartbeat、interaction pump、cancel、timeout、terminal fallback 与有界 shutdown。
- [ ] uploaded snapshot containment；Git source在无 Sandbox时稳定拒绝。

验收：text/tool/interaction/failure/cancel 场景均通过；Worker不持有Mongo/用户token/厂商Key。

## T7. 端到端与恢复测试

- [ ] 临时 Redis + memory control plane 跑真实 BullMQ Remote Reference E2E。
- [ ] 覆盖 duplicate delivery、Worker crash/lease expiry/retry、Redis loss/rebuild、取消竞态和交互。
- [ ] 搜索 Redis job/audit/event/error，确认无 prompt/path/secret marker。

验收：同一 SDK/CLI Remote run 获得 terminal Event；破坏性 fixture 最终自动收敛。

## T8. 文档、门禁与提交

- [ ] 更新 Phase 4/P4 状态，保持 P5/正式 Remote certification 未完成。
- [ ] 更新运维配置、启动顺序、故障恢复和已知限制。
- [ ] 运行定向测试与 `pnpm check`，检查 diff/status并提交实现。
- [ ] 真实 Redis TLS/ACL、Mongo replica set、生产 TLS、Docker Sandbox 与双平台客户端证据保持未完成。

验收：本 Spec 代码任务完成且全仓门禁通过；外部证据不以本机测试替代。
