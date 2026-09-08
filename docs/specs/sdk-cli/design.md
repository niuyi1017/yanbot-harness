# M3 TypeScript SDK 与 CLI 技术设计

## 1. 设计原则

1. **协议客户端而非内部门面**：SDK 只依赖公开 contracts 和 HTTP/SSE，不导入 Runtime、Adapter 或厂商实现。
2. **一种语义，多种连接来源**：显式端点、嵌入式 handle 和 daemon 描述文件最终都产生同一个 `HarnessClient`。
3. **机器输出稳定**：CLI 的 JSONL stdout 只输出结构化记录，诊断信息进入 stderr。
4. **默认不放权**：交互确认必须来自用户或调用方，CLI 不提供权限绕过选项。
5. **凭据最少暴露**：不提供命令行 token 参数；优先从专用环境变量或 mode-0600 daemon 描述文件获取。

## 2. 模块结构

```text
packages/sdk/
├── src/
│   ├── index.ts              # 稳定公共导出
│   ├── client.ts             # HarnessClient 与高层 RunHandle
│   ├── transport.ts          # fetch、错误映射与 SSE 解析
│   └── daemon.ts             # runtime.json 安全发现
└── test/
    ├── client.test.ts
    └── daemon.test.ts

apps/cli/
├── src/
│   ├── index.ts              # 可测试的 runCli
│   ├── main.ts               # bin 入口
│   ├── arguments.ts          # 无副作用参数解析
│   ├── output.ts             # text/JSONL renderer
│   └── interactions.ts       # TTY 权限与问题响应
└── test/cli-e2e.test.ts

examples/sdk-basic/src/index.ts
```

## 3. SDK 公共 API

```ts
type HarnessClientOptions = {
  origin: string;
  accessToken: string;
  fetch?: typeof fetch;
};

class HarnessClient {
  static connect(options: HarnessClientOptions): HarnessClient;
  static fromRuntime(handle: { origin: string; accessToken: string }): HarnessClient;
  static fromDaemon(options?: { descriptorPath?: string; env?: NodeJS.ProcessEnv }): Promise<HarnessClient>;

  health(): Promise<RuntimeHealth>;
  grantWorkspace(input: CreateWorkspaceGrantRequest): Promise<WorkspaceGrant>;
  revokeWorkspaceGrant(grantId: string): Promise<void>;
  createSession(input: CreateLocalSessionRequest): Promise<LocalSession>;
  listSessions(): Promise<LocalSession[]>;
  getSession(sessionId: string): Promise<LocalSession>;
  createRun(sessionId: string, input: CreateLocalRunRequest, options?: { idempotencyKey?: string }): Promise<RunHandle>;
  getRun(runId: string): Promise<LocalRun>;
  cancelRun(runId: string, reason?: string): Promise<LocalRun>;
  respondToInteraction(response: InteractionResponse): Promise<void>;
  events(runId: string, options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent>;
  listAdapters(): Promise<AdapterSummary[]>;
  listModels(adapterId: string): Promise<ModelDescriptor[]>;
  getEffectiveConfig(scopes?: ConfigScope[]): Promise<PublicConfigSummary>;
  listExtensions(adapterId?: string): Promise<ExtensionSummary[]>;
}

class RunHandle {
  readonly run: LocalRun;
  events(options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent>;
  refresh(): Promise<LocalRun>;
  cancel(reason?: string): Promise<LocalRun>;
  respond(response: InteractionResponse): Promise<void>;
}
```

传入的 origin 必须是 HTTP(S) URL；daemon 模式额外强制 loopback。SDK 使用 contracts schema 校验所有核心响应。M2 尚未为 health、adapter/config/extension 列表提供公共 schema 的部分，在 M3 补充到 contracts，确保 SDK 不以类型断言信任网络数据。

`HarnessSdkError` 包含 `kind`、可选 HTTP status、requestId 和标准 Harness error。错误消息只使用服务端已脱敏的标准 message；非标准响应使用固定文案。

## 4. SSE 与取消

解析器按空行切分记录，接受 LF/CRLF、多个 `data:` 行与 `:` 注释。每条数据经过 `adapterEventSchema` 验证，并校验 URL 对应的 runId。`afterEventId` 同时通过查询参数传递，避免部分 fetch 实现限制 `Last-Event-ID`。

调用方 AbortSignal 立即中断 fetch/reader。首版不在未知网络错误后自动无限重连；调用方可使用最后收到的 eventId 显式续订，从而避免在认证失败、协议损坏或终态后形成隐藏重试。

