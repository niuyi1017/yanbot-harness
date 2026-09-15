# 第三方 CLI Harness Adapter 设计

总体进程、协议、凭据和双 Runtime 边界以
[`docs/architecture/system-architecture.md`](../../architecture/system-architecture.md) 为准；本 Spec 只细化 CLI Sidecar
进程监管和厂商翻译实现。

## 1. 设计结论

CLI型Harness采用“两级适配”：通用Sidecar进程协议解决Runtime与Adapter的隔离，厂商专用Wrapper解决具体CLI的
命令和输出差异。

```text
产品 SDK / 产品 CLI / UI
          │ Harness HTTP + SSE
Local Runtime 或 Remote Worker
          │ adapter-api
Sidecar Client / Supervisor
          │ JSON-RPC 2.0 + JSONL
Vendor Sidecar Wrapper
          │ child_process argv + 独立 pipes
Vendor CLI（例如某个已锁定版本的 Claude Code CLI）
```

这使上层同时获得两个正交维度：Runtime可在Local或Remote，Adapter可由厂商SDK或厂商CLI实现。四种组合共享同一
Session/Run/Event协议。

![Yanbot Harness 双 Runtime 与双厂商接入架构](../../architecture/assets/yanbot-harness-runtime-adapter-architecture.png)

## 2. 模块划分

### `packages/adapter-sidecar`

在现有Schema之上增加 `SidecarClient` 与 `SidecarSupervisor`：

- 使用 `spawn(executable, argv, { shell: false })`，不拼接shell命令。
- 完成initialize握手、请求ID关联、JSONL分帧、通知分发、超时和关闭。
- 校验每一帧Schema、协议主版本、manifest与capability一致性。
- 限制单行、缓冲区、stderr和待处理请求数量，防止内存失控。
- 管理POSIX进程组和Windows进程树，dispose保持幂等。

### `packages/adapter-cli-host`

向厂商Wrapper提供可复用但不含厂商判断的基础设施：

- 安全可执行文件发现与版本探测。
- allowlist环境构造、临时凭据目录和工作目录边界。
- 子进程启动、stdout/stderr解析入口、背压、超时和取消升级。
- 脱敏日志、输出大小限制、统一退出原因。
- 测试用Fake CLI与时钟/进程抽象。

### `packages/adapter-<vendor>-cli`

每个厂商单独实现：

- `manifest`、CLI精确兼容范围和安装探测。
- 公共permission/model/config到厂商argv/config的映射。
- 厂商机器输出到Harness Event的状态机解析器。
- 厂商session ID、resume/cancel/interaction和usage映射。
- 厂商错误、退出码、限流与认证失败归一化。

厂商包可以使用CLI Host，但不能把厂商原始类型导出给Runtime或客户端。

## 3. 双进程管道

Sidecar Wrapper自身的stdin/stdout属于Harness协议，厂商CLI必须使用Wrapper创建的另一组pipes：

```text
Runtime stdin  -> Wrapper JSON-RPC parser
Runtime stdout <- Wrapper JSONL writer

Wrapper        -> Vendor CLI stdin/argv
Wrapper parser <- Vendor CLI stdout
Wrapper log    <- Vendor CLI stderr
```

Wrapper以单写入队列串行输出JSONL，避免并发事件交叉半行。厂商stdout经过增量分帧、长度限制与Schema/版本验证；
stderr默认只形成限长、脱敏诊断，不直接变成assistant消息。任何非协议内容出现在Wrapper stdout都视为协议错误。

## 4. 运行映射

`startRun`的推荐流程：

1. 验证工作区、配置、能力与凭据引用。
2. 构造固定可执行路径和argv数组，禁用颜色、分页器、更新检查和隐式交互。
3. 创建独立进程组/进程树，并注入最小环境。
4. 先发 `run.started`，再把厂商机器事件逐项归一化。
5. 捕获并映射厂商session ID为不透明 `adapterSessionId`。
6. 厂商明确成功后发 `run.completed`；非零退出、解析失败或无终端结果发 `run.failed`。
7. 在finally中关闭管道、清理临时凭据和全部子进程。

`resumeRun`只有在版本探针确认厂商CLI支持稳定恢复参数时才调用。若使用上下文重放模拟，必须声明`emulated`、限制
最大历史和成本差异，且不能复用原厂session ID语义。

## 5. 交互、权限与工具事件

