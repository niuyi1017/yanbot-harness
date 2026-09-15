# 统一本地分发开发步骤

状态：**实现候选已交付，计划未全部完成，正式发布阻断**。T1–T3 三平台机制/归档/签名候选、实际 npm/pnpm/离线与 portable 回归通过；T4 基础生命周期/权限、T6 缓存回退/锁恢复/真实 ENOSPC/Windows 独占故障通过；Mac/Linux OS 阻网通过。强 containment 已证实缺口，T5–T7 正式身份/许可/实机、Windows 阻网及两个正式版本业务回滚仍有门禁。证据见 [verification-evidence.json](verification-evidence.json)。2026-09-15。

同日后续：原生/VM 部署边界已获用户批准，不再等待方案选择。Windows 原子 Job host 的 SDK/签名包与强杀探针已通过；Mac 真实 VM 生命周期及内核 panic 回收通过，产品 guest 集成候选实施中。以 [managed-containment-host/tasks.md](../managed-containment-host/tasks.md) 的分层证据推进 T4；旧兼容路径的否定结果仍有效，完整发布门禁不自动取消。
本文件是 P1D 分发工作流的实施清单；整体进度以 [roadmap](../harness-platform-foundation/roadmap.md) 为准。
`preview.2` 的已有实现/证据不是下列新任务的完成证据。

## T0. 方案确认与发布约束冻结

- [x] 用户确认 local/sdk/runtime 包职责、payload 形态、最低平台矩阵、离线 kit 与分阶段范围。
- [x] 记录现有 Mac P0 制品源提交/摘要，独立提交已确认 Spec 基线 `1fd2e44` 后开始编码；Windows 冻结仍待实机证据。
- [x] T2 产品打包前选择后续 Preview 版本线 `0.1.0-preview.3`；T1 使用独立 scope 与 probe 版本。
- [x] README 等文档也改变 tgz 字节：已切 preview.3，旧 preview.2 ZIP 反复校验摘要未变，未重建/覆盖。
- [ ] 核实新增包名/scope 权限、Registry/镜像、再分发许可、Node 与包管理器精确版本、签名信任根和实机资源；缺失项登记为发布门禁。
- 文件：本目录三份 Spec、foundation roadmap、后续 delivery 说明。
- 前置：无；方案确认记录见 [decision-record](decision-record.md)。
- 验收：评审记录列明接受/调整决定，未虚构发布域名或证书；版本与 `preview.2` 隔离可证明。

## T1. 平台打包与包管理器可行性探针

