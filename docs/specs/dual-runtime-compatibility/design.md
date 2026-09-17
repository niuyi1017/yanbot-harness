# Local / Remote Runtime 双形态兼容设计

总体进程、协议、凭据和Adapter装载边界以
[`docs/architecture/system-architecture.md`](../../architecture/system-architecture.md) 为准；本 Spec 只细化 Local/Remote
协议兼容与迁移，不重新定义厂商接入层。

## 1. 设计结论

平台采用“一套客户端协议，两类执行后端”。Local 与 Remote 不共享部署安全边界，但共享资源语义和 SDK/CLI
调用面。Remote 不是把 Local Runtime 换成公网监听地址，而是由远端网关/控制平面、持久化层、队列、Worker
与隔离沙箱共同实现同一 Harness 协议。

```text
CLI / SDK / Local Web / Electron
              │
      Connection Resolver
              │
      HarnessClient + contracts
              │
      ┌───────┴────────┐
      │                │
Local Runtime      Remote API / Control Plane
loopback token     HTTPS + user/device auth + tenant
local path grant           │
file state             queue + event store
      │                    │
      │                Cloud Worker
      │                isolated sandbox
      └──── adapter-api ───┘
                 │
        CodeBuddy / future adapters
```

## 2. 客户端连接模型

目标公共配置使用可判别联合，避免由 URL 形态猜测运行位置：

```ts
type RuntimeTarget =
  | { mode: 'local-daemon'; descriptorPath?: string }
  | { mode: 'local-managed'; executablePath?: string; environment?: Record<string, string> }
  | { mode: 'remote'; origin: string; tokenProvider: AccessTokenProvider };

type AccessTokenProvider = () => Promise<{ accessToken: string; expiresAt?: string }>;
```

`HarnessClient.connect(target)` 解析连接并完成 health/capability 握手。现有 `fromDaemon()`、`fromRuntime()` 和
`startManagedRuntime()` 保留为 Local 便捷入口；现有 `{ origin, accessToken }` 在 Preview 迁移期继续可用，但不作为
远端长期令牌设计。CLI 使用互斥 target/profile，并把认证令牌放在安全配置或登录缓存中，不提供 `--token`。

安装层依据已确认的 [`unified-local-distribution`](../unified-local-distribution/design.md)：local facade 默认注入已装
Runtime resolver，SDK 本身保持无 Runtime 依赖。上面的 target 类型为语义草图，`local-managed` 实现必须复用
`startManagedRuntime` 的 resolver、就绪与关闭所有权，调用方可获取/释放 managed handle，不能只得到无清理入口的
client。`connect(remote)` 不解析本地平台包，不启动本地进程。统一安装可独立开发，无需等待远端服务。

### 2.1 CLI target 与 profile

CLI 的规范选择面冻结为：

- `--descriptor PATH`：`local-daemon`。
- `--managed-runtime PATH`：`local-managed`。
- `--remote HTTPS_URL`：`remote`，token 从 `YANBOT_HARNESS_ACCESS_TOKEN` 动态读取。
- `--profile NAME [--profile-file PATH]`：从无密钥 profile 文件解析上述三种 target；profile 文件默认路径为
  `YANBOT_HARNESS_PROFILE_FILE`，未设置时为 `~/.yanbot-harness/profiles.json`。
- `--runtime URL`：仅保留为 Preview legacy `/local` 入口，URL 必须是 loopback，并使用
  `YANBOT_HARNESS_ACCESS_TOKEN`；它不代表 Remote target。

这些 target 参数彼此互斥；`--profile-file` 只能与 `--profile` 一起出现。profile 文件采用显式版本格式，不保存
token、refresh token 或模型密钥：

```json
{
  "schemaVersion": 1,
  "profiles": {
    "local": { "mode": "local-daemon", "descriptorPath": "/path/runtime.json" },
    "remote": {
      "mode": "remote",
      "origin": "https://harness.example.com",
      "tokenEnvironment": "YANBOT_HARNESS_ACCESS_TOKEN"
    }
  }
}
```

`tokenEnvironment` 只引用 `YANBOT_HARNESS_*_ACCESS_TOKEN` 环境变量名，缺省为
`YANBOT_HARNESS_ACCESS_TOKEN`；变量值在 SDK 每次请求时由异步 provider 读取，以允许外层进程刷新环境适配器，且不能
借 profile 读取并发送其他进程环境秘密。profile 缺失、Schema 非法、目标凭据缺失、Remote 非 HTTPS、握手形态不匹配
或协议不兼容均直接失败，不能尝试其他 profile、descriptor 或 managed Runtime。交互式登录和系统凭据存储由后续认证
子 Spec 定义，本批不把明文 token 文件包装成“登录缓存”。

