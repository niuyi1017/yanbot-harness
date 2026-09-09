# SDK/CLI Delivery Readiness Requirements

## 1. Context

M3 已完成 TypeScript SDK、CLI、Local Runtime HTTP/SSE 边界和 Reference Adapter 离线验收。2026-09-09 使用明确授权的有效 CodeBuddy 中国版凭据执行了真实探针，首次运行、Session resume、取消和 usage 事件均成功，证明核心厂商链路已经可用。

当前状态仍不能直接标记为“可交付”：真实探针完成后 Node 包装进程没有自动退出；README、任务状态和能力矩阵仍记录旧的 401/pending 结论；SDK、contracts、CLI 包仍标记为 `private`，缺少独立包文档和正式制品流水线；干净消费者环境尚未使用最终制品完成真实 CodeBuddy 端到端验收。

本 Spec 的目标是一次性完成 SDK/CLI 的本地 Preview 交付闭环，让外部 Node.js 集成方能够安装 SDK 或 CLI，连接随交付物提供的 Harness Local Runtime，并在不接触 CodeBuddy 密钥和 Harness 内部包的情况下运行、续接、观察和取消任务。

## 2. Delivery definition

本期“可以交付 SDK/CLI”必须同时包含：

1. 可安装的 `@yanbot-harness/contracts`、`@yanbot-harness/sdk` 和 `@yanbot-harness/cli` 制品。
2. 可独立启动的 Local Runtime companion bundle；SDK/CLI 本身不是 CodeBuddy 直连客户端。
3. Reference Adapter 的零凭据验收路径和 CodeBuddy Adapter 的受控真实验收路径。
4. 版本、校验和、兼容范围、安装步骤、配置步骤、错误码和安全边界文档。
5. 可重复执行的 release build、clean-room install 和 smoke gate。

本期交付级别为 **Local Preview**。它不是公网多租户 SaaS，也不承诺 M4–M11 的 Web、Electron、云端控制平面、Admin、市场或教师端迁移能力。

## 3. User stories and acceptance criteria

### R1. TypeScript SDK artifact

- 集成方能在一个不含 workspace 源码的空目录中安装 contracts 与 SDK 制品。
- 集成方只从 `@yanbot-harness/sdk` 导入公共 API，不需要安装或导入 Adapter、Runtime、CodeBuddy SDK。
- SDK 支持显式 Runtime endpoint、嵌入式 handle 和安全 daemon descriptor。
- SDK 能完成 health、workspace grant/revoke、Session create/list/get、Run create/get/cancel、Interaction response、SSE 事件、Adapter/Model/config/extension 查询。
- SDK 的网络响应和事件继续经过公共 schema 校验，错误不包含访问令牌、CodeBuddy Key 或完整非协议响应体。
- 包清单不包含测试、源码映射、`.env`、本地路径或厂商凭据。

### R2. CLI artifact

- 集成方能在空目录中安装 CLI 制品并通过 `yanbot-harness --version`、`--help` 和现有命令调用 Runtime。
- CLI 生产依赖保持只指向 SDK；不得直接导入 Runtime、Adapter 或 CodeBuddy SDK。
- text 与 JSONL 输出、TTY Interaction、稳定退出码和凭据查找顺序与 M3 契约一致。
- CLI 不新增 token 命令行参数、权限绕过参数或把密钥放入进程参数的用法。

### R3. Runtime companion

- 交付包包含一个无需 yanbot-harness 源码仓库即可启动的 Local Runtime companion bundle。
- Runtime 只监听 loopback，启动 descriptor 权限保持 `0600`，正常关闭后删除 descriptor。
- CodeBuddy Key 只由 Runtime 进程环境读取；SDK/CLI 消费者只持有短范围的 Harness Runtime access token。
- bundle 支持 `codebuddy` 与 `reference` 两种装配模式，并明确记录 Node 版本和首批认证平台。
- Runtime 启动、失败和关闭不得打印 CodeBuddy Key、Harness access token 或敏感配置。

### R4. Real CodeBuddy acceptance

- 有效中国版凭据与 `CODEBUDDY_INTERNET_ENVIRONMENT=internal` 下，真实探针必须以退出码 0 自动结束。
- 真实验收至少覆盖首次运行、文本输出、完整 assistant message、usage、Session resume 和取消。
- 受控场景继续覆盖模型列表、工具生命周期、权限 Interaction 和问题 Interaction；无法由当前厂商版本稳定触发的能力必须在能力矩阵中明确标为未认证或不支持，不能伪造通过。
- 探针结束后不得残留 smoke、CodeBuddy CLI 或其后代进程。
- 真实探针保持 opt-in，不进入无凭据的默认 CI。

### R5. Release packaging

- contracts、SDK、CLI 采用同一 release version；制品内不得保留 `workspace:*`。
- SDK、contracts、CLI 具备正确的 `exports`、types、engines、files、license、repository、README 和发布配置。
- Local Runtime 以 portable bundle 交付，避免要求消费者安装所有内部 workspace 包。
- release 目录包含 artifact manifest、SHA-256 校验和、兼容矩阵和 quickstart。
- release 脚本可重复运行；同一 Git commit、相同工具链输入应产生结构一致的制品清单。

