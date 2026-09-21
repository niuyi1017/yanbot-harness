# Cloud Admission Control 任务

## T1. Spec 门禁

- [x] 冻结额度语义、原子性、租户隔离、回滚和非目标。
- [x] requirements/design/tasks 独立提交后才进入实现。

## T2. 配置与 Schema

- [x] 增加角色、permission policy、组织 active/UTC 日额度严格配置。
- [x] 新增 AdmissionState Schema、唯一索引和 Run release marker。
- [x] 验证系统环境变量可共存、命名空间 typo 拒绝、边界值 fail closed。

验收：旧组织可懒初始化；配置不能用空 allowlist 或超大数值关闭保护。

## T3. 原子 Store

- [x] memory/Mongo 实现 `insertAdmittedRunAndOutbox`，拒绝不产生部分写入。
- [x] 实现 UTC 日切、concurrency/quota 分类与 tenant-first 条件更新。
- [x] 实现幂等 `releaseRunAdmission`，activeRuns 永不为负。

验收：同组织竞争最多接纳 limit 个；不同组织互不影响；idempotency replay 不重复计数。

## T4. Service 与终态

- [x] createRun 在 workspace/outbox 前完成角色和 policy 预检并调用 admission store。
- [x] completed/failed/cancelled/retry exhaustion 全部释放，attempt retry 不释放。
- [x] 429 retryable 语义和 Controller 实际拒绝状态审计正确。

验收：所有 terminal race 最多释放一次；拒绝请求没有 Run/outbox/slot 残留。

## T5. Reconciliation 与运维

- [x] 新增 bounded dry-run/apply reconciliation service 和 CLI。
- [x] 更新 Cloud Server README、P4 路线图和部署/回滚说明。
- [x] 保持计费/Admin/P5 Sandbox 与生产认证为未完成。

验收：dry-run 无写入；apply 只修 activeRuns，不返还 UTC 日额度。

## T6. 验证与提交

- [x] 单测覆盖权限、竞争、日切、幂等、所有终态、租户隔离和 reconcile。
- [x] 运行定向测试与全仓 `pnpm check`。
- [x] 检查 diff/status，保留用户临时文件并提交实现。
- [x] 真实 Mongo replica set 并发 transaction 证据保持外部门禁，未用 memory 测试替代或伪造。

验收：本 Spec 代码任务全部完成，P4 仅剩生产/双平台外部证据，不提前宣称 Remote Preview certified。
