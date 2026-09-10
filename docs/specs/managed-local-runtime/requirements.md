# Managed Local Runtime 需求

## 1. 背景与目标

`0.1.0-preview.1` 已经交付可移植 Local Runtime、TypeScript SDK 和 CLI，并完成脱离仓库的 Reference/CodeBuddy 验证。但普通消费者仍需手工解压 Runtime、启动进程、设置 descriptor 路径并在结束时清理进程。

本阶段要在不改变“SDK/CLI 只调用 Harness Runtime，Adapter 与厂商凭据留在 Runtime 边界内”的前提下，把 Local Runtime 从手工 companion artifact 提升为可被 SDK、CLI 和宿主程序显式管理的本地执行组件。

## 2. 交付形态

正式本地交付支持三种连接形态：

1. `managed`：SDK 或 CLI 启动自己拥有的 Runtime 子进程，完成探活、连接和有界关闭。
2. `daemon`：多个本地客户端通过受保护的 descriptor 共享一个长期 Runtime，延续当前 `fromDaemon()` 语义。
3. `external`：宿主使用显式 origin 和 access token 连接已部署 Runtime，延续当前 `connect()` 语义。

Managed 为普通 SDK 嵌入和 CI 的首选；Daemon 用于 CLI、IDE、Electron 或多进程共享；External 为后续客户托管与云端 Runtime 保留协议入口。

## 3. 用户故事与验收标准

### 3.1 SDK 管理本地 Runtime

- Given 本机已有一个与 SDK 兼容的 Runtime 可执行文件，When 宿主调用 managed-runtime API，Then SDK 必须启动子进程、等待 descriptor 与 health 就绪，并返回可用的 `HarnessClient` 和明确的 Runtime handle。
- Given Runtime 无法启动、提前退出、descriptor 非法或探活超时，When 启动 API 等待就绪，Then API 必须在有界时间内失败，清理已启动进程和它拥有的临时状态，且不泄露凭据或完整 stderr。
- Given 宿主调用 Runtime handle 的 `close()`，Then SDK 必须先发送正常终止信号并等待 descriptor 清理；超过宽限后才允许终止自己创建的进程。
- Given 多次并发调用 `close()`，Then 关闭操作必须幂等。

### 3.2 可执行文件解析

- 显式 `executablePath` 优先级最高。
- 在平台 Runtime 包完成前，可使用 `YANBOT_HARNESS_RUNTIME_PATH` 指向已安装 Runtime。
- 未找到 Runtime 时必须给出稳定、可操作的 SDK 错误，不允许在普通 SDK 方法中静默下载并执行二进制。
- 后续平台包必须在安装时完成版本固定，不得在首次 Run 时从浮动 latest URL 下载。

### 3.3 CLI 体验

- CLI 保留 `--runtime` 和 `--descriptor` 显式连接方式。
- 未指定连接时，CLI 应能按配置使用已安装 Runtime 进行 managed 启动，或明确要求运行 `runtime install`。
- CI 必须支持 ephemeral 语义：Runtime 由当次 CLI 调用启动，运行结束后清理，并保持 CLI 原有退出码。
- 共享 Daemon 的 `start/status/stop/restart/logs/doctor` 和安装管理命令以后续可独立验收任务实现。

### 3.4 凭据与安全边界

- SDK/CLI 公共 Run 请求、descriptor、stdout、stderr 和持久化事件中不得出现 CodeBuddy Key。
- Managed Runtime API 不提供名为 `codeBuddyApiKey` 的参数；Runtime 凭据继续由 Runtime 自身的凭据 Provider 从受控环境或系统密钥存储解析。
- 只要 Runtime 在第三方控制的机器上运行，本地交付只承诺第三方 BYOK，不承诺对机器所有者隐藏我方 Key。
- 只监听 loopback、Origin 校验、Bearer 认证、Workspace Grant 和持久化脱敏等现有安全语义保持不变。

### 3.5 发布与兼容性

- Runtime 平台制品必须记录 SDK/Runtime/protocol 兼容范围。
- 安装与更新必须验证 SHA-256 与签名/来源证明；校验值与制品不能仅依赖同一个可覆盖的非受信渠道。
- 安装、升级和回滚采用临时目录 + 原子 rename，不就地覆盖正在运行的 Runtime。
- `darwin-arm64` 与 `linux-x64` 为首批正式目标；Windows 和 Intel Mac 必须在完成打包、权限和真实 Adapter 验证后才能宣称支持。

## 4. 非目标

- 本 Spec 不实现 Yanbot Cloud Runtime、多租户控制面或短期执行令牌。
- 不实现浏览器 SDK。
- 不把 CodeBuddy Key 写入 release bundle、descriptor、命令行或示例 `.env`。
- 不在 SDK 调用中静默下载任意可执行文件。
- 不同时扩展 MCP、skills、agents、hooks 或 CodeBuddy 模型列表能力。
- 不更改 Adapter SPI 和现有 Harness HTTP/SSE 业务协议。

## 5. 已知约束与依赖

- Node.js 仍固定为 `>=22.22.0 <23`。
- CodeBuddy Agent SDK 和它的子进程生命周期由 Adapter/Runtime 收口，SDK Runtime Manager 只负责自己启动的 Harness Runtime 进程。
- 当前 release 脚本只能在本机产出当前 `platform-arch` 的 Runtime archive，跨平台产物需由 CI matrix 构建后聚合。
- 私有 npm Registry、license 文本、macOS 签名/notarization 身份与线上分发域名需由团队确定；在这些外部信息完成前可实现本地可测的解析、启停与制品检查。
