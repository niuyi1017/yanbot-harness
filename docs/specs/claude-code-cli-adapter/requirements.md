# Claude Code CLI Adapter

## 目标

实现四种模式中的首个 CLI 厂商接入；用户已选择 Claude Code。首版锁定 2.1.284，
以 Experimental、无工具文本能力进入 Local Runtime 静态允许列表，复用 Sidecar/CLI Host。
用户目前没有 Anthropic API Key，真实模型调用验收必须保留为未完成。

## 验收标准

1. 独立 Wrapper 通过公开 Sidecar 协议，SDK 和平台 CLI 不增加厂商字段。
2. 精确版本不符时拒绝执行。只接收部署配置的绝对可执行路径，不接受 shell 或在线安装。
3. 使用 bare、dontAsk、禁用工具、私有 HOME/config、显式环境；仅 Runtime 配置可传入自有 API Key。
4. 请求 prompt 通过有界 stdin 传输，不放在进程参数中；版本、权限、扩展、恢复能力先校验。
5. init、文本增量和最终 usage 映射成公共事件；is_error/assistant API error/缺终态/非零退出不能成功。
6. 终态在进程和临时目录收尾后派发，取消不继续输出；凭据与原始诊断不能进入事件或日志。
7. 覆盖结构化认证失败、错误 subtype、重复/缺失终态、错版本、取消与错误能力拒绝。
8. 实际无凭据 CLI 通过 Runtime/SDK 路径返回 AUTHENTICATION_FAILED；真实付费成功不以 fixture 代替。

## 边界和依赖

首版不开放工具、交互、恢复、扩展、工作区隔离或模型发现，不将文档支持等同实测认证。
CLI 由用户独立安装，仓库不分发厂商二进制。集成须遵循厂商商业条款，用户使用自有授权凭据；
不收集订阅 OAuth token，不提供中转转售。Remote 容器与真实模型认证由后续独立门禁覆盖。
POSIX 父强杀的完整树归属尚未认证，不能声明强隔离；Windows 必须配置原生 Job host。
