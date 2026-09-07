# M2 Local Runtime 技术设计

## 1. 设计原则

1. **服务边界优先**：HTTP/SSE只表达平台公共语义，不能暴露Adapter实例或厂商SDK类型。
2. **默认拒绝**：认证、Origin、Workspace、权限和Capability存在不确定性时拒绝执行。
3. **先落盘再广播**：事件可见性以持久化成功为前提，保证重放语义。
4. **Run级隔离**：每个活动Run持有独立Adapter Runtime和Abort生命周期，不共享可变凭据状态。
5. **本地不等于可信**：loopback仍可能被恶意网页调用，必须同时使用访问凭据、Origin校验和工作区Grant。
6. **离线可验证**：Reference Adapter是默认端到端实现；真实CodeBuddy状态单独记录。

## 2. 模块结构

```text
apps/local-runtime/
├── src/
│   ├── app.ts                 # Express app factory与路由装配
│   ├── server.ts              # loopback监听、启动描述与关闭流程
│   ├── auth.ts                # Bearer、Cookie、Origin与一次性绑定
│   ├── workspace-grants.ts    # realpath授权与内存Grant
│   ├── run-supervisor.ts      # Run并发、超时、订阅和恢复
│   ├── event-hub.ts           # replay + live SSE订阅
│   ├── local-state-store.ts   # 文件型Store实现
│   ├── redaction.ts           # 日志和持久化脱敏
│   └── adapters.ts            # 注册表及进程内Context Provider
└── test/
    ├── api.test.ts
    ├── auth.test.ts
    ├── workspace-grants.test.ts
    ├── state-store.test.ts
    └── runtime-e2e.test.ts

packages/contracts/            # Local API、Session、Run、Cursor与错误Schema
packages/harness-core/         # ManagedRunController
packages/permission-engine/    # 风险分类与决策链
packages/config-loader/        # 配置层、合并和安全摘要
packages/extension-kit/        # Extension Descriptor与发现
packages/testing/              # Runtime测试客户端、临时状态根和确定性依赖
```

Express只出现在`apps/local-runtime`。公共包不依赖HTTP框架。

## 3. Contracts扩展

新增公共类型均由Zod Schema导出：

```ts
type LocalSession = {
  protocolVersion: '1.0.0';
  sessionId: string;
  adapterId: string;
  adapterSessionId?: string;
  title?: string;
  status: 'idle' | 'running' | 'failed';
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  workspaceRef?: string;
};

type LocalRun = {
  protocolVersion: '1.0.0';
  runId: string;
  sessionId: string;
  adapterId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  prompt: string;
  model?: ModelRef;
  permissionPolicy: PermissionPolicy;
  adapterSessionId?: string;
  firstSequence?: number;
  lastSequence?: number;
  terminalEventType?: 'run.completed' | 'run.failed' | 'run.cancelled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

type LocalApiError = {
  error: HarnessError;
  requestId: string;
};
```

Run创建传输体不允许客户端直接决定`cwd`：

```ts
type CreateLocalRunRequest = {
  prompt: string;
  workspaceGrant: string;
  relativeCwd?: string;
  model?: ModelRef;
  maxTurns?: number;
  permissionPolicy?: PermissionPolicy;
  configScopes?: ConfigScope[];
  extensions?: ExtensionSelection[];
  resume?: boolean;
};
```

Runtime在校验Grant后构造内部`RunRequest`。对现有`RunRequest`的破坏性修改不进入M2；进程内Adapter仍接收已解析的绝对`cwd`。

## 4. HTTP API

所有JSON响应设置`Cache-Control: no-store`。除明确说明外均需认证。

