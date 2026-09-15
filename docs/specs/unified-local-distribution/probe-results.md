# T1 本机机制探针记录

日期：2026-09-15。状态：**本机子集通过，T1 尚未完成，不构成新包发布认证**。

按 spec-workflow，先提交用户已确认的 Spec（`1fd2e44`），再实现隔离探针。未修改产品 SDK/Runtime 代码、版本或 `preview.2` archives；未 push、publish 或触发远端 workflow。

## 环境与复跑

- 实际宿主：macOS arm64；Node 22.23.1、npm 10.9.8、pnpm 11.10.0。
- 安装探针：`pnpm probe:distribution`。
- Runtime 装配探针：先按仓库要求安装 frozen-lock 开发依赖，再执行 `pnpm probe:runtime-deploy`。该命令先 build，再执行离线 deploy。
- 默认在系统临时目录创建独立运行目录，保留 `report.json` 与 fixtures/deploy 供检查；支持 `--output-dir DIRECTORY`。不要把输出放入受源码检查的目录。
- 版本、脚本 SHA-256、制品 SHA-256、用例结果与局限随报告记录；初轮摘录见 [probe-evidence.json](probe-evidence.json)，续作见 [T1b](probe-evidence-t1b.json)、[T1c](probe-evidence-t1c.json) 与 [T1d](probe-evidence-t1d.json)。历史报告绑定各自脚本摘要，不冒充后来版本的运行结果。
- `.github/workflows/distribution-probes.yml` 提供 Mac arm64 / Windows Server 2022 x64 / Linux x64 的实际宿主入口。T1b 增加 Mac producer，只生成一次 fixture tgz/locks，再传给三个 consumer；单测与报告也纳入流程。**本次没有执行远端 CI**，也不以 Windows Server 代替 Windows 10/11 产品验收。

## 安装机制：16/16 通过

| 检查                | 观察结果                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| npm pack 内容       | opaque gzip 文件保留；根 `node_modules` 被排除，但 `files: ['payload']` 下的嵌套 `payload/node_modules` 被保留 |
| npm/pnpm 平台筛选   | 三个平台均提供 metadata，实际只下载 Mac arm64 平台 tarball；正常 export 定位，pnpm 隔离布局通过                |
| SDK-only            | 不安装、不请求 Runtime；没有因统一 local 入口而污染轻量 SDK 图                                                 |
| 禁用 optional       | 安装可结束，但调用 resolver 得到带平台与恢复建议的缺包错误                                                     |
| Registry 拒绝平台包 | 独立 cache/store，同时拒绝 metadata/tarball；必须观测到拒绝请求，不能用缓存成功伪装测试通过                    |
| 同系统锁文件重装    | npm ci / pnpm frozen lock 在新 node_modules 和新 cache/store 下通过                                            |
| npm 空缓存离线      | 同一套 5 个 local/contracts/sdk/runtime/当前平台 tgz 显式安装通过；Registry 请求 0 次                          |
| 离线闭包缺失        | 只提供 local tgz 时失败，Registry 请求仍为 0 次                                                                |
| Runtime-only        | 无 local/SDK 前置，安装后搬迁至中文、空格、`&` 路径可解析                                                      |
| 安装脚本禁用        | 每个 fixture 自带会失败并写标记的 postinstall；整个测试未生成标记                                              |

首次测试纠正了设计中的一处泛化：不能把根 `node_modules` 的 npm 排除规则套用到所有嵌套目录。保留 archive 方案的依据是完整目录/签名摘要/受限展开边界，已同步到 design。

首次 pnpm 拒绝访问测试也暴露了探针的缓存隔离不足：仅指定 store 不够，已增加独立 `cache-dir` 和拒绝请求断言。报告只保留修正后的通过结果，不把早期失败解释为产品缺陷。

这些包使用独立 `@harness-install-probe` scope、`0.0.0-probe.1` 版本和内存 loopback Registry；payload 是字节保留 fixture，**不是真实 tar 目录、厂商 Runtime 或签名实现**。离线证据来自包管理器 offline 模式与拒绝一切请求的本地 Registry，尚未实施系统防火墙断网认证；真实传递闭包还需包含 Zod/解包库等产品依赖。

## Runtime frozen-lock deploy

本机验证：`pnpm --filter @yanbot-harness/local-runtime deploy --prod --offline --frozen-lockfile --ignore-scripts <临时目录>`。

