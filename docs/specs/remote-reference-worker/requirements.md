# Remote Reference Worker 需求

## 1. 背景与目标

Phase 4 已有 Cloud Control Plane、Mongo outbox、execution grant 和持久化 Event API，但 Run 只能停留在
`queued`。本阶段建立独立 `apps/cloud-worker`，用 Redis/BullMQ 将 `run.requested` outbox 可靠派发给受信任的
Reference Adapter Worker，完成可恢复的 Remote Reference 执行闭环，为后续 CodeBuddy 沙箱提供真实队列、租约和内部协议基础。

目标是：API 进程不导入/执行 Adapter；Worker 不持有用户 access token、Mongo URI、token pepper 或平台长期厂商密钥；
Run 的所有公开状态和 Event 仍只通过 Cloud Server 内部 execution-grant API 落库。

## 2. 验收需求

### RW1. 队列与派发

- 新增共享的严格队列 job schema，只允许 `runId`、`attempt`、短期 execution grant 和无敏感值的版本字段。
- Cloud Server relay 以 Mongo outbox 为事实源，使用确定性 BullMQ job ID，重复派发不得产生两个有效执行。
- outbox 具有 claim lease、owner、expiry、attempt 和稳定状态；进程崩溃后可重新领取。
- Redis 不可用时 Run 保持 queued/outbox pending，不在 API 进程内降级执行。

### RW2. Run attempt 与租约

- Mongo 持久化 Run attempt：organization、run、attempt、queueJobId、状态、lease owner/expiry、heartbeat、错误分类。
- Worker 必须先单次 claim execution grant 和对应 attempt，再读取 Run/workspace 或追加 Event。
- heartbeat 只续约同一 run/attempt/worker；过期、错误 owner、错误 attempt 和已终态均拒绝。
- reaper 对过期 attempt 撤销旧 grant；未超过上限时创建新 outbox attempt，超过上限时写唯一 `run.failed`。

### RW3. 内部执行协议

- execution grant 增加 `run.read`，Worker 可读取指定 Run 的执行输入；不能列举 Session、Run 或租户资源。
- 内部请求同时绑定 grant、run、attempt 和 worker identity；用户 access token 不能替代。
- interaction response 使用带取消信号的 bounded polling；未知/未回答返回 pending，不泄露其他 Run 的 response。
- Worker cancellation 通过 Run 终态或 grant revoke 收敛，调用 Adapter `cancel()` 并清理资源。

### RW4. Reference Worker

- Worker 仅从 `adapter-api`/`harness-core` 创建受信任 Reference Adapter runtime，Cloud Server 不导入这些包。
- 默认生产入口只注册 Reference Adapter；测试可注入确定性 text/tool/interaction/failure/cancel scenario。
- Worker 按序上报全部公共 Event；Adapter 异常、协议错误和非预期退出映射为脱敏 `run.failed`。
- uploaded snapshot 只读取 Cloud Server 返回的受控 shared-volume storage key；不得接受 job 中的任意路径。
- Git source 在本阶段只登记、不 clone；没有受限网络沙箱时明确失败，不从 Worker 主机直接联网。

### RW5. 安全与审计

- queue job、attempt、outbox、Event、audit 和错误中不得出现 Mongo URI、Redis 密码、用户 access/refresh token、prompt、
  workspace bytes、绝对宿主路径或厂商 Key。
- raw execution grant 只允许出现在一次 queue job payload 和 Worker 内存；数据库只存 peppered digest。
- relay/claim/heartbeat/retry/exhaustion/terminal 均写固定字段 audit，不接受任意 metadata。
- 日志只输出 request/job/run/attempt 等非秘密标识及稳定错误码。

### RW6. 运维与验证

- 配置严格验证 Redis URL、queue name、lease/heartbeat/retry 时间关系、并发和最大 attempt；production fail closed。
- 提供 relay、Worker 和 reaper 独立启动/关闭及健康状态；关闭时停止取新任务并有界等待当前任务。
- 单测使用 memory store 与 fake/internal transport；Redis 集成测试启动临时本机 Redis，不依赖常驻服务。
- 全仓 `pnpm check` 通过；真实 Mongo replica set、容器和生产 Redis/TLS 仍单列部署证据。

## 3. 非功能要求

- **一致性**：Mongo outbox/attempt 是派发事实源，BullMQ 是可重建传输层，Event/Mongo 是公开状态事实源。
- **幂等**：job ID、attempt 唯一索引、grant 单次 claim、Event sequence/terminal 唯一约束共同阻止重复执行。
- **恢复**：relay、Worker 或 Redis 重启不应永久卡住非终态 Run；所有超时最终进入 retry 或 terminal failure。
- **最小权限**：Worker 不直连 Mongo，不访问公共用户 API，不持有控制面长期 secret。
- **可测试**：时间、worker ID、queue transport、internal client 和 Adapter factory 均可注入。

## 4. 范围

- `packages/cloud-queue`：job schema、queue factory、连接配置和测试 Redis helper 边界。
- `apps/cloud-server`：outbox claim/relay、attempt/reaper、execution-grant run/lease 内部 API、Schema/索引/审计。
- `apps/cloud-worker`：配置、internal client、Reference execution engine、heartbeat/cancel/interaction 协调、入口和测试。
- Phase 4/路线图/兼容状态文档更新。

## 5. 非目标

- 不执行真实 CodeBuddy，不注入厂商凭据，不声明 P5 完成。
- 不在本机缺少 Docker 时伪造非 root 容器、cgroup、seccomp、网络和 Docker socket 隔离证据。
- 不从 Worker 主机直接 clone Git；Git 执行留给受限网络 Sandbox Spec。
- 不实现多区域 Redis/Mongo、Kubernetes、计费、额度 UI 或 Admin 管理界面。
- 不把 BullMQ completion 当作公开 Run terminal；只有持久化 terminal Event 才算完成。

## 6. 外部依赖与门禁

- 本机存在 Redis 可执行文件，可用于短生命周期集成测试；生产 Redis ACL/TLS 需部署验证。
- 当前环境无 Docker CLI，容器隔离必须在后续具备 Docker/受控 Linux 环境时验证。
- 真实 Mongo replica set、生产 TLS、正式 Remote hostname、Windows/macOS 客户端证据仍未提供。