- [x] 三平台隔离 staging 的 facade/meta/platform export、npm 10.9.8/pnpm 11.10.0 optional/os/cpu/libc/ignore-scripts 机制通过。
- [x] frozen-lock 装配、资源/peer/optional 图、零链接与许可证盘点通过；盘点不等于再分发批准。
- [x] 同一 Mac fixture tgz/原始 lock 在三平台消费；空缓存离线、缺包/Registry 拒绝诊断通过。
- [x] manifest/resolver、tar-stream 3.2.1、限值、缓存/IPC 契约落地；差异先记 decision-record。
- 历史本机证据见 [probe-results](probe-results.md)；后续跨系统运行已取得，不能把历史“未运行 CI”说明当作当前状态。
- [x] T1b 同一 kit/tgz/原始 lock export→import（18/18）及 Mac producer→三平台 consumer CI 均已通过。
- [x] T1b 验证 hoisted deploy 与仅 `.bin` Node 链接的相对 exec shim，得到零链接候选目录；比对逐包资源/实际依赖上下文、搬迁后 Reference 与 CLI shim。新增审计单测覆盖资源/版本/peer 错接、重复副本和越界链接。
- [x] T1c 本机发布 metadata 归一化：只移除六项 pnpm metadata，归一化十份自有 manifest，其余 6,267 文件保持原字节；零本地依赖引用/链接，资源与解析图对比、搬迁后的 Reference Run/close 通过。独立探针单测累计 17 项。
- [x] T1c 明确 [artifact-contract](artifact-contract.md) 的 manifest/files/signature/resolver/IPC 字段与候选大小限值；仅为实施契约，不算生产签名/解包/生命周期已实现。
- [x] T1d 本机：锁定 tar-stream 3.2.1，新增 scripts/lib/runtime-archive-probe.mjs 与独立攻击测试；验证有界压缩快照/USTAR framing/清单/取消及失败清理。完整目录 archive round-trip 与搬迁后 Reference 通过；复用 T1c 归一化/资源审计，不改旧 release 构建器。前置 T1c，验收 pnpm test:probes、pnpm probe:runtime-archive 及 pnpm check；跨平台执行另记。
- T1 机制探针通过不等于正式发布；实际冷启动认证、完整生命周期、厂商许可/生产身份与实机验收仍在 T3–T7 收口。
- 文件：`scripts/test-distribution-packaging.mjs`、`scripts/probe-runtime-deploy.mjs`、`scripts/lib/{deploy-probe-audit,normalize-runtime-staging}.mjs` 及对应单测、`.github/workflows/distribution-probes.yml`、本目录契约/探针记录；fixtures/完整 deploy 隔离生成，不提交产品制品。
- 前置：T0 的产品方案确认；真实 Registry 缺失可使用本地测试 Registry，签名使用标明的测试密钥。
- 验收：Mac/Windows 空目录探针输出安装依赖图、实际下载包和 hash；明确不支持的组合；不可把本机一种布局通过当作跨平台通过。

## T2. Runtime 平台包与确定性 release staging

- [x] 本机首个平台候选：frozen deploy→相对 shim→归一化→SBOM/清单→临时 Ed25519 签名→npm tgz→校验/缓存→新 IPC Reference health/close 通过。证据见 implementation-evidence-t2t3.json；dirty 工作树与测试签名只算开发候选，不是冻结 release。
- [x] 新公共包版本、contracts 与 Runtime/CLI 版本入口校验；旧 preview.2 archive 未重建。完整 pnpm check 通过，45 个原归档/审计测试继续共用同一 codec。

- [x] 完整 Runtime payload、manifest/signature/SBOM 平台 npm tgz 与 portable archive 均已构建/验证；三平台 portable Reference CI 通过。
- [x] 公共包/平台包校验统一 release descriptor、源提交/lock；不发布内部 Adapter/Core 包。
- [x] common tgz 在 CI 只构建一次，三平台消费同一摘要；文件允许集、路径/凭据和依赖边界检查已接通。
- 文件：`scripts/build-runtime-bundle.mjs`、`build-client-packages.mjs`、`assemble-release.mjs`、`check-release-artifacts.mjs`、`check-common-package-hashes.mjs`、`scripts/lib/*`、Runtime 版本入口、CI；新增平台包模板目录。
- 前置：T1。
- 验收：`pnpm check`，新平台包 build/check，解包后零 workspace 协议/外部 symlink/凭据，payload 运行资源齐全；旧 Preview portable 回归通过。

## T3. Resolver、本地 facade 与兼容 API

- [x] runtime/local 与 SDK 注入已实现；Runtime 包 16 项（本机 15 通过、Windows 专用项跳过；其独占测试已远端通过）、SDK 30 项、local 3 项；权限/父死亡依真实平台语义记录。
- [x] 签名/版本/target/material/fileList/payload 校验、私有摘要缓存、内核锁、最小默认环境；统一启动 deadline 覆盖迟到 resolver 与无响应 health。正式根保持空，不自动信任制品内公钥。
- [x] 三平台实际 npm/pnpm 新 local 包安装、四种 Reference 场景、SDK-only 与缺包/401 已通过；完整故障/升级认证仍未完成。

