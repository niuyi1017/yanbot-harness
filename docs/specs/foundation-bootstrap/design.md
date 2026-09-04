# Foundation Bootstrap 技术设计

## 1. 实施边界

本阶段建立“可验证的协议内核”，不建立完整产品应用。仓库中可以出现用于冒烟的开发脚本和示例，但不能提前创建空壳Web、Electron、Admin或Cloud应用。

## 2. 初始目录

```text
yanbot-harness/
├── docs/
│   ├── architecture/
│   │   ├── adapter-protocol.md
│   │   └── codebuddy-capability-matrix.md
│   └── specs/
├── examples/
│   └── sdk-basic/
├── packages/
│   ├── contracts/
│   ├── harness-core/
│   ├── adapter-api/
│   ├── adapter-kit/
│   ├── adapter-reference/
│   ├── adapter-codebuddy/
│   ├── adapter-sidecar/
│   └── testing/
├── scripts/
│   ├── check-package-boundaries.mjs
│   └── smoke-codebuddy.mjs
├── .github/workflows/ci.yml
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── eslint.config.mjs
├── .prettierrc.json
├── .gitignore
├── .nvmrc
└── README.md
```

`adapter-sidecar` 本阶段只包含协议Schema和兼容校验，不包含child_process、进程监管或真实Harness桥接。

## 3. 包依赖方向

```text
contracts
   ▲
   ├──────── adapter-api
   │              ▲
   │              ├── adapter-kit ── testing
   │              ├── adapter-reference
   │              ├── adapter-codebuddy ── @tencent-ai/agent-sdk
   │              └── adapter-sidecar (schemas only)
   │
   └──────── harness-core

examples/sdk-basic ── harness-core + adapter-reference
```

规则：

- `contracts`不依赖其他workspace包。
- `adapter-api`只依赖`contracts`。
- `harness-core`只依赖`contracts`和`adapter-api`。
- `adapter-kit`只依赖公共包，不依赖具体Adapter。
- 只有`adapter-codebuddy`可以依赖`@tencent-ai/agent-sdk`。
- `testing`提供fixtures和测试工具，生产包不得反向依赖它。

## 4. 工具链

### 4.1 版本

```json
{
  "engines": { "node": "22.22.0" },
  "packageManager": "pnpm@11.10.0"
}
```

- TypeScript统一为5.9.3，模块配置使用`NodeNext`。
- package源码为ESM，相对导入在TypeScript源码中使用`.js`后缀。
- 每个包输出`dist/*.js`和`dist/*.d.ts`，通过`exports`公开。
- 默认不生成或发布source map；开发调试如需启用须确认不包含敏感源码路径。
- 根脚本使用`pnpm -r --if-present`，不引入额外任务编排器。

### 4.2 根命令

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:boundaries
pnpm smoke:codebuddy   # 显式执行，默认CI不运行
```

## 5. 标识与版本规则

- `protocolVersion`使用SemVer字符串，首版为`1.0.0`。
- `adapterId`使用反向域名或组织命名空间形式，首批为：
  - `cn.yanbot.reference`
  - `cn.tencent.codebuddy`
- `modelRef`在传输层使用对象而不是拼接字符串：

```ts
type ModelRef = {
  adapterId: string;
  modelId: string;
};
```

- 平台Session ID和Run ID使用UUID。
- Adapter内部Session ID作为opaque string，仅由对应Adapter解释。
- Event的`sequence`在单个Run内从1开始严格递增。

## 6. 公共Schema

### 6.1 Adapter Manifest

```ts
type AdapterManifest = {
  protocolVersion: string;
  adapterId: string;
  adapterVersion: string;
  displayName: string;
  harness: {
    name: string;
    version?: string;
  };
  runtimeKinds: Array<'in-process' | 'sidecar' | 'remote'>;
  configSchema?: Record<string, unknown>;
};
```

Manifest中的配置Schema不得包含真实配置值。

### 6.2 Capability

```ts
type CapabilityLevel = 'native' | 'emulated' | 'unsupported';

type CapabilitySupport = {
  level: CapabilityLevel;
  version?: string;
  limits?: Record<string, string | number | boolean>;
  reason?: string;
};

type HarnessCapabilities = Record<CapabilityId, CapabilitySupport>;
```

首版Capability ID：

```text
sessions.resume
runs.cancel
streaming.text
streaming.tool-events
interactions.permissions
interactions.questions
extensions.mcp
extensions.skills
extensions.agents
extensions.hooks
workspace.worktrees
workspace.sandbox
models.list
usage.tokens
usage.cost
computer-use
```

Capability ID使用kebab-case分段，不使用某个Harness的功能名称。

### 6.3 Run输入

```ts
type RunRequest = {
  runId: string;
  sessionId: string;
  adapterSessionId?: string;
  prompt: string;
  cwd?: string;
  model?: ModelRef;
  maxTurns?: number;
  permissionPolicy: 'interactive' | 'auto-edit' | 'read-only';
  configScopes: Array<'user' | 'organization' | 'project' | 'local'>;
  extensions?: ExtensionSelection[];
};

