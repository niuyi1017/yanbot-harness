# 统一分发实施决策记录

## 连续执行授权与跨平台修正

- 用户授权连续完成整个计划，普通实现决定不再逐节点等待；真实发布身份、Registry 权限、再分发许可和 Windows 10/11 实机仍为外部门禁，不阻塞可独立测试的代码。
- 后续开发版本采用 `0.1.0-preview.3`，不重建或覆盖冻结的 `preview.2` 制品。所有新打包命令使用独立输出目录。
- CI 34958355225：Linux 安装和完整 archive/Reference 通过；Mac 安装通过、路径扫描失败；Windows producer 摘要检查失败。Windows CRLF 检出改变脚本字节，使用仓库 `.gitattributes` 固定文本 LF，保持摘要比较严格，不对收到的 kit 放宽校验。
- 路径扫描继续禁止本次仓库/真实路径及临时装配根，且扫描全部二进制与凭据模式。通用 home 前缀（如 GitHub 与第三方共同使用的 `/Users/runner`）不能证明本次构建路径泄漏，移出全局硬拒绝集合；不修改第三方原字节，不增加 vendor 路径豁免。正式制品仍需来源/许可审计，此扫描不等于完整机密检测。
- T2/T3 将已测试的 archive 解包与路径契约移入 runtime 包的共享内部模块，构建侧复用同一实现；不复制第二份解析器，不允许运行时依赖仓库 scripts。测试信任根仅显式注入，默认空信任根失败关闭，正式根未配前不宣称可生产安装。
- 缓存互斥采用内核持有的本机 loopback 独占监听锁（缓存绝对路径摘要映射端口，进程退出自动释放）；不读取 PID 文件、不猜测死锁后删除其他进程锁。端口碰撞只会串行等待/有界失败，不能跳过校验或误抢锁；受策略限制无法绑定时给出缓存错误。它不是 Registry 请求。缓存损坏保留原目录并失败，不自动覆盖或 GC，恢复需显式新 cacheRoot 或人工处理。
- Windows 新缓存根显式建立仅当前用户继承 ACL 并复读校验；该实现需 Windows CI 通过后才能计作证据。普通运行临时目录的 ACL 与进程树 containment 在 T4 独立收口，不能因缓存 ACL 成功一并勾选。
- SDK 首版先验证自定义 Node 的版本及与宿主相同的 OS/CPU，跨架构 Node 明确拒绝，不将它错误交给按宿主选包的默认 resolver；后续如支持异架构需要扩展 context。新 IPC 与旧显式路径分支隔离。POSIX 独立组和 Windows taskkill 只是基础回收，脱组后代、Runtime 强杀后 Windows 后代及父宿主强杀的完整 containment 保持发布阻断，不能宣称已保证。
- 第二次 CI 34959311734：三平台原样 tgz/跨系统 lock 安装均通过，Mac/Linux archive 通过；Windows hoisted 的六个普通 pnpm CLI shim 含装配绝对路径。归一化前仅对已登记 uuidv7/which 的 shell/cmd/ps1 shim 按实际 package.bin 生成相对启动器，校验目标 Node shebang，未知 bin 条目拒绝；第三方包资源仍不变。该变更先加入契约，再重跑 Windows，不删除命中资源。
- T6 common 构建独立于旧 preview.2 builder：公共包只 pack 一次，第三方 consumer 闭包从实际锁定安装图遍历并显式装入 kit，平台 payload 不重新解析内部依赖。每个平台 kit 引用同一 common 字节；离线签名清单绑定全部 tgz 和安装器摘要。新消费者目录必须不存在，失败保留诊断、不覆盖已有工程。npm 精确 10.9.8、独立空配置/cache、offline/ignore-scripts；零 Registry 请求不冒充 OS 防火墙证明。
- 离线 bootstrap 必须先从可信渠道取得/核验安装器及外部信任根，不能依赖 kit 自带公钥自证；默认不附生产公钥。开发测试向安装器显式传入单独生成的测试信任文件，正式流程仍缺发布身份。
- 干净 CI 揭示未发布 optional 平台包未进入锁文件，而本机已有 node_modules 的快速路径掩盖了 frozen-lock 漂移。开发工作区通过三个明确的 pnpm overrides 移除平台包的开发安装边；对外 runtime manifest 保持三个精确 optionalDependencies，pack 后必须验证未被改写。不会关闭 frozen-lock 或发布空壳平台包来绕过此问题；增加干净工作区安装验证。
- CI 外部结果与本地证据分别记录。T1 已验证的契约足以推进独立 T2/T3 工作，未通过的平台门禁继续保持未完成。