### R6. Clean-room verification

- 自动化测试在临时空目录中安装最终 tarball，而不是使用 workspace link。
- SDK 示例只依赖打包后的 contracts/SDK，并通过打包后的 Runtime 完成 Reference Adapter 调用。
- CLI 通过打包后的 bin 和 Runtime 完成 text、JSONL、resume、cancel 和失败退出码验证。
- 受控 release gate 使用相同制品完成一次真实 CodeBuddy 首次运行、resume 和 cancel。
- 验收结束后临时目录、descriptor 和子进程均被清理。

### R7. Documentation and handoff

- 独立 SDK README 提供安装、连接、完整最小示例、事件消费、Interaction、取消、错误处理和安全说明。
- 独立 CLI README 提供安装、Runtime 启动、命令、JSONL、退出码、无头模式和故障排查。
- Runtime 文档说明 Key 注入、`internal` 路由、状态目录、descriptor 和关闭方式，但不要求复制真实 Key 到仓库文件。
- changelog/release notes 记录 Preview 限制、CodeBuddy SDK 精确版本和已认证能力。
- 文档明确 SDK/CLI 不能单独替代 Runtime，也不能绕过 CodeBuddy 套餐、认证或权限。

### R8. Quality and release gate

- `pnpm check` 全量通过，测试数量和平台被记录。
- CI 增加 package/release dry-run 与 clean-room Reference 验收；默认 CI 不需要外部凭据。
- 发布候选必须来自干净 Git 状态或明确记录的 commit，所有 Spec、代码、lockfile 和制品版本一致。
- 发布前执行敏感文件、凭据模式、源码映射、workspace 协议和禁止依赖检查。
- 形成可执行的失败回滚流程：撤回 release candidate、恢复前一版本、撤销泄露的外部凭据。

## 4. Current baseline

- `pnpm check` 于 2026-09-09 通过，共 108 项测试。
- `@tencent-ai/agent-sdk` 固定为 `0.3.254`。
- Reference Adapter 的 SDK/CLI HTTP/SSE 黑盒链路通过。
- 有效 CodeBuddy 凭据下，首次运行、resume、cancel 和 usage 真实通过。
- 已知问题：真实 smoke 输出成功 JSON 后进程未自动退出，需要人工中断；中断后确认无残留 CodeBuddy 进程。
- 当前 SDK、contracts、CLI 与 Runtime package 均为 `private`；当前 M3 明确只验证可打包结构，没有执行正式 npm 发布。
- 当前 CodeBuddy hardening 改动与本 Spec 尚未形成 release commit/tag。

## 5. Constraints and dependencies

- Node.js 基线保持 `>=22.22.0 <23`，pnpm 保持 `11.10.0`。
- CodeBuddy SDK 必须继续只存在于 `packages/adapter-codebuddy`，上层公共类型不得泄露厂商类型。
- Runtime 只允许从 allowlisted process environment 解析 CodeBuddy Key，不接受通过 HTTP/SDK/CLI 请求上传 Key。
- 中国版凭据必须搭配 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`；不得为 internal 模式硬编码自定义 base URL。
- 真实 smoke 使用操作员显式提供的临时进程环境，不把凭据写入 Git、fixture、日志或 release artifact。
- 首批认证平台为 macOS arm64 和 CI 的 Linux x64/Node 22；Windows 未完成真实 CodeBuddy 验收前不得宣称已认证。
- SDK/CLI 的协议兼容范围必须以 Harness protocol version 为准，不能只依赖 npm 包版本相同。

## 6. Out of scope

- M4 本地 Web 工作台。
- M5 云端账号、会话元数据和多租户控制平面。
- Electron 安装器、自动更新和桌面发布。
- npm 公网正式发布；本期产出可发布到私有 Registry 或作为离线 release bundle 交付的制品。
- 新增其他厂商生产 Adapter。
- 新增 CodeBuddy MCP、Skill、Agent、Hook 支持；这些能力继续按 capability negotiation 显示为不支持。
- 教师端业务迁移、教师账号、数据库和报告功能。
- 自动购买或升级 CodeBuddy 套餐、自动签发/轮换厂商 Key。

## 7. Delivery exit criteria

只有同时满足以下条件才能标记“SDK/CLI Local Preview 可交付”：

1. 所有 P0 任务完成，没有未解释的进程泄漏或挂起。
2. 默认 `pnpm check`、release dry-run、clean-room Reference E2E 全部通过。
3. 使用最终制品而非 workspace 源码完成一次真实 CodeBuddy run/resume/cancel，且自动退出、无残留进程。
4. capability matrix 与真实证据一致，未验证能力没有被标记为已支持。
5. release bundle、manifest、checksums、quickstart、release notes 完整。
6. Git commit、版本、lockfile、制品 manifest 可相互追踪，凭据扫描通过。
