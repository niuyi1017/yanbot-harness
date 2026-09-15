# Managed 隔离宿主设计

## 已批准选择

用户批准保留强回收目标并增加原生/隔离宿主。先验证 Windows 内核机制，再接入现有 SDK/resolver；Mac 独立验证 VM 生命周期。代码和平台清单仍在本仓库，不涉及其他业务仓库。

## Windows 原生宿主

新增 `native/windows/managed-job-host.cpp`，仅链接系统 Win32 API，使用构建期 MSVC 编译（静态 CRT），不引入运行时编译或 Node addon。每个 helper 创建无名称、不可继承的 Job，仅设 KILL_ON_JOB_CLOSE；不设 BREAKAWAY_OK/SILENT_BREAKAWAY_OK。

使用 STARTUPINFOEX 的 PROC_THREAD_ATTRIBUTE_JOB_LIST 原子地将新 Runtime 归入 Job，同时 CREATE_SUSPENDED；恢复前完成句柄/控制通道准备。不采用“先 suspended CreateProcess 再 AssignProcessToJobObject”：宿主若在两步之间被强杀仍会遗留悬挂进程。最低 Windows 10/Server 2016 满足现有目标。

独占 stdin 是 SDK 的生命周期租约，EOF/无效输入/显式 stop 触发 TerminateJobObject；根 Runtime 退出也立即清空后代。helper 通过持有的 Job 查询 ActiveProcesses=0 后输出 `stopped` 证明并退出。Job 句柄不进入 Runtime。句柄继承使用白名单，Runtime 的 stdin/stdout/stderr 默认为 NUL；helper 自己的控制/stdout 不传给后代。根进程与 Job 都用原有 HANDLE，不从数字 PID 重新打开。

helper stdout 为有界 JSONL，仅 `started {protocolVersion:1,hostPid,runtimePid}` 与 `stopped {protocolVersion:1,activeProcesses:0}`；错误只输出固定阶段/Win32 错误码，不输出 argv/env。测试可不启用 Runtime IPC；产品路径只转交 Node IPC fd 3，沿用 managed protocol 1 hello/ready/shutdown，不携带业务或 Key。SDK 以 helper started 中的 runtimePid 绑定 descriptor/ready，不能再把 helper PID 当 Runtime PID。

SDK 仍返回同一 ManagedRuntimeHandle。resolver 增量返回经过签名缓存核验的 containment helper 描述；轻量 SDK 不猜测安装路径。正常 close 先发送现有 IPC shutdown，宽限期后关闭 helper stdin；若 helper 无清空证明，返回 CLEANUP_FAILED 并保留状态。helper 被强杀时 Job 最后句柄关闭是内核兜底，但缺少确认时不虚构正常 close 成功。

调用方可显式设置 `requireContainment: true`；无已接通宿主（含旧显式路径或尚未接通 VM 的 Mac）必须在 spawn 前报 CONTAINMENT_UNAVAILABLE。未认证的候选默认兼容路径不通过该选项冒充强模式，正式默认切换仍需跨平台验收。

## macOS VM 宿主

选择 Apple Virtualization.framework，不依赖全机 PID 追踪、不把 sandbox-exec 当进程生命周期容器，也不要求用户运行 Docker 后台服务。先实现独立 Swift host 的能力检查、严格启动配置、控制 EOF/stop 与强制 VM stop 生命周期。

优先 Linux arm64 的最小 guest 做机制验收，guest payload 与 darwin-arm64 外层宿主分开标识。kernel/initrd/磁盘必须是调用方预置、受信任且摘要匹配的普通文件；不读取任意既有虚拟机状态、不自动联网拉取、不运行 x86 Rosetta 代替 arm64 guest。guest 镜像供应链/许可证是独立发布门禁。若改用 macOS guest，也必须独立审批 OS 镜像和安装前提。

每实例独立 VM + 控制连接；guest 内固定 agent/Runtime，host 通过 virtio-vsock 转发认证业务与控制。只暴露明确授权的 workspace/state/file-credential，共享目录不含宿主 HOME、Docker socket 或发布凭据。HTTP/SSE 代理保持原 SDK API；宿主路径与 guest 路径映射由边界层处理，不把 guest PID 冒充宿主进程 PID。

VM 启动/停止与 host/guest 崩溃需真实启动资源验证；只有编译和 isSupported=true 不能证明 containment。平台模式是否默认启用以完整认证结果决定，未认证强模式 fail closed。

