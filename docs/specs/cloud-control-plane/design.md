# Cloud Control Plane 设计

## 1. 总体架构

```text
SDK / CLI
   │ HTTPS + bearer
   ▼
NestJS cloud-server
   ├─ auth guard -> token/device/membership
   ├─ public Harness controllers
   ├─ workspace preparation
   ├─ control-plane services
   ├─ execution-grant internal controller
   └─ audit allowlist
          │
          ├─ MongoDB (metadata, tokens, events, outbox, audit)
          └─ private workspace volume (immutable snapshot bytes)

Phase 5: outbox relay -> Redis Queue -> Worker/Sandbox
```

Cloud Server 只做接收、鉴权、持久化和流式读取。Reference Adapter 不进入 API 进程。Run 创建事务写入 `runs` 与
`outbox`，使后续引入 Redis 时无需改变公共 API。

## 2. 模块与文件

```text
apps/cloud-server/src/
  main.ts app.module.ts config.ts
  auth/                  opaque token、guard、device exchange、refresh rotation
  identity/              organizations/users/memberships/devices provision
  persistence/           repository ports、Mongo schemas/store、transaction helper
  workspaces/            snapshot upload、Git registration、TTL cleanup
  sessions/              tenant-scoped Session
  runs/                  Run/idempotency/cancel/outbox
  events/                durable append/replay/SSE
  interactions/          response persistence
  execution-grants/      issue/consume/internal worker scope
  audit/                 allowlist record
  catalog/               Reference Adapter/Model read-only catalog
  common/                error mapping、request ID、Zod pipe
  operations/            bootstrap/cleanup CLI

packages/workspace-snapshot/src/
  manifest.ts payload.ts paths.ts
```

`remote-reference-fixture` 改为依赖 `workspace-snapshot` 的 manifest validator，避免正式服务复制安全规则或反向依赖测试包。

## 3. 配置

配置使用 Zod 在启动前解析：

```ts
type CloudConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  trustProxy: boolean;
  tlsTerminated: boolean;
  mongodbUri: string;
  mongodbDatabase: string;
  tokenPepper: string;
  workspaceRoot: string;
  accessTokenTtlSeconds: number; // default 900
  refreshTokenTtlSeconds: number; // default 604800
  eventRetentionSeconds: number; // default 604800
  workspaceTtlSeconds: number; // default 86400
  gitAllowedHosts: string[];
};
```

production 必须 `tlsTerminated=true` 且 `trustProxy=true`；应用检查 `X-Forwarded-Proto=https`。development/test 可在 loopback
HTTP 运行，但 health/profile 和文档明确它不是公网认证证据。pepper 长度至少 32 bytes，不进入 Nest logger。

## 4. 持久化模型与索引

所有集合前缀为 `yanbot_harness_`，timestamps 为 UTC Date：

| 集合             | 关键字段                                                                           | 唯一/查询索引                                              |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| organizations    | organizationId, name, status                                                       | organizationId                                             |
| users            | userId, externalIdentities, status                                                 | userId                                                     |
| memberships      | organizationId, userId, roles, status                                              | organizationId+userId                                      |
| devices          | organizationId, userId, deviceId, secretDigest, status                             | organizationId+deviceId                                    |
| token_grants     | organizationId, userId, deviceId, familyId, accessDigest, refreshDigest, expires   | digest unique, TTL                                         |
| sessions         | organizationId, userId, public Session                                             | organizationId+sessionId                                   |
| runs             | organizationId, userId, public Run, workspaceRef, inputFingerprint, idempotencyKey | org+run; org+session+key sparse unique                     |
| run_events       | organizationId, runId, event                                                       | org+run+sequence unique; org+eventId unique; retention TTL |
| interactions     | organizationId, runId, requestId, response, expiresAt                              | org+requestId unique                                       |
| workspaces       | organizationId, workspaceRef, source, digest, storageKey, status, expiresAt        | org+workspaceRef; TTL                                      |
| execution_grants | organizationId, runId, attempt, digest, actions, expiresAt, claimedAt              | digest unique; TTL                                         |
| outbox           | organizationId, runId, kind, status, availableAt                                   | status+availableAt                                         |
| audit_logs       | allowlisted fields, expiresAt                                                      | org+timestamp; TTL                                         |

