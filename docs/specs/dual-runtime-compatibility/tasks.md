# Local / Remote Runtime 双形态兼容任务清单

## 当前状态（2026-09-17）

- [x] 审计总体需求、总体设计、SDK/CLI Spec、当前 contracts 与交付兼容矩阵。
- [x] 明确“一套 SDK/CLI、两种 Runtime”是强制产品要求。
- [x] 冻结需求、架构边界、迁移原则和验收维度。
- [ ] Remote Runtime 尚未实现或认证；当前交付仍为 Local-only Preview。

## Phase 1：中立协议与迁移层

- [x] **P1.1 中立 contracts**：在 `packages/contracts/src/index.ts` 增加 Session/Run/Request/Result 中立
      Schema 与类型；`Local*` 改为带 `@deprecated` 的同对象别名。依赖：Spec 提交。验收：contracts 单测、build、
      typecheck，Schema identity 与 JSON 往返均通过。
- [x] **P1.2 Runtime 描述 contracts**：定义 Runtime Profile、部署 capability、Workspace Source、认证模式和
      protocol discovery Schema。依赖：P1.1。验收：Local/Remote profile 往返、非法组合拒绝、未知 major 可被发现但
      不能被当前资源 Schema 接受。
- [x] **P1.3 版本与兼容周期**：保持 Harness Protocol `1.0.0`；`/v1/*` 为规范路由；preview.4 与 preview.5
      强制保留 `/local/*` 和 `Local*`，最早在有迁移证据的 `0.2.0` 移除。验收：requirements/design 明确记录。
- [x] **P1.4 Local 中立路由**：在 `apps/local-runtime` 实现 `/v1/*`，同一 handler 同时挂载 `/local/*`，旧
      `/local/health` 保持最小响应。依赖：P1.2。验收：两套路由响应等价、认证边界一致、旧 health exact-match 通过。
- [x] **P1.5 边界测试**：覆盖 Schema 往返、旧客户端 JSON/路径兼容、稳定错误码、协议 major 阻断和禁止 404
      transport 猜测。依赖：P1.1-P1.4。验收：contracts 与 local-runtime 定向测试通过。

验收：旧 Local Preview 场景不回退；新客户端不再要求业务代码使用 `Local*`；协议 major 不兼容时明确阻断。

## Phase 2：SDK/CLI 双目标连接

- [x] **P2.1 SDK 目标模型**：在 `packages/sdk` 实现 `RuntimeTarget` 与异步 `AccessTokenProvider`，保留当前
      constructor/fromDaemon/fromRuntime 兼容入口。依赖：P1。验收：类型检查与构造/刷新提供器测试。
- [x] **P2.2 显式握手**：建立 `/v1/health` profile 握手、协议 major 阻断和明确 transport 选择，不使用业务
      404 猜测协议。依赖：P2.1。验收：local target 成功、remote target 无本地启动副作用、未知 major 明确失败。
- [x] **P2.3 分发边界复核**：与 `unified-local-distribution` T3/T4 共用 resolver/managed handle contract；验证
      local facade 与轻量 SDK 的依赖边界，Remote 连接零本地启动副作用。验收：定向依赖/生命周期测试。
- [x] **P2.4 CLI target/profile**：增加互斥 `--remote`、`--profile`、`--profile-file`，实现无密钥版本化 profile
      loader 和环境变量 token provider；Local 规范入口使用 `/v1`，受限 `--runtime` 保持 loopback legacy 兼容。
      依赖：P2.1-P2.3。验收：参数、profile Schema、凭据刷新、握手形态和现有 Local E2E 测试通过。
- [x] **P2.5 安全失败规则**：继续拒绝 `--token`；profile/认证/握手失败不静默 fallback；Remote `run` 在创建
      Session/Grant/Run 前拒绝，不发送本机 cwd、`--workspace` 或 `--cwd`。依赖：P2.4。验收：请求捕获与零本地启动
      副作用测试通过，错误退出码稳定。
- [x] **P2.6 文档与示例**：更新 SDK 示例、CLI 帮助、安装与迁移文档，明确 Remote 服务、交互式登录和远端
      workspace preparation 尚未交付。依赖：P2.4-P2.5。验收：示例 typecheck、文档链接和 CLI help 快照通过。

验收：同一 SDK 示例只替换 target 即可连接两种 Reference Runtime；CLI JSONL 与退出码保持一致。

## Phase 3：双模式 Reference Conformance

- [x] **P3.1 Kit Spec**：冻结 contracts-only driver、首批公共场景、本地专项测试保留边界与 Remote fixture
      延后条件。依赖：P2。验收：requirements/design/tasks 独立提交且不声称 Remote 已实现。
