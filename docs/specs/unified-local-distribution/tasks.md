# 统一本地分发开发步骤

状态：**方案已确认，全部实现任务未开始**。2026-09-15。
本文件是 P1D 分发工作流的实施清单；整体进度以 [roadmap](../harness-platform-foundation/roadmap.md) 为准。
`preview.2` 的已有实现/证据不是下列新任务的完成证据。

## T0. 方案确认与发布约束冻结

- [x] 用户确认 local/sdk/runtime 包职责、payload 形态、最低平台矩阵、离线 kit 与分阶段范围。
- [ ] 固定 P0 源提交/制品摘要；选择后续 Preview 版本线，独立提交本 Spec 基线后开始编码。
- [ ] README 等文档变化也会改变 tgz 字节：P0 重建只从其冻结 ref 执行，本规划后的新制品须先切换新版本，不能以 `preview.2` 身份覆盖既有包。
- [ ] 核实新增包名/scope 权限、Registry/镜像、再分发许可、Node 与包管理器精确版本、签名信任根和实机资源；缺失项登记为发布门禁。
- 文件：本目录三份 Spec、foundation roadmap、后续 delivery 说明。
- 前置：无；当前仅已完成审计与草案文档。
- 验收：评审记录列明接受/调整决定，未虚构发布域名或证书；版本与 `preview.2` 隔离可证明。

## T1. 平台打包与包管理器可行性探针

- [ ] 在隔离 staging 验证 facade/meta/platform export 定位，以及 npm 10.9.8（拟定）/pnpm 11.10.0 的 optional、os/cpu/libc、脚本禁用行为。
- [ ] 确定 frozen-lock Runtime 生产依赖装配方式，检查厂商辅助程序/资源、peer/optional 闭包、解引用和许可证。
- [ ] 用最小测试包验证同一公共 tgz 跨平台安装、Mac 产生的 lockfile 在 Windows 重装、空缓存离线 kit、平台缺包/Registry 拒绝诊断。
- [ ] 冻结 manifest、resolver 类型、解包库精确版本、大小限值、缓存权限与生命周期 control protocol；不可行之处先修 Spec。
- 文件：新增 `scripts/test-distribution-packaging.mjs`、测试 fixtures（隔离产物不提交）、本目录设计探针记录；精确文件名为目标。
- 前置：T0 的产品方案确认；真实 Registry 缺失可使用本地测试 Registry，签名使用标明的测试密钥。
- 验收：Mac/Windows 空目录探针输出安装依赖图、实际下载包和 hash；明确不支持的组合；不可把本机一种布局通过当作跨平台通过。

## T2. Runtime 平台包与确定性 release staging

- [ ] 复用 Runtime 源生成完整 payload，打包成包含 manifest/signature/SBOM 的平台 npm tgz，继续生成 portable archive。
- [ ] 公共包/平台包统一从 release descriptor 取得版本、源提交、lock 摘要；生成过程不发布内部 Adapter/Core 包。
- [ ] 保持 common tgz 只构建一次；扩展 artifact allowlist、secret/source/path 扫描和按层依赖断言。
- 文件：`scripts/build-runtime-bundle.mjs`、`build-client-packages.mjs`、`assemble-release.mjs`、`check-release-artifacts.mjs`、`check-common-package-hashes.mjs`、`scripts/lib/*`、Runtime 版本入口、CI；新增平台包模板目录。
- 前置：T1。
- 验收：`pnpm check`，新平台包 build/check，解包后零 workspace 协议/外部 symlink/凭据，payload 运行资源齐全；旧 Preview portable 回归通过。

## T3. Resolver、本地 facade 与兼容 API

