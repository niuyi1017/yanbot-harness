# 第三方 CLI Harness Adapter 任务清单

## 当前状态（2026-10-09）

SDK 型与 CLI 型均使用公共 Adapter SPI；Claude Code 2.1.284 是首个 Experimental CLI Adapter。
Local 三平台和 Linux Remote 已取得无凭据工程证据。付费模型、生产 broker/egress、持久 Session 恢复与正式发布仍未完成。

## Phase 1：厂商能力探针

- [x] 用户选择 Claude Code 2.1.284；核对官方机器接口、条款及固定平台包 SHA512。
- [x] 实测非交互 JSONL、session ID、认证错误、退出码；保存无凭据结果，不收集已有用户凭据。
- [x] 建立 `docs/architecture/claude-code-cli-capability-matrix.md` 和 `claude-code-cli-adapter` 子 Spec。
- [ ] 真实付费文本/usage/cancel 验收；用户目前没有 Anthropic Key。工具/权限/恢复未开放。

验收：能力声明与证据一致，目前仅 Experimental，不声称厂商生产认证。

## Phase 2：Sidecar Client 与 Supervisor

- [x] `packages/adapter-sidecar` 进程启动、initialize 握手、请求关联、乱序响应与通知。
- [x] 增量 JSONL、Schema/sequence 校验、有界队列/缓冲/stderr、请求/空闲/关闭超时及幂等 dispose。
- [x] Bridge 与 Reference Fixture 通过 Conformance；响应前事件、取消、AbortSignal、提前退出、重复终态、溢出与异常退出收敛。
- [x] 用有序 capabilities 响应作为终态屏障，覆盖管道分块的重复终态；Sidecar 29 项测试通过。
- [x] POSIX 同组子孙进程回收；Windows 原生 Job owner、原子 Job 归属、空树证明、父强杀与派生进程实际 CI 通过。
- [ ] POSIX Local 主进程被 SIGKILL 后的任意脱组进程 containment 认证。不能将 Windows Job 或 Linux Docker 结果推及此项。

验收：`pnpm --filter @yanbot-harness/adapter-sidecar test:unit`；实际 Windows [CI 37814307676](https://github.com/niuyi1017/yanbot-harness/actions/runs/37814307676)。

## Phase 3：通用 CLI Host

- [x] `packages/adapter-cli-host` 安全 spawn、精确版本探测、显式环境允许列表；不使用 shell 拼接。
- [x] 私有凭据目录、POSIX 权限/Windows ACL、容量限制、目录身份替换拒绝和成功/失败/取消清理。
- [x] 有界 stdin、stdout 异步行解析、stderr 限额、错误/退出归一化；缺少可执行文件在启动前明确失败。
- [x] Fake CLI 覆盖 CRLF、拆分 UTF-8、背压、解析失败、配额、空闲/总时限、取消和协作子孙进程。
- [~] POSIX TERM/KILL 升级和 Windows Job 回收已测；任意脱组/强杀保证仍按 Phase 2 跟踪。

验收：Host 无厂商解析分支；三平台工程 CI 和 Windows ACL/Job 实测通过。

## Phase 4：首个厂商 CLI Adapter

- [x] `packages/adapter-claude-code-cli`，固定 2.1.284 与 Experimental manifest。
- [x] 只读文本命令、机器事件、临时 session、错误/退出码映射；恢复、工具、权限交互明确 unsupported。
- [x] Local Runtime 静态允许列表；SDK/平台 CLI 不暴露厂商字段。
- [x] 凭据文件、显式 `--live`、预算限制和版本校验的冒烟/升级门禁；用户无 Key，付费门禁未执行。
- [x] 三平台真实无凭据 SDK/独立 Runtime 认证失败及持久化：[CI 37814307621](https://github.com/niuyi1017/yanbot-harness/actions/runs/37814307621)。
- [~] 文本/usage native 声明保持 Experimental；真实付费增量和费用待验收。

验收：Wrapper/parser fixture 15 项通过；真实三平台错误路径与能力矩阵一致。

## Phase 5：Remote Worker 与双 Runtime 认证

- [x] 同一 CLI Adapter 装入 Linux Sandbox 测试镜像；固定 CLI 版本/SHA512 与不可变镜像 ID，镜像不发布。
- [x] CodeBuddy SDK 与 Claude CLI 使用固定 Guest allowlist，经相同公共协议执行。
- [x] 实际 Docker 验证隔离、取消、父强杀、容器回收；完整 SDK/HTTP/Redis/Worker 无凭据错误路径 5 项 E2E 全通过。
- [x] macOS/Windows/Linux Local 与 Linux Remote 工程证据归档；Remote 见 `../remote-sandbox-executor/evidence/dac5b24/`。
- [ ] execution grant 绑定短期凭据、受控模型出网、持久 Session/恢复与真实模型请求。

验收：当前是离线容器基线；不代表完整 Remote 生产认证或四模式整体完成。

## Phase 6：交付与运营

- [~] 已明确用户独立安装厂商 CLI、CI 测试镜像不发布；正式再分发许可证/签名门禁仍待完成。
- [x] 工程 manifest、能力矩阵、安装检查、固定版本升级、回滚与故障边界见 `docs/delivery/four-mode-engineering-preview.md`。
- [ ] 市场/管理端签名 Adapter 安装管理；当前只使用部署固定允许列表。
- [x] 更新总 roadmap 与真实证据；保持 Experimental/Preview 声明，不把协议存在视为生产可用。

验收：正式发布仍需干净目标系统、真实凭据、恢复/取消/卸载清理和签名制品门禁。
