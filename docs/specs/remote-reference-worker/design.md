# Remote Reference Worker 设计

## 1. 架构

```text
public SDK/CLI
      │
      ▼
cloud-server ── Mongo transaction ── Run + outbox
      │                                  │
      │                         OutboxRelayService
      │                                  │ deterministic jobId
      │                                  ▼
      │                              Redis/BullMQ
      │                                  │
      │                                  ▼
      │                           cloud-worker process
      │                             │ Reference Adapter
      │                             │ heartbeat/cancel
      ◀──── private internal API ───┘
        claim / run / workspace / interaction / event
```

控制面是唯一 Mongo writer，Worker 不导入 cloud-server store。Redis 丢失可由 pending outbox 重建；Redis job 完成不能直接修改
Run，Worker 必须先通过内部 API 写 terminal Event。

## 2. 模块

```text
packages/cloud-queue/src/
  schema.ts              strict job/version schema
  queue.ts               BullMQ Queue/Worker connection factory

apps/cloud-server/src/
  dispatch/              outbox relay、attempt coordinator、reaper
  execution-grants/      claim/heartbeat/run/workspace/interaction/event API
  persistence/           RunAttempt schema 和 tenant-first/dispatch store ports

apps/cloud-worker/src/
  config.ts              strict Redis/internal origin/worker/timeout config
  internal-client.ts     grant-only HTTP client and stable error mapping
  reference-engine.ts    adapter-api/harness-core execution
  run-coordinator.ts     heartbeat、interaction、cancel、terminal fallback
  worker.service.ts      BullMQ worker lifecycle
  main.ts                production Reference composition root
```

## 3. 队列消息

```ts
type RemoteRunJob = {
  schemaVersion: 1;
  runId: UUID;
  attempt: number;
  executionGrant: `yhe_${string}`;
};
```

禁止 organizationId、prompt、workspace path、Mongo/Redis URL、厂商配置和 access token。queue name 由部署配置提供；BullMQ
自定义 job ID 禁止冒号，因此固定为 `run-<runId>-attempt-<attempt>`。BullMQ `attempts=1`，业务 retry 由 Mongo reaper 创建新 attempt 和新 grant，避免重复使用
已经 claim 的单次 token。

## 4. Outbox 与 attempt 模型

`outbox` 增加：

- `attempt`，默认 1；
- `status`: pending/publishing/published/cancelled；
- `leaseOwner`、`leaseExpiresAt`；
- `queueJobId`、`publishedAt`。

新增 `run_attempts`：

```ts
{
  organizationId, runId, attempt,
  queueJobId,
  status: 'dispatching' | 'queued' | 'leased' | 'completed' | 'failed' | 'abandoned',
  workerId?, heartbeatAt?, leaseExpiresAt?,
  createdAt, updatedAt, failureCode?
}
```

唯一索引为 org+run+attempt 和 queueJobId。relay 原子 claim 一个 outbox；若对应 queue job 已存在则补写 published。若
dispatching attempt 没有 queue job，撤销旧 grant/attempt 并创建下一 attempt，而不是试图恢复丢失的 raw token。

## 5. 派发状态机

```text
outbox pending
  -> publishing (relay lease)
  -> create attempt + execution grant
  -> BullMQ add deterministic job
  -> attempt queued + outbox published

relay crash:
  job exists      -> recover metadata and mark published
  job not exists  -> abandon/revoke, create retry outbox
```

单 Run 同时最多一个 active attempt。retry 上限默认 3，退避存入 outbox `availableAt`。超过上限由控制面用内部可信路径写
`run.failed`，错误只包含稳定 `HARNESS_FAILED`/`RUN_TIMEOUT` 分类。

## 6. Worker claim、lease 与 heartbeat

claim body 只有 `workerId`；Cloud Server transaction：

1. 按 digest 查未领取、未过期、未撤销 grant；
2. 校验对应 attempt 为 queued、run/attempt 一致；
3. 写 grant claimedAt/claimedBy 和 attempt leased/leaseExpiresAt；
4. 返回不含 digest 的 scope。

heartbeat 间隔必须小于 lease TTL 的三分之一。每次续约同时校验 run 非 terminal、grant 未 revoke、worker ID 匹配。403/404
视为取消或失租，Worker abort 并调用 Adapter cancel；网络瞬断在 lease deadline 内重试，超过 deadline 停止上报。