## 2026-09-15：方案确认，授权启动 T1

- 用户已确认 local/sdk/runtime/platform 拆分、统一安装和独立进程方案，并在切换模型后授权开始开发。
- 当前执行节点为 T1 打包与包管理器可行性探针；使用隔离的测试包名/版本，不发布产品包、不改写现有 release archive。
- 文档/开发基线：`zb-dev`，规划前 HEAD `0247627`。本机现有 Mac `preview.2` archive 的 manifest 源提交为 `1055355fe62690625013113fe09ea509876b1c3f`、`gitDirty: false`。
- 本机制品 `yanbot-harness-0.1.0-preview.2-darwin-arm64.zip` SHA-256：`109ae675089927f7244ce4a0754b5604414e937cd213e48e0f857e5cc4e8c1b0`。此摘要只固定当前 Mac 制品，不替代 Windows 或正式冻结认证。
- 测试版本使用独立 probe 标识；正式下一 Preview 版本在 T2 产品打包前确定。不得以修改后的 README/源代码重新生成同身份 `preview.2` tgz。
- 当前可用本机：macOS arm64，Node 22.23.1、npm 10.9.8、pnpm 11.10.0。Windows/Linux 的结果需由相应 runner/实机执行取得，不用平台模拟替代认证。

## 外部发布门禁

Windows 父死亡测试细化：Node 22 所用 libuv 1.51 的父属 Job Object 会在父死亡时强杀非 detached 子进程，故不能要求此时 Runtime 一定完成 descriptor 删除。测试分别验证“父被强杀后子进程消失、持久目录/可能的旧 descriptor 保留”和“父存活但 IPC 断开时正常 close/descriptor 清理”。不改成 detached 来逃避 OS 保护；旧 descriptor 的死 PID 不能作为可连接服务。libuv Job 允许子进程 breakaway，仍不构成全树保证。依据：[libuv Windows process implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L65-L91)。

CI 34965940828 的直接权限测试定位真正前置失败：从 PowerShell 7 启动的 Node 继承了其模块环境，固定 Windows PowerShell 5.1 的 Get-Acl 自动加载到不兼容 Security 模块。改用其内置 .NET Framework Directory/File.GetAccessControl、SetAccessControl 与强类型构造器，不依赖 Get-Acl/New-Object 自动加载；保持固定系统解释器、ACL 复核与受限目录逻辑，不因命令失败跳过保护。

Linux 阻网门禁仅在一次性 GitHub runner 创建独立 network namespace；只启用该 namespace 的 lo，在加载任何 kit/npm 代码之前降回原用户 UID/GID 并清除 supplementary groups。外连预检必须 ENETUNREACH；不修改 runner 主 network namespace、防火墙或用户电脑配置。无可用 sudo/unshare 时测试失败，不能当作已认证。

Windows ACL 实施补充：elevated token 创建文件的默认 owner 不一定等于 User SID；[WindowsIdentity.Owner](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsidentity.owner) 返回该 token 的默认 owner SID。专用目录只接受当前 User/Token Owner，随后强制 owner 为 User 且 DACL 仅 User；descriptor 接受这两个受当前 token 控制的 owner，但有效 DACL 仍只能授予当前 User，不能增加 Administrators/Everyone 访问规则。不使用固定英文组名或管理员 SID 全局豁免。

T4 有界关闭补强：Runtime 正常 close 完成后不再取消最后的退出 watchdog，而是 unref，让空事件循环自然退出；若不合作的子进程/handle 仍保活，watchdog 在 5 秒触发。POSIX 只尝试当前 Runtime 自身作为组长的独立进程组；Windows 在 Runtime 自身仍活着时调用固定系统 taskkill 回收自身树，不在它退出后通过旧 PID 猜测回收。此补强不解决 Runtime 被 SIGKILL 或脱组后代的强 containment，相关发布保证仍阻断。

2026-09-15 补充验证：macOS 使用仅作用于测试进程及其后代的 sandbox-exec profile，先确认对文档保留 IP 的外连返回 EPERM，再在同一 policy 下执行完整离线安装/Reference/close；仅允许 loopback，不更改用户全局防火墙。其他 OS 仍需各自证据。缓存升级测试使用显式测试签名的 preview.3/preview.4 小型 fixture，覆盖共存、打开旧文件、回退、锁持有者死亡与信任轮换，不冒充两个正式 release 的业务数据迁移认证。

以下条件不阻止隔离探针，但未完成前不做真实发布：

- 私有 Registry/镜像地址、scope/包名占用与读写权限。
- 正式签名身份、可信公钥分发与轮换流程。
- Runtime 内部厂商资产的再分发许可审核。
- Windows 10/11、其他目标平台与真实厂商认证证据。

