# 任务

## 离线工程基线（2026-10-09）

- [x] 中立 Docker Sandbox Adapter 与固定 create 策略；配置/路径/清理失败负例测试。sandbox-docker 12 项通过。
- [x] Sandbox guest 的 Sidecar 转发与 lease watchdog；固定 Adapter allowlist、无凭据与能力拒绝测试。
- [x] Worker opt-in 集成及已有 Reference 回归；run.adapterId 与实际 Adapter 严格匹配。Worker 配置/协调器 11 项通过。
- [x] Linux Docker CI 实测生命周期、父强杀、并发隔离、未启动容器回收与配置；见 `evidence/dac5b24/`，不将 mocks 计入实际认证。
- [x] Claude CLI、CodeBuddy SDK 经过 SDK → HTTP → Redis → Worker → Docker；无凭据错误持久化，5 项 E2E 全通过，无跳过。
- [x] 同一完整链路接入实际 Mongo 8.0.32 Store，5 项全通过；禁用 Docker 持久日志的实际检查通过。见 `evidence/1386dbb/`。
- [x] 安装/运维/已知限制、总体 roadmap 与证据归档：`docs/delivery/four-mode-engineering-preview.md`。
- [ ] 后续生产门禁：出网策略与 credential broker、真实厂商认证、持久 Session 与恢复、真实 Mongo/TLS 部署。离线基线不能代表四模式整体完成。