| 方法     | 路径                                       | 用途                                                  |
| -------- | ------------------------------------------ | ----------------------------------------------------- |
| GET      | `/local/health`                            | 无认证的最小健康状态                                  |
| POST     | `/local/auth/exchange`                     | 一次性浏览器Token换HttpOnly Cookie                    |
| POST     | `/local/workspaces/grants`                 | 使用特权Bearer授权目录并返回短期Grant与`workspaceRef` |
| DELETE   | `/local/workspaces/grants/:grantId`        | 撤销Grant                                             |
| GET/POST | `/local/sessions`                          | 列表/创建Session                                      |
| GET      | `/local/sessions/:sessionId`               | Session详情                                           |
| POST     | `/local/sessions/:sessionId/runs`          | 创建或续接Run，返回202                                |
| GET      | `/local/runs/:runId`                       | Run状态                                               |
| POST     | `/local/runs/:runId/cancel`                | 幂等取消                                              |
| GET      | `/local/runs/:runId/events`                | 历史重放与实时SSE                                     |
| POST     | `/local/interactions/:requestId/responses` | 幂等响应Interaction                                   |
| GET      | `/local/adapters`                          | Manifest与Capabilities                                |
| GET      | `/local/models?adapterId=...`              | Adapter模型列表                                       |
| GET      | `/local/config/effective`                  | 脱敏后的有效配置摘要                                  |
| GET      | `/local/extensions`                        | 已发现Descriptor与能力状态                            |

写接口只接受`application/json`并限制body大小。未知字段由Schema拒绝。Workspace Grant签发与撤销属于特权控制接口，只接受父进程、CLI或SDK持有的Bearer，不接受浏览器Cookie单独调用；浏览器只能使用已签发的Grant。HTTP状态约定：Schema错误400、认证失败401、Origin或Workspace拒绝403、不存在404、状态/幂等冲突409、超额429、内部安全失败500、Adapter暂不可用503。

## 5. 认证、Origin与启动描述

### 5.1 Runtime访问Token

- 默认生成至少256 bit随机Token，存活期不超过当前Runtime进程。
- 程序化启动返回内存中的`RuntimeHandle { origin, accessToken, close }`。
- 独立进程模式写入用户数据目录中的临时`runtime.json`，权限为0600，包含PID、origin、过期时间和Token；关闭时删除。该文件不是Session状态，日志不得输出其内容。
- 可由父进程通过专用环境变量注入Token，但环境变量名在文档中公开、值不记录。

### 5.2 浏览器绑定

Runtime内部API可签发`{ token, origin, expiresAt }`。`POST /local/auth/exchange`同时校验Token、精确Origin、TTL和未消费状态，成功后设置随机Cookie会话。Token先标记消费再返回，避免并发重放。

M2只实现协议和测试入口；Local Web如何获得绑定URL在M4确定。

### 5.3 中间件顺序

```text
request-id
→ host/loopback校验
→ body与header限制
→ origin校验
→ bearer/cookie认证
→ schema校验
→ route
→ 统一错误脱敏
```

Host头不能扩大监听边界。CORS不使用通配符，不允许携带凭据的任意Origin。

## 6. Workspace Grant

Workspace Grant使用服务器端内存Registry而非把路径签进Token：

```ts
type WorkspaceGrantRecord = {
  grantId: string;
  secretHash: string;
  workspaceRef: string;
  canonicalRoot: string;
  expiresAt: number;
  revokedAt?: number;
};
```

客户端拿到`grantId.secret`。Registry只保存secret hash，并使用常量时间比较。授权和运行前均调用`realpath`；`relativeCwd`必须是相对路径，解析后的真实目录满足`isWithin(canonicalRoot, resolved)`。前缀字符串比较不可用于路径边界，必须按平台路径段比较并处理大小写规则。

绝对路径仅存在内存和受控debug日志的脱敏形式。Session可保存随机`workspaceRef`用于提示需要重新授权，但Runtime重启后Grant全部失效。

## 7. Managed Run与并发

现有`executeAdapterRun()`会在AsyncIterable结束后释放Runtime，不能让HTTP层并发响应Interaction或取消。M2在`harness-core`新增：

```ts
interface ManagedRunController {
  readonly events: AsyncIterable<AdapterEvent>;
  respond(response: InteractionResponse): Promise<void>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

function createManagedAdapterRun(...): Promise<ManagedRunController>;
```

控制器负责能力一致性校验、事件Schema/ID/sequence/终态约束、Adapter Runtime生命周期和幂等释放。原`executeAdapterRun()`改为消费该控制器，以保持示例兼容。

