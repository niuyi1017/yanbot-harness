# Cloud Control Plane 需求

## 1. 背景

双 Runtime 基座、Remote Reference Fixture 和矩阵证据已经证明公共 Session/Run/Event 语义可在 `executionMode=remote`
下复用，但 Fixture 没有真实网络 listener、生产身份、MongoDB、多进程持久化、工作区字节存储或正式审计边界。
`dual-runtime-compatibility` Phase 4 要求建立 `apps/cloud-server`，使 Remote API 成为可部署、可持久化、可供后续 Worker
领取任务的正式控制平面。

本阶段只负责控制面，不在 API 进程中执行 Adapter，也不通过公网暴露 Local Runtime。Run 创建后进入持久化 outbox；
Phase 5 的 Worker/Redis Queue 消费该 outbox 并在沙箱执行。

## 2. 目标

- 建立 NestJS 11 `apps/cloud-server`，只暴露中立 `/v1/*` Harness API。
- 使用独立 MongoDB/Mongoose 持久化组织、用户、成员关系、设备、令牌、Session、Run、Event、Interaction、Workspace、
  execution grant、outbox 与 audit。
- 实现设备凭据换取短期访问令牌、refresh token 单次轮换、撤销和过期检查。
- 所有业务查询强制绑定 organization；跨租户资源与不存在资源返回相同结果。
- 实现上传快照和受控公开 Git commit 的工作区准备、摘要校验、限制、TTL 与清理。
- 实现 Session、Run、幂等创建、持久化 SSE replay、取消和交互响应的控制面语义。
- 生成一次性、短期、Run-scoped execution grant，供未来 Worker 领取/上报；长期平台或模型凭据不进入 grant。
- 使用固定字段审计，不记录 token、请求 body、prompt、仓库 query、工作区内容或本机路径。

## 3. 验收标准

### CP1. 应用与配置

- `apps/cloud-server` 使用 NestJS 11，Node 22，ESM 与仓库统一 TypeScript/ESLint/Prettier 门禁。
- 启动必须提供 `MONGODB_URI`、`CLOUD_TOKEN_PEPPER`、`CLOUD_WORKSPACE_ROOT` 和显式 HTTPS 部署声明；缺失时 fail closed。
- 应用只监听配置地址；生产模式若未声明上游 TLS 已终止则拒绝启动。
- `/v1/health` 返回 Remote Runtime Profile，声明 bearer、durable replay、retention 与实际启用的 workspace source。
- MongoDB database 独立；集合统一使用 `yanbot_harness_` 前缀，不访问 yanbot 主业务集合。

### CP2. 身份、设备与令牌

- 用户通过预配置/管理面 provision 的组织成员和设备进入系统；本阶段没有公开注册接口。
- device secret、access token、refresh token 和 execution grant 均使用至少 256-bit 随机值，数据库只保存带 server pepper 的
  SHA-256 digest。
- `POST /v1/auth/device/exchange` 使用 device ID + secret 签发 15 分钟 access token 与 7 天 refresh token。
- `POST /v1/auth/refresh` 原子轮换 refresh token；旧 token 再次使用会撤销整个 token family。
- 每次业务请求重新查询 access token、device、membership 与 organization 状态；禁用/撤销即时生效。
- 认证错误固定为 `401 AUTHENTICATION_FAILED`，不暴露 token/device/user 是否存在。

### CP3. Tenant 资源

- Session、Run、Event、Interaction、Workspace、Grant、outbox 与审计记录均含 `organizationId`。
- repository/store API 必须接受 tenant context，禁止仅按全局资源 ID 查询。
- 跨组织访问返回与不存在资源相同的 `404 HARNESS_FAILED`。
- 创建 Session 要验证 Adapter allowlist；列表默认只返回当前组织资源。
- 同一 Session 同时只允许一个 queued/running 写入 Run。

### CP4. 工作区准备

- 上传快照使用版本化 manifest + base64 file payload；只允许普通文件/目录，规则复用独立
  `packages/workspace-snapshot`，不依赖测试 Fixture。
- 校验 exact fields、排序、父目录、跨平台路径、碰撞、敏感文件名、单文件/总大小、条目数、SHA-256 与 canonical digest。
- 字节必须先写私有 staging，再核对 manifest，最后原子发布到 tenant-scoped immutable workspace 目录。
- Git source 仅接受 HTTPS、配置 allowlist host、无 username/password/query/hash 的 URL，以及完整 40 位 commit SHA；不保存
  credentialRef，不在 API 进程执行 clone。