## 5. daemon 发现与凭据顺序

CLI/SDK 的连接优先级为：

1. 显式 `--runtime <origin>` + `YANBOT_HARNESS_ACCESS_TOKEN`。
2. 显式 `--descriptor <path>`。
3. `YANBOT_HARNESS_RUNTIME_DESCRIPTOR` 指向的描述文件。
4. `~/.yanbot-harness/runtime.json`。

不支持 `--token`，避免 token 出现在 shell history 和进程列表。描述文件校验 `schemaVersion`、PID、origin、accessToken、expiresAt；在 POSIX 上拒绝 group/other 可读写权限。连接后仍调用 `/local/health`，陈旧描述文件给出可操作错误。

嵌入式 Runtime 由宿主启动并把 `{ origin, accessToken }` 交给 `HarnessClient.fromRuntime()`；SDK 不承担 Adapter 装配，保持厂商隔离。

## 6. CLI 命令

```text
yanbot-harness run <prompt> [--adapter ID] [--session ID] [--workspace PATH]
                           [--cwd RELATIVE] [--model ID] [--permission POLICY]
                           [--config-scope SCOPE]... [--resume] [--json]
yanbot-harness adapters [--json]
yanbot-harness models --adapter ID [--json]
yanbot-harness sessions [--json]
yanbot-harness run-status <run-id> [--json]
yanbot-harness cancel <run-id> [--reason TEXT] [--json]
```

`run` 未提供 Session 时创建 Session；提供 Session 时沿用其 Adapter。默认 workspace 为当前目录，默认权限为 `interactive`。`--model` 可接受 modelId，SDK 请求中与选定 adapter 组合为 ModelRef。

文本模式仅把 output channel 的 delta 写到 stdout，工具、usage 和状态使用简短 stderr 行。TTY 遇到 permission/question 时读取用户输入并调用 SDK 响应。JSONL 模式逐事件原样输出，不读取交互输入；若事件要求交互则以专用退出码结束，Run 保持可由另一客户端响应，不隐式取消或批准。

退出码：`0` 成功，`2` 用法错误，`10` 取消，`11` 权限/交互未处理，`20` 认证，`30` Adapter/上游失败，`40` Runtime/网络/协议错误。

## 7. 测试与打包

- SDK 单元测试使用受控 fetch 测错误、schema 和 SSE 边界。
- SDK 黑盒测试启动 `startLocalRuntime()` + Reference Adapter，验证 grant/session/run/events/cancel/interaction。
- CLI E2E 通过构建后的 bin 子进程连接同一真实 loopback Runtime，分别断言 text 和 JSONL 输出。
- `packages/sdk` 的生产依赖只有 contracts；`apps/cli` 的生产依赖只有 sdk。
- 包边界脚本新增 CLI/SDK 厂商依赖门禁及 CLI 直接访问 Runtime 内部包门禁。

## 8. 复用检查

- 复用 `packages/testing/src/index.ts` 中已验证的 HTTP/SSE 行为作为实现参考，但不从生产 SDK 依赖 testing 包。
- 复用 `apps/local-runtime/src/server.ts` 的 descriptor 字段和 M2 contracts；仅将缺失的响应 schema 提升到 contracts。
- 复用 Reference Adapter 作为离线黑盒依赖，不新增专为 CLI 设计的假协议。
- 不复用 `examples/sdk-basic` 当前的进程内 Adapter 示例，因为它绕过了 M2 Runtime，不能代表第三方客户端边界；该示例会改写为仅使用 SDK。

## 9. 为什么不这样做

### CLI 直接导入 CodeBuddy 或 Reference Adapter

这会绕过 Local Runtime 的认证、Workspace Grant、持久化和统一权限语义，也会让 CLI 随厂商 SDK 升级而变化，因此禁止。

### SDK 直接读取 Runtime 状态文件或调用 Supervisor

状态文件不是公共 API，直接读取会破坏并发与重启语义。除启动 descriptor 外，所有操作必须走 HTTP/SSE。

### 在 CLI 参数中接受访问令牌

命令行参数可能进入 shell history 和系统进程列表。M3 只允许环境变量或安全 descriptor。

### JSONL 模式自动批准 Interaction

机器输出不代表调用方授权。自动批准会把无头执行变成隐式权限绕过，因此遇到 Interaction 必须由外部客户端显式响应或退出等待。