`RunSupervisor`持有活动controller与Abort/timeout。默认每Session一个活动Run，全局并发4，默认超时30分钟；均可通过启动配置收紧。Run开始流程：

```text
验证请求与幂等键
→ 验证Session/Adapter/Capability
→ 消费Workspace Grant
→ 合并配置并解析Extension
→ 创建queued Run元数据
→ 创建ManagedRunController
→ 标记running
→ 消费事件：校验 → 脱敏持久化 → 更新元数据 → 广播
→ 终态释放controller和并发槽
```

Workspace Grant默认可在TTL内复用，但每次Run都重新校验；可撤销。创建Run失败不消耗幂等键的成功映射。

## 8. Interaction与Permission Engine

Adapter仍是原始权限回调的唯一持有者，Runtime只处理统一`interaction.requested`。事件到达时：

1. 在Run上下文登记`requestId`、kind、到期时间和响应状态。
2. Permission Engine根据公共policy、toolName、risk和脱敏inputSummary计算`allow`、`deny`或`prompt`。
3. `allow`/`deny`立即通过controller响应；`prompt`先落盘并广播给客户端。
4. question永远需要用户答案，除取消/超时外不自动构造答案。

首版规则：

| Policy        | 低风险读取                | 工作区内编辑              | 命令/删除/未知工具 | Question |
| ------------- | ------------------------- | ------------------------- | ------------------ | -------- |
| `read-only`   | Adapter原生允许或平台允许 | deny                      | deny               | prompt   |
| `interactive` | prompt（若Adapter请求）   | prompt                    | prompt             | prompt   |
| `auto-edit`   | allow                     | allow（能证明在授权根内） | prompt             | prompt   |

若脱敏摘要不足以证明路径位于授权根，结果必须是`prompt`或`deny`，不能自动allow。长期方案可为Adapter SPI增加结构化权限上下文，但M2不把CodeBuddy原始输入提升为公共协议。

## 9. SSE与Event Hub

SSE使用Adapter事件的`eventId`作为`id:`，`type`作为`event:`，完整统一事件作为`data:`。订阅时：

1. 从Store读取游标后的完整事件并逐条发送。
2. 在读取期间将新事件暂存到有界订阅队列。
3. 完成历史发送后排空队列，再进入实时模式。

订阅队列溢出时关闭连接并让客户端从最后确认ID重连，不丢弃Run本身。终态事件发送后关闭SSE。心跳使用注释行，不进入Store和sequence。

Store维护eventId到sequence的线性查找首版即可；单Run事件数量设上限。未知或属于其他Run的`Last-Event-ID`返回409，避免错误跳过历史。

## 10. LocalStateStore

目录布局：

```text
<stateRoot>/
├── store.json
└── sessions/<sessionId>/
    ├── session.json
    └── runs/<runId>/
        ├── run.json
        └── events.jsonl
```

每个文件包含`schemaVersion`。JSON元数据写入同目录随机临时文件，设置0600后rename；目录0700。事件append通过每Run Promise队列串行，单行先完成Schema校验和持久化脱敏。

重启恢复：

- 扫描Session/Run元数据并校验ID与目录一致。
- 忽略并截断最后一个不完整JSONL尾行，同时记录脱敏warning。
- 中间非法行或sequence断裂将该Run标记为状态损坏，不继续猜测。
- 对非终态Run追加一个sequence连续的`run.failed`事件，错误码`INTERNAL_ERROR`，并把Run状态设为`interrupted`。
- 不自动恢复执行；用户重新授权Workspace后才能显式创建resume Run。

持久化脱敏删除常见secret/token/password/cookie键，对绝对路径替换为`[WORKSPACE]`或`[REDACTED_PATH]`。Adapter事件原始消息永不写入。

## 11. Config Loader

配置源抽象：

```ts
type ConfigLayer = {
  scope: 'local' | 'user' | 'project' | 'organization' | 'enforced';
  values: JsonObject;
  sourceRef: string;
};
```

合并从低到高依次为local、user、project、organization、enforced。`configScopes`只控制前四层是否参与，enforced永远参与。对象递归合并、数组替换、null tombstone；禁止原型污染键。

结果拆为：

