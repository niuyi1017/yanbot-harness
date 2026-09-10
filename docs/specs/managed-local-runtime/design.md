# Managed Local Runtime 设计

## 1. 设计概览

本设计在现有 Runtime 与 SDK 之间增加生命周期层，不改造 Adapter 执行链：

```text
Consumer application / CLI
          │
          ├─ managed: spawn + readiness + owned shutdown
          ├─ daemon: protected descriptor discovery
          └─ external: explicit origin + token
          ▼
Harness Runtime ── HTTP/SSE ── Adapter ── CodeBuddy
```

首个实现切片只建立 managed 核心原语：给定已安装 Runtime 可执行文件，SDK 可启动、等待就绪、构造客户端并关闭它。平台包、安装器和共享 Daemon CLI 基于这些原语逐步增加。

## 2. SDK 公共 API

`packages/sdk/src/managed-runtime.ts` 新增：

```ts
type StartManagedRuntimeOptions = {
  executablePath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  stateRoot?: string;
  reference?: boolean;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  fetch?: typeof fetch;
};

type ManagedRuntimeHandle = {
  readonly client: HarnessClient;
  readonly origin: string;
  readonly pid: number;
  readonly descriptorPath: string;
  close(): Promise<void>;
};

function startManagedRuntime(options?: StartManagedRuntimeOptions): Promise<ManagedRuntimeHandle>;
```

设计选择：

- 返回“handle + client”，不让普通 `HarnessClient` 隐式拥有子进程，调用方可明确使用 `try/finally` 关闭。
- 不在启动 API 中接受厂商专用 Key 字段。`environment` 是 Runtime 进程环境边界，由宿主显式提供；类型和文档不会把 CodeBuddy Key 提升为 Harness SDK 协议概念。
- `reference` 只映射为 Runtime `--reference`，用于零凭据验收。
- `executablePath` 省略时从传入 `environment` 或 `process.env` 的 `YANBOT_HARNESS_RUNTIME_PATH` 解析。平台包解析在后续任务加入，但不改变公共 API。

## 3. 进程与就绪流程

### 3.1 状态目录

- 如果调用方提供 `stateRoot`，将其视为调用方管理的持久目录，SDK 不删除。
- 如果没有提供，SDK 在 OS temp 下使用 `mkdtemp()` 创建 mode-0700 专用目录，关闭或启动失败时删除。
- descriptor 固定为 `<stateRoot>/runtime.json`，继续复用 `readRuntimeDescriptor()` 的文件权限、loopback、TTL 和 PID 验证。

### 3.2 启动

```text
resolve executable
→ validate executable file
→ create/resolve stateRoot
→ spawn Runtime with YANBOT_HARNESS_STATE_DIR
→ wait for descriptor or child exit
→ read and validate descriptor
→ construct HarnessClient
→ call health and validate protocol
→ return owned handle
```

- 子进程 stdout 不用作协议或就绪信号，避免依赖文案；就绪只以经验证 descriptor + health 为准。
- stdout/stderr 默认不继承终端。启动期诊断使用有界 ring buffer，错误信息只返回通用阶段和退出信息，不返回完整环境或无界输出。
- 默认启动超时为 15 秒，配置值必须限制在合理范围。
- 启动过程中子进程提前退出时立即失败，不继续轮询到超时。

### 3.3 关闭

```text
first close caller
→ SIGTERM owned child
→ wait for exit within shutdownTimeoutMs
→ if still alive, force terminate owned child
→ wait for exit
→ remove SDK-owned temporary stateRoot
→ resolve shared close promise
```

- 只对 SDK 自己 `spawn()` 返回的 child handle 发信号，不根据 descriptor 中的任意 PID 终止进程。
- POSIX 平台首先使用 `SIGTERM`，宽限后使用 `SIGKILL`；Windows 完成真实进程树验证前不宣称可证。
- Runtime 现有 SIGTERM 处理必须继续负责取消活动 Run、关闭 CodeBuddy 子进程并删除 descriptor。

## 4. 平台制品设计

长期目标为受限私有 Registry 中的平台包：

```text
@yanbot-harness/runtime
├─ optionalDependency: @yanbot-harness/runtime-darwin-arm64
├─ optionalDependency: @yanbot-harness/runtime-darwin-x64
├─ optionalDependency: @yanbot-harness/runtime-linux-x64
└─ optionalDependency: @yanbot-harness/runtime-win32-x64
```