- [ ] 新增 `packages/runtime`：固定映射、manifest export、签名/摘要校验、受限展开、同卷原子缓存、并发锁、独立启动器。
- [ ] SDK 增加可选 resolver/Node 可执行文件注入与统一启动 deadline；保留旧路径/env/options/handle，错误分类增量兼容。
- [ ] 新增 `packages/local`，重导出 SDK，为 managed 调用装配默认 resolver/最小环境，不增加模块加载时副作用。
- [ ] 完成严格 pnpm 布局、只读 node_modules、空格/中文/特殊字符路径、Rosetta、错误 manifest、缓存损坏和目录逃逸用例。
- 文件：`packages/{local,runtime}/src` 与 test/manifests、`packages/sdk/src/{managed-runtime,index,transport}.ts`、SDK tests、`pnpm-workspace.yaml`、根 lockfile、boundary checker、示例。
- 前置：T1、T2 的 artifact contract；生产签名身份尚缺时只做测试签名，不开放默认未签包。
- 验收：`pnpm --filter @yanbot-harness/sdk test:unit`、新 local/runtime 单测、`pnpm check`；新 facade Reference 可启动；SDK-only 依赖图无任何 Runtime；显式路径优先且失败无 fallback。

## T4. 双平台生命周期与权限收口

- [ ] 新 Runtime 增加 versioned private IPC，父断开触发正常取消/关闭；SDK graceful close 后有界强制回收整个 owned tree。
- [ ] 覆盖 POSIX 进程组、Windows owned tree、PID 复用风险、Runtime 失去响应和厂商孙进程；必要时先补 containment/watchdog 设计，再实现相关 helper。
- [ ] 实现 Windows state/descriptor/cache ACL 校验，临时状态/持久状态/缓存 ownership 分离，以及清理失败保留诊断。
- [ ] 保留旧 Runtime 显式路径兼容行为，新包必须协商 managed protocol；将来的 `local-managed` target 复用 handle 的 close 所有权。
- 文件：`apps/local-runtime/src/{main,server,managed-control}.ts`、SDK managed runtime、平台 lifecycle/ACL 模块、Fake Vendor fixtures、release lifecycle 测试。
- 前置：T3；新 control contract 不修改 descriptor schema 1。与 P2 Sidecar 复用进程树基础能力时保持单一 ownership。
- 验收：Mac 与 Windows 的正常关闭、父进程崩溃、Runtime 强杀、超时、并发、未响应孙进程测试；受管树无残留且其他 Daemon 不受影响。若某条只能尽力清理，阻断该保证的发布声明。

## T5. 签名、Registry 与发布策略

- [ ] 集成正式发布清单和 payload 签名，固定信任根/keyId，验证篡改、未知签名、轮换、重放旧版和 Node/protocol mismatch。
- [ ] 校验私有 scope/平台包 ACL、第三方镜像闭包、不可变版本及发布顺序；分别验证安装 token 和发布 token 的权限。
- [ ] 检查原生 payload 组件签名与再分发要求；JS/tgz 用包签名/attestation，不伪造原生签名。
- 文件：release manifest/signature tooling、CI protected release workflow、`packages/runtime` 信任配置、交付与许可证说明。
- 前置：T2、T3；真实 Registry/签名身份/再分发审核为外部发布前置。
- 验收：测试 Registry 全流程安装，所有 mandatory target 实际可取；篡改被拒；日志/产物/Runtime 环境中无 Registry token；真实发布另按授权执行。

## T6. 离线套件与手动升级回滚

- [ ] 生成当前平台闭包 tgz、签名清单、显式安装器和独立 consumer 样例；禁止其他平台 tgz 混装及已有项目静默覆盖。
- [ ] 验证空 npm cache + 阻网 + `--ignore-scripts` 的安装、首次展开/Reference；必要的元数据和 lock 支持必须随 kit 提供。
- [ ] 验证 V1→V2→V1、活动 V1 缓存保留、磁盘失败、Windows 占用、只读状态/Schema 不兼容和用户配置保留。
- 文件：新增 `scripts/build-offline-kit.mjs`、交付安装器模板、`scripts/test-release-clean-room.mjs` 及新分发测试、`docs/delivery/unified-local-installation.md`。
- 前置：T2–T5；测试使用测试签名，正式 kit 需正式信任根。
- 验收：clean-room 网络请求为零、依赖闭包可追溯、未安装 pnpm 的消费者可用；回滚保留 workspace/BYOK，坏包不覆盖旧包。

