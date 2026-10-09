# 任务

- [x] T1：需求/设计/任务与总体凭据边界更新，独立提交。
- [x] T2：策略/私有文件/文本输入验证、增量转发与脱敏；10 项定向测试通过。
- [x] T3：execution grant 授权、Run 原子计数、Cloud 内部 HTTP 入口与审计；8 项 HTTP 正负例通过。
- [x] T4：实际 Mongo 并发/重连计数、取消/租约失效/客户端断开、错误和限额回归；CI 26 项全通过、零跳过，见 `evidence/558c962/`。
- [x] T5：配置/运维/限制见 `operations.md`，证据已归档并更新 roadmap；实现提交 `6d3e262` 已推送。

后续独立阶段：Sandbox Guest/Worker 传输桥、CodeBuddy 策略、真实 Key 冒烟与生产认证。
