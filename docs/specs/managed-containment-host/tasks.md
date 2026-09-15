# Managed 隔离宿主实施清单

状态：2026-09-15 已批准部署边界扩展，实施中；不等于统一分发已完成。

- [x] H0：冻结需求/设计与授权边界，提交本目录三份 Spec；前置 unified T4 否定证据；验收 git 历史可追踪。
- [x] H1：Windows 原生 Job host、构建脚本、10 项独立故障探针及 CI 已实现；真实 Windows CI `34979912098` 通过，涵盖原子归 Job、root/host 强杀、EOF、脱组/嵌套/并发与错误启动。Windows 10/11 实机/厂商仍属于 H5，不以 Server 2022 CI 替代。
- [x] H2：Windows SDK/resolver/签名平台 staging 集成通过；`34979044531` 三平台实际 npm/pnpm/离线通过，`34979912098` 真实 SDK detached 探针通过、SDK 36 项通过/1 项其他平台用例跳过，含 Runtime/SDK 父进程强杀。SDK-only 无新增 Runtime/native 依赖。
- [ ] H3：新增 macOS Swift VM host、受控启动配置与 guest 控制契约。前置 H0；验收 Swift 编译、配置拒绝、能力检查与真实最小 guest 的断连/host/guest 崩溃；缺失启动资源明确记录。
- [ ] H4：Mac guest 制品/路径与凭据映射、vsock 代理和 SDK 集成。前置 H3；验收 Reference Session/Run/Event/cancel、工作区限制、离线、强杀后代，未授权资源不加载。
- [ ] H5：同一冻结版本的三平台回归、真实厂商、正式签名/镜像许可、文档与发布门禁同步。前置 H2/H4；无真实证据不勾选，不能以测试签名候选发布。

允许跳过外部资源等待以继续无依赖项；不跳过失败的工程保证。此清单完成前，旧 containment 缺口与统一分发发布阻断保持有效。

H3 当前实机证据：macOS 26.4.1 arm64、Swift 6.3.1、真实最小 Linux guest 已通过 stop/EOF/非法控制、宿主 SIGKILL、父 SIGKILL，且其他 VM 存在时不作归属推断。新增实际 sysrq kernel panic + 心跳回收已本机通过；最终可复跑报告与 H4 产品链路继续同步，不用编译通过替代实机证据。

H4 当前实现候选：原生 arm64 CI `34983207692`/`34984037390` 已构建真实 Runtime + Node 22.23.1 guest 根制品；vsock/私有 Unix HTTP/SSE 代理、SDK 显式目录/凭据边界、内核 flock 持久状态独占、签名 manifest/resolver 均已实现。SDK 单元边界与签名 guest 摘要绑定测试通过，完整真实 VM Runtime/SSE 和实际 VM 平台包回归仍待报告，不勾选。