机制 fixture 的 kernel 输入还需规范为 VZLinuxBootLoader 使用的 ARM64 Image。若上游提供 Linux EFI zboot/gzip，只在显式构建步骤按 [Linux zboot header](https://github.com/torvalds/linux/blob/v6.12/drivers/firmware/efi/libstub/zboot-header.S) 校验 offset/size/压缩类型并有界解压；记录变换前后摘要，运行时不猜测格式或下载补全。

## 复用与拒绝方案

### H4 通信与映射细化（实施前冻结）

guest 使用同版本 Linux arm64 Node + 规范化 Runtime，构建期记录文件与动态库摘要，不在用户启动时下载。开发 guest 可由原生 arm64 CI 生成；正式再分发与系统库许可证独立审批。guest initramfs 上限 256 MiB（压缩），VM 内存 2 GiB，机制 fixture 仍保持 512 MiB。

使用原始 HTTP/SSE 字节转发，避免另造业务 RPC：SDK 的认证 loopback proxy → 私有 Unix socket（新建 0700 目录）→ VZ vsock → guest loopback bridge → 现有 Runtime。Unix socket 仅本次实例可访问；一次性 bootstrap 只走私有 socket，向 guest agent 传明确允许的环境配置，回传 guest descriptor；不经过公开 loopback，也不进入 argv/console/log。公开 proxy 仅允许认证的 `/local/` 路由，禁止 bootstrap。字节流有限并发、背压、断开传播，Runtime 自身仍执行认证及 Session/Run/Event 协议。

VM 路径映射采用显式预声明：调用方通过启动选项声明 workspace 目录及只读属性，之后仍须调用现有 grantWorkspace；未预声明的路径拒绝，不自动共享父目录。此模式不同于原生任意目录 grant，必须在 SDK 文档明确。固定映射 `/harness-shares/workspace-N`，边界层只翻译协议中的 workspace 字段，绝不全局替换用户文本或 SSE 内容。state 独占子目录单独共享，host descriptor/config 不在 guest share 内。默认不共享任何 workspace，不复制整个 HOME。凭据仅接受显式环境或经原有规则校验的文件内容；不透传宿主 process.env。网络默认关闭，真实厂商认证需显式启用 NAT 并单独验收。

host 的 pid 是 VM 生命周期 owner；guest Runtime pid 只在私有 bootstrap 中核验，不写作 host descriptor pid。旧 Darwin 制品仍不能满足 requireContainment；只有含已核验 VM host/kernel/initrd 的新描述符才能进入 VM 路径。

开发期保留 Darwin 兼容 Runtime 与新增 VM guest 于同一签名 payload；因此归档压缩上限从 128 MiB 调为 256 MiB，展开总量仍限定 512 MiB、单文件 256 MiB，其余数量/路径/摘要限制不变。新增 manifest containment 类型 `macos-vm-v1`，固定 host/kernel/initrd 路径并绑定 guestTarget=linux-arm64、每个 guest 摘要与签名 files.json 一致。仅显式 `--vm-guest-config` + 测试签名构建候选；正式镜像身份/许可未审批前不允许该构建路径使用正式密钥。

同一限制同步到离线 kit：单 tgz 上限 256 MiB、总闭包 512 MiB。安装 smoke 在启动前显式声明自身新建工作区；不为测试绕过 workspace 边界。Mac OS 阻网 profile 仅额外允许受保护 `/private/tmp/hvm-UUID/http.sock` Unix 通道，外网拒绝基线继续验证；VM 默认无网络设备，不将 XPC 后端误认作继承 sandbox 的普通子进程。独立 Daemon/显式 Runtime 路径继续是 native 兼容模式，不宣称 VM containment。

持久 stateRoot 复用固定的私有 `guest-state` 子目录；Swift host 在启动前对其父目录中的 `vm-lease` 普通文件持有独占 flock，锁不共享给 guest、不可被子进程继承，host 退出由内核释放，拒绝并发复用而不以 PID 扫描恢复。guest wrapper 发固定心跳；失联 5 秒停止 VM。内核参数使用 panic=0，重复 guest-ready 视为异常重启并停止；[Linux panic 参数](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html) 中负数代表立即重启，不能用负数模拟持续失活。

flock 另写 active/stopped 标记：只有 VZ 已停止才标记 stopped。host SIGKILL 会保留 active，防止 OS 释放锁后旧 VM 后端尚未退出时新实例并发写状态；禁止凭 PID 消失自动清标记。父 SDK 退出但 host 正常收尾时，host 只移除固定位置、schema 已知且 pid 绑定自身的公开代理 descriptor，保证持久根可再次启动；畸形或不属于本 host 的文件保留。

- 复用 `packages/sdk/src/managed-runtime.ts` 的统一 deadline/handle、`apps/local-runtime/src/managed-control.ts` 的业务关闭、runtime cache/signature codec 与 `scripts/probe-managed-containment.mjs` 的自有认证 fixture 清理。
- 原 `terminateOwnedChild` 的 process group/taskkill 仍是旧路径兼容实现，不当作新宿主能力，也不额外新建一套 Session/Run 客户端。
- 拒绝全机 PID 扫描/kill、扩大超时冒充回收、允许 breakaway 以迁就测试、继承 Job handle 到厂商进程、无资源时静默回退原生 host 运行。

## 技术依据

### 开发候选业务回滚探针

固定旧 preview.2 ZIP 的已记录 SHA-256，先验证再解压到新建临时目录，并复核 manifest 中每个包摘要；新候选使用 source/lock 相同的 common + VM platform 构建离线 kit。分别安装完整旧 SDK 消费者与新 local 消费者，禁止解析到仓库源码。旧原生 Runtime 使用测试状态根的 `guest-state`，VM 使用该目录的父状态根；仅在上一 owner 已完成 close 后切换。每一阶段核对之前阶段的 Session、Run 终态及完整重放事件，再新增一组业务数据；末尾复核全部状态和原 ZIP 摘要。只共享新建测试工作区，不接触已有用户状态，不伪造活动 descriptor 或清除 active lease。产物标明旧冻结版本与新测试签名候选的身份差异。

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：Job 与后代、KILL_ON_JOB_CLOSE、broker 限制。
- [Microsoft 原子创建并归 Job](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)：避免 suspended/assign 崩溃窗口。
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)：JOB_LIST、HANDLE_LIST 与最低系统版本。
- [Apple VZVirtualMachine](https://developer.apple.com/documentation/virtualization/vzvirtualmachine)：VM 生命周期与 virtualization entitlement。
