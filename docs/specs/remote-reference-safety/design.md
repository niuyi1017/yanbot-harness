# Remote Reference 安全负例设计

## 1. 总体方案

本阶段在现有私有 Fixture 内增加三个正交组件：`FixtureStateStore`、`WorkspaceManifestValidator` 和结构化
`AuditRecorder`。HTTP dispatch、Reference Adapter 与公共 SDK/Conformance 路径保持不变。

```text
SDK Remote target
      │ HTTPS semantic fetch
      ▼
auth -> tenant-scoped dispatch -> FixtureStateStore -> atomic state.json
                    │                    │
                    │                    └─ completed events survive reconstruction
                    ├─ WorkspaceManifestValidator
                    ├─ harness-core / Reference Adapter
                    └─ AuditRecorder (allowlisted metadata only)
```

Fixture 仍无网络 listener、数据库、队列、对象存储或沙箱。测试提供的 `stateRoot` 只用于验证公共资源与事件跨实例恢复，
不能作为生产存储设计承诺。

## 2. 持久化模型

新增 `src/state-store.ts`，文件 Schema 固定为：

```ts
type PersistedFixtureStateV1 = {
  schemaVersion: 1;
  sessions: Array<{ tenantId: string; session: Session }>;
  runs: Array<{ tenantId: string; run: Run; events: AdapterEvent[] }>;
  snapshots: Array<{
    tenantId: string;
    uploadId: string;
    digest: string;
    workspaceRef: string;
  }>;
  idempotency: Array<{
    tenantId: string;
    sessionId: string;
    key: string;
    fingerprint: string;
    runId: string;
  }>;
};
```

不持久化 token、token digest、subject、controller、Interaction pending 状态、waiter、audit entry、cwd 或 HTTP 数据。
Snapshot cwd 由当前 Fixture 的受控 workspace 目录重建。只有 terminal Run 作为跨实例 replay 验收对象；若加载到非 terminal
Run，状态转为 `interrupted`、Session 回到 idle，并保留已有事件供诊断，不尝试伪恢复 controller。

`FixtureStateStore` 初始化时完整读取并严格校验：顶层版本与字段、tenant ID、所有 public Schema、事件 run/session 归属、
sequence 连续、最多一个终端且终端最后、资源引用存在。任一失败导致 Fixture 创建失败，不能跳过坏记录。

每次变更建立不可变快照并进入串行写队列：在 state root 内写 mode-0600 唯一临时文件，`rename` 覆盖正式文件；失败向上
传播。事件消费顺序是 `validate -> update memory -> await persist -> notify SSE`。调用方提供的 root 永不由 Fixture 删除；
Fixture 自建 root 在 `close()` 后删除。

## 3. 工作区 manifest

新增 `src/workspace-manifest.ts`，定义测试专用版本化清单：

```ts
type RemoteWorkspaceManifest = {
  schemaVersion: 1;
  entries: Array<
    | { path: string; type: 'directory' }
    | { path: string; type: 'file'; size: number; sha256: string; executable: boolean }
  >;
};
```

默认空 manifest 合法。限制冻结为：10,000 entries、64 MiB expanded total、16 MiB per file、1,024 UTF-8 path bytes。
算法沿用 `packages/runtime/lib/inventory.mjs` 和 `archive.mjs` 的成熟规则：POSIX 相对路径、跨平台保留名、NFC + lowercase
碰撞键、父目录先出现、严格字典序、普通 file/directory、精确字段和 SHA-256。由于 runtime 模块是发行包内部 `.mjs`，
其限制面向已签名 Runtime archive，直接依赖会让测试 fixture 与发行载荷耦合，因此在 Fixture 内实现同规则的更小类型化
验证器，并用攻击用例锁定行为。

accepted manifest 被规范序列化为 `JSON.stringify(value) + '\n'`，workspace digest 为完整 canonical bytes 的 SHA-256。
`prepareSnapshot` 可选接收 expected digest；不匹配时拒绝。Fixture 不解压或写入条目，因此此验证只证明 preparation metadata
的 fail-closed 语义，不证明真实 archive extraction。

## 4. Tenant 与 token 负例

内存 Map 继续使用长度前缀的 `tenant + resource ID` 复合键。测试矩阵覆盖：

