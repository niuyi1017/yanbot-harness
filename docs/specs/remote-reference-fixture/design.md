# Remote Reference Fixture 设计

> 状态说明：本文是 P3.6 基线设计。当前 Fixture 的持久化、manifest 与 audit 安全扩展由
> [`remote-reference-safety`](../remote-reference-safety/design.md) 定义；后者在对应部分优先。

## 1. 设计结论

本批用一个私有进程内 Fixture 验证 Remote 公共协议，不建设缩小版生产控制平面。Fixture 通过注入式 `fetch`
接收 `https://remote.reference.test/v1/*` 请求，执行 Bearer token 和 tenant 检查，并使用 Reference Adapter 产生事件。
SDK 看见的仍是标准 Remote target、标准 `/v1` JSON/SSE 和标准 public contracts。

```text
Runtime Conformance Kit (contracts only)
                 │ driver
                 ▼
          HarnessClient (SDK)
                 │ HTTPS URL + injected fetch
                 ▼
      Remote Reference Fixture (private)
        auth / tenant / workspace seed
        session / run / event memory store
                 │
        harness-core managed adapter run
                 │
          Reference Adapter (offline)
```

生产边界没有被模拟成已完成：没有真实 TLS listener、数据库、Redis、队列、对象存储、Git、Worker 或沙箱。Fixture
Runtime Profile 明确声明 `eventReplay.durability = process`。

## 2. `CreateRunRequest` 迁移

公共请求变为两个严格对象的联合，共享 prompt、model、maxTurns、permissionPolicy、configScopes、extensions 和 resume：

```ts
type CreateRunRequest =
  | {
      prompt: string;
      workspaceGrant: string;
      relativeCwd?: string;
      // shared fields
    }
  | {
      prompt: string;
      workspace: WorkspaceSource;
      // shared fields
    };
```

选择联合而不是把三个字段全部改成 optional，再用宽松 refinement，原因是 TypeScript 调用方也应得到“旧形态或新形态，
不能混用”的静态提示。两个对象都保持 `.strict()`；旧 JSON 的默认字段输出保持不变。Harness Protocol 不升级 major，
因为变更是新客户端可选的加法，已有合法请求与响应语义不变。

`WorkspaceSource` 定义移动到请求 Schema 之前，但不改变其 JSON。Local Runtime 在 HTTP 边界完成归一化：

```text
legacy workspaceGrant      -> existing internal Local request
workspace.local-path-grant -> existing internal Local request
workspace.git-ref          -> CAPABILITY_UNSUPPORTED
workspace.uploaded-snapshot-> CAPABILITY_UNSUPPORTED
```

归一化后的内部类型继续要求 `workspaceGrant`，因此 `WorkspaceGrantRegistry`、路径规范化、符号链接边界与持久化逻辑
不需要复制。幂等 fingerprint 基于归一化请求，使同义的新旧 local 表达得到相同内部语义；是否允许同一 idempotency key
跨两种 JSON 表达复用由归一化位置决定，本批选择允许，因为两者授权与执行输入完全相同。

## 3. Fixture 包边界

新增私有包 `packages/remote-reference-fixture`：

- 生产依赖：contracts、adapter-api、adapter-reference、core。
- 开发依赖：SDK、testing、Vitest。
- 不被 SDK、CLI、Local Runtime 或发行构建依赖。
- 不提供可执行 bin，不监听 socket，不发布。

主要测试接口：

```ts
type RemoteReferenceFixture = {
  origin: 'https://remote.reference.test';
  fetch: typeof fetch;
  issueToken(input: { tenantId: string; subjectId: string; expiresAt?: Date }): string;
  prepareSnapshot(input: {
    tenantId: string;
    digest?: `sha256:${string}`;
    cwd?: string;
  }): Extract<WorkspaceSource, { kind: 'uploaded-snapshot' }>;
  close(): Promise<void>;
};
```

这些方法是测试控制面，不是候选产品 API。`prepareSnapshot` 只登记受控虚拟 cwd；不接收客户端绝对路径请求，也不读取
上传内容。默认目录是 Fixture 自己创建的临时目录，关闭时清理。

## 4. 认证与租户

Fixture 生成随机 opaque token，并在内存表保存：

```ts
{
  (tokenDigest, tenantId, subjectId, expiresAt);
}
```

请求只接受 `Authorization: Bearer ...`。表中保存 token 的 SHA-256 摘要而不是明文，比较摘要后构造 principal；缺失、
未知或过期 token 返回 `AUTHENTICATION_FAILED`。所有资源索引与查询都带 tenant ID：