type AdapterRunInput = RunRequest & {
  abortSignal?: AbortSignal;
};
```

`organization`是平台配置作用域。CodeBuddy不直接支持时，由配置层解析后把结果传给Adapter，不能将该字符串直接写入`settingSources`。

`RunRequest`属于contracts，必须可JSON序列化；`AbortSignal`只存在于进程内`adapter-api`调用上下文，不进入contracts、持久化或Sidecar协议。Sidecar取消统一使用独立的`cancel`请求。

### 6.4 Event Envelope

```ts
type AdapterEvent<TType extends string, TPayload> = {
  protocolVersion: '1.0.0';
  eventId: string;
  runId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: TType;
  payload: TPayload;
  adapterMetadata?: Record<string, unknown>;
};
```

首版事件：

- `run.started`
- `session.initialized`
- `assistant.delta`
- `assistant.message`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `interaction.requested`
- `interaction.resolved`
- `usage.updated`
- `run.completed`
- `run.failed`
- `run.cancelled`

规则：

- 每个Run必须以`run.started`开始，以一个且仅一个最终事件结束。
- `assistant.delta`可以不存在；Adapter可只提供完整消息。
- Tool ID缺失时Adapter生成稳定的Run内ID。
- 原始消息不得整个放进`adapterMetadata`。
- 时间使用UTC ISO 8601。

### 6.5 Interaction

```ts
type InteractionRequest =
  | {
      kind: 'permission';
      requestId: string;
      toolName: string;
      risk: 'low' | 'medium' | 'high';
      inputSummary?: Record<string, unknown>;
    }
  | {
      kind: 'question';
      requestId: string;
      questions: Array<{
        id: string;
        prompt: string;
        options?: Array<{ label: string; value: string }>;
        multiple?: boolean;
      }>;
    };
```

响应以`requestId`幂等关联。重复响应返回原结果，不重复调用厂商回调。

### 6.6 Error

首版稳定错误码：

```text
ADAPTER_UNAVAILABLE
ADAPTER_INCOMPATIBLE
CAPABILITY_UNSUPPORTED
AUTHENTICATION_FAILED
CONFIGURATION_INVALID
PERMISSION_DENIED
INTERACTION_EXPIRED
RUN_CANCELLED
RUN_TIMEOUT
HARNESS_FAILED
HARNESS_PROTOCOL_ERROR
INTERNAL_ERROR
```

厂商异常先在Adapter内部分类，公共错误包含可安全展示的message、retryable和可选adapterCode，不包含堆栈、凭据或原始响应。

## 7. Adapter SPI

```ts
interface HarnessAdapter {
  readonly manifest: AdapterManifest;

  probe(context: ProbeContext): Promise<AdapterProbeResult>;
  createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime>;
}

interface AdapterRuntime {
  capabilities(): Promise<HarnessCapabilities>;
  listModels?(input?: ListModelsInput): Promise<ModelDescriptor[]>;
  startRun(input: AdapterRunInput): AsyncIterable<AdapterEvent>;
  resumeRun?(input: AdapterRunInput & { adapterSessionId: string }): AsyncIterable<AdapterEvent>;
  respondToInteraction?(input: InteractionResponse): Promise<void>;
  cancel(input: { runId: string; reason?: string }): Promise<void>;
  dispose(): Promise<void>;
}
```

约束：

- `probe()`只检查版本、可执行文件和认证可用性，不执行计费模型请求。
- `createRuntime()`失败不能留下SDK子进程。
- 可选方法与Capability声明必须一致。
- `cancel()`至少终止事件生产并产生`run.cancelled`；底层是否硬中断记录在Capability limits。
- `dispose()`可重复调用。
- 一个Runtime可否并行执行多个Run由Capability limits声明，核心默认串行。

## 8. Reference Adapter

Reference Adapter接受确定性Scenario：

```ts
type ReferenceScenario =
  | { kind: 'text'; chunks: string[] }
  | { kind: 'tool'; toolName: string; result: unknown }
  | { kind: 'permission'; allowResult: string }
  | { kind: 'question'; answerResult: string }
  | { kind: 'failure'; code: HarnessErrorCode }
  | { kind: 'wait-for-cancel' };
