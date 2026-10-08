# 任务

- [x] 官方机器接口/条款核对、2.1.284 macOS 包完整性验证、无凭据探针；证据见能力矩阵。
- [x] CLI Host 有界 stdin；新增输入/大输入/取消回归，通过 Host 测试。
- [x] 厂商 manifest、严格解析器、Wrapper 和 Adapter；通过 fixture Conformance 和错误/取消矩阵。
- [x] Local Runtime 静态接入及 SDK 路径验收；保持打包入口可用，检查依赖边界。
- [x] 实际无凭据 CLI 经 SDK/独立 Runtime 返回 AUTHENTICATION_FAILED，持久化 failed；macOS arm64 2.1.284，`scripts/smoke-claude-code-cli.mjs`。
- [x] macOS/Windows/Linux 无凭据工程 CI、交付说明与固定版本升级门禁。实际 CI `37814307621`；配置/回滚见 `docs/delivery/four-mode-engineering-preview.md`。
- [ ] 真实 API Key 文本/usage/cancel 验收（阻断：用户目前没有密钥）。
- [x] Linux Remote 断网 Sandbox 与完整 SDK/HTTP/Redis/Worker 无凭据路径；见 `../remote-sandbox-executor/evidence/dac5b24/`。
- [ ] Remote 模型出网、credential broker、持久 Session 和真实厂商跨平台认证（独立后续门禁）。
