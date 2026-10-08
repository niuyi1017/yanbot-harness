# 设计

- 新增 `packages/sandbox-docker`，实现 HarnessAdapter facade。复用 `adapter-sidecar` 的握手/事件/错误/取消，
  不改变 SDK、公共 HTTP 或 RunRequest。包内只处理中立容器生命周期，不解析任何厂商输出。
- 新增 `apps/sandbox-runtime`，由固定入口选择 Reference、CodeBuddy SDK 或 Claude CLI Adapter；接收私有 boot 帧和 lease 心跳，
  其余请求使用 Sidecar Schema。一次最多一个 active Run，resume/扩展/凭据注入本阶段关闭。
- 受信 Docker 可执行路径来自部署；只接受 Linux daemon。本机镜像 ID `sha256:<64hex>` 或 registry `@sha256:<64hex>`；
  `--pull=never`，避免请求路径隐式拉取。create 得到完整 CID 后 start --attach --interactive；始终按 CID 清理。
- 固定 non-root 65532:65532、256 PID、512 MiB memory/swap、1 CPU、只读根、64 MiB /tmp tmpfs、64 MiB /home/sandbox tmpfs；
  无 host PID/IPC/network。工作区从受信 snapshot root 的真实子目录读取，经 boot stdin 传入 Guest tmpfs，不创建宿主 bind mount。源不能是 root 本身；拒绝 symlink/特殊文件，最多 2048 文件、16 MiB、16 层。Guest 校验路径后写入 /home/sandbox/workspace；Run 结束后随容器销毁。
- Host 每 2 秒发送不返回响应的私有 lease 通知，guest 10 秒没有 lease 则终止；guest PID1 退出由 Docker auto-remove 清理整容器。
  失联时不尝试继续任务；控制面既有 lease/reaper 决定重试。容器创建/启动错误输出只保留稳定错误。
- `RunCoordinator` 的 Adapter factory 接收当前 Run，并可异步创建 facade；Factory 仍只在 composition root 选择。
  Worker 依据部署选择 sandbox，按 Run 的 adapterId 严格匹配。默认控制面 catalog 仍只开放 Reference。
- Guest adapter manifest 从实际 adapter 取得，并将 runtimeKinds 映射为 sidecar；禁用 resume 声明以匹配无持久状态行为。
- CI 用固定 Node 基础镜像构建只含受控仓库制品的镜像，最终使用 image inspect 返回的不可变 ID；不上传含厂商二进制的镜像。
  默认镜像只带 Reference，Claude 验证镜像通过单独授权/官方完整性步骤安装，生产仍不开放。

## 复用与备选

复用 CLI Host 的环境允许列表理念、Sidecar Bridge、AdapterEventFactory、现有 Reference Adapter 与 Worker lease。
拒绝直接 `docker run` 后只杀 Docker 客户端：这不能证明容器清理。拒绝 host-network 与 Docker socket 挂载到 guest。
暂不实现可任意指定镜像/command 的公共 API，所有执行配置仅来源受信部署。

官方参考：[create](https://docs.docker.com/reference/cli/docker/container/create/)、
[resources](https://docs.docker.com/engine/containers/resource_constraints/)、
[security](https://docs.docker.com/engine/security/)。

工作区方案调整：不把宿主目录复制到磁盘暂存或依赖跨 UID 共享权限；有界 stdin 快照传输避免父强杀后遗留暂存文件，也不向 Guest 暴露宿主 mount。boot 帧上限 32 MiB，普通协议帧上限 4 MiB。

## 未启动容器回收

`docker create` 的响应可能在客户端超时后丢失，导致尚未运行、没有 Guest lease watchdog 的容器。
Worker 启动及每 15 秒扫描专用 Harness label 的 created 容器；只回收名称符合 Harness UUID 格式且创建超过 60 秒的对象。
使用非 force rm：若其间被正常启动，Docker 拒绝删除，保留运行中的资源。此回收器不扫描或删除其他 label 的容器。

## CLI 容器探针

增加不发布的 CI 镜像变体，构建时从官方 npm 取得 Claude Code Linux x64 2.1.284，
校验与已通过平台探针相同的固定 SHA512 后仅保留可执行文件。该镜像通过 DockerSandboxAdapter 的同一公共协议，
在 network=none、无 API Key 环境验证 AUTHENTICATION_FAILED 和清理；其结果仍不是付费模型成功证据。

## Remote API 实验接入

开发/测试环境可显式启用 `CLOUD_EXPERIMENTAL_CLAUDE_CLI=true`，控制面只增加固定 Claude 2.1.284 元数据，
不导入或执行厂商 Adapter。生产配置拒绝此开关，默认目录仍为 Reference。Session/Run 以已授权 Session 的 adapterId 派发，
model.adapterId 必须匹配。Claude 只接受已准备 uploaded-snapshot、read-only、无 resume/extensions/configScopes，maxTurns 仅允许 1。
CI 用真实 HTTP、Redis、独立 Worker 和 Docker 验证 SDK 创建 Claude Session/Run、认证失败持久化及 grant/队列边界；
测试存储仍为 MemoryControlPlaneStore，这不替代生产 Mongo/TLS 验收。

SDK 型厂商同时复用现有 CodeBuddy Adapter：Guest/Worker 固定允许列表增加 `cn.tencent.codebuddy`，不传入凭据。
测试/开发控制面可用 `CLOUD_EXPERIMENTAL_CODEBUDDY=true` 开启诊断 Session，生产同样拒绝。Remote SDK 暂不开放恢复、
模型发现、扩展、配置或多轮；缺少 Key 的 startup exception 必须转换为一对公共 started/failed 事件，不能让 Wrapper 无终态退出。
Docker/完整 Worker 链路分别验证 SDK 型 CodeBuddy 与 CLI 型 Claude 的无凭据失败；付费成功依旧未认证。
