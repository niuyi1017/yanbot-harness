# 设计

- 新增 `packages/adapter-claude-code-cli`，提供 ClaudeCodeCliAdapter、协议 Wrapper、事件解析器和固定 manifest。
- 复用 adapter-sidecar 的 Bridge/Supervisor；复用 adapter-cli-host 的版本探针、进程归属、目录 ACL、流量限额。
  Adapter 将可信部署配置映射到 Wrapper 的独立环境；公共 Adapter context 有值时明确拒绝未映射配置。
- Wrapper 接收有界 JSONL 请求（4 MiB），初始化后允许 probe/start/cancel/shutdown。一次只运行一个请求，
  stdin EOF/SIGTERM/SIGINT 取消运行并等待清理；stdout 只写公共 JSONRPC 帧，并等待写入回调提供背压。
- CLI Host 增加可选标准输入字符串，最大 4 MiB，启动后写入并关闭；同时启动输出消费以避免双向管道死锁。
- 每次调用建立私有 HOME/CLAUDE_CONFIG_DIR；bare 禁用外部配置自动发现，固定工具空集，permission-mode dontAsk，
  禁用自更新和非必要遥测，默认 max-turns=1、max-budget-usd=0.10。预算为厂商软运行限额，不声称精确费用硬上限。
- 精确 `2.1.284 (Claude Code)` 版本检查先于每次运行；请求只允许 read-only、无 extensions、无 adapterSessionId。
- 解析 system/init 的 session_id；忽略已知系统元信息与心跳；解析 stream_event 文本增量，assistant 完整消息去重，
  result 的有限非负 token/cost。未知事件种类或不合模式的工具输出失败关闭。
- 结果仅缓存，不直接发终态；runVendorCli 正常返回且目录清理通过后才发 completed。auth 错误使用固定文案。
  原始错误/诊断绝不透传；清理失败优先于认证/取消错误。
- Runtime entrypoint 用 YANBOT_HARNESS_ADAPTER=claude-code-cli 选择，厂商路径/Key file/Job host 来自环境；
  credentials 使用既有受保护文件读取器。SDK 无变化。发行打包需要包含 Wrapper 编译产物并验证相对资源路径。

## 放弃方案

不把厂商 CLI 嵌入 Runtime 进程：独立 Wrapper 可隔离协议噪声与故障；不以通用任意命令 Adapter 替代固定厂商映射，
避免公共 API 变成 shell 入口。不启用文档提及但没有凭据实测的 resume/工具权限，后续按能力逐项认证。

## 三平台无凭据认证门禁

CI 在 macOS arm64/Windows x64/Linux x64 从官方 registry 下载独立平台包到 runner 临时目录，
先校验仓库固定 SHA512 再解包，仅运行无凭据 SDK 冒烟；二进制不进入仓库或上传 artifacts。
Windows 先编译可信 CLI Job host。只上传脱敏 JSON 测试报告。安装脚本拒绝未知平台、版本和摘要，
不执行 npm lifecycle。此门禁只认证无凭据路径，仍不能声明真实付费调用成功。