- 使用当前 frozen-lock store，重用 108 项，下载 0 项；根 lock SHA-256 未变化。
- raw deploy 共 6,280 个普通文件、170,904,475 字节、296 条内部链接；没有指向 staging 外部的链接。
- 搬迁后的普通文件树摘要一致，链接目标仍在新目录内。Reference health、Session/Run、终态 `run.completed` 和关闭后 descriptor 清理通过。
- 未发现 TypeScript、Vitest 或 testing workspace 包落入生产包图；报告记录实际生产包版本、声明的 bin 文件和许可证文件清单。
- 厂商清单观测到 agent-sdk 0.3.254 与 codebuddy-code 2.146.0。后者声明 `SEE LICENSE IN README.md`，前者 manifest 声明 MIT 但此部署目录根未发现独立 LICENSE 文件。此处只是文件盘点，**不推断已获再分发许可**。

重要限制：raw deploy 仍有 9 份 manifest 包含本地依赖引用，虚拟 store 路径和 pnpm 元数据也包含构建机信息。该目录只能作为候选装配输入，不能直接作为最终 payload。新构建器仍需归一化发布 metadata、去除本机路径、生成 SBOM/许可证材料，验证合法链接的解引用和厂商动态资源保留。

## T1b：原始制品/锁转移与零链接装配

### 制品与原始锁转移

- `pnpm probe:distribution --export-kit <不存在的目录>`：生成 fixture tgz、npm/pnpm 原始 lock 和 `kit.json`，16/16 通过。
- `pnpm probe:distribution --import-kit <上述目录>`：校验 kit/包/脚本/锁摘要，直接消费相同 tgz，不重新 pack；18/18 通过。
- exporter/importer 仅使用固定 `127.0.0.1:48731`，保持锁中的 Registry URL 不变；端口占用失败，不改写 lock。两次运行必须先后执行，不在同一主机并行争用端口。
- 新增的两个测试使用新 node_modules/cache/store，以 npm ci / pnpm frozen lock 重装，重装前后锁 SHA-256 一致，只下载本机平台包。
- 本机 sourceTarget/actualTarget 都是 darwin-arm64，报告 `crossHost: false`。CI 已连接 Mac→Windows/Linux，但没有实际远端结果，不能标记跨系统验收通过。
- kit 是受控测试输入，不是签名生产离线包；其摘要用于验证转移一致性，不替代发布身份验证。

### 无链接候选目录与依赖/资源审计

- 增加 `--config.node-linker=hoisted`，继续使用 frozen lock + offline + ignore-scripts，根锁未变。
- 默认 isolated deploy 有 296 条内部链接；hoisted 只剩 `uuidv7`、`which` 的两个 `.bin` Node 链接。用相对 POSIX exec shim 调用原 CLI 文件，避免直接复制文件导致相对 import 失效；其他类型的链接不擅自转换。
- 转换后的候选目录为 6,283 个普通文件、170,901,232 字节、**0 条链接**；搬迁到中文/空格/`&` 路径后目录摘要一致。CLI shim、Reference Session/Run/close 与 descriptor 清理通过。
- 逐包摘要包含嵌入的 cli/动态资源，不只检查 export 入口；同时比对 dependencies/optional/peer 的实际解析上下文，包含同版本不同 peer 的区别。
- 默认布局为 109 个包实例，hoisted 为 110 个，其中 `content-type@1.0.5` 多一个内容/依赖相同的副本。报告分别记录物理副本摘要与去重语义摘要；不据此保证 Node 模块缓存/单例身份一致。
- 新增 7 项审计单测：搬迁一致性、解析版本变化、嵌入资产丢失、重复物理副本、peer 环境错接、缺少 optional/必需 peer、越界链接；接入 `pnpm check`。

候选目录仍有 9 份 manifest 含本地引用，pnpm 元数据也未清理；**不是已签名、已归一化或可发布的最终 payload**。当前大小只用于下一步上限设计，不是最终平台最大体积认证。

## T1c：发布元数据归一化与制品字段

- `pnpm probe:runtime-deploy` 现从 link-free 输入生成独立 normalized 目录，不改变原 deploy。只删除明确列出的六份 pnpm metadata；规范化十份已登记自有 manifest（其中九份原来含本地依赖引用），保留 exports/type 等运行字段，实际依赖锁为已装配精确版本。
- 最终 6,277 个文件、170,732,190 字节；零链接、零本地引用 manifest，已知构建机路径与凭据模式扫描通过。其余 6,267 文件（含第三方 manifest/许可证/嵌入 CLI）逐文件保持原字节；这不是任意编码凭据的完备检测。
- 文件加目录共 7,021 entries；files 清单序列化为 1,304,886 字节；最大文件 12,098,611 字节，最长相对路径 138 UTF-8 字节。本机数据支持候选上限预算，不作为 Windows/Linux 或压缩流认证。
- 归一化前后依赖图与包副本数量摘要一致：110 个实例、109 个去重上下文；此比较忽略 manifest 字节，只能与严格文件变更允许集一起使用。搬迁到中文/空格/`&` 路径后的文件树摘要一致；两个 CLI shim、Reference Session/Run/close 和 descriptor 清理通过。
- 新增十项归一化/安全扫描单测，累计 17 项探针单测。覆盖目标防覆盖、重复归一化、未知 pnpm 内容、依赖缺失/漂移、符号链接、非法路径、大文件/二进制路径标记与凭据拒绝。
- 两次初轮完整运行分别被 TypeScript 诊断标识符中的 ck\_ 子串、jose 中的 PEM 格式头误报拦截。规则改为前缀边界/私钥编码体识别，并加正反回归；未删改第三方字节，也未增加包级扫描豁免。失败脚本摘要和最终成功摘要均记录在 T1c evidence 中。
- [artifact-contract](artifact-contract.md) 固定 v1 字段、逐文件清单、签名输入字节、候选资源限制、resolver 最小类型及 IPC 消息序列；对应校验器、解包器、缓存权限及生命周期仍需后续实现/验证。
- 完整装配探针结束后顺序执行 `pnpm check`，格式/lint/依赖边界/build/typecheck/全部单测及 17 项探针测试通过。未修改 SDK/Runtime 产品代码或原有测试超时；旧 preview.2 archive 摘要仍为 decision-record 的冻结值。