公共 Schema 在写入和读取时均由 contracts 解析。Mongo `_id` 从不进入 API。所有 repository 方法以 `TenantContext` 开头；
不存在 `getRun(runId)` 这类无 tenant 方法。

## 5. 认证设计

### 5.1 Token 形态

- device secret：`yhd_<base64url32>`。
- access token：`yha_<base64url32>`。
- refresh token：`yhr_<familyId>.<base64url32>`。
- execution grant：`yhe_<base64url32>`。

digest 为 `SHA-256(pepper || 0x00 || token)`。比较使用 `timingSafeEqual`。数据库索引只看到 digest；应用日志不记录 digest。

### 5.2 Exchange 与 refresh

exchange 根据 organizationId + deviceId 查询设备，再验证 secret digest、用户/组织/成员状态，创建 token family。refresh 使用
Mongo transaction 查找 active refresh digest、把旧 grant 标记 rotated 并创建下一 grant。若已 rotated token 再次出现，
按 familyId 撤销全部 grant，返回统一 401。

access guard 每次查 access digest并联查身份状态，不信任客户端 token 内的 claims。`TenantContext` 只由 guard 构造并挂到
request；controller 不接受 organizationId body/query 覆盖。

### 5.3 Bootstrap

无公开注册。运维 CLI `cloud:provision` 从 stdin/受保护环境读取 organization/user/device 参数，upsert 非秘密身份并只在首次
创建时输出一次 device secret。命令输出不得包含 Mongo URI 或 token pepper。

## 6. 工作区设计

### 6.1 公共验证包

把 Fixture 的 manifest 规则迁到 `packages/workspace-snapshot`：版本、路径、限制、canonical digest 与敏感文件规则保持不变；
新增 payload validator 验证 base64 严格编码、decoded size、逐文件 hash、manifest 全覆盖且无额外文件。

上传 API 接受：

```ts
{
  manifest: RemoteWorkspaceManifest;
  files: Array<{ path: string; contentBase64: string }>;
}
```

目录不进入 files。API JSON limit 按总上限设置，但 service 在 decode 前先计算 base64 理论上限。staging 目录 mode 0700，文件
mode 0600/0700；路径由已验证 POSIX segments 拼接，并逐级禁止 symlink。写完后重新 hash，原子 rename 为
`<workspaceRoot>/<organizationId>/<workspaceRef>`。Mongo 写失败删除 owned staging/final tree；调用方路径从不参与删除。

### 6.2 Git source

Git API 只登记后续 Worker 可验证的不可变 source：标准 `https:` URL、allowlist hostname、默认端口、无 userinfo/query/hash，
ref 必须是 40 位小写 commit SHA。API 不解析 DNS、不发网络请求、不 clone，因而不产生 SSRF；Phase 5 Worker 仍需在受限网络
中 clone 并核对实际 commit。未配置 allowlist 时 health 不声明 `git-ref`，route 返回 capability unsupported。

## 7. Run、outbox 与事件

Run 创建 transaction：

1. 验证 tenant Session、idle 状态和 workspace。
2. 计算 canonical request fingerprint。
3. 检查 org+session+idempotency key；同 fingerprint 返回 reused，冲突返回 409。
4. 写 queued Run、把 Session 标为 running、写 `run.requested` outbox。

Phase 4 不创建 `run.started`，因为尚无 Worker。execution grant 由内部 outbox relay/Worker claim 流程签发，而不是公共客户端。
内部事件 append 验证 grant scope、sequence、run/session ID 和公共 Event Schema，transaction 更新 Run/Session 并写 event。

SSE 请求先按 cursor 查询数据库，再轮询新 sequence；每次查询都含 organizationId。多实例不依赖进程内事件 hub，心跳不写
数据库。terminal event 后关闭 stream。过期/未知 cursor 返回稳定 404/409，不从头静默重放。