- [x] `packages/runtime` 固定映射、manifest export、验签/摘要、受限展开、原子缓存、锁与独立启动器。
- [x] SDK 可选 resolver/Node 注入与统一 deadline；保留旧路径/env/options/handle，错误分类增量兼容。
- [x] `packages/local` 重导出 SDK、装配 resolver/最小环境，无 import 时启动副作用。
- [x] 严格 pnpm 布局、缓存空格/中文/特殊字符路径、错误 manifest、缓存损坏和目录逃逸用例通过；POSIX 只读平台内容不写安装目录单测通过。
- [x] 整套真实安装矩阵使用中文/空格/`&`/`#` 根路径，本机及三平台 CI `34969665142` 通过。
- [ ] Rosetta 实机拒绝及 Windows 只读安装目录 ACL 场景尚未认证。
- 文件：`packages/{local,runtime}/src` 与 test/manifests、`packages/sdk/src/{managed-runtime,index,transport}.ts`、SDK tests、`pnpm-workspace.yaml`、根 lockfile、boundary checker、示例。
- 前置：T1、T2 的 artifact contract；生产签名身份尚缺时只做测试签名，不开放默认未签包。
- 验收：`pnpm --filter @yanbot-harness/sdk test:unit`、新 local/runtime 单测、`pnpm check`；新 facade Reference 可启动；SDK-only 依赖图无任何 Runtime；显式路径优先且失败无 fallback。

## T4. 双平台生命周期与权限收口

- [x] 进一步覆盖父死亡 watchdog、真实 IPC 断开、未知 schema 保留、descriptor 有界读取/ACL；Windows 父被强杀与正常 IPC 清理分开测试。
- [ ] 强 containment 已证实缺口：Mac `pnpm probe:managed-containment` exit 1/status blocked，detached 后代在 close 后存活。探针安全回收自身 fixture，不把其他绿灯当作该保证通过。
- [x] 故障后的隔离宿主选择、复用点、拒绝的 PID 扫描方案与权限边界已写入 design 的 T4 补充；未擅自安装原生服务/沙箱或缩减原验收承诺。

- [x] IPC hello/ready/shutdown、版本/PID/instanceId、启动/关闭期限、并发隔离、IPC 丢失、组内顽固孙进程、私有状态拒绝通过；SDK 累计 30 项。
- [x] Windows cache ACL/resolver 单测与真实包 managed startup 已远端通过；state/descriptor 使用固定系统 .NET API，完整 containment 单列阻断。

- [ ] 新 Runtime 增加 versioned private IPC，父断开触发正常取消/关闭；SDK graceful close 后有界强制回收整个 owned tree。
- [ ] 覆盖 POSIX 进程组、Windows owned tree、PID 复用风险、Runtime 失去响应和厂商孙进程；必要时先补 containment/watchdog 设计，再实现相关 helper。
- [x] Windows state/descriptor/cache ACL、状态/缓存 ownership 分离和失败保留实现并通过三平台基础回归；父强杀可能保留旧 descriptor，不能误认为它仍是可连接服务。
- [x] 新协议与旧显式路径分开；当前 SDK 对冻结 preview.2 Runtime 的 Reference Run/close 本机通过；后续 target 必须复用现有 handle。
- 文件：`apps/local-runtime/src/{main,server,managed-control}.ts`、SDK managed runtime、平台 lifecycle/ACL 模块、Fake Vendor fixtures、release lifecycle 测试。
- 前置：T3；新 control contract 不修改 descriptor schema 1。与 P2 Sidecar 复用进程树基础能力时保持单一 ownership。
- 验收：Mac 与 Windows 的正常关闭、父进程崩溃、Runtime 强杀、超时、并发、未响应孙进程测试；受管树无残留且其他 Daemon 不受影响。若某条只能尽力清理，阻断该保证的发布声明。

## T5. 签名、Registry 与发布策略

- [x] 测试 Ed25519 平台/kit 签名、未知/篡改/版本拒绝、轮换/撤销后缓存拒绝，以及实际 fixture Registry 安装已实现。
- [x] docs/delivery/unified-release-gates.md 明确正式发布顺序、token 分权、信任分发/轮换、许可、不可变版本和人工授权；默认 CI 不执行发布。

