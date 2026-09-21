# Cloud Admission Control 需求

## 1. 背景与目标

Remote Reference 已能可靠排队和执行，但公共 `createRun` 目前只检查 Session 写锁，没有组织额度、组织并发或调用权限预检。
这会允许单个组织无限创建跨 Session Run，并把拒绝推迟到 Redis/Worker，既浪费资源，也无法形成可审计的服务边界。

本阶段完成 P4 剩余代码项：在 Run 与 outbox 落库前，以 Mongo 为事实源执行组织级 admission；每个被接纳 Run 恰好占用一个
active 槽位和一个 UTC 日额度，所有终态路径恰好释放 active 槽位。角色和 permission policy 在工作区/队列写入前 fail closed。

## 2. 验收需求

### AC1. 权限预检

- `CLOUD_RUN_ALLOWED_ROLES` 是严格、去重的 owner/admin/member allowlist；调用者至少命中一个角色才能创建 Run。
- `CLOUD_ALLOWED_PERMISSION_POLICIES` 是严格、去重的 interactive/read-only/auto-edit allowlist。
- 权限拒绝使用稳定 403；不得创建 Run、outbox、counter reservation 或泄漏其他租户状态。
- adapter、model、workspace 和 Session 仍执行已有校验；admission 不绕过现有边界。

### AC2. 并发与 UTC 日额度

- `CLOUD_MAX_ACTIVE_RUNS_PER_ORGANIZATION` 限制同一组织所有 Session 的非终态 Run 数。
- `CLOUD_MAX_RUNS_PER_UTC_DAY` 限制同一组织每个 UTC 日被接纳的新 Run 数；重放同一个 idempotency key 不重复计数。
- 达到并发上限返回可重试 429；达到日额度返回不可重试 429；两者都不进入 outbox。
- 限制是部署侧保护配额，不宣称计费、套餐、余额或商业额度系统已经实现。

### AC3. 原子性与释放

- Admission counter、Run、outbox 和 Session 状态在同一个 Mongo transaction 内提交；失败全部回滚。
- Run completed/failed/cancelled、dispatch retry exhaustion 均幂等释放 active 槽位；attempt retry 不新增额度、不新增 active 槽位。
- Run 持久化 `admissionReleasedAt`，阻止重复终态、取消竞态或 reaper 重复扣减。
- 旧组织没有 counter 时安全懒初始化；不得要求破坏性迁移。

### AC4. 修复与审计

- 提供显式 reconciliation 命令：按非终态 Run 重算 active 数，但保留当前 UTC 日 admitted 数，默认只报告，`--apply` 才写入。
- run admission 接纳/拒绝、release 和 reconciliation 写固定字段审计，不记录 prompt、路径、token 或请求体。
- memory 与 Mongo store 使用同一状态机；测试覆盖竞争、日切、幂等和所有终态。

## 3. 非功能要求

- **隔离**：所有 counter 查询/更新以 `organizationId` 为首要条件，禁止全局 Run ID 更新。
- **并发**：不能用“先 count 再 insert”的非原子模式；Mongo 冲突必须由 transaction/单文档原子条件收敛。
- **回滚**：Run/outbox 插入失败不消耗额度；release 失败不得静默把 Run 宣称为完整收敛。
- **范围边界**：不增加 Admin 配额 UI、支付、计费、余额、模型 token 计量或跨区域限流。
- **兼容**：现有 idempotency、单 Session 写锁、execution grant、relay/reaper 语义不变。

## 4. 外部门禁

- 真实 Mongo replica set 的并发 transaction 仍需部署环境证据；memory store 测试不能替代。
- P4 的生产 TLS/Redis ACL、macOS/Windows Remote 客户端认证仍保持未完成。
- P5 Docker Sandbox、短期 CodeBuddy 凭据和真实模型调用不属于本 Spec。