- Workspace 记录包含不可猜 ID、tenant、kind、digest/source、状态、createdAt/expiresAt；过期后不能创建 Run。
- 清理只删除数据库确认属于当前 workspace root 的过期对象；路径必须由内部 ID 构造，不能使用客户端路径。

### CP5. Session、Run、Event 与幂等

- 公共资源继续使用 `@yanbot-harness/contracts` Schema、状态机和 `/v1` 路由。
- Run 创建必须使用已准备、未过期、同租户 workspace；拒绝 local path grant。
- 幂等键作用域为 organization + session + key；相同 body 返回原 Run，不同 body 返回稳定冲突错误。
- Run 与 outbox 在同一 MongoDB transaction 中写入；API 不直接执行 Adapter。
- Event 以 organization + run + sequence 唯一索引持久化，写入先于 SSE 发布；cursor 可跨进程重放。
- 取消 queued/running Run 产生唯一 `run.cancelled` 终端事件，并使后续 Worker event 被拒绝。
- Interaction response 持久化且按 request ID 幂等，供 Worker 拉取；跨租户/过期请求统一拒绝。

### CP6. Execution grant 与内部边界

- grant 只包含 opaque token，数据库记录绑定 organization、run、workspace、attempt、expiry、允许动作和单次领取状态。
- grant token 只在签发响应出现一次；outbox、Run、Event 与 audit 不保存 raw token。
- 内部 endpoint 使用 execution grant，不接受用户 access token 替代。
- grant 只能读取指定 workspace 元数据、追加指定 Run event、读取 interaction response 与报告终态；不能列出租户资源。
- 过期、撤销、错误 Run/attempt 或重复领取均 fail closed。

### CP7. 审计与脱敏

- Audit 固定字段：timestamp、requestId、organizationId、subjectId、deviceId、action、resourceType、resourceId、outcome、
  status、errorCode；资源 ID 可记录，secret/prompt/body/path/content 不可记录。
- 认证成功/失败、workspace 准备/拒绝、Session/Run 创建、取消、Interaction、grant 签发/消费均可审计。
- 日志与错误不包含 Authorization、device secret、refresh token、execution grant、payload bytes、prompt 或 Mongo URI。
- 跨租户负例、token 过期/轮换重放、恶意 manifest/Git URL 和 audit marker 搜索测试全部通过。

### CP8. 回归与阶段状态

- 新增 store/service/controller 定向测试，并以真实 MongoDB 集成测试作为部署门禁；没有 MongoDB 时单元门禁仍可运行。
- `pnpm check` 全量通过。
- Phase 4 代码完成后只标记控制面完成；Phase 5 Worker/Redis Queue/沙箱与真实 Adapter 执行继续未完成。
- Remote 兼容表仍保持未实现，直到真实部署、Windows/macOS 客户端与 Worker 证据齐全。

## 4. 非功能要求

- **安全**：默认拒绝、令牌可撤销、tenant 条件查询、严格输入限制、审计 allowlist。
- **一致性**：MongoDB transaction 保护 Run/outbox、refresh rotation、terminal event 与状态更新。
- **可靠性**：所有外部写入支持幂等或明确冲突；SSE 以数据库为事实源。
- **可运维**：索引、TTL、健康检查、清理命令与 bootstrap provision 命令可独立运行。
- **可测试**：核心策略依赖 repository ports；单测使用确定性内存实现，生产使用 Mongo 实现。

## 5. 范围

- `apps/cloud-server` NestJS API、Mongo repository、认证、控制面模块和运维 CLI。
- `packages/workspace-snapshot` 可复用快照 manifest/payload 校验。
- 必要的 contracts 增量、SDK workspace preparation 方法和 CLI Remote run 解锁。
- Phase 4 Spec、威胁模型、测试与状态文档。

## 6. 非目标

- 不实现 Redis/BullMQ consumer、Worker lease、Adapter 执行或 Docker 沙箱；属于 Phase 5。
- 不实现真实 CodeBuddy Remote、模型凭据交换或用量结算。
- 不托管长期私有 Git credential，不允许 SSH/scp/file/git URL。
- 不实现公开注册、密码登录、OAuth UI、管理后台或多区域部署。
- 不把内存 repository 用于生产，也不把单进程 notifier 当作 durable event store。
- 不把本地开发 HTTP listener 描述为公网 HTTPS 已认证。

## 7. 依赖

- `packages/contracts`、`packages/sdk`、`packages/testing` 与 Remote Runtime Conformance。
- NestJS 11、Mongoose/MongoDB；Redis/BullMQ 只在 Phase 5 接入。
- 部署层 TLS termination、独立 MongoDB 与受保护 workspace volume。
