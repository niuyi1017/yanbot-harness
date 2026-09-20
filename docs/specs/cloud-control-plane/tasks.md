# Cloud Control Plane 任务清单

## 当前状态（2026-09-20）

- [x] 审计双 Runtime、总体架构、Remote Fixture、安全负例与现有 contracts。
- [x] 冻结 Phase 4 控制面边界、认证模型、持久化模型、工作区 API 与威胁模型。
- [ ] 正式实现尚未开始；Phase 5 Worker/Redis Queue/沙箱明确不在本 Spec。

## T1. Spec 门禁

- [x] 新增 `requirements.md`、`design.md`、`tasks.md`。
- [x] 格式、范围、威胁模型与依赖复核后独立提交。

验收：实现前存在独立 Spec commit；没有把 Fixture、开发 HTTP 或 API 进程描述为完整 Remote Runtime。

## T2. Workspace Snapshot 公共安全包

- [ ] 新增 `packages/workspace-snapshot`，迁移 manifest/path/digest 规则。
- [ ] 增加 payload base64、size、逐文件 digest、覆盖关系与安全写入验证。
- [ ] Remote Fixture 改为依赖公共包，删除重复实现且全部 P3.6/P3.7 回归通过。

验收：公共包不依赖 Fixture/Nest/Mongo；原 23 项 manifest 测试与新增 payload/写入攻击矩阵通过。

## T3. Cloud Server 基座与 Mongo Store

- [ ] 新增 NestJS 11 `apps/cloud-server`、严格配置、Remote health 与安全 middleware。
- [ ] 定义 tenant-first repository ports、Mongo schemas、复合唯一索引、TTL 索引与 transaction helper。
- [ ] 增加确定性 memory store 仅供 service 单测；production bootstrap 禁止使用。
- [ ] 增加 bootstrap provision 与 workspace cleanup 运维命令。

验收：build/typecheck 通过；缺配置/production 无 TLS 声明 fail closed；集合前缀和索引测试通过。

## T4. Identity、认证与审计

- [ ] 实现 organization/user/membership/device provision 与禁用状态。
- [ ] 实现 device exchange、短期 access、refresh 单次轮换、reuse family revoke 与 access guard。
- [ ] 实现固定字段 audit service 和公共错误映射。
- [ ] 覆盖无效/过期/撤销/replay/跨组织与 secret marker 脱敏测试。

验收：raw secret 不进入 store 序列化/audit/error；每个业务请求重新验证身份状态。

## T5. Workspace Preparation

- [ ] 实现 tenant-scoped snapshot upload staging、验证、原子发布与失败清理。
- [ ] 实现 allowlisted HTTPS + immutable commit Git registration；API 不联网。
- [ ] 实现 workspace TTL、Run 创建时 expiry 验证与 owned cleanup。
- [ ] 覆盖 traversal、symlink、collision、digest、oversize、SSRF URL、userinfo/query 与跨租户负例。

验收：只有受控 workspaceRef 进入 Run；数据库或文件失败不留下可用半成品。

## T6. Session、Run、Outbox、Event 与 SSE

- [ ] 实现 Reference catalog、Session CRUD 和 tenant 隔离。
- [ ] 实现 workspace-bound Run、Session 写锁、fingerprint 幂等和 transaction outbox。
- [ ] 实现持久化 Event append、cursor replay、SSE polling、唯一终态与取消竞态。
- [ ] 实现 Interaction response 持久化/幂等。

验收：公共 Conformance 中无需 Worker 的资源语义通过；Run 保持 queued，API 进程不导入/执行 Adapter。

## T7. Execution Grant 与内部接口

- [ ] 实现 run/workspace/attempt/action scoped grant 签发、单次 claim、过期和撤销。
- [ ] 内部 endpoint 默认关闭，开启后只接受 grant，不接受用户 access token。
- [ ] 覆盖错误 Run/attempt/action、重复 claim、终态后 append 与 raw grant 脱敏。

验收：grant 不能列举资源或跨 Run 使用；outbox、event、audit 中不存在 raw grant。

## T8. SDK/CLI Remote Workspace 接入

- [ ] SDK 增加 snapshot/Git preparation 方法，不接收本机路径作为 Remote source。
- [ ] CLI 在显式 snapshot/Git 参数存在时启用同名 Remote `run`；默认 cwd 仍不得发送。
- [ ] 更新 profile/CLI 文档和请求捕获测试。

验收：同一 SDK Run API 使用返回的 WorkspaceSource；Local 行为与 legacy 路由不回退。

## T9. 回归、证据与状态

- [ ] 运行 cloud-server 定向测试、Fixture/SDK/CLI 回归和 `pnpm check`。
- [ ] 有 MongoDB 时运行真实 transaction/index/SSE 重建集成测试并归档证据；无 MongoDB 不伪造该结果。
- [ ] 更新 Phase 4 任务状态与 compatibility，保持 Phase 5/正式 Remote 未完成。
- [ ] 检查 diff/status，保留用户未跟踪临时文件，提交实现。

验收：本 Spec 的代码任务全部完成、全仓门禁通过；外部部署/TLS/Mongo/Worker 证据单独列为未完成门禁。