Remote 目标可先执行 `adapters`、`models`、`sessions`、`run-status` 和 `cancel` 等不构造本机工作区输入的公共命令。
当前 `CreateRunRequest` 仍只接收 local path grant，因此 Remote `run` 在连接握手后、创建 Session 前返回稳定 usage
错误；不得调用 `grantWorkspace`，也不得把隐式 cwd、`--workspace` 或 `--cwd` 发送到远端。待 Phase 4 的 git/upload
preparation 接入公共请求后，再启用同名 `run` 命令，不新增 remote 专用命令。

## 3. 协议中立化与迁移

当前 Harness Protocol `1.0.0` 的 `/local/*` 与 `Local*` 名称已经进入 Preview 包。中立资源不改变既有字段、
状态机、错误码或事件语义，因此本轮保持协议版本 `1.0.0`，并把 `/v1/*` 作为同一协议主版本的规范路由；
不以命名中立化为由制造 2.x 断层。迁移顺序如下：

1. 在 contracts 中新增中立 `Session`、`Run`、`CreateSessionRequest`、`CreateRunRequest` 与 Runtime profile/capability。
2. 新增中立版本化资源路由（目标 `/v1/*`）；Local Runtime 暂时同时提供 `/local/*` 兼容别名。
3. 新 SDK 先请求 `/v1/health` 并根据显式 profile 选择 `/v1` transport；现有构造器明确固定为 legacy
   `/local` transport，以保持已发布客户端行为。不得捕获业务接口 404 后逐个探测。
4. `Local*` TypeScript 导出变为带 `@deprecated` 的值/类型别名，不复制第二套 Schema。
5. Remote Runtime 只实现中立路由，不新增 `/cloud/*` 客户端协议。

兼容周期冻结为：`0.1.0-preview.4` 与 `0.1.0-preview.5` 必须同时保留全部 `/local/*` 路由和 `Local*` 导出；
最早只能在后续 `0.2.0` 移除，并且需要先有一版发布说明、弃用测试和使用量/内测迁移证据。协议 major 不兼容时
SDK 在 health 握手后立即阻断；协议 discovery Schema 可解析任意合法 SemVer，资源 Schema 仍只接受当前
`1.0.0`，从而能把“不兼容版本”与“畸形响应”区分开。

## 4. Runtime Profile 与 capability

规范 `/v1/health` 握手除 `protocolVersion` 外返回完整 Runtime Profile；兼容 `/local/health` 保持 preview.3 的
四字段最小响应，避免旧客户端的 strict Schema 被加法字段击穿：

```ts
type RuntimeProfile = {
  executionMode: 'local' | 'remote';
  serviceVersion: string;
  capabilities: {
    workspaceSources: Array<'local-path-grant' | 'git-ref' | 'uploaded-snapshot'>;
    eventReplay: { durability: 'process' | 'durable'; retentionSeconds?: number };
    interactions: { supported: boolean; maxWaitSeconds?: number };
  };
  authentication: 'local-descriptor' | 'bearer';
};
```

Adapter capability 继续描述模型侧能力；Runtime Profile 描述部署侧能力。客户端先检查两者交集，再展示或调用功能。
服务端必须明确返回不支持原因，客户端不得从 `executionMode` 硬编码猜测所有能力。

## 5. 工作区抽象

Run 创建请求使用可判别的 `workspace` 来源，但资源响应只保存不泄密的 `workspaceRef`。来源因部署不同：

```ts
type WorkspaceSource =
  | { kind: 'local-path-grant'; workspaceGrant: string; relativeCwd?: string }
  | { kind: 'git-ref'; repository: string; ref: string; credentialRef?: string }
  | { kind: 'uploaded-snapshot'; uploadId: string; digest: string };
```

- Local：路径授权由 Runtime 在本机验证，SDK 不上传目录。
- Remote：客户端先创建 upload/Git preparation，再得到租户作用域 `workspaceRef`；Worker 只能领取该引用对应的快照。
- 首个 Remote Preview 只开放受控 Git 引用和上传快照；`credentialRef` 若未完成安全设计必须禁用。
- 路径、token、Git 密钥不进入 Session/Run 公共事件。

为保持 preview.3 线上的请求 JSON 可用，`CreateRunRequest` 第一批仍保留顶层 `workspaceGrant` 与
`relativeCwd` 作为规范 local-path-grant 表达；`WorkspaceSource` Schema 同时冻结远端形态，待远端工作区准备子 Spec
实施时再把联合类型接入 Run 创建 API。这样不会提前接受 Runtime 尚不能安全处理的远端输入。

## 6. 认证与租户边界