## T1d：受限归档、清单验证与取消清理

- 锁定 tar-stream 3.2.1（MIT）为根开发依赖，ignore-scripts 安装；Registry 返回的包 integrity 与官方 npm Registry 一致。根 lock 只增加该开发工具闭包，不修改原生产依赖版本；本机 Runtime 实际依赖图与 T1c 相同。
- 从新 frozen-lock deploy→归一化目录生成 USTAR/gzip 测试 archive。压缩包 53,307,040 字节（约 50.8 MiB），tar 流 176,051,200 字节，清单 1,304,886 字节/7,021 entries；均在候选上限内。完整摘要及实际库源码摘要见 [T1d evidence](probe-evidence-t1d.json)。
- 从压缩快照展开后 6,277 文件、170,732,190 字节；包含执行标志的 inventory SHA-256 与 T1c 完全一致。搬迁后 CLI shim、Reference Session/Run/close 和 descriptor 清理通过，不等于真实厂商或跨平台认证。
- 单机打包 30,896 ms、展开 8,690 ms。探针打包计时包括目录扫描；展开计时包括压缩快照/校验/展开/提交，不包括后续额外 inventory 扫描和 Runtime 启动。这不是冷磁盘统计或 15 秒完整首启保证；T3 仍需把验签、缓存校验、启动/health 纳入同一 deadline 测量。
- 归档安全测试覆盖：清单 digest/canonical JSON/大小/数量、路径穿越与别名、Windows 非法名称、符号/硬链接、PAX/global PAX/GNU/稀疏/设备/FIFO、异常数字/权限/checksum、文件 hash/零 padding/双结束块、截断/重复/尾随数据、gzip CRC/ISIZE/拼接 member、展开炸弹、逐字节分片，以及预取消、超时、观察到文件写入后取消和并发独立目录。失败后校验本次容器消失、已有 sentinel 不变，不给任意输入调用系统解包器。
- 首版只接受可由 builder 表达的 USTAR 子集；需要 PAX 的非 ASCII 内部资源名/过长路径被拒绝，不静默改名。目标父目录中文/空格/`&` 已实测，与内部资源命名能力分开声明。
- `pnpm probe:runtime-archive` 在现有 deploy 探针基础上增加归档/展开环节，CI matrix 已切换到此入口；原 `probe:runtime-deploy` 保留。本次未推送或运行远端 CI，Windows/Linux 结果仍待取得。
- 完整归档探针结束后顺序运行 `pnpm check` 全部通过，含新增 28 项归档测试、累计 45 项探针测试。没有修改 SDK/Runtime 产品实现、原有测试超时或旧 archive；根锁新增开发依赖闭包的变更明确纳入当前证据。

## 下一段 T1 与发布门禁

- 执行已接通的公共 tgz 跨宿主复用与 Mac→Windows lockfile 转移 CI，取得实际报告。
- Linux libc 与 Windows ACL/长路径的实际结果；Windows 10/11 和真实厂商场景单独认证。
- 将本机 archive 探针推进到各平台实测；正式 SBOM/签名材料生成、厂商真实运行与再分发审核仍需完成。
- 缓存权限/锁恢复、生命周期与完整启动 deadline 的实现机制；当前候选字段与 Mac 大小数据不能代替其他平台的实测证据。
- 真实 Registry、签名身份、目标平台资源仍是外部门禁。

T1b 首次全量检查与装配探针并行时，既有 CLI 交互清理用例触发 5 秒超时；未修改产品代码或超时阈值，待探针结束后顺序完整重跑 `pnpm check` 全通过（包括新增 7 项审计测试）。此记录只说明复跑结果，不把超时原因确认为负载。P1D 与 T1 保持进行中，T2–T7 不提前勾选。