取消 transaction 对 queued/running Run 写唯一 terminal event、更新 Run 和 Session、撤销 grant、标记 outbox cancelled。事件
唯一索引处理并发取消。Interaction response 使用 org+requestId 唯一键保证幂等。

## 8. Execution grant

grant record 的 `actions` 初始为：`workspace.read`、`events.append`、`interaction.read`、`run.complete`。claim 使用 digest 查询并
原子设置 `claimedAt`；之后每次内部请求同时验证 digest、run、attempt、expiry、revokedAt 和 action。grant 不包含模型凭据，
也不能签发另一个 grant。

Phase 4 提供 service/store 和内部 controller，但不开放公共 claim endpoint，也不自行启动 Worker。Phase 5 接入 mTLS/private
network 与 Redis relay 前，内部 controller 默认由 `CLOUD_INTERNAL_API_ENABLED=false` 关闭。

## 9. 审计与错误

Audit service 只接受枚举 action 和显式字段，不接受任意 metadata。request ID 在最外层 middleware 生成。认证失败没有可信
tenant 时 organization/subject/device 留空，不记录攻击输入。应用错误映射到公共 `ApiError`；Zod/Mongo/FS 内部 message 只进
受控诊断分类，不返回客户端。

稳定分类：401 authentication、403 permission、404 foreign/missing、409 idempotency/session lock、413 workspace limit、
422 invalid manifest/source、500 persistence。对 SDK 保持 Harness error code，不新增 deployment-specific public code。

## 10. 威胁模型

| 威胁                            | 控制                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| token/database 泄漏             | opaque random token、peppered digest、TTL、rotation、无 raw secret 日志   |
| refresh replay                  | 单次轮换、family reuse detection、family revoke                           |
| tenant IDOR                     | repository tenant-first API、复合索引、foreign=missing 测试               |
| malicious archive/path          | strict manifest/payload、无 archive extraction、symlink-free owned root   |
| Git SSRF/credential leak        | URL allowlist、immutable SHA、API 不联网、禁 userinfo/query/credentialRef |
| duplicate Run / double terminal | transaction、idempotency fingerprint、unique indexes                      |
| forged Worker event             | run-scoped one-time execution grant、action/attempt/sequence checks       |
| audit/log injection             | allowlist fields、无 body/URL/error message、控制字符拒绝                 |
| stale workspace                 | expiry check at Run create and Worker claim、owned cleanup                |
| API process code execution      | Cloud Server 不导入 Adapter/Core，不 spawn/clone，不访问 Docker socket    |

剩余风险：Mongo/volume 运维、TLS proxy、内部网络、Worker sandbox 与 Git clone 网络策略必须在部署/Phase 5 验证；单元测试不能
替代这些证据。

## 11. 实施顺序

```text
Spec 独立提交
  -> workspace-snapshot 提取与 Fixture 回归
  -> cloud-server skeleton/config/Mongo ports
  -> auth/identity/audit
  -> workspace preparation
  -> Session/Run/outbox/event/SSE
  -> execution grants/internal boundary
  -> SDK/CLI preparation integration
  -> security negatives + full check
```

## 12. 拒绝方案

- **公网暴露 Local Runtime**：缺少 tenant、持久化和控制/执行分离。
- **把 Remote Fixture 扩成生产服务**：测试包使用 injected fetch、无 listener/Mongo/正式身份，身份错误。
- **JWT 自包含 access token**：即时设备/成员撤销困难；首个 Preview 使用可查询 opaque token。
- **API 进程直接执行 Reference Adapter**：破坏控制面/执行面边界，也会掩盖 Phase 5 sandbox 缺口。
- **在 API 进程 git clone**：引入 SSRF、凭据和资源消耗；只登记 allowlisted immutable source。
- **只写 Mongo 后再异步写队列**：崩溃会丢任务；先用 transaction outbox，Phase 5 relay 到 Redis。
- **复制 Fixture manifest validator**：安全规则会漂移；提取独立生产可用包。