Local 使用随机短期 token 和 mode-0600 descriptor，并强制 loopback。Remote 使用 HTTPS Bearer token，令牌至少绑定
subject、organization、device/client、audience、expiry 和 token ID。网关完成认证和租户上下文注入，业务层查询必须
以 tenant + resource ID 为条件；仅凭全局 UUID 查询资源是不允许的。

控制平面签发本次执行授权，Worker 用其换取短期模型凭据或服务端 credential reference。模型长期密钥不进入
SDK/CLI、队列正文、Session Volume 或事件。刷新令牌和设备凭据使用系统安全存储，CLI 输出与 debug 日志做统一脱敏。

## 7. 运行、事件与状态

- Local Runtime 可同步接收并本地执行；Remote API 先持久化 Run，再通过队列投递。
- 两端共享 Run 状态机和唯一终端事件；Remote 的 `queued` 可以停留更久，但语义不变。
- Remote 事件先写持久化事件存储，再由网关 SSE 转发；游标使用公共 `eventId` 和单 Run 单调 `sequence`。
- 重复投递由 Run attempt/lease 与幂等键收敛；Worker 崩溃后由控制平面决定重试或失败，不能留下永久 `running`。
- Session 状态与执行凭据分离；Session 写锁阻止两个 Worker 同时修改同一 Adapter 上下文。

## 8. Adapter 装载形态与 Runtime 部署形态

Local Runtime 和 Remote Worker 都只通过 `adapter-api` 调用 CodeBuddy Adapter。Adapter 不负责用户登录、租户、队列、
上传或 HTTP 路由，也不感知客户端是 Windows 还是 macOS。CodeBuddy Key 的交付方式不同：Local 由测试方在 Runtime
配置中提供；Remote 由平台服务端保管并按 Run 短期注入。两端不得把 Key 交给 SDK 或 CLI。

“Runtime 在哪里运行”和“厂商能力通过SDK还是CLI接入”是两个独立维度：

|                         | 厂商 SDK 型 Adapter                  | 厂商 CLI 型 Sidecar Adapter          |
| ----------------------- | ------------------------------------ | ------------------------------------ |
| Local Runtime           | 当前 CodeBuddy/WorkBuddy 路径        | 本机Sidecar Wrapper托管厂商CLI       |
| Remote Runtime / Worker | Worker内进程Adapter或隔离容器Adapter | Worker/沙箱内Sidecar托管Linux厂商CLI |

上层始终看到同一 Harness Session/Run/Event 协议。CLI 型接入的详细进程边界见
[`cli-harness-adapter`](../cli-harness-adapter/design.md)；不能为Claude Code等具体CLI新增一套客户端API。

## 9. 一致性测试与发布门禁

建立同一套黑盒场景，分别指向 Local Reference Runtime 与 Remote Reference Runtime：

- health/profile 与协议不兼容。
- Session 创建、查询与隔离。
- Run 创建、幂等、状态机和全部终端事件。
- SSE 正常流、断线重放、错误响应和取消竞态。
- permission/question Interaction 与超时。
- capability 不支持的稳定错误。
- 凭据、绝对路径和跨租户数据不泄漏。

CodeBuddy 真实认证另跑环境门禁。发布矩阵分别记录 Local macOS、Local Windows、Remote service，不以 CI 模拟结果
替代目标环境实测。只有 Remote 全链路通过后，兼容表才能从“Required, not implemented”改为 Preview。

## 10. 实施顺序

```text
中立 contracts + 迁移策略
  -> Local Runtime 中立路由兼容层
  -> SDK/CLI RuntimeTarget + capability 握手
  -> 双模式 Reference Conformance
  -> Remote auth/control plane/workspace preparation
  -> queue/worker/sandbox/event persistence
  -> CodeBuddy 真实远端门禁
  -> macOS/Windows Local + Remote 联合交付认证
```

第一批提交边界为 contracts（含测试）→ Local `/v1` 路由（含 alias 测试）→ SDK RuntimeTarget/握手。第二批为
CLI target/profile → 安全失败测试 → 帮助与迁移文档；仍不会越过到 `apps/cloud-server`。Remote Reference 与后续
阶段各自继续依照任务清单推进。

## 11. 拒绝方案

- **直接公网暴露 Local Runtime**：缺少 TLS、租户、远端工作区、持久化、队列和沙箱边界。
- **复制 Cloud SDK/CLI**：会造成命令、状态和错误语义长期分叉。
- **把本机路径发给 Remote**：远端无法访问该路径，也会泄漏客户端目录信息。
- **客户端携带 CodeBuddy Key**：扩大泄漏面，无法统一轮换、额度和审计。
- **把可配置 origin 当作已兼容**：只证明 HTTP transport 可指向其他地址，不能证明服务端契约与安全边界成立。
