# 四模式工程候选

此文档描述 Harness 基座的执行能力，版本仍为 Experimental/Preview。四模式是两个维度的组合：
Local/Remote 决定执行位置，SDK/CLI 决定厂商接入方式；应用使用同一套 Session、Run、Event API。

| 执行位置 | SDK 型                                                   | CLI 型                                                                |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Local    | 现有 CodeBuddy Adapter，沿用公共 Adapter SPI             | Claude Code 2.1.284，通过独立 Wrapper 与 CLI Host                     |
| Remote   | Sandbox Guest 装载 CodeBuddy SDK，缺凭据返回标准认证失败 | Sandbox Guest 装载 Claude Wrapper，断网无凭据认证失败已通过 Docker CI |

## 已验证与限制

- Local Claude 无凭据路径已在 macOS arm64、Windows x64、Linux x64 实际通过；该结果证明版本/协议/错误/清理路径。
- Docker CI 已验证 Reference 完整运行、Claude 实际二进制认证失败、非 root、只读根文件系统、资源限制、断网、并发隔离、取消和父强杀回收。
- 完整 Remote SDK → HTTP/SSE → Redis → Worker → Docker 厂商链路已使用真实 Mongo 8.0.32 Store，通过 5 项 E2E、无跳过；独立 Mongo 事务/索引/重连测试 8 项通过。CI 单节点部署不能作为生产 TLS/认证/故障切换证据。
- 用户目前没有 Anthropic Key。真实模型成功、费用、带模型请求的取消未验收。生产 credential broker、受控模型出网、持久 Session volume/恢复与生产部署仍是后续门禁。
- Remote 厂商入口只在 development/test 中显式开启；production 配置拒绝实验开关。默认仍是 Reference。

## Local CLI 配置

```sh
export YANBOT_HARNESS_ADAPTER=claude-code-cli
export CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude
# 有自有授权 Key 时才配置；文件权限 0600。
export ANTHROPIC_API_KEY_FILE=/absolute/path/to/private-key-file
pnpm --filter @yanbot-harness/local-runtime start
```

Windows 额外配置 `HARNESS_CLI_JOB_HOST` 指向构建的 `cli-job-host.exe`。只支持固定版本 2.1.284；不会隐式安装或升级 CLI。

## Remote 候选配置

Cloud Server 保留既有 Mongo/Redis/认证配置，开发/测试环境选择需要的固定厂商：

```sh
CLOUD_EXPERIMENTAL_CLAUDE_CLI=true
CLOUD_EXPERIMENTAL_CODEBUDDY=true
```

Worker 保留既有队列、internal origin、worker ID 和 snapshot root，增加：

```sh
WORKER_EXECUTION_MODE=sandbox
WORKER_DOCKER_PATH=/usr/bin/docker
WORKER_SANDBOX_IMAGE=sha256:<64-hex-local-image-id>
```

镜像必须已存在且不可变。Claude 候选镜像须独立包含 `/opt/claude/claude`；CI 的测试镜像安装过程校验官方固定 SHA512，镜像不发布。
默认网络关闭，容器没有厂商 Key，也没有 Docker socket 或宿主 bind mount。快照经有界 stdin 送入 tmpfs，容器退出即销毁。

SDK 创建 Session 时选择 `cn.tencent.codebuddy` 或 `com.anthropic.claude-code-cli`，通过既有 `prepareWorkspaceSnapshot` 创建工作区。
调用 `createRun` 使用 `permissionPolicy: 'read-only'`、`maxTurns: 1`，不开启 resume、extensions 或 config scopes。
缺少凭据时预期看到 `run.started` → `run.failed`，错误码 `AUTHENTICATION_FAILED`，持久化状态为 `failed`。

## 验证与回滚

- `pnpm check`：类型、依赖边界、单元与离线 probes。
- `scripts/smoke-claude-code-cli.mjs`：独立 Local Runtime + SDK 的无凭据探针；只有显式 `--live` 才读取 Key file。
- `scripts/probe-remote-sandbox.mjs`：在专用 Linux Docker 测试环境运行，所需三个不可变镜像变量见 `.github/workflows/remote-sandbox.yml`。
- 关闭 Cloud Server 的两个实验开关，Worker 恢复 Reference 执行配置，即可停止新厂商 Run 的接入；已派发的 Run 先按既有取消流程收敛。
- 旧候选镜像保留在受信部署侧，以 digest 切回。禁用自动更新，不混用厂商版本与 Wrapper 版本。

证据和剩余任务以 `docs/specs/remote-sandbox-executor/`、`docs/specs/claude-code-cli-adapter/` 及总 roadmap 为准。

工程证据：[`1386dbb` Mongo/Docker 与 Worker E2E](../specs/remote-sandbox-executor/evidence/1386dbb/README.md)；已有 Cloud 部署的显式索引迁移见 [Mongo 运维说明](../specs/remote-mongo-conformance/operations.md)。
