# 内测单文件交付实施清单

- [x] D0：冻结 requirements/design/tasks，明确“单 ZIP、单 local 入口、离线依赖闭包”与测试签名边界。
- [x] D1：实现外层交付生成器、顶层安装入口、中文 README、manifest 与 SHA256SUMS。
- [x] D2：实现生成器和归档验证测试，覆盖路径、链接、篡改、错误平台、输入不一致与拒绝覆盖。
- [x] D3：更新 package scripts、Git ignore 和交付索引；全量 `pnpm check` 通过。
- [x] D4：在实现提交 `2ed0ecd` 上重新构建 common 与 `darwin-arm64` 测试签名 platform，生成一个最终 ZIP。
- [x] D5：在中文/空格路径、空 npm cache 中从 ZIP 一键安装，最终清单只直接依赖 `@yanbot-harness/local`；摘要、npm 树与 Reference smoke 均通过。证据见 `verification-evidence.json`。
- [x] D6：提交证据与说明并推送 `zb-dev`；175,357,443 字节的大体积 ZIP 保持本地交付文件，不提交 Git。
- [x] D7：更新 spec，将单文件交付目标扩展到 `win32-x64`，明确 Windows runner 原生构建、验证与 artifact 下载链路。
- [ ] D8：泛化交付生成器与 README，按 platform report 生成 `darwin-arm64` 或 `win32-x64` 单 ZIP；补充两平台 fixture 测试与候选验证脚本。
- [ ] D9：更新 Windows unified job，在同一提交的 common/platform 上构建并完整验证 Windows 单 ZIP，上传 ZIP 与验证报告。
- [ ] D10：下载通过门禁的 Windows ZIP 到本地 `delivery-output/`，记录大小、SHA-256、源提交和验证证据，更新交付说明并推送 `zb-dev`。

外部门禁：正式签名/信任根、Registry scope、guest/vendor 再分发许可、真实厂商 BYOK、Windows 10/11 与两个正式签名 release 回滚仍未完成，不能将 D0–D6 的内测候选称为生产发布。
