# 第三方 CLI Harness Adapter 需求

## 1. 背景

当前首个生产Adapter通过厂商 Node SDK（仓库实现名为 `adapter-codebuddy`）进程内接入。但第三方AI Harness并不一定
提供可嵌入的Node SDK；部分产品主要通过独立CLI提供Agent能力，例如可将Claude Code CLI作为此类接入方式的候选。
具体厂商是否提供其他SDK不影响本设计：只要本次选用的集成面是CLI，就必须经过标准CLI Adapter边界。

现有 `adapter-sidecar` 已冻结 JSON-RPC 2.0 over JSON Lines 的请求、响应与事件Schema，但尚未实现child process
（子进程）启动、监管、厂商CLI解析或真实Adapter。因此目前是“架构已预留，产品能力未完成”。

一句话目标：**用厂商专用 Sidecar Wrapper 把第三方CLI翻译成统一Adapter SPI，使平台SDK、平台CLI、Local Runtime
和Remote Runtime不感知厂商命令行差异。**

## 2. 术语边界

- **平台 CLI**：用户调用的 `yanbot-harness` 命令，是 `@yanbot-harness/sdk` 的消费者。
- **厂商 CLI**：Claude Code或其他第三方Agent命令行程序，只在对应Adapter内部运行。
- **Sidecar Wrapper**：平台可监管的厂商专用可执行适配器，对上说Harness JSON-RPC，对下托管厂商CLI。
- **CLI Host**：各厂商Wrapper可复用的安全子进程、管道、超时、取消与清理基础设施。

平台 CLI 与厂商 CLI 不能直接相互调用，也不能共用stdout协议通道。

## 3. 用户故事与验收标准

### CA1. 统一Adapter入口

- Runtime只通过 `adapter-api` 调用CLI型Adapter，与SDK型Adapter使用相同Session、Run、Event和Error语义。
- 业务代码只选择 `adapterId + modelRef`，不拼接厂商命令或解析厂商输出。
- 同一CLI型Adapter可以被Local Runtime和Remote Worker装载；差异仅在安装路径、凭据来源和沙箱策略。
- SDK、平台CLI、Local Web和Electron不新增厂商专用API。

### CA2. 厂商专用Wrapper

- 每个厂商CLI必须有独立Wrapper/driver，负责版本探测、argv、输入、机器可读输出和错误映射。
- Wrapper通过Harness Sidecar JSON-RPC接收 `initialize`、`probe`、`startRun`、`resumeRun`、`cancel` 等请求。
- Wrapper stdout只能输出Harness JSONL协议帧；厂商CLI通过独立管道运行，其原始stdout/stderr不得直接穿透。
- 核心层和通用CLI Host不得按 `claude`、`codebuddy` 或其他厂商名写分支。

### CA3. 机器可读输出门禁

- 生产级CLI Adapter优先要求厂商提供文档化、机器可读、可流式的JSON/JSONL输出。
- 厂商输出必须映射为有序Harness Event，并以唯一终端事件结束。
- 只提供面向人的彩色终端文本时，Adapter默认保持Experimental，不得依赖脆弱正则宣称生产兼容。
- 如确需文本解析，必须锁定CLI精确版本、禁用颜色/动画、建立完整fixtures并在版本升级时阻断重验。

### CA4. 能力如实协商

- `resume`只有CLI提供稳定session ID/恢复命令时才能声明`native`；历史提示重放只能显式声明`emulated`及限制。
- `cancel`必须至少停止平台事件流并清理进程；能否得到厂商确认的取消终态需要单独声明。
- 权限请求、用户提问、模型列表、MCP/Skill、用量与Computer Use都按真实CLI能力声明。
- 不支持能力返回 `CAPABILITY_UNSUPPORTED`，不得通过伪造空结果或自动批准实现表面一致。

### CA5. 交互与非交互执行

- 厂商CLI必须以非交互/无TTY模式运行，或者由Wrapper通过明确、可测试的结构化通道处理交互。
- 未知登录提示、升级提示、遥测同意、权限确认或分页器不得挂起后台Run。
- CLI能输出结构化权限/提问事件时，Wrapper映射为Harness Interaction并关联request ID。
- 只能依赖TTY按键的交互首期标记unsupported；不在生产环境模拟终端按键猜测状态。

### CA6. 凭据与配置

- 厂商API Key、OAuth token或登录目录只由Runtime/Worker按最小范围注入Sidecar或厂商CLI。
- 凭据不得进入命令行参数、Sidecar JSONL、事件、stderr、错误、进程列表或持久化Session状态。
- 环境变量使用Adapter allowlist，不透传Runtime完整 `process.env`。
- Local可以使用用户已有CLI登录态，但必须显式选择且记录凭据来源摘要；Remote只能使用平台管理的短期凭据或隔离凭据目录。

### CA7. 生命周期与取消

- CLI Host负责启动超时、运行超时、空闲超时、最大输出、背压和协议行长度限制。
- 取消采用分阶段升级：请求优雅中断，等待有限时间，再终止整个进程树。
- POSIX使用独立进程组；Windows使用可靠的进程树/Job Object等价机制，不能只杀父进程留下厂商子进程。
- Sidecar崩溃、厂商CLI崩溃、无终端事件退出和协议损坏都必须映射为确定错误并释放资源。

### CA8. 安装、版本与供应链

- Adapter manifest声明支持的CLI版本范围、OS/arch、可执行文件发现方式、能力和配置Schema。
- 本地交付明确区分：平台是否打包Wrapper、是否允许打包厂商CLI、或要求用户单独安装；遵守厂商许可证。
- Remote镜像锁定厂商CLI精确版本和摘要，不在Run期间在线自动升级。
- 市场安装只接受签名/允许列表Adapter；不得让manifest提供任意shell字符串或启动未授权可执行文件。

### CA9. 一致性与真实门禁

- 假CLI覆盖分帧、背压、噪声、错误、取消和进程清理，普通CI不消耗真实账号。
- 每个真实CLI版本必须通过Adapter Conformance Kit和独立能力矩阵。
- macOS和Windows Local分别认证；Remote使用实际Linux镜像认证，三者证据不能互相替代。
- CLI升级必须先更新fixtures并重跑真实冒烟，不自动合并依赖升级。

## 4. 当前范围

本次任务补齐需求、设计和实施计划，不选择或实现具体Claude版本，也不宣称Claude Code或其他CLI厂商已兼容。
首个真实CLI Adapter开始前，需要基于厂商当前文档和安装包做能力探针并建立单独子Spec。

## 5. 非目标

- 不让平台SDK或平台CLI直接执行厂商CLI。
- 不构建一个靠配置文件就能解析所有厂商终端文本的“万能Adapter”。
- 不默认使用PTY模拟人工终端交互。
- 不把CLI厂商账号、许可证或长期凭据固化进交付包。
- 不因CLI缺少某项能力而修改公共Session/Run/Event语义。

## 6. 依赖

- `packages/contracts`、`packages/adapter-api`、`packages/adapter-sidecar`、`packages/adapter-kit`、`packages/testing`。
- `apps/local-runtime` 与后续 `apps/cloud-worker` 的Adapter进程监管入口。
- `docs/specs/dual-runtime-compatibility/` 的Local/Remote安全与认证边界。
