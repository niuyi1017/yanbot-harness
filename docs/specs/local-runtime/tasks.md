# M2 Local Runtime 任务拆解

## 进度快照（2026-09-07）

- 已完成：LR-T1本地Session、Run、Workspace Grant、游标和错误contracts及测试。
- 已完成：LR-T2 Managed Run控制器、Interaction幂等/协议约束和Permission Engine。
- 已完成：LR-T3文件型LocalStateStore、持久化脱敏、重启中断恢复与Event Hub游标重放。
- 已完成：LR-T4 Bearer/浏览器绑定认证、Origin隔离与opaque Workspace Grant边界。
- 已完成：LR-T5 Config Loader五层合并、安全读取与Extension Kit只读发现/能力协商。
- 下一步：LR-T6 Run Supervisor与Local API。

## 1. 执行规则

- 本Spec提交并通过Review后才能写实现代码。
- 按`contracts → core/公共包 → Store/Security → Runtime → E2E`顺序执行。
- 每项任务原则上形成一个可独立Review的提交；发现设计偏差时先更新Spec。
- 普通CI不得读取真实凭据或访问模型网络。
- 真实CodeBuddy探针不阻塞M2离线实现，但继续阻塞生产可用声明。

## 2. 需求追踪矩阵

| 需求                     | 任务                              |
| ------------------------ | --------------------------------- |
| LR-R1 Runtime生命周期    | LR-T5、LR-T8                      |
| LR-R2 本地认证与网页隔离 | LR-T4、LR-T8                      |
| LR-R3 工作区授权         | LR-T4、LR-T8                      |
| LR-R4 Session与Run       | LR-T1、LR-T2、LR-T6               |
| LR-R5 SSE与重放          | LR-T3、LR-T6、LR-T8               |
| LR-R6 Interaction        | LR-T2、LR-T6、LR-T8               |
| LR-R7 LocalStateStore    | LR-T3、LR-T8                      |
| LR-R8 Permission Engine  | LR-T2、LR-T6                      |
| LR-R9 Config Loader      | LR-T5、LR-T6                      |
| LR-R10 Extension发现     | LR-T5、LR-T6                      |
| LR-R11 Adapter与模型     | LR-T2、LR-T6                      |
| LR-R12 错误与日志        | LR-T1、LR-T3、LR-T4、LR-T6、LR-T8 |

## LR-T1. 扩展本地协议Contracts

**依赖**：本Spec获批。

**文件**：

- `packages/contracts/src/index.ts`。
- `packages/contracts/test/contracts.test.ts`。

**工作内容**：

- 新增LocalSession、LocalRun、状态、创建请求、Workspace Grant、游标和LocalApiError Schema。
- 冻结状态枚举、时间格式、ID约束和HTTP边界的严格字段校验。
- 保持`RunRequest`作为Adapter内部公共请求；本地创建请求不允许直接提交绝对`cwd`。

**验收**：

- 所有新增结构通过JSON往返测试。
- 非法状态、未知字段、绝对`relativeCwd`和厂商专有字段被拒绝。
- `contracts`不依赖HTTP框架、Node文件系统或具体Adapter。

## LR-T2. 建立Managed Run与Permission Engine

**依赖**：LR-T1。

**文件**：

- `packages/harness-core/src/index.ts`及测试。
- `packages/permission-engine/`。
- 必要的`packages/testing`辅助工具。

**工作内容**：

- 新增`ManagedRunController`，支持events、respond、cancel和dispose。
- 将现有事件不变量集中到controller，并让`executeAdapterRun()`复用。
- 实现工具风险分类和read-only/interactive/auto-edit决策表。
- 对能力不匹配、重复响应、过期Interaction和取消竞态返回稳定错误。

**验收**：

- Reference Adapter覆盖成功、失败、permission、question、cancel和重复释放。
- 乱序、跨Run事件、双终态和终态后事件被拒绝。
- 未识别工具不自动放行；公共API不存在`bypassPermissions`。

## LR-T3. 实现LocalStateStore与Event Hub

**依赖**：LR-T1。

**文件**：

- `apps/local-runtime/src/local-state-store.ts`。
- `apps/local-runtime/src/event-hub.ts`。
- `apps/local-runtime/src/redaction.ts`。
- 对应测试与testing fixtures。

**工作内容**：

- 定义Store接口并实现版本化JSON/JSONL文件后端。
- 实现原子元数据写入、串行事件append、事件游标读取和先持久化后广播。
- 实现尾部不完整行恢复、中间损坏报告和启动时未完成Run收口。
- 实现持久化与日志脱敏、文件/目录权限和大小限制。

**验收**：

- 并发append保持sequence顺序且没有破损行。
- `Last-Event-ID`能从准确位置重放并衔接实时事件。
- 模拟进程中断后Run被标为interrupted并具有连续终态事件。
- 状态目录扫描不包含Token、Cookie、凭据、环境变量或fixture绝对路径。

## LR-T4. 实现认证与Workspace Grant

**依赖**：LR-T1。

**文件**：

- `apps/local-runtime/src/auth.ts`。
- `apps/local-runtime/src/workspace-grants.ts`。
- 对应安全测试。