- [x] **P3.2 中立测试客户端**：扩展 `packages/testing` 的 HTTP/SSE client，使其可显式选择 `/v1`，使用中立
      contracts，并保留 `/local` legacy 默认行为。依赖：P3.1。验收：build/typecheck 和旧 Local E2E 通过。
- [x] **P3.3 Conformance Kit**：在 `packages/testing` 定义无 SDK/Vitest/Runtime 依赖的 driver 与
      discovery/resources、run/idempotency、interaction/replay、cancellation 四个场景函数。依赖：P3.2。
      验收：包依赖边界检查与定向单测通过。
- [x] **P3.4 Local driver**：新增 Local `/v1` Reference driver，运行全部公共场景；工作区准备仅在 driver 内使用
      path grant。依赖：P3.3。验收：四场景通过，公共断言无 execution-mode 分支。
- [x] **P3.5 Local 专项回归**：从现有 E2E 移除已抽取的重复断言，保留重启恢复、旧 grant 失效、持久化脱敏、
      timeout 和 interrupted recovery；运行全仓门禁。依赖：P3.4。验收：`pnpm check` 通过。
- [x] **P3.6 Remote Reference fixture**：在远端工作区请求契约可安全表达后，实现不连接真实模型的最小 fixture，
      复用 P3.3 全部场景，不复制断言。依赖：P3.5 与 Remote workspace 子 Spec。
- [x] **P3.7 Remote 安全负例**：覆盖跨租户拒绝、token 过期、持久化事件重放、恶意工作区清单和日志脱敏。
      依赖：P3.6。验收：稳定错误分类和无敏感数据证据。
- [ ] **P3.8 矩阵证据**：将 Local macOS/Windows 与 Remote service 作为独立矩阵项输出证据。依赖：P3.7。
  - [x] 实现严格单平台报告、macOS/Windows CI runner、双目标聚合器与 Fixture/service 身份隔离。
  - [ ] 取得同一提交的 macOS/Windows 实际 CI artifact 与 run URL。
  - [ ] Phase 4/5 完成后取得正式 Remote service 的真实 HTTPS 证据；Fixture 结果不能替代。

验收：Reference Adapter 在 Local 与 Remote 两套后端通过同一组核心断言，没有模式专用公共 API。

## Phase 4：Remote 控制平面与工作区

- [x] 建立 `apps/cloud-server` 认证、组织/用户/设备、Session、Run、execution grant 与审计模块子 Spec。
- [x] 实现 HTTPS API、短期访问令牌、刷新流程和租户作用域查询。
- [x] 实现上传快照与受控 Git 引用的准备、摘要校验、大小限制、TTL 和清理。
- [x] 实现 Run 元数据、事件持久化、SSE 重放和幂等创建。
- [ ] 建立额度、并发和权限预检；失败不得绕过安全边界。

验收：跨用户/组织资源不可见；本机路径被拒绝；网关重启后仍可在保留期内重放事件。

## Phase 5：Worker、沙箱与 CodeBuddy

- [ ] 建立 `apps/cloud-worker` 队列领取、lease、心跳、取消、重试与孤儿任务收敛。
- [ ] 每个 Run 使用非 root 隔离容器和临时工作区，限制 CPU、内存、磁盘、进程、网络和挂载。
- [ ] 仅通过 `adapter-api` 启动 CodeBuddy Adapter，并按 Run 注入短期凭据。
- [ ] 实现 Session 写锁、隔离状态目录、TTL、容器重建恢复与凭据分离。
- [ ] 完成真实 CodeBuddy 远端初始运行、续接、交互、取消、超时和故障恢复门禁。

验收：容器不能读取平台长期密钥、Docker 控制接口或其他租户工作区；所有任务有确定终态并可审计。

## Phase 6：联合交付认证

- [ ] 在 macOS 完成 Local 包与 Remote 目标的 SDK/CLI 全流程测试。
- [ ] 在真实 Windows 10/11 x64 完成 Local 包与同一 Remote 目标的 SDK/CLI 全流程测试。
- [ ] 输出 Local/Remote 能力矩阵、已知限制、回滚方案和测试方使用文档。
- [ ] 仅在证据齐全后更新 `docs/delivery/compatibility.md` 的 Remote 状态。

验收：测试方使用同一个 SDK 包和 CLI 包，仅修改连接 profile 即可选择本机或远端执行；两端终端事件、错误分类
和脚本输出一致。

## 实施门禁

- Phase 1 属于公共协议改动，按 contracts → producer → consumer 顺序实施；本次委托视为已授权按更新后的 Spec
  连续执行，但 Spec 仍必须独立提交后才开始编码。
- Phase 4、5 涉及认证、多租户和沙箱，分别建立模块级子 Spec 与威胁模型。
- 开始 Remote 实现节点时建议切换到 `gpt-6-astra + high`；文档审计与任务拆分使用当前
  `gpt-5.6-sol + high` 足够。
