# Remote Reference Fixture 需求

> 状态说明：本文定义 P3.6 最小基座。P3.7 已在
> [`remote-reference-safety`](../remote-reference-safety/requirements.md) 将 Fixture 扩展为严格 manifest、结构化审计与
> Fixture 文件级 durable replay；正式 Remote 控制平面仍未实现。

## 1. 背景

`dual-runtime-compatibility` Phase 3 已经抽取部署无关的 Runtime Conformance Kit，并让 Local Runtime 的
Reference Adapter 通过 discovery/resources、run/idempotency、interaction/replay 和 cancellation 四组公共场景。
Remote 路径仍缺少可执行证据，原因是现有 `CreateRunRequest` 只接受顶层 `workspaceGrant`，无法安全表达
`git-ref` 或 `uploaded-snapshot`，也不能用本机路径授权伪造远端工作区。

正式 Remote 控制平面仍需独立的 `apps/cloud-server`、认证、持久化、队列、工作区准备和威胁模型 Spec。本 Spec
只建立一个私有、进程内、无真实模型凭据的 Remote Reference Fixture，为公共协议迁移和 Conformance 提供测试基座，
不得被描述或部署为生产云服务。

## 2. 目标

- 以向后兼容方式把已冻结的 `WorkspaceSource` 联合接入 `CreateRunRequest`。
- 保持 preview.3 顶层 `workspaceGrant` / `relativeCwd` JSON 可用，并让 Local Runtime 接受等价的
  `workspace.kind = local-path-grant` 新形态。
- 建立仅供测试使用的 Remote Reference Fixture，通过 HTTPS 语义、Bearer token、租户作用域工作区和公共 `/v1`
  HTTP/SSE 接口运行 Reference Adapter。
- 使用同一套 `packages/testing` Runtime Conformance 场景验证 Remote，不复制公共断言。
- 为后续跨租户、令牌过期、持久化重放、恶意清单和日志脱敏负例留下明确接口，但不把未实现项标记完成。

## 3. 用户故事与验收标准

### RF1. 向后兼容的 Run 工作区输入

- 已有客户端发送顶层 `workspaceGrant` 和可选 `relativeCwd` 时，Schema、Local `/local` 与 Local `/v1` 行为不变。
- 新客户端可发送且只能发送一个 `workspace` 判别联合；不得同时发送旧顶层字段和新字段。
- `workspace.kind = local-path-grant` 继续校验相对路径穿越、绝对路径和空字节。
- `git-ref` 与 `uploaded-snapshot` 沿用现有严格 Schema；未知字段和非法摘要必须在边界拒绝。
- Local Runtime 对新 `local-path-grant` 归一化到现有授权解析路径；对远端来源返回稳定
  `CAPABILITY_UNSUPPORTED`，不得尝试解释或访问远端输入。

### RF2. 测试专用 Remote Fixture

- Fixture 是新的私有 workspace 包，不进入 SDK、CLI 或发行包的生产依赖图。
- Fixture 只暴露注入式 `fetch` 与显式测试控制面，例如签发测试 token、预置上传快照；不监听公网端口。
- SDK 仍以 `mode: remote` 和 `https://` origin 连接；不得增加跳过 TLS/HTTPS 校验的产品开关。
- Fixture 的 Runtime Profile 声明 `executionMode = remote`、`authentication = bearer`、仅支持
  `uploaded-snapshot`；P3.7 后使用测试文件状态声明有限期 durable replay。
- Fixture 不连接 MongoDB、Redis、对象存储、Docker、真实 Git 或真实模型服务。

### RF3. 租户与工作区最小边界

- 测试 token 至少绑定 tenant、subject 和 expiry；请求从 Bearer token 获得租户上下文。
- 预置快照至少绑定 tenant、upload ID、SHA-256 摘要和受控虚拟工作目录。
- 创建 Run 时只能使用当前租户拥有且摘要匹配的快照；本机路径来源必须被拒绝。
- Session、Run、Interaction 和 Event 均按租户查询，资源标识不能绕过租户条件。
- Fixture token 和内部工作区元数据不得出现在公共 Session、Run 或 Event 响应中。

### RF4. Remote 公共 Conformance

- Remote driver 必须调用公共 SDK，不能直接调用 Fixture 内部资源方法完成 Session/Run/Event 操作。
- 四组现有 Runtime Conformance 函数全部运行并通过，公共断言保持不含 execution-mode 分支。
- driver 仅负责为每个 Run 注入预置的 `uploaded-snapshot` 工作区来源。
- 连接、资源、SSE 游标、Interaction 响应、取消和幂等均经过 `/v1` transport。

### RF5. 兼容与错误证据

- contracts 单测覆盖旧/新 JSON 往返、互斥字段和非法来源。
- Local Runtime 单测覆盖新 local source 成功以及 remote source 明确拒绝。
- Remote Fixture 测试覆盖 HTTPS target 握手、Remote Profile 和四组共享场景。
- `pnpm check` 通过；文档只将 P3.6 标记完成，不提前完成 P3.7、P3.8 或 Phase 4。

## 4. 非功能需求

- **安全**：不引入产品侧 TLS 绕过、静态生产 token、长期 Git 凭据或主机路径回退。
- **兼容**：Harness Protocol 保持 `1.0.0`；preview.3 请求保持可解析和可执行。
- **边界**：`packages/testing` 继续只依赖 contracts；Fixture 可以依赖 core、Reference Adapter、SDK 和 testing，
  但 SDK/CLI 不反向依赖 Fixture。
- **确定性**：Fixture 使用可注入时钟和 ID，Reference 场景不访问网络。
- **诚实声明**：Fixture 文件状态只证明协议级重建重放，不证明生产数据库、HA、认证、队列或沙箱。

## 5. 本批范围

- `CreateRunRequest` 的兼容联合与 Local 归一化。
- 私有 Remote Reference Fixture 和其测试控制面。
- SDK 驱动的 Remote Conformance 四场景。
- 相关 contracts、Local Runtime、Fixture 测试与文档状态更新。

## 6. 非目标

- 不新增或实现 `apps/cloud-server`、`apps/cloud-worker`。
- 不定义正式上传、Git preparation、登录、刷新令牌或审计 API。
- 不声明持久化事件重放、跨进程恢复、队列投递或沙箱隔离。
- 不启用 CLI Remote `run`；正式 workspace preparation API 落地前继续 fail closed。
- 不实现真实 Git clone、压缩包解压、恶意文件扫描或对象存储。
- 不将 Fixture 发布到 npm 或加入交付物。
- 不在本批完成 P3.7 的完整安全负例或 P3.8 平台矩阵证据。

## 7. 依赖

- `docs/specs/dual-runtime-compatibility/` Phase 1-3。
- `packages/contracts`、`packages/sdk`、`packages/testing`、`packages/harness-core`。
- `packages/adapter-reference`。
- 后续正式 `apps/cloud-server` 工作区与认证子 Spec。
