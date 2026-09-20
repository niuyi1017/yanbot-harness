# 双 Runtime 矩阵证据设计

## 1. 总体方案

证据分成“单 runner 运行”和“跨 runner 聚合”两层：

```text
macos-15                         windows-2022
  local HTTP/SSE                  local HTTP/SSE
  remote injected fixture        remote injected fixture
          │                              │
          └──── platform report v1 ──────┘
                         │
                  strict aggregator
                         │
          matrix-summary.json (incomplete)
                         │
        future real Remote service evidence
```

单 runner 同时执行 Local 与 Remote Fixture，是为了证明共享断言在该 Node/OS 组合下可运行。聚合器把 `runtimeKind`、
`transport` 和 `serviceEvidence` 作为不可变身份字段，因此 Fixture 无法填补真实 Remote service 槽位。

## 2. 复用 Conformance 的运行器

新增 `scripts/lib/dual-runtime-evidence.mjs`，从已构建 workspace package 导入：

- `startLocalRuntime` 与 `ReferenceAdapter`，构造真实 loopback `/v1` driver；
- `createRemoteReferenceFixture` 与 `HarnessClient`，构造 injected-fetch Remote driver；
- `verifyRuntime*Conformance` 四个公共场景函数。

每个场景使用全新 Runtime/Fixture，保持与现有 Vitest suite 相同的隔离语义。共享场景定义唯一来源仍是
`@yanbot-harness/testing`，脚本不复制断言。清理在 `finally` 执行，单场景结果按固定 ID 排序。

## 3. Platform Report Schema

```ts
type PlatformEvidenceV1 = {
  schemaVersion: 1;
  evidenceKind: 'dual-runtime-platform';
  source: { commit: string; dirty: boolean };
  generatedAt: string;
  runner: {
    target: 'darwin-arm64' | 'win32-x64';
    platform: 'darwin' | 'win32';
    arch: 'arm64' | 'x64';
    node: string;
  };
  versions: { release: string; protocol: string };
  runtimes: [LocalEvidence, RemoteFixtureEvidence];
  remoteService: {
    status: 'not-run';
    reason: 'formal-remote-service-not-implemented';
  };
  status: 'passed' | 'failed';
};
```

每个 runtime 条目包含固定身份、四个 scenario 结果和总状态。错误只保留 `error.name` 与经归一化、长度受限的 message；
生成器去除当前临时根路径，并拒绝换行和控制字符，避免报告成为日志注入或本机路径泄漏渠道。

source commit 优先读取 Git 本身而非调用方字符串；若 Git 不可用则命令失败。`git status --porcelain` 只用于生成 dirty
布尔值，不把文件名写入报告。`generatedAt` 是唯一非确定字段。

## 4. 目标绑定

目标映射冻结为：

| target       | platform | arch  | CI runner    |
| ------------ | -------- | ----- | ------------ |
| darwin-arm64 | darwin   | arm64 | macos-15     |
| win32-x64    | win32    | x64   | windows-2022 |

生成器启动前比对 `process.platform` 与 `process.arch`。因此 macOS 开发机不能通过传入 `win32-x64` 生成看似真实的 Windows
报告，聚合器也会再次验证映射。

## 5. 聚合器

`scripts/aggregate-dual-runtime-matrix.mjs <output> <reports...>` 完整解析并严格验证所有报告：

- exact top-level/runtime/scenario fields；
- 两个 target 各出现一次且 commit 完全相同；
- Local/Fixture 身份、execution mode、transport、service flag 固定；
- 四个 scenario ID 唯一、齐全且全通过；
- `remoteService` 只能是本阶段定义的 `not-run`。

输出 `dual-runtime-matrix` v1，状态为 `incomplete`，包含平台报告的相对证据摘要而非嵌套任意原始输入。聚合器成功表示
“证据基础设施与已有 Reference 后端通过”，不表示 P3.8 或 Remote 产品完成。

## 6. CI 工作流

新增 `.github/workflows/dual-runtime-matrix.yml`：

1. `platform-evidence` matrix 在 macOS/Windows 安装、build、执行生成器并上传 JSON。
2. `aggregate` 在 Ubuntu 下载两个 artifact，严格聚合并上传 summary。
3. workflow 由 pull request、push 和手工触发；不读取 secrets。

matrix artifact 名包含 target；聚合 job 显式传入两个预期文件路径，避免目录扫描误收旧证据。

## 7. 测试策略

- 本机运行生成器，取得真实 `darwin-arm64` Local/Fixture 报告。
- Node 单测用最小合法报告测试聚合成功，并覆盖缺失 target、commit 不同、重复 target、Fixture 冒充 service、场景失败和
  platform/arch 不匹配。
- root `test:probes` 纳入聚合器单测；`pnpm check` 回归全仓。
- workflow YAML 通过 Prettier，并由脚本测试锁定 runner/target 映射和 artifact 名。

## 8. 状态规则

实施完成后只把 P3.8 拆分子项中的“生成器/CI/聚合器”勾选。以下两项仍保持未完成：

- Windows GitHub Actions 实际 run URL 与 source commit 尚未取得；
- 正式 Remote service 尚不存在，无法生成 HTTPS/service evidence。

只有后续取得真实报告并归档，才能将 P3.8 顶层标为完成。

## 9. 拒绝方案

- **解析 Vitest 控制台输出**：输出非稳定机器契约，且无法绑定 transport 身份；直接调用共享场景函数。
- **把 Fixture 标成 Remote service**：会制造错误兼容结论；Schema 强制 `serviceEvidence: false`。
- **在 macOS 交叉生成 Windows JSON**：只能证明字符串参数，不证明 Windows 行为；target 必须匹配当前进程。
- **Remote service 缺失即让 CI 永远红**：会阻塞证据基础设施落地；aggregate 用 `incomplete` 明示缺口，Phase 6 再升级为
  完整发布门禁。
