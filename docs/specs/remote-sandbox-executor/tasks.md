# 任务

- [ ] 中立 Docker Sandbox Adapter 与固定 create 策略；配置/路径/清理失败负例测试。
- [ ] Sandbox guest 的 Sidecar 转发与 lease watchdog；固定 Adapter allowlist、无凭据与能力拒绝测试。
- [ ] Worker opt-in 集成及已有 Reference 回归；run.adapterId 必须与实际 Adapter 匹配。
- [ ] Linux Docker CI 实测生命周期、父强杀、并发隔离与配置证据，不将 mocks 计入实际认证。
- [ ] 安装/运维/已知限制、总体 roadmap 与证据归档。
- [ ] 后续：出网策略与 credential broker、真实厂商认证、持久 Session 与恢复。
