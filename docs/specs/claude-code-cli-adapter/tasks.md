# 任务

- [x] 官方机器接口/条款核对、2.1.284 macOS 包完整性验证、无凭据探针；证据见能力矩阵。
- [x] CLI Host 有界 stdin；新增输入/大输入/取消回归，通过 Host 测试。
- [x] 厂商 manifest、严格解析器、Wrapper 和 Adapter；通过 fixture Conformance 和错误/取消矩阵。
- [~] Local Runtime 静态接入及 SDK 路径验收；保持打包入口可用，检查依赖边界。
- [x] 实际无凭据 CLI 经 SDK/独立 Runtime 返回 AUTHENTICATION_FAILED，持久化 failed；macOS arm64 2.1.284，`scripts/smoke-claude-code-cli.mjs`。
- [ ] macOS/Windows/Linux 工程 CI、交付说明与升级门禁。
- [ ] 真实 API Key 文本/usage/cancel 验收（阻断：用户目前没有密钥）。
- [ ] Remote 强隔离、真实厂商跨平台认证（独立后续门禁）。
