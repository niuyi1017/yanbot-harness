# SDK 与 Local Runtime 统一安装需求

状态：**方案已确认；T1 探针进行中，T2–T7 产品实现未开始**。日期：2026-09-15。
审计基线：`zb-dev` / `0247627`，当前交付候选为 `0.1.0-preview.2`。本 Spec 进入后续 Preview，确切版本号待发布计划冻结。

## 1. 问题与目标

当前消费者需要安装 SDK tgz、单独解压 Runtime，再向 `startManagedRuntime()` 提供路径。SDK 已具备启动、探活、连接与关闭原语，但普通用户仍承担制品装配工作。

本期目标：普通本地用户只选择一个安装入口，由 SDK 自动定位随依赖安装的 Local Runtime 并启动独立子进程。内部 SDK、Runtime、Adapter 的模块与进程边界保持清晰；只用 Remote 的消费者保持轻量安装；Daemon、Electron 和高级部署保留 Runtime 独立交付。

已确认的是上述产品方向；`@yanbot-harness/local` 等新增名称、payload 形态及实施顺序是本次推荐，已获用户确认，不代表已经发布。

## 2. 可验收需求

### UD1. 普通本地安装

- 在受支持的 Mac/Windows、干净 Node 环境中，用户只需安装精确版本的 `@yanbot-harness/local`，再从该包调用 `startManagedRuntime({ reference: true })`，无需提供 Runtime 路径即可完成 Reference Session/Run/Event 与关闭。
- 统一包重导出同一 SDK 客户端和业务类型；其安装便利层不导入或执行 Runtime/Adapter 的业务入口。
- `import`、安装以及普通客户端方法都不自动启动 Runtime；只有显式 managed 启动或将来的显式 `local-managed` target 才创建进程。
- “一个包”指一个消费者安装入口，不指一个进程、一个 npm tarball、无需 Node 或无需配置 BYOK。

### UD2. 轻量与高级安装

- `@yanbot-harness/sdk` 的生产依赖图不包含 Runtime、平台 payload、Adapter 或厂商 SDK，包含 optional/peer 自动安装路径在内都不得引入它们。
- 安装轻量 SDK 和执行 Remote 连接不得解析、下载、展开或启动本地 Runtime。Remote 服务本身仍受双 Runtime Spec 的实现/认证门禁约束。
- `@yanbot-harness/runtime` 可以独立安装并提供启动器和定位接口；保留 portable archive 与显式路径覆盖，支持外部 Daemon、Electron 资源和企业部署。
- 平台 CLI 本期保持轻量依赖，既有 `--runtime`、`--descriptor`、`--managed-runtime PATH` 语义继续成立；CLI 默认携带 Runtime 和 Daemon 管理命令另行交付。

### UD3. 平台选择与缺失诊断

- 首轮本地统一安装必须覆盖 `darwin-arm64` 与 `win32-x64`；保持 `linux-x64` glibc Reference 回归。Intel Mac 是后续扩展目标，Windows arm64、Linux arm64/musl 不自动获得支持声明。
- 依据实际运行 Node 的 `process.platform/process.arch` 与 payload manifest 选包；macOS Rosetta/x64 Node 不可静默使用 arm64 payload，跨平台复制 `node_modules` 不视为安装方法。
- 平台包必须声明 `os/cpu`，Linux 还需 libc 约束。包管理器可跳过的 optional dependency，在启动时是本地执行的必需制品。
- 缺包、禁用 optional、架构不支持、Node 不兼容、缓存不可写、签名/摘要不匹配、版本不匹配必须产生可操作的稳定错误；不能静默使用另一版本、全局 PATH 或远端执行。

### UD4. 可重复、离线与私有 Registry

- 安装与首次 Reference 启动支持 `--ignore-scripts`；不得依赖 `preinstall/install/postinstall` 在线下载、源码编译或修改系统服务。
- 在线安装由包管理器按锁定的 Registry 元数据获取 tgz；第一次启动只读取已安装文件，允许有界的本机校验/展开。
- 离线套件包含目标平台及所有公共传递依赖的 tgz、完整性清单、来源签名和安装说明。必须在无仓库、空 npm cache、阻断网络的机器上安装并启动 Reference；只有打包成功或缓存命中不能算离线验收。
- 私有 Registry 路径覆盖全部 scoped 包与第三方依赖镜像；consumer token 只用于安装，publish token 只用于发布，不进入 Runtime 环境或产物。
- 同名同版本 tgz 在各平台、在线和离线渠道中逐字节相同；不得为离线渠道重写该包的 dependencies 或复用同一身份发布不同字节。

### UD5. 发现与 API 兼容

