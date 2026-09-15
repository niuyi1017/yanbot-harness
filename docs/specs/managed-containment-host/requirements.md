# Managed 隔离宿主需求

状态：2026-09-15 用户已允许引入原生/隔离宿主并改变必要部署前提；沿用连续实施授权。生产签名、Registry、操作系统镜像再分发及真实厂商认证不因本授权自动获批。

## 动机与范围

承接 unified-local-distribution T4：现有 macOS detached 故障探针证实 managed close 后仍可能残留后代。保留完整 owned execution 回收要求，不把 IPC ACK、根 PID 消失或尽力扫描当作完成。

- CH1：Windows 10/11、Server 2022 的每次 managed 执行拥有一个独立且不允许 breakaway 的 Job；Runtime 执行任何用户代码前必须已经归组。宿主/SDK/Runtime 任一方退出或失联后，有界回收 Job 中全部后代，包括 detached 和嵌套 Job。
- CH2：Windows 只持有自己创建的内核对象；不得通过过期 PID 重开并强杀进程。创建失败、控制输入截断、超时和错误必须 fail closed；其他实例、Daemon 和用户文件不受影响。
- CH3：macOS 强模式选择 Virtualization.framework 的逐执行 VM 边界；不在宿主直接运行需要完整保证的厂商树。VM 内操作系统/Node/厂商 payload 必须单独匹配、认证和签名；旧 darwin payload 不冒充 Linux guest 制品。
- CH4：强隔离必须成为可验证的能力而非默认猜测。无本地镜像、宿主能力或受信任 helper 时明确拒绝该强模式，不回退到弱生命周期。旧 preview.2 显式路径兼容保留且不升级认证声明。
- CH5：正常退出先取消/关闭业务，再回收隔离边界；成功返回必须有宿主清空证明。父被强杀的资源回收由持有的 OS 对象/VM 生命周期保证，不能只依赖进程内 finally。
- CH6：helper/guest 纳入不可变版本、源提交、清单/摘要、离线闭包和签名；不在 npm install/运行时编译或隐式下载镜像。SDK-only 不新增 native/vendor 生产依赖。
- CH7：故障测试至少覆盖普通/脱组/嵌套后代、Runtime/宿主/SDK 强杀、继承句柄泄漏、并发互不误伤、未知协议和启动失败；区分机制探针、SDK 集成、真实厂商认证。

## 非目标与前置

不实现 Remote、Electron UI、共享 Daemon 管理、全机 PID 清扫或自动发布。不自动更改宿主防火墙、安装常驻提权服务、下载个人磁盘镜像或读取现有 VM 私有数据。允许在本次拥有的临时目录构建和测试原生 helper、在明确隔离的 CI 执行机制测试。

Windows Job 是 owned descendant 生命周期边界，不是抵御同一用户/管理员利用外部 WMI、调度服务或其他宿主 broker 代为创建进程的安全沙箱；此类第三方服务创建的进程不能宣称被本 Job 管理。若真实厂商依赖这些行为，必须进入更强 VM 隔离认证，不能降低 CH1。

Mac VM 实机验收依赖本地可用 Virtualization 能力、受控 guest 启动资源及凭据/工作区映射。缺少资源可先完成宿主和契约验证，不能将未启动的 VM 标为通过。
