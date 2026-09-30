# Claude Code CLI 能力矩阵

状态：Experimental，2026-09-30。候选固定版本 2.1.284。不是生产认证。

## 官方依据与受测制品

- [Headless](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Commercial/legal](https://code.claude.com/docs/en/legal-and-compliance)
- 官方 npm `@anthropic-ai/claude-code-darwin-arm64@2.1.284`，98952459 bytes。
- 包 SHA512 SRI：`sha512-WczsKY4Bg4dlh5M2UILMHM/9xpBdDcXLulzCSE+TFIb6itI7q3kfYTIwvKOzxB557krwHEuKLgWkUiXGdojjVQ==`。
- 下载后按 registry 元数据校验，解包到临时目录；没有全局安装或收集已有用户凭据。

## macOS arm64 实际观察

经 CLI Host/私有 HOME，以显式环境运行 `--version` 返回 `2.1.284 (Claude Code)`，exit 0。
`--bare -p 'Return OK.' --tools '' --permission-mode dontAsk --output-format stream-json --verbose
--include-partial-messages --max-turns 1 --max-budget-usd 0.01` 无凭据运行非零退出。
输出依次含 commands_changed/init/status/assistant/result。init tools=[]、apiKeySource=none；
assistant.error=authentication_failed；result.subtype=success 但 is_error=true、terminal_reason=api_error。
usage 与费用为零。必须检查 is_error，不可仅依据 subtype 判定成功。
原始 commands_changed 含大量内置元信息，未纳入受信指令或输出 fixtures。

| 能力                                            | 首版声明             | 证据/限制                                    |
| ----------------------------------------------- | -------------------- | -------------------------------------------- |
| 非交互 JSONL                                    | 支持                 | 实际无凭据输出已验证                         |
| 文本流                                          | native，Experimental | 官方格式 + fixture；真实付费增量待验收       |
| 取消                                            | emulated             | Host 终止进程；真实调用与 POSIX 父强杀待认证 |
| session ID                                      | 记录，不恢复         | init 实测有 ID；临时目录每次销毁             |
| usage tokens/cost                               | native，Experimental | 错误结果零值实测；付费值待验收               |
| resume、工具、权限交互、扩展、模型列表、sandbox | unsupported          | 未授权启用且未完成实测                       |

用户 2026-09-30 明确暂无 API Key：付费成功、费用和真实取消门禁保持未完成。
厂商二进制由用户独立安装，升级须重新锁定版本、验证官方完整性并重新运行全部能力门禁。