```

- 使用注入的clock和ID generator，避免测试依赖真实时间和随机UUID。
- 默认不访问文件系统和网络。
- 可记录收到的输入供断言，但测试结束后释放引用。
- Reference Adapter不是Mock某一家厂商，而是公共协议的可执行参考实现。

## 9. CodeBuddy Adapter映射

### 9.1 运行映射

| Harness概念 | CodeBuddy SDK |
|---|---|
| startRun | `query({ prompt, options })` |
| adapterSessionId | `system/init.session_id` |
| resumeRun | `options.resume` |
| cancel | `AbortController`及Query interrupt能力，以实测为准 |
| text stream | `stream_event.event.delta.text_delta` |
| final text | `assistant.message.content[text]` |
| tool start | `assistant.message.content[tool_use]` |
| tool result | 顶层或嵌入式`tool_result` |
| usage/cost | `result`消息字段，以能力矩阵记录 |
| models.list | `unstable_v2_createSession().getAvailableModels()`，标记不稳定 |

### 9.2 权限映射

| 公共策略 | CodeBuddy权限模式 |
|---|---|
| `interactive` | `default` + `canUseTool` |
| `auto-edit` | `acceptEdits`，仍受平台高风险规则约束 |
| `read-only` | `plan`并追加工具允许/禁止策略 |

公共协议不提供`bypassPermissions`。真实冒烟可以在完全隔离fixture中通过内部测试选项使用，但该选项不得进入公开Schema。

### 9.3 配置映射

- `user`、`project`、`local`可在策略允许时映射为CodeBuddy `settingSources`。
- `organization`先由平台配置层解析为显式MCP、Agent、Hook和规则，再传给Adapter。
- 默认`settingSources: []`，防止用户机器历史配置影响确定性测试。
- CodeBuddy环境变量通过allowlist构造，不透传整个`process.env`。

### 9.4 消息归一化

- 先处理assistant消息中的嵌入式`tool_result`，再处理文本和tool_use。
- 对已见过的tool ID去重。
- 没有明确tool_result但Run结束时，将仍在运行的tool统一结算为未知或失败，不静默遗留。
- `result.is_error`映射为`run.failed`，否则映射为`run.completed`。
- AsyncIterable自然结束但没有result时，标记`HARNESS_PROTOCOL_ERROR`，不能伪装成功。

## 10. Capability Matrix

`docs/architecture/codebuddy-capability-matrix.md`至少包含：

| 能力 | 官方文档 | Fixture | 真实冒烟 | 支持级别 | 限制/备注 |
|---|---|---|---|---|---|

每项状态只能是：未验证、通过、部分通过、失败。能力支持级别只有在真实冒烟或明确无需网络的本地验证后才能标为`native`。

## 11. Sidecar协议设计

本阶段在`adapter-sidecar`中定义：

- JSON-RPC 2.0请求：`initialize`、`probe`、`capabilities`、`listModels`、`startRun`、`resumeRun`、`respondToInteraction`、`cancel`、`shutdown`。
- 通知：`event`、`log`。
- `initialize`完成版本协商，失败返回`ADAPTER_INCOMPATIBLE`。
- stdout只允许协议JSONL；stderr用于脱敏诊断。
- Schema测试覆盖未知字段、未知方法、破坏性版本和乱序事件。

不实现child_process，不发布可执行Sidecar，也不声称已兼容DeepSeek或Pi。

## 12. CI设计

GitHub Actions在push和PR执行：

1. Corepack启用固定pnpm。
2. Node 22.22.0。
3. `pnpm install --frozen-lockfile`。
4. `pnpm format:check`。
5. `pnpm lint`。
6. `pnpm check:boundaries`。
7. `pnpm typecheck`。
8. `pnpm test`。
9. `pnpm build`。
10. Secret与禁止文件检查。

CI不配置CodeBuddy Key，不执行真实冒烟。冒烟结果由受控环境执行后，将不含敏感信息的摘要更新到能力矩阵。

## 13. 复用与重写决策

### 13.1 可参考重写

- `yanbot-teacher/apps/local-runtime/src/index.ts`中的query选项和消息循环。
- `sdk-tool-events.ts`中的嵌入式tool_result识别。
- `interaction-manager.ts`中的超时和单次完成语义。

### 13.2 不直接复制

- 教师Workflow判断、报告MCP和服务端业务调用。
- 教师端contracts中的账号、报告和考研Schema。
- 中文业务错误文案和默认System Prompt。
- `permissionMode || 'default'`等未经公共策略解析的直通逻辑。

## 14. 被放弃的方案

### 14.1 先复制教师端Runtime再删除业务代码

业务分支与通用消息循环交织，删除式迁移容易残留隐式约束。本阶段从公共协议开始，以小函数参考重写。

### 14.2 公共SDK直接导出CodeBuddy消息

会让所有消费者跟随Preview API变更，违背Adapter目标。

### 14.3 现在实现DeepSeek、Pi和Sidecar运行时

会在核心协议尚未通过CodeBuddy验证前扩大变量。首期只实现CodeBuddy和Reference Adapter。

### 14.4 默认允许全部工具

不符合本地和云端安全边界。公共默认策略固定为`interactive`。

## 15. 后续衔接

完成本阶段后进入M2 `local-runtime-foundation` 子Spec。M2只能使用本阶段公开exports；若需要修改协议，先更新本Spec和兼容版本说明。
