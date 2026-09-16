# Managed 隔离宿主实施清单

状态：2026-09-16 H0–H4c 工程候选完成；H5 正式发布外部门禁未完成，不等于可发布。

- [x] H0：冻结需求/设计与授权边界，提交本目录三份 Spec；前置 unified T4 否定证据；验收 git 历史可追踪。
- [x] H1：Windows 原生 Job host、构建脚本、10 项独立故障探针及 CI 已实现；真实 Windows CI `34979912098` 通过，涵盖原子归 Job、root/host 强杀、EOF、脱组/嵌套/并发与错误启动。Windows 10/11 实机/厂商仍属于 H5，不以 Server 2022 CI 替代。
- [x] H2：Windows SDK/resolver/签名平台 staging 集成通过；`34979044531` 三平台实际 npm/pnpm/离线通过，`34979912098` 真实 SDK detached 探针通过、SDK 36 项通过/1 项其他平台用例跳过，含 Runtime/SDK 父进程强杀。SDK-only 无新增 Runtime/native 依赖。
- [x] H3：macOS Swift VM host、受控启动配置与 guest 控制契约已通过同一提交实机 8 组机制矩阵：stop/EOF/非法控制、host/parent SIGKILL、持久状态独占/崩溃拒绝、真实 kernel panic 心跳回收、配置/摘要拒绝。
- [x] H4：真实 Linux arm64 Runtime guest、路径/凭据映射、vsock/Unix/HTTP-SSE 代理和 SDK 已通过 Reference text/question/cancel、三轮完整事件重放后继续请求、工作区限制、持久复用、SDK 父强杀和双 VM 隔离；测试签名 Mac 平台包 10 组 npm/pnpm/离线/OS 阻网安装通过。
- [ ] H5：同一冻结版本的三平台回归、真实厂商、正式签名/镜像许可、文档与发布门禁同步。前置 H2/H4；无真实证据不勾选，不能以测试签名候选发布。
- [x] H4b：冻结 preview.2 完整消费者 → 测试签名 VM 候选 → 旧完整消费者三阶段通过；分别保留 0/1/2 个既有 Session、Run 终态和完整事件重放，工作区哨兵与输入制品摘要不变。该证据不替代 H5 正式版本/厂商认证。
- [x] H4c：Windows disposable CI `35089747716` 对精确 Node 程序的临时 outbound Internet block 通过：规则回读匹配、外连 `EACCES`、loopback 离线 19 包安装/Reference 完成、规则 finally/独立 watchdog 清理。未改全机默认策略。

允许跳过外部资源等待以继续无依赖项；不跳过失败的工程保证。此清单完成前，旧 containment 缺口与统一分发发布阻断保持有效。

可复核摘要见 [implementation-evidence-h3h4.json](implementation-evidence-h3h4.json)。所有 VM/签名/回滚证据均明确为开发候选；正式镜像许可、生产身份、Registry、真实厂商与 Windows 10/11 实机仍只在 H5 解除。