- 保留当前 `startManagedRuntime()`、所有既有 options/handle、`fromDaemon()`、`fromRuntime()` 和显式连接方式。
- 路径解析优先级为显式 `executablePath` → 所选 environment 中的 `YANBOT_HARNESS_RUNTIME_PATH` → 调用方注入的 resolver → 本地统一包默认 resolver。选择高优先级来源后失败应立即报错。
- 轻量 SDK 不猜测兄弟包路径；通过可选 resolver 注入实现自动发现，统一包默认装配它。
- 新增平台包和 bundled managed 路径先验证精确版本、完整性和 managed 启动能力，再 spawn；连接后验证协议与 Runtime Profile。旧 Preview 显式路径使用既有兼容策略，不要求旧 Runtime 提供新字段。

### UD6. 生命周期和清理

- 全部启动阶段受统一 deadline 约束，包括展开、spawn、descriptor 和 HTTP health；超时/启动失败必须回收已拥有的进程。
- 新 Runtime 通过父子专用控制通道支持正常关闭和父进程死亡通知；正常关闭先取消 Run、关闭 Adapter/厂商子进程，再清理 descriptor。超时才强制收口受拥有的进程树。
- macOS 与 Windows 均测试启动失败、重复 close、并发实例、父进程正常退出/崩溃、Runtime 崩溃和顽固厂商孙进程。不能仅凭父 Runtime PID 消失宣称清理完成。
- 临时运行状态属于本次 managed 实例；调用方传入的持久 `stateRoot`、用户工作区和凭据文件不得递归删除。版本缓存与 Session 状态分离，关闭一次 Runtime 不删除共享 payload 缓存。
- 不强杀非拥有 Daemon 或凭 descriptor 任意 PID 杀进程；清理失败返回错误并保留必要诊断/所有权信息。

### UD7. 凭据和信任

- Local Access Token、Remote Platform Access Token、厂商 Key、Registry token 分属不同边界；包/启动器/argv/公共协议/事件/日志不含厂商 Key。
- 推荐由 Runtime 读取受保护 BYOK 文件，SDK 只转交引用。若宿主主动把 Key 放进 `process.env` 或 `environment`，Key 已在宿主内存中，不能宣称对 SDK 进程或机器所有者隐藏。
- 新统一入口默认使用最小环境白名单，剔除安装/发布凭据及 Node 注入变量；旧 SDK 的完整 `environment` 语义保留为显式高级路径并说明风险。
- 摘要用于完整性，受信任密钥验证的签名用于来源。未配置发布信任根前可做测试签名验证，但不得把它标记为生产签名。
- Windows descriptor/state/cache ACL 必须在新 managed 通路中建立和验证；POSIX 权限不得作为 Windows ACL 的替代证据。

### UD8. 版本、升级与回滚

- Preview 统一包、SDK、contracts、Runtime meta 和目标平台包锁定同一个精确版本 V；禁止 `latest`、`^`、`~` 作为内部发布依赖。
- npm 安装目录由包管理器管理；Runtime 不修改自己所在的 `node_modules`。升级后新启动使用新 payload，活动实例继续使用原摘要目录。
- 停止/排空后由消费者恢复旧 lockfile 和整套包版本实现回滚；新状态 Schema 若不可逆，须拒绝旧版写入并使用备份恢复，不能只回退二进制。
- 独立安装的原子版本切换、自动更新和共享 Daemon 运维属于后续任务；本期必须给出可演练的手动升级/回滚步骤。

## 3. 非目标

- 不修改或重新发布 `preview.2` 的包拓扑、冻结 API、认证结论或现有交付压缩包。
- 不在本轮实现生产代码；先确认 Spec 与计划。确认后先提交 Spec 基线，再进入实现。
- 不随 npm 包捆绑 Node，不制作 MSI/EXE/DMG 安装器，不承诺浏览器 SDK。
- 不实现 Remote Runtime、真实 CLI 厂商 Adapter、Electron UI、系统服务、共享 Daemon 自动升级或 OS Keychain provider。
- 不将 Runtime 打成单一 JS/SEA 文件，不合并 SDK 和 Runtime 进程，不开放内部 Adapter/Core 为消费者公共 API。

## 4. 依赖与完成定义

- 依赖 `managed-local-runtime` 已有启动原语、`dual-platform-preview-release` 发布矩阵，以及 `dual-runtime-compatibility` 的公共协议/目标模型；分发实现可在 P0 基线隔离后独立推进，无需等 Remote 服务完成。
- 本仓库内同步 system architecture 与 PNG/SVG、foundation requirements/design/tasks/roadmap、managed/dual-runtime/历史发布 Spec 的适用范围、README、交付矩阵与后续交付说明；本期无其他业务仓库改动。
- 发布前外部输入：scope/包名权限、私有 Registry 与镜像、厂商再分发许可评审、签名信任根、目标系统实机。均以门禁记录，不臆造已就绪。
- 方案完成：三份 Spec 和关联文档一致、任务可独立验收、当前与目标清楚，已获用户确认。实现完成：本 Spec UD1–UD8 均有对应测试证据，且双平台真实厂商认证仅按实际结果声明。