- [ ] 集成正式发布清单和 payload 签名，固定信任根/keyId，验证篡改、未知签名、轮换、重放旧版和 Node/protocol mismatch。
- [ ] 校验私有 scope/平台包 ACL、第三方镜像闭包、不可变版本及发布顺序；分别验证安装 token 和发布 token 的权限。
- [ ] 检查原生 payload 组件签名与再分发要求；JS/tgz 用包签名/attestation，不伪造原生签名。
- 文件：release manifest/signature tooling、CI protected release workflow、`packages/runtime` 信任配置、交付与许可证说明。
- 前置：T2、T3；真实 Registry/签名身份/再分发审核为外部发布前置。
- 验收：测试 Registry 全流程安装，所有 mandatory target 实际可取；篡改被拒；日志/产物/Runtime 环境中无 Registry token；真实发布另按授权执行。

## T6. 离线套件与手动升级回滚

- [x] 本机实际公共闭包 18 包 + 平台包，签名 kit 与显式 fresh-consumer 安装器；验签后快照 tgz，保留相对 file 锁依赖。原有项目拒绝覆盖。
- [x] 本机 npm/pnpm local Reference 文本/权限/提问/取消、SDK-only 无 Runtime 下载、optional 缺失与平台 401 诊断；空 npm cache 的 offline/ignore-scripts 安装与 Reference Run/close 通过。7 组真实包用例见 implementation-evidence-t6.json。
- [x] 离线完整性/拒绝覆盖、CLI 路径别名与 Windows shim 独立测试现为 9 项，连同归档/审计共 54 项；真实包 CI 共用一次构建的 common tgz。
- [x] 小型缓存 fixture V1→V2→V1、打开旧文件、锁超时/持有者死亡、占用路径保留和未知 state schema 拒绝已覆盖；Mac/Linux OS 阻外网安装通过。
- [x] Linux 独立 tmpfs 实际 ENOSPC、部分文件清理/旧缓存保留，以及 Windows FileShare.None 占用后拒绝、释放恢复/字节保留已在 CI 通过。
- [ ] 两个正式冻结 release 的完整业务回滚和 Windows OS 阻网仍待认证；生产身份/企业 Registry 不因 fixture 通过解除。

- [x] 已生成平台闭包 tgz、签名清单、显式安装器与 consumer；错误平台/缺失/篡改/重复/越界与已有工程覆盖均有拒绝测试。
- [ ] 验证空 npm cache + 阻网 + `--ignore-scripts` 的安装、首次展开/Reference；必要的元数据和 lock 支持必须随 kit 提供。
- [ ] 验证 V1→V2→V1、活动 V1 缓存保留、磁盘失败、Windows 占用、只读状态/Schema 不兼容和用户配置保留。
- 文件：新增 `scripts/build-offline-kit.mjs`、交付安装器模板、`scripts/test-release-clean-room.mjs` 及新分发测试、`docs/delivery/unified-local-installation.md`。
- 前置：T2–T5；测试使用测试签名，正式 kit 需正式信任根。
- 验收：clean-room 网络请求为零、依赖闭包可追溯、未安装 pnpm 的消费者可用；回滚保留 workspace/BYOK，坏包不覆盖旧包。

## T7. 联合认证与文档切换

- [ ] CI 增加下表门禁，记录版本/平台/场景/摘要，不把 Reference 成功算作真实厂商认证。
- [ ] Mac 与 Windows 10/11 实机通过新 local 安装路径的 CodeBuddy 核心验收；Linux 保持 Reference 回归，Intel Mac 另立认证记录。
- [x] 新指南标为 preview.3 实现候选并列出限制；旧 preview.2 指南保留，README/SDK/Runtime/compatibility/handoff/architecture/roadmap/managed Spec 同步，不冒充正式发布。
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