优先使用厂商正式的机器事件或hook/control协议。Wrapper将厂商tool start/result映射为公共工具事件，将结构化权限
或问题映射为Interaction。若厂商CLI只在TTY中显示提示：

- 首期以安全的非交互权限模式运行，并把交互能力声明为unsupported；或者
- 在独立版本完成PTY状态机、提示fixture与安全评审后，才可声明emulated。

不得看到提示文本后自动输入“yes”。厂商的自动批准参数必须映射到公共permission policy并受平台禁止规则约束。

## 6. 取消和进程清理

```text
cancel(runId)
  -> 标记取消，停止接受非终端事件
  -> 发送厂商支持的结构化取消或中断信号
  -> grace period
  -> 终止进程树
  -> kill timeout
  -> 强制清理并发出唯一 run.cancelled 或确定失败
```

POSIX使用独立process group，Windows实现独立进程树策略并测试CLI再派生Node/Python子进程的情况。Runtime关闭、
Sidecar断链和Worker lease丢失都走同一清理路径。PID必须与启动身份/句柄关联，禁止仅按可复用PID盲杀进程。

## 7. 凭据设计

- API Key/token通过allowlist环境或权限受限临时文件注入，不进入argv。
- OAuth登录态放在每个用户/Session隔离目录，不能复用系统全局目录作为Remote默认值。
- Local若允许使用已有登录态，必须由用户显式开启并限制可读取路径。
- Remote Worker通过execution grant取得短期凭据，Run结束后销毁临时目录。
- 脱敏器覆盖环境变量名、Authorization值、厂商token格式和凭据文件路径。

## 8. 安装与交付

安装入口与 Runtime 平台 payload 遵循已确认的
[`unified-local-distribution`](../unified-local-distribution/design.md)。local 单包安装不意味着自动分发所有厂商 CLI；
首轮仍为现有 SDK 型 CodeBuddy/Reference。新 Wrapper/CLI 的许可、版本和平台证据分别验收，只有批准后的资产才可进入
Runtime payload 或独立受信包，缺少 CLI 时不得由 SDK/普通启动静默联网下载。

Wrapper与厂商CLI是两个制品：

- Wrapper由我们构建、签名并随Runtime/Adapter包交付。
- 厂商CLI只有许可证允许且供应链流程确认时才可打包；否则由测试方按文档安装到受支持路径。
- manifest记录Wrapper版本、支持的厂商CLI版本/摘要、OS/arch和能力矩阵版本。
- Remote镜像在构建期安装并锁定CLI，运行期不执行自更新。

本地Mac和Windows分别验证可执行文件发现、路径空格、Unicode路径、权限、进程清理和升级提示。CLI不支持某平台时，
对应Adapter在probe阶段返回不可用，不影响其他Adapter和Runtime运行。

## 9. 测试策略

### 离线Fake CLI

- 任意位置拆分JSON行、多个事件同一chunk、CRLF和UTF-8边界。
- 超大行、非法JSON、未知事件、序号错误、无终端事件与非零退出。
- stderr洪水、stdout背压、永不退出、忽略中断和派生孙进程。
- resume、interaction、cancel竞态和重复shutdown。
- 凭据、绝对路径与厂商原始输出脱敏。

### 厂商真实门禁

- 锁定CLI版本后探测最小运行、流式、工具事件、session ID、resume、cancel和退出码。
- 每项能力分别标记documented、fixture-tested、real-verified。
- macOS/Windows Local与Linux Remote镜像分别记录，不跨平台推断。

## 10. 与现有实现的复用

- 复用 `packages/adapter-sidecar/src/index.ts` 的JSON-RPC Schema，不另建厂商协议。
- 复用 `packages/adapter-api` 的生命周期和capability断言。
- 复用 `packages/adapter-kit` 的事件工厂与 `packages/testing` 的Conformance思路。
- 复用Local Runtime的凭据allowlist、Run取消和敏感日志约束，但进程监管形成独立公共包。

## 11. 放弃方案

- **平台CLI直接调用厂商CLI**：绕过Runtime的权限、状态、事件、审计与Local/Remote统一边界。
- **通用正则解析任意CLI文本**：厂商文案、颜色、终端宽度和版本变化会导致静默错误。
- **每家复制一套进程监管**：取消、超时、Windows清理和脱敏逻辑容易不一致。
- **默认PTY模拟用户**：难以确定状态，容易自动接受危险权限或卡在不可见提示。
- **把厂商CLI塞进adapter-sidecar核心包**：会让协议层依赖具体厂商和许可证。