- meta package 负责解析当前 platform/arch 的固定版本制品。
- 平台包包含当前 portable deploy 目录，不将内部 Adapter/Core 包提升为可依赖的公共 API。
- SDK 可将 meta package 作为 optional dependency，保留只连接外部 Runtime 的 slim 使用方式。
- CLI 正式包默认携带当前平台 Runtime，为用户提供单次安装体验。

Preview 期间可继续从签名离线 bundle 安装 Runtime，通过 `YANBOT_HARNESS_RUNTIME_PATH` 与同一 managed API 验证，避免在 Registry 决策前锁定不可回退的包名。

## 5. CLI 分层

CLI 后续增加 `runtime` 命令组：

```text
yanbot-harness runtime install
yanbot-harness runtime start [--reference]
yanbot-harness runtime status
yanbot-harness runtime stop
yanbot-harness runtime restart
yanbot-harness runtime doctor
```

- `run` 默认优先级为：显式 `--runtime` → 显式 `--descriptor` → 现有 Daemon descriptor → 已安装 Runtime 的 managed/ephemeral 模式。
- 普通命令不静默安装或更新 Runtime。缺少制品时返回稳定 runtime 错误并提示显式安装。
- JSON 模式 stdout 继续仅输出 JSONL，Runtime Manager 日志只进 stderr 且遵守 `--log-level`。

## 6. 安全与信任边界

### 6.1 Managed 本地凭据

SDK 启动 Runtime 时需要明确子进程环境。首版可由调用方提供完整 environment，这意味着凭据可能已存在宿主进程中；文档必须如实描述，不沿用 Preview 中“SDK 进程不持有 Key”的受控验收结论。

正式交付优先增加 Runtime 内的 credential provider：

- macOS Keychain。
- Windows Credential Manager。
- Linux Secret Service 或显式企业 Secret Manager。
- CI 中仅向 Runtime 子进程注入的临时环境。

### 6.2 制品信任

- SHA-256 用于损坏检测，签名/来源证明用于发布者身份校验。
- macOS Runtime 需代码签名和 notarization；Windows 需 Authenticode；Linux 使用已签名 manifest/attestation 与受控 Registry。
- Runtime Manager 不允许将未验证的 archive 直接解压到活跃版本目录。

## 7. 关键文件与复用

| 文件                                  | 复用/改动                                         |
| ------------------------------------- | ------------------------------------------------- |
| `packages/sdk/src/daemon.ts`          | 复用 descriptor 权限、TTL、loopback 和 PID 验证   |
| `packages/sdk/src/client.ts`          | 复用 `HarnessClient.fromRuntime()` 与 `health()`  |
| `packages/sdk/src/transport.ts`       | 复用 `HarnessSdkError` 稳定错误分类               |
| `apps/local-runtime/src/server.ts`    | 复用 descriptor 原子写入与拥有者清理              |
| `apps/local-runtime/src/main.ts`      | 复用 SIGTERM/SIGINT 有界关闭入口                  |
| `scripts/build-runtime-bundle.mjs`    | 复用 portable deploy 构建，后续增加平台包 staging |
| `scripts/test-release-clean-room.mjs` | 复用脱离仓库验收，增加 managed 场景               |

新建 `managed-runtime.ts` 而不将 spawn 逻辑放入 `daemon.ts`，因为 daemon descriptor 发现是非拥有型连接，managed Runtime 是有子进程所有权的资源 API，两者的关闭责任必须保持可见差异。

## 8. 放弃的方案

### 8.1 让所有 SDK 用户手工启动 Daemon

放弃作为默认体验。这对多客户端共享合理，但会给普通 SDK 嵌入增加额外运维步骤。Daemon 作为保留模式而非唯一模式。

### 8.2 让 SDK 直接调用 CodeBuddy SDK

放弃。这会绕过 Workspace Grant、权限、事件持久化、超时、错误标准化和 Adapter 边界。

### 8.3 首次 SDK 调用时自动下载 latest Runtime

放弃。这会引入不可预期的网络副作用、供应链攻击面、版本漂移和离线失败。Runtime 应由固定版本包或显式 install/update 命令取得。

### 8.4 立即把 Runtime Manager 实现成 OS 系统服务

放弃作为首个实现切片。进程拉起、探活、所有权和关闭原语可先跨平台验证；launchd/systemd/Windows 服务在共享 Daemon 任务内基于同一原语实现。
