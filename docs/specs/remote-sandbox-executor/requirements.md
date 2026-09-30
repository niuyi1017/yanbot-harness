# Remote Sandbox Executor

## 目标

把 Reference Worker 的执行边界升级为可实测的 Linux 容器候选，为 Remote SDK/CLI 两种厂商形态复用公共 Adapter 协议。
当前本机没有 Docker，使用 GitHub Linux runner 实际验收；不能用普通子进程或 fake Docker 成功替代容器证据。

## 可验证要求

1. 每个 Adapter Runtime 使用独立 Linux 容器；镜像只接受不可变 sha256 ID/digest；命令、用户、资源、挂载策略由部署固定。
2. 非 root、read-only rootfs、cap-drop ALL、no-new-privileges、private IPC/PID、CPU/内存/PID/tmpfs 上限，默认 network none。
3. 只挂载经过 realpath 检查的指定 snapshot 子目录，read-only；不挂载 Docker socket、宿主 HOME 或凭据目录。
4. prompt 经 stdin 公共 RunRequest；Docker inspect/环境/argv 不包含 prompt、grant、长期 Key。
5. 取消、正常结束和失败都按不可变容器 ID 清理并确认容器消失。Worker 被强杀后，guest lease 超时退出触发 auto-remove。
6. Guest 只允许 Reference SDK Adapter 和独立安装的 Claude CLI Adapter。无凭据 CLI 认证失败可在隔离容器内验证。
7. Worker 显式 opt-in sandbox；默认 Reference 行为兼容。Git/恢复/厂商凭据/出网未认证时明确拒绝，不在宿主降级执行。
8. CI 验证实际 rootfs/网络/UID/资源配置、取消、父强杀、两个并发容器隔离、终态与清理；保存 source commit/镜像 ID。

## 边界

本次完成离线容器执行基线。生产 egress 代理、credential broker、短期厂商令牌、持久 Session volume 与恢复另行实现，
没有它们不得把真实模型 Remote 通路或四模式整体标记完成。容器共享宿主内核，不宣称等同虚拟机隔离。
