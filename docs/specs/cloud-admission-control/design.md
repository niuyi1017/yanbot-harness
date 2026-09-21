# Cloud Admission Control 设计

## 1. 请求路径

```text
AccessTokenGuard
  -> adapter/model/request schema preflight
  -> role + permission-policy preflight
  -> transaction
       -> idempotency/session/workspace validation
       -> atomic AdmissionState reserve
       -> Run + outbox + Session write
  -> relay/Worker（不再做重复 admission）
```

终态路径在自己的既有 transaction 中调用 `releaseRunAdmission`。Attempt retry 只替换执行尝试，不修改组织 admission。

## 2. 配置

Cloud Server 增加：

- `CLOUD_RUN_ALLOWED_ROLES`，默认 `owner,admin`；
- `CLOUD_ALLOWED_PERMISSION_POLICIES`，默认 `interactive,read-only`；
- `CLOUD_MAX_ACTIVE_RUNS_PER_ORGANIZATION`，默认 10；
- `CLOUD_MAX_RUNS_PER_UTC_DAY`，默认 1000。

列表必须非空、无重复、只含枚举值。数值为正整数并设硬上限，防止配置错误关闭保护。生产和测试使用同一解析器。

## 3. 数据模型

新增 `yanbot_harness_admission_states`：

```ts
{
  organizationId: string; // unique
  activeRuns: number;
  admittedRuns: number;
  periodStart: Date; // UTC 00:00
  activeLimit: number; // 最近一次 reserve 使用的部署限制快照
  periodLimit: number;
  updatedAt: Date;
}
```

`RunRecord` 增加可选 `admissionReleasedAt`。不把 counter 放入 Organization，以便旧组织懒初始化，也避免身份记录与高频计数争用。

## 4. Store 状态机

`insertAdmittedRunAndOutbox` 接收 Run/outbox/Session、UTC period 和两个 limit：

1. 初始化缺失 AdmissionState；
2. 若 periodStart 早于当前 UTC 日，原子把 admittedRuns 归零但保留 activeRuns；
3. 条件更新 `activeRuns < activeLimit && admittedRuns < periodLimit`，同时各加一；
4. 成功后插入 Run/outbox 并更新 Session；失败返回 `concurrency` 或 `quota`；
5. Mongo 全部处于调用方 transaction，异常回滚；memory 实现在任何写入前完成全部检查。

`releaseRunAdmission` 先以 org+run+`admissionReleasedAt missing` 标记 Run，再对同组织 activeRuns 做不低于零的扣减。重复调用返回 false。

Mongo 的 AdmissionState 是单组织竞争点，这是有意选择：它提供严格上限，优先正确性而非无限水平吞吐。后续若真实流量证明热点，再以
bucket/token service 演进，不能提前用近似 count 破坏额度承诺。

## 5. 终态接入

- `ControlPlaneService.cancelRun`：Run/Session/Event 更新后 release。
- `ExecutionGrantService.append`：terminal Event 更新后 release。
- `ControlPlaneService.failDispatch`：retry exhaustion 的 terminal 更新后 release。
- Reference Worker 的 attempt retry/reaper 不 release；它仍属于同一公共 Run。

Session 写锁继续限制单 Session；AdmissionState 补充跨 Session 的组织并发上限，两者不能互相替代。

## 6. Reconciliation

新增 `reconcile-admission` 命令。对每个 AdmissionState/Organization：

- 计算该组织没有 terminalEventType 的 Run 数；
- 比较 activeRuns；
- 默认输出仅含 organizationId、expected/actual 和状态的 JSONL；
- 只有 `--apply` 才修正 activeRuns/updatedAt；不降低或重算 admittedRuns；
- 设置最大扫描数量，发现超限或未知状态 fail closed。

命令不自动运行，不在 API 请求里做全表扫描。部署前后可显式执行，回滚旧版本时 counter 集合可保留，不影响旧代码。

## 7. 错误与审计

- 角色/策略：403 `PERMISSION_DENIED`。
- 并发：429 `HARNESS_FAILED`、`retryable=true`。
- 日额度：429 `HARNESS_FAILED`、`retryable=false`。
- 审计 action 固定为 `run.admission.accept|reject|release` 和 `admission.reconcile`，errorCode 只用稳定分类。

Controller 审计应记录实际 CloudError HTTP 状态，而不是把所有拒绝写成 400。

## 8. 复用与拒绝方案

复用 `ControlPlaneStore.transaction`、现有 tenant-first Run 查询、idempotency 和 terminal transaction；不在 Redis/BullMQ 增加配额逻辑。

拒绝方案：

- **每次 `countDocuments(non-terminal)`**：并发写入会 write-skew，且数据量增长后不可控。
- **BullMQ concurrency 当组织额度**：只能限制 Worker 全局吞吐，不能保证租户隔离或日额度。
- **每个 attempt 计费**：基础设施重试会错误消耗用户额度。
- **先 reserve、后另一个 transaction 插 Run**：崩溃会泄漏槽位。
- **自动降低 admittedRuns 的 reconciliation**：会把已经消费的日额度错误返还，扩大滥用面。

## 9. 回滚

应用回滚到旧版本时，新集合和 Run 可选字段可被旧 Schema 忽略读取，但生产写入使用 strict Schema，因此旧版应先停止新流量再回滚。
若新版本回滚后重新上线，先 dry-run reconciliation，再 apply。禁止直接删除 counter 集合作为“修复”，否则会清空日额度证据。
