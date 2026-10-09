# 任务

- [x] T1：requirements/design/tasks 先提交。
- [x] T2：私有帧与 Host/Guest 桥；定向测试覆盖背压、限额、错误、断开与规范化。
- [x] T3：Claude 部署 loopback 配置、Sandbox 接线、Worker grant callback；build/typecheck 与相关包回归。
- [x] T4：完整 SDK/Redis/Mongo/Worker/Docker/pinned Claude 合成上游成功、取消与隔离 CI；7 项全通过、零跳过，见 `evidence/be56b81/`；不冒充付费调用。
- [x] T5：运维、限制、roadmap、证据已归档；实现源码 `be56b81` 已推送，最终 8 个 CI 全通过（分发 macOS 同源码重跑记录见证据）。