## T7. 联合认证与文档切换

- [ ] CI 增加下表门禁，记录版本/平台/场景/摘要，不把 Reference 成功算作真实厂商认证。
- [ ] Mac 与 Windows 10/11 实机通过新 local 安装路径的 CodeBuddy 核心验收；Linux 保持 Reference 回归，Intel Mac 另立认证记录。
- [ ] 将新交付指南从“目标”切换到实际版本；保留 preview.2 指南供旧用户；同步 README、SDK/Runtime README、compatibility、handoff、architecture、foundation roadmap 与 managed Spec 状态。
- 文件：`.github/workflows/*`、release test scripts、上述文档；若 P1 同时合入则联合验证 RuntimeTarget 连接/关闭及旧 transport。
- 前置：T3–T6；真实 Mac/Windows 机器与各自 BYOK；Remote 真服务认证不作为本地安装发布的依赖。
- 验收：`pnpm check`、release build/check/Reference、受控 CodeBuddy gate、离线/回滚/lifecycle gate 全部满足目标声明；所有证据对应同一冻结 release。

## 最低测试矩阵

| 维度       | 必须覆盖                                                                                          | 发布判定                                             |
| ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| OS/CPU     | macOS arm64；Windows Server 2022 + Windows 10/11 x64；Linux x64 glibc Reference                   | Mac/Windows 不可用 Linux CI 替代；其余架构明确拒绝   |
| 安装器     | npm 精确版本；pnpm 11.10.0 普通/隔离布局；Mac→Windows frozen lock                                 | 正常只安装匹配 payload；显式多架构下载不改变执行选择 |
| 离线/企业  | 空 cache、阻网、ignore-scripts、私有 Registry/镜像、401/404、代理/CA                              | 正确安装或可诊断失败，无隐藏下载                     |
| 依赖边界   | local；sdk-only；runtime-only；CLI；混合两版本 SDK                                                | sdk-only 不含 payload，local 不复制业务客户端        |
| 发现/路径  | explicit/env/resolver 优先级、包 export、只读 node_modules、空格/中文、长路径失败提示、Rosetta    | 无路径猜测、跨架构执行或 silent fallback             |
| 校验/缓存  | 版本/签名/摘要错误、tar traversal/link/ADS、并发展开、损坏缓存、磁盘满、无权限                    | 启动前拒绝，旧版本保持可用                           |
| 生命周期   | readiness/health 超时、退出/崩溃、重复 close、并发实例、父死亡、Runtime 强杀、顽固孙进程          | 整树清理证据，其他进程与持久状态保留                 |
| 凭据       | file BYOK、显式 inline 环境边界、token 泄漏扫描、Windows ACL、最小环境                            | 无 secret 进入协议/日志/包，权限失败关闭             |
| 业务与兼容 | Reference Session/Run/Event/Interaction/cancel；旧 preview.2 显式路径/Daemon；真实 CodeBuddy 核心 | 公共调用语义保持；未实测能力不扩大                   |
| 升级/回滚  | V1/V2 共存、锁文件回退、持久状态 Schema、占用文件、失败中断                                       | 不覆盖活跃制品，不丢工作区/用户配置                  |

## 分期与后续工作

T0→T1→T2→T3→T4 为本地运行主线；T5 在制品契约稳定后推进，T6/T7 收口交付。T1 的机制风险先验证，再投入正式包和生命周期改造。

共享 Daemon 的 install/update/start/status/stop/restart、自动 GC、OS 密钥 Provider、Electron 宿主认证和 Intel Mac 包列为后续独立切片，承接 `managed-local-runtime` tasks 5–8；不以本期安装体验名义一次实现全部 Runtime Manager。

模型提醒：方案确认后，T1/T3/T4/T5 建议继续 `gpt-6-astra + high`；普通文档与稳定脚本整理可使用 `gpt-5.6-sol + high`。出现平台 containment 或发布信任边界改变时先复核 Spec，再编码。