- `adapterConfig`：经过Adapter configSchema校验的非敏感值。
- `extensionSelections`：解析后的Descriptor引用。
- `publicSummary`：仅包含来源、启用项和脱敏状态。
- `credentialRefs`：由进程内Provider解析，不返回HTTP。

## 12. Extension Kit

Descriptor统一包含`extensionId`、kind、version、displayName、source、configSchema、requiredCapabilities和可选credentialRefs。发现器只读取显式根：用户配置目录、授权项目目录和测试fixture。

- MCP：解析配置结构并产出Descriptor，不在M2启动server。
- Skill：解析frontmatter和相对入口，正文仅作为后续Adapter输入资源。
- Agent/Hook：冻结Descriptor Schema，不执行。

运行前比较`requiredCapabilities`与Adapter capabilities。当前CodeBuddy声明extensions为unsupported，因此带这些选择的Run返回`CAPABILITY_UNSUPPORTED`。这保留真实边界并为后续扩展实现提供稳定输入。

## 13. Adapter装配

`createLocalRuntime()`接受Adapter列表与`AdapterContextProvider`。测试默认注入Reference Adapter；生产入口显式注册CodeBuddy Adapter。Provider只从allowlist环境变量或未来安全存储读取凭据，并按Adapter ID返回最小Context。

路由与Supervisor只通过Registry和manifest/capabilities选择Adapter，不允许`if (adapterId === 'cn.tencent.codebuddy')`一类条件分支。

## 14. 复用检查

复用：

- `packages/contracts/src/index.ts`：继续作为跨进程Schema唯一来源。
- `packages/adapter-api/src/index.ts`：Registry、能力校验和Runtime接口。
- `packages/harness-core/src/index.ts`：事件不变量，扩展为ManagedRunController。
- `yanbot-teacher/apps/local-runtime/src/desktop-security.ts`：常量时间比较、工作区授权和默认拒绝经验。
- `yanbot-teacher/apps/local-runtime/src/interaction-manager.ts`：Pending注册先于通知、超时deny和幂等清理经验。

不直接复用：

- 教师端`index.ts`混合了云端Grant、报告工具、ASR、MCP文件编辑和CodeBuddy SDK调用，无法保持业务与厂商边界。
- 教师端允许非desktop模式任意`cwd`，不满足通用Runtime面对恶意网页的安全模型。
- 教师端存在`bypassPermissions`探测路径，公共平台禁止暴露该策略。

## 15. 放弃的方案

### 15.1 直接复制教师端Express入口

放弃原因：入口包含大量教师业务、云端API和厂商消息处理，复制会把已建立的Adapter隔离重新打破。

### 15.2 使用WebSocket承载所有运行事件

放弃原因：M2主要是服务端单向事件流，SSE天然支持HTTP认证、断线游标和调试；双向Interaction使用普通HTTP即可。终端/语音等真正双向流留给后续独立协议。

### 15.3 首版引入SQLite

放弃原因：M2数据量和查询模式简单，版本化JSON/JSONL更易审计和跨平台打包；Store接口保留后续替换能力。

### 15.4 把Workspace路径签入自包含JWT

放弃原因：路径会暴露给客户端和日志，撤销困难。使用服务端内存Registry和opaque token更容易过期、撤销和隐藏路径。

### 15.5 在Runtime中直接调用CodeBuddy SDK

放弃原因：这会让厂商类型、认证和权限语义泄漏到Local API，并阻止Reference/Future Adapter无代码切换。

## 16. 验证策略

- contracts：Schema往返、未知字段、状态转换和错误Envelope。
- core：ManagedRun成功、失败、Interaction、取消、事件乱序和重复释放。
- security：Origin、Bearer/Cookie、一次性Token竞态、Host、TTL和常量时间路径。
- workspace：`..`、绝对relativeCwd、符号链接、撤销、过期和重启失效。
- state：原子元数据、并行append、尾行恢复、中间损坏、重启中断和脱敏扫描。
- API E2E：Reference Adapter覆盖创建Session/Run、SSE重放、Interaction、取消和resume。
- CodeBuddy：普通CI只使用现有fixture/facade；真实探针继续pending，提供显式凭据后单独执行。