**工作内容**：

- 实现启动Token、Bearer/Cookie认证、Origin校验和一次性浏览器交换。
- 实现opaque Workspace Grant Registry、TTL、撤销和secret hash。
- 使用`realpath`和路径段关系验证授权根与`relativeCwd`。
- 提供可注入clock、random和文件系统边界以支持确定性测试。

**验收**：

- 伪造、过期、重复交换和Origin不匹配均默认拒绝。
- `..`、绝对relativeCwd、同前缀旁路和符号链接越界测试通过。
- Runtime重启后旧Workspace Grant不可用。
- 错误和日志不输出Token或绝对路径。

## LR-T5. 建立Config Loader与Extension Kit

**依赖**：LR-T1、LR-T4。

**文件**：

- `packages/config-loader/`。
- `packages/extension-kit/`。
- 对应Schema、fixtures和测试。

**工作内容**：

- 实现五层配置、固定优先级、深合并、数组替换、null tombstone和原型污染防护。
- 区分adapterConfig、publicSummary、credentialRefs和extension selections。
- 定义MCP/Skill/Agent/Hook Descriptor并从显式受信根只读发现。
- 对照Adapter capabilities计算有效配置；unsupported必须明确失败。

**验收**：

- 配置优先级和冲突行为通过表驱动测试。
- project/local源无法越过Workspace Grant读取文件。
- MCP敏感字段和Skill绝对路径不会出现在public summary。
- 当前CodeBuddy选择extension时稳定返回`CAPABILITY_UNSUPPORTED`。

## LR-T6. 实现Run Supervisor与Local API

**依赖**：LR-T2、LR-T3、LR-T4、LR-T5。

**文件**：

- `apps/local-runtime/src/app.ts`。
- `apps/local-runtime/src/run-supervisor.ts`。
- `apps/local-runtime/src/adapters.ts`。
- `apps/local-runtime/package.json`与tsconfig。
- API测试。

**工作内容**：

- 建立health、auth、workspaces、sessions、runs、events、interactions、adapters、models、config和extensions路由。
- 实现Session单活动Run、全局并发、超时、幂等创建/取消/响应和SSE订阅。
- 通过Registry和Context Provider创建Run级Adapter Runtime。
- 将状态、权限、配置和Capability错误映射为统一HTTP Envelope。

**验收**：

- 所有路由均经过Schema、认证和Origin中间件；health仅暴露最小字段。
- 同一幂等键不重复创建Run，冲突请求返回409。
- SSE断开不取消Run，显式取消和超时各产生唯一终态。
- Runtime源码没有厂商名条件分支和教师业务概念。

## LR-T7. 实现loopback Server与独立进程生命周期

**依赖**：LR-T6。

**文件**：

- `apps/local-runtime/src/server.ts`及入口。
- README本地开发说明。
- 进程生命周期测试。

**工作内容**：

- 只允许`127.0.0.1`/loopback监听并默认使用随机端口。
- 实现`RuntimeHandle`、0600临时启动描述、信号处理和幂等关闭。
- 停止接收新Run，按限时策略结束活动Run并清理描述文件与Adapter资源。
- 生产入口显式注册Adapter并使用allowlist Context Provider。

**验收**：

- 非loopback绑定配置启动失败。
- 启动失败和正常退出均无残留端口、Token文件或活动计时器。
- 描述文件权限、过期和清理行为在支持的平台通过测试。
- 日志只输出可安全展示的origin与版本，不输出访问Token。

## LR-T8. Reference Adapter端到端与阶段门禁

**依赖**：LR-T7。

**文件**：

- `apps/local-runtime/test/runtime-e2e.test.ts`。
- `packages/testing`中的本地API测试客户端与fixtures。
- 根脚本、CI、README和本Spec状态。

**工作内容**：

- 用Reference Adapter覆盖完整HTTP/SSE生命周期、Interaction、resume、cancel、timeout和重启恢复。
- 建立安全回归套件、敏感状态扫描和禁止业务概念/厂商导入检查。
- 在干净检出执行全量门禁并更新总体任务状态。
- 若仍无真实CodeBuddy凭据，明确记录离线通过和真实探针pending，不调用外部模型。

**验收**：

- `pnpm check`与远端Actions通过。
- 端到端测试无网络、无随机竞态、无真实Token费用。
- `rg '@tencent-ai/agent-sdk'`仍只命中`adapter-codebuddy`允许范围。
- `rg -i 'teacher|school|adjustment|report' apps/local-runtime packages/permission-engine packages/config-loader packages/extension-kit`不命中业务实现。
- 文档明确M3可以开始，以及真实CodeBuddy发布门禁是否仍pending。

## 3. 提交建议

1. `feat: define local runtime contracts`
2. `feat: add managed runs and permission engine`
3. `feat: add local runtime state and event replay`
4. `feat: secure local runtime workspace access`
5. `feat: add local config and extension discovery`
6. `feat: expose local runtime api`
7. `feat: add loopback runtime lifecycle`
8. `test: verify local runtime end to end`

实际实现如需合并相邻提交，必须仍保持contracts先于消费者，且每个提交可独立构建与Review。