| 资源        | tenant B 操作            | 预期                          |
| ----------- | ------------------------ | ----------------------------- |
| Session     | get                      | 与不存在资源相同 404          |
| Run         | get/cancel               | 与不存在资源相同 404          |
| Event       | subscribe/foreign cursor | 与不存在资源相同 404          |
| Interaction | respond                  | 与不存在 interaction 相同拒绝 |
| Snapshot    | create Run               | 与不存在 snapshot 相同 404    |

`#authenticate` 在每个请求执行，不能依赖 SDK 已完成 health negotiation。测试使用可变时钟：token 在 health 时有效，随后推进
到 expiry，现有 client 的下一请求收到 401。token 表不进入 `FixtureStateStore`。

## 5. 结构化审计与脱敏

新增只读测试控制方法 `auditEntries()`，返回冻结副本：

```ts
type RemoteReferenceAuditEntry = {
  timestamp: string;
  requestId: string;
  action:
    | 'runtime.health'
    | 'adapter.list'
    | 'model.list'
    | 'session.create'
    | 'session.list'
    | 'session.get'
    | 'run.create'
    | 'run.get'
    | 'run.cancel'
    | 'run.events'
    | 'interaction.respond'
    | 'workspace.prepare'
    | 'route.unknown';
  outcome: 'succeeded' | 'rejected' | 'failed';
  status: number;
  errorCode?: HarnessErrorCode;
};
```

HTTP router 改为 `route -> dispatch -> audit`：action 在解析任何 body 前只由 method + pathname 模板映射，绝不保存原 URL
或资源 ID；响应完成后记录 status/error code。`prepareSnapshot` 同样只记录固定 action 与结果。未知异常写 `failed/500`，但
不写异常 message/stack。

这是 allowlist 记录，不做“先记录敏感内容再替换”的 redaction。安全测试仍使用 token、Authorization 字符串、绝对路径、
credential marker、恶意 manifest 路径和 prompt secret 搜索 audit JSON，作为无敏感数据证据。

## 6. 错误分类

- expired/missing token：`401 AUTHENTICATION_FAILED`。
- foreign/missing Session、Run、Event、Snapshot：`404 HARNESS_FAILED`，通用不存在文案。
- foreign/missing Interaction：统一 `404 HARNESS_FAILED`。
- invalid workspace manifest/digest：测试控制面 `RemoteFixturePreparationError`，code 为
  `CONFIGURATION_INVALID`，message 为固定通用文案。
- corrupted persisted state：Fixture 创建直接抛出 `RemoteFixtureStateError`，不启动部分状态。
- persistence write failure：当前请求/事件失败，不把未持久化事件发布为 durable。

错误 body、audit 和状态文件均不得包含攻击输入原文。

## 7. 关键文件

- `packages/remote-reference-fixture/src/index.ts`：生命周期、HTTP dispatch、tenant 与 Adapter 编排。
- `packages/remote-reference-fixture/src/state-store.ts`：严格状态加载与原子持久化。
- `packages/remote-reference-fixture/src/workspace-manifest.ts`：manifest Schema、限制与 digest。
- `packages/remote-reference-fixture/test/security.test.ts`：五类 P3.7 负例与重建证据。
- `docs/specs/dual-runtime-compatibility/tasks.md`：P3.7 状态。

## 8. 实施顺序

```text
Spec 独立提交
  -> manifest validator + unit attacks
  -> state store + restart replay
  -> router audit refactor
  -> tenant/token/log integrated negatives
  -> existing Conformance + full pnpm check
```

如果实现发现需要改变 SDK public API、公开 workspace preparation API 或生产 retention 语义，必须停止并另立 Phase 4 Spec；
本批不得自行冻结这些产品接口。

## 9. 拒绝方案

- **用 Local state store 直接复用**：它位于 app 内、绑定 Local 数据模型与路径语义；跨 app 私有导入会反转边界。
- **依赖 runtime archive 内部 `.mjs`**：会把测试 Fixture 绑到发行载荷实现与 512 MiB 限制；采用相同安全规则的专用小验证器。
- **持久化 raw token 以便重启**：扩大泄漏面且不属于 replay 必需状态；重启后测试重新签发 token。
- **记录完整 URL/body 后正则脱敏**：容易遗漏未知字段；固定 action/status allowlist 从源头不采集敏感数据。
- **把内存 Map 序列化后直接信任加载**：损坏状态会突破 Schema 与 tenant 假设；加载必须完整验证并 fail closed。
- **把 Fixture durable 标成生产 durable**：文件重建测试只完成 P3.7 协议证据，Phase 4 仍需数据库、retention 和 HA 设计。
