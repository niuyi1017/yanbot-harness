# 第三方 CLI Harness Adapter 任务清单

## 当前状态（2026-09-29）

- [x] 审计现有Adapter SPI、Sidecar Schema、总体架构与双Runtime设计。
- [x] 确认SDK型与CLI型Harness都是产品必须覆盖的接入形态。
- [x] 补齐CLI Wrapper、进程监管、能力降级、凭据、跨平台和交付设计。
- [~] Sidecar Client/Supervisor/Adapter Bridge 已有本机工程候选：进程监管、握手、请求关联、JSONL 分帧、
  限额、超时、POSIX 进程组清理及 Reference Conformance 通过。Windows 原生 Job owner、真实 CLI Adapter 与双平台认证未完成。

## Phase 1：厂商能力探针

- [ ] 选择首个CLI厂商与精确版本，核对许可证、支持平台、安装/更新方式和机器输出文档。
- [ ] 探测非交互运行、流式JSON、工具事件、session ID、resume、cancel、权限交互、模型与usage。
- [ ] 记录命令、输出fixtures、退出码和已知后台子进程，不保存真实凭据。
- [ ] 建立 `docs/architecture/<vendor>-cli-capability-matrix.md` 和厂商Adapter子Spec。

验收：明确每项能力为native/emulated/unsupported，并得出“可产品化”或“仅Experimental”的结论。

## Phase 2：Sidecar Client 与 Supervisor

- [~] 在 `packages/adapter-sidecar` 实现进程启动、initialize 握手、请求关联和通知分发。首轮工程候选
  已覆盖握手、并发/乱序响应和通知；Windows 无受信 owner 时明确失败。
- [~] 实现增量 JSONL 分帧、Schema 校验、背压、长度/缓冲限制、stderr 限长和脱敏。拆分 UTF-8/CRLF、非法帧、
  stderr/行长限制已测；完整背压与输出配额故障矩阵待补。
- [~] 实现启动/请求/空闲/关闭超时和幂等 dispose。请求超时、Run 事件空闲超时、关闭超时和幂等关闭已测；
  完整运行时限及异常终态故障矩阵待补。
- [~] 实现 POSIX 进程组与 Windows 进程树清理，禁止 `shell: true` 和命令字符串拼接。macOS 已测试同组
  子孙进程回收；脱组/忽略信号场景、Windows Job owner 与目标机无残留证据待补，不回退到 PID `taskkill`。
- [~] 使用 Fake Sidecar 覆盖协议污染、半帧、崩溃、超时和僵尸进程。已覆盖大部分通信负例和 POSIX
  子孙进程及本机 Reference Adapter Conformance；完整故障矩阵与 Windows runner 仍待补。
- [x] 新增通用 `SidecarAdapter` Bridge 与无凭据 Reference Sidecar Fixture。正常 Run、响应前 Event、取消、
      AbortSignal 与提前退出通过 `runAdapterConformance`/定向测试；错配、乱序、重复终态、队列溢出及异常退出失败收敛。
      验收：`pnpm --filter @yanbot-harness/adapter-sidecar test:unit`；Windows 和真实厂商仍按独立门禁跟踪。
- [x] Bridge 增加可配置 Run 事件空闲超时，覆盖 Wrapper 存活但不发终态的情况；超时后取消并回收进程。

首轮验证：`pnpm --filter @yanbot-harness/adapter-sidecar test:unit` 与全仓 `pnpm check` 通过；Bridge 新增后
Sidecar 包 28 项单元测试通过。这只证明本机工程候选。

验收：Sidecar实现与Reference进程通过Adapter Conformance Kit；macOS与Windows CI无残留进程。

## Phase 3：通用 CLI Host

- [ ] 首轮工程候选：新增 Host 包与安全 spawn/owner、环境允许列表、受限 stdout/stderr 增量读取、超时/取消及
      版本探针。验证：包内 Fake CLI 正常、输出污染、限额、超时、取消用例与全仓 `pnpm check`。
- [ ] 新增 `packages/adapter-cli-host`，提供安全spawn、版本探测、allowlist环境和临时凭据目录。
- [ ] 建立厂商stdout增量解析接口、stderr诊断接口、退出归一化与输出配额。
- [ ] 实现取消升级、进程树句柄和运行后临时目录清理。
- [ ] 提供Fake Vendor CLI，覆盖CRLF、UTF-8、背压、噪声、无终态和派生子进程。

验收：包内无厂商名分支；安全与故障fixture在macOS、Windows、Linux通过。

## Phase 4：首个厂商 CLI Adapter

- [ ] 新增 `packages/adapter-<vendor>-cli`，锁定支持的CLI版本和manifest。
- [ ] 实现命令/config、机器事件、session、权限、错误和退出码映射。
- [ ] 只对探针确认的能力声明native，其余明确降级。
- [ ] 接入Local Runtime静态允许列表，不向SDK/平台CLI暴露厂商字段。
- [ ] 建立真实凭据保护的手动冒烟与升级门禁。

验收：同一个SDK/平台CLI示例只切换adapterId即可运行；真实能力矩阵与测试结果一致。

## Phase 5：Remote Worker 与双Runtime认证

- [ ] 将同一CLI Adapter安装进Remote Worker/沙箱镜像，锁定CLI版本和摘要。
- [ ] 通过execution grant注入短期凭据与隔离登录目录，禁止在线自更新。
- [ ] 验证取消、Worker崩溃、容器清理、Session恢复和事件重放。
- [ ] 分别记录macOS Local、Windows Local和Linux Remote证据。

验收：四象限架构中的SDK/CLI型、Local/Remote组合共享公共协议；跨租户、凭据和工作区隔离通过。

## Phase 6：交付与运营

- [ ] 明确Wrapper和厂商CLI是打包、单独安装还是镜像内置，并完成许可证评审。
- [ ] 发布manifest、版本兼容矩阵、安装检查、升级/回滚和故障排查文档。
- [ ] 市场/管理端只允许签名Adapter和受支持可执行路径，不接受任意shell配置。
- [ ] 将真实认证状态更新到交付兼容矩阵，不以Sidecar Schema存在代替可用证据。

验收：测试方在干净目标系统按文档完成安装、probe、运行、恢复/能力拒绝、取消和卸载清理。

## 模型节点提醒

本次架构审计与Spec使用 `gpt-5.6-sol + high` 足够。开始Phase 1真实CLI能力探针和Phase 2跨平台进程监管实现时，
建议切换到 `gpt-6-astra + high`。