```text
tenantId + sessionId
tenantId + runId
tenantId + interactionRequestId
tenantId + uploadId
```

本批实现这些边界作为正确架构基础；P3.7 再增加专门的攻击负例与脱敏证据。跨租户资源统一按 not found 处理，避免确认
资源存在性。

## 5. 工作区准备与校验

Remote Profile 只声明 `uploaded-snapshot`。创建 Run 时：

1. 请求必须使用新 `workspace` 形态。
2. source.kind 必须是 `uploaded-snapshot`；local path 和 git ref 返回 `CAPABILITY_UNSUPPORTED`。
3. 以 tenant + uploadId 查询已预置快照。
4. 常量时间比较请求 digest 与登记 digest；不匹配返回 `CONFIGURATION_INVALID`。
5. Adapter 仅获得 Fixture 受控目录，公共资源只记录随机 `workspaceRef`，不返回 cwd。

正式上传/Git API、清单验证、大小限制、TTL 与清理由 Phase 4 子 Spec 定义；Fixture 控制面不能成为 SDK 方法。

## 6. 资源与事件执行

Fixture 使用进程内 Map 保存 Session、Run、幂等记录、Interaction 和 Event。创建 Run 的顺序是：

1. tenant 条件下查询 Session 并检查单 Session 活动 Run。
2. 校验工作区和 Adapter/model 输入。
3. 在内存中创建 queued Run 与幂等记录。
4. 用 `createManagedAdapterRun` 启动 Reference Adapter。
5. 后台消费事件；每个事件通过 public Schema，存入 tenant/run 事件列表，并唤醒 SSE subscriber。
6. 根据事件更新 Run 状态和 terminal metadata；Interaction 索引绑定 tenant/run/controller。

取消和 Interaction 响应都通过 `ManagedRunController`。事件流以 SSE `data:` 帧输出；已有事件立即重放，未终止 Run
继续等待新事件，终端事件后关闭。`afterEventId` 必须属于同一 tenant/run，否则返回稳定游标错误。进程关闭时取消活动
controller 并清理临时目录。

Fixture 不实现磁盘持久化，因此重启重放不属于本批证据。

## 7. HTTP 路由与错误

Fixture 只实现 Conformance 所需 `/v1` 路由：

- `GET /v1/health`
- `GET /v1/adapters`
- `GET /v1/models`
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `POST /v1/sessions/:sessionId/runs`
- `GET /v1/runs/:runId`
- `POST /v1/runs/:runId/cancel`
- `GET /v1/runs/:runId/events`
- `POST /v1/interactions/:requestId/responses`

路由器直接返回标准 `Response`，但请求和响应都经过 contracts Schema。错误体使用 `ApiError` 与稳定 Harness error code；
不返回 stack、token、tenant 内部对象或 cwd。`/local/*`、workspace grant 和任何管理端点均不存在。

## 8. Conformance driver

每个公共场景创建独立 Fixture 和 Reference scenario，签发 tenant A token，预置 tenant A snapshot，再通过：

```ts
HarnessClient.connect({
  mode: 'remote',
  origin: fixture.origin,
  tokenProvider: async () => ({ accessToken }),
  fetch: fixture.fetch,
});
```

构建 `RuntimeConformanceDriver`。`createRun` 只添加预置 `workspace` 与公共默认字段，其余方法均委托 SDK。测试直接调用
P3.3 的四个函数，确保 Local/Remote 共享断言。

## 9. 提交与验证顺序

```text
Spec 独立提交
  -> contracts + tests
  -> Local normalization + tests
  -> Remote fixture + SDK Conformance tests
  -> 全仓 check + 文档状态
```

contracts producer 必须先于 Local/Fixture consumer。实现提交可以按上述边界拆分，最终必须运行 `pnpm check`。

## 10. 拒绝方案

- **给 Remote target 增加 HTTP 测试开关**：会弱化产品安全约束；使用 HTTPS URL + 注入 fetch。
- **把 Local Runtime 改名复用为 Remote**：它没有 tenant、远端工作区或 Remote Profile，证明不了目标语义。
- **让 `packages/testing` 依赖 SDK/Adapter**：破坏 contracts-only Conformance 边界。
- **先实现上传 REST API**：在没有正式存储、清单和威胁模型前会冻结错误产品接口；测试控制面直接预置。
- **新建 `apps/cloud-server` 的内存版**：容易被误用为生产起点并虚假推进 Phase 4；Fixture 保持私有包和无 listener。
- **复制四套断言**：无法证明公共语义一致；Remote driver 必须调用现有函数。