T1 发现影响方案的机制差异时，先更新 Spec 和本记录，再进入正式实现。

## 2026-09-15：T1 本机机制结果

- npm/pnpm 安装机制探针 16/16 通过；pnpm frozen-lock 离线 deploy 与搬迁后的 Reference Run/close 通过。
- 修正 npm pack 排除规则的泛化，维持 archive 的完整目录与校验边界设计。
- raw pnpm deploy 仍含内部链接和本机路径，确定仅作为候选装配输入，不能直接发布；具体 link-free 装配与资源核查尚未完成。
- 新增三平台 CI 入口但未远端执行；共享 tgz/跨系统 lockfile、最终解包/control 契约继续作为 T1 未完成项。
- 证据与复跑方式见 [probe-results](probe-results.md)。现有 preview.2 制品保持不变，不新增真实 Registry/签名承诺。

## 2026-09-15：T1b 制品转移与无链接候选目录

- 本机 export 16/16、使用原始 kit 的 import 18/18 通过；npm/pnpm 原始 lock 摘要未变。同机测试不计作 Windows/Linux 证据。
- CI 改为 Mac 构建一次 fixtures/locks 后上传，三平台下载并按相同 loopback Registry origin 消费，不重新 pack 公共 tgz、不改写 lock。
- hoisted deploy 不需要自制依赖扁平化器；仅两个 `.bin` Node 链接转换为相对 exec shim 后得到零链接目录。普通资源与依赖上下文必须等价，完全相同的重复物理副本单独记录。
- 本机额外的 content-type 副本不等于语义或单例等价认证；真实厂商回归、发布 metadata 清理和许可证/签名门禁仍保留。
- 审计器增加 peer 上下文细化，避免同版本同字节包引用不同 peer 时被误判相同；独立单测纳入 `pnpm check`。

## 2026-09-15：T1c 元数据归一化与字段契约

- 归一化只在新候选目录运行；删除六个明确列出的 pnpm 元数据文件，修改范围仅限已登记自有 manifest。第三方代码、manifest、许可证及辅助程序必须保持原字节；原 deploy 不变。
- 与文件差异允许集并列运行实际依赖图比较，后一比较只忽略 manifest 字节及获准剔除的 metadata，不能独立拿它证明资源未变。
- 第一轮完整探针因第三方 TypeScript worker 的 Block*scoped/Check* 诊断标识符误触发 ck* 子串模式而失败。保留失败报告，不删改第三方文件；将凭据前缀限定到标识符边界，新增大型文件中独立 ck*/npm*/ghp* 样式的拒绝测试。该规则不宣称覆盖所有凭据/编码。
- 第二轮扫描命中 jose PEM 解析器中的纯格式头字符串，并非私钥材料；规则改为同时要求私钥头与连续编码体，补充纯格式头放行/私钥体拒绝测试，不给包或路径添加扫描豁免。
- 具体 manifest/files/signature/resolver/IPC 字段及候选大小上限落在 [artifact-contract](artifact-contract.md)。它是实现约束，不是已实现的签名或跨平台生命周期认证。
- 精确解包依赖、攻击样例、跨系统 fixture 和正式发布信任根仍未完成；T1 总项不勾选，T2–T7 不提前开始。

## 2026-09-15：T1d 受限归档与解包探针

- 选定 tar-stream 3.2.1，精确锁入根开发依赖及 pnpm-lock；使用 ignore-scripts 安装，不增加 SDK/Runtime 生产依赖，不执行产品发布。
- 维护者源码显示 PAX/GNU 长头在 entry 回调之前处理；因此将 USTAR framing/type/路径/长度/checksum 检查放在 tar-stream 之前，并拒绝所有扩展头。库只做流解析，由应用代码以 wx 创建清单允许的文件，不调用文件系统提取器。
- 首版 builder 对需要 PAX 的内部资源名失败，不做转码/改名；目标父目录中的中文/空格/特殊字符与内部归档命名分别测试。此限制及选择理由先落入 artifact-contract 再实现。
- 压缩输入先校验摘要并复制至唯一私有容器；从快照验证单 member gzip CRC/ISIZE/实际输入消耗量，避免尾随空 member 被忽略。失败/超时等待解析器及写入任务结束后只删除本次容器；没有共享缓存锁或正式签名的产品实现。
- 新增独立攻击样例，并把完整 archive round-trip 接入现有 deploy→归一化→搬迁→Reference 的链路；本机和跨平台结果分开记录。旧 preview.2 archive 不重建。
