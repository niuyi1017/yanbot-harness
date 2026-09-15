# Managed 隔离宿主实施清单

状态：2026-09-15 已批准部署边界扩展，实施中；不等于统一分发已完成。

- [x] H0：冻结需求/设计与授权边界，提交本目录三份 Spec；前置 unified T4 否定证据；验收 git 历史可追踪。
- [ ] H1：新增 Windows 原生 Job host、构建脚本、故障 fixture 与独立 CI。前置 H0；验证 root 退出、EOF、host/root 强杀、detached/嵌套 Job、继承控制句柄隔离、并发及错误启动，无其他进程受影响；证据必须来自真实 Windows。
- [ ] H2：SDK 与 Runtime resolver 集成已核验 helper，平台 staging/manifest 纳入二进制，保持轻量依赖/旧路径。前置 H1；验收 SDK unit、真实安装和新的故障探针，不以独立 host 探针代替产品路径。
- [ ] H3：新增 macOS Swift VM host、受控启动配置与 guest 控制契约。前置 H0；验收 Swift 编译、配置拒绝、能力检查与真实最小 guest 的断连/host/guest 崩溃；缺失启动资源明确记录。
- [ ] H4：Mac guest 制品/路径与凭据映射、vsock 代理和 SDK 集成。前置 H3；验收 Reference Session/Run/Event/cancel、工作区限制、离线、强杀后代，未授权资源不加载。
- [ ] H5：同一冻结版本的三平台回归、真实厂商、正式签名/镜像许可、文档与发布门禁同步。前置 H2/H4；无真实证据不勾选，不能以测试签名候选发布。

允许跳过外部资源等待以继续无依赖项；不跳过失败的工程保证。此清单完成前，旧 containment 缺口与统一分发发布阻断保持有效。