## 7. 执行与交互

Worker 用 `run.read` 获取指定 Run，转换为公共 `RunRequest`；用 `workspace.read` 获取受控 workspace 元数据。Reference Adapter
不读取业务文件，但 uploaded snapshot 的 storage key 仍必须位于配置的 shared root。Git source 在没有 Sandbox 网络策略时返回
稳定配置错误并由 Worker写 `run.failed`。

`createManagedAdapterRun()` 负责 Adapter Schema/sequence/terminal 校验。Worker 对每个 Event 调用内部 append。遇到
`interaction.requested` 后，继续消费由 Adapter 自身等待；独立 interaction pump 轮询 response，找到后调用 controller.respond。
terminal 后停止 heartbeat/pump 并清理 runtime。

## 8. 取消、故障与恢复

- queued cancel：控制面已有取消 transaction，outbox cancelled；relay 不派发。
- running cancel：控制面写 terminal + revoke grant；heartbeat/event append 失败，Worker cancel runtime 并结束 job。
- Adapter failure：能映射时写 `run.failed`；terminal append 成功后 attempt completed。
- Worker 进程崩溃：BullMQ job stalled 仅作为信号；Mongo lease 到期后 reaper 撤销 grant并创建新 attempt。
- Redis 丢 job：published outbox/queued attempt reconciliation 生成新 attempt；不复用 raw grant。
- terminal Event 已落库但 Worker 后续崩溃：reaper看到 Run terminal，直接关闭 attempt，不重试。

## 9. 配置与安全

Cloud Server 新增 Redis URL、queue name、relay interval/lease、run lease、heartbeat、max attempts、retry delay。Worker 新增 internal
HTTPS origin、Redis URL、queue、worker ID、并发、heartbeat/interaction polling/timeouts、shared workspace root。production internal origin
必须 HTTPS；Redis production URL 必须 `rediss:` 或明确私网 TLS termination 声明。

敏感配置只在 composition root 使用，不传给 Adapter。Reference runtime context 为空。日志结构固定，禁止输出 job.data、headers、
URL credentials、prompt 和 path。

## 10. 威胁模型

| 威胁                       | 控制                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| duplicate delivery         | deterministic job ID、active attempt 唯一、grant 单次 claim         |
| stolen/replayed grant      | digest-only DB、短 TTL、attempt/worker binding、terminal revoke     |
| Worker ID spoofing         | token possession + first claim binding；后续由私网/mTLS继续加固     |
| queue payload leakage      | 最小 job schema；无 prompt/path/vendor key；Redis ACL/TLS部署门禁   |
| Worker crash after claim   | Mongo lease/reaper、新 attempt/new grant、不复用 token              |
| forged/cross-run event     | public schema、grant scope、run/session/sequence transaction checks |
| cancellation race          | terminal Mongo state为事实源，grant revoke使迟到 Event fail closed  |
| host path escape           | storageKey来自控制面，shared-root containment；job不接受 path       |
| Git SSRF                   | 本阶段 Worker不 clone；留给 network-isolated Sandbox                |
| vendor credential exposure | 本阶段无 vendor credential；CodeBuddy另立 Spec                      |
| Docker socket takeover     | 本阶段不接 Docker；后续 sandbox launcher不得挂载 socket             |

## 11. 复用与拒绝方案

复用：

- `apps/cloud-server` 的 outbox、ExecutionGrantService、tenant-first store 与 Event transaction。
- `packages/adapter-api` 的唯一 Adapter 边界。
- `packages/harness-core#createManagedAdapterRun` 的序号、交互和终态校验。
- `packages/adapter-reference` 作为无凭据 Remote 执行目标。

拒绝：

- **API 进程直接执行 Adapter**：破坏控制/执行分离。
- **BullMQ 自动重复使用同一个 job/grant**：claim 后 token 不可安全复用。
- **Worker 直连 Mongo**：扩大凭据和租户数据面。
- **queue body 携带 prompt/workspace bytes**：增加 Redis 泄漏面，Worker应按 grant读取。
- **在无 Docker 环境用普通子进程冒充 Sandbox**：只能称 Reference Worker，不能称 P5 隔离完成。
- **Worker 主机直接 Git clone**：缺少 DNS/egress/resource 隔离。
