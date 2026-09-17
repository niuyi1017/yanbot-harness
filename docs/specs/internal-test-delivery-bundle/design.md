# 内测单文件交付设计

## 1. 交付语义

`@yanbot-harness/local` 是唯一面向同事的安装入口，但 npm 包仍保留既有职责边界：

```text
一个外层交付文件：yanbot-harness-<V>-<TARGET>-internal-test.zip
└─ 一个安装入口：node install.mjs
   └─ 离线安装根：@yanbot-harness/local@V
      ├─ @yanbot-harness/sdk@V
      └─ @yanbot-harness/runtime@V
         └─ @yanbot-harness/runtime-<TARGET>@V
```

“一个包”指使用者只拿一个 ZIP、只安装一个 local 入口，不表示把各 npm 包物理合并成单一 tgz。继续保留包边界可避免 SDK-only 路径下载 Runtime，也让 npm/pnpm 的平台选择和精确版本约束保持可审计。

## 2. ZIP 布局

```text
yanbot-harness-<V>-<TARGET>-internal-test/
├─ README.zh-CN.md
├─ install.mjs
├─ delivery-manifest.json
├─ SHA256SUMS
├─ internal-test-trust.json
└─ offline-kit/
   ├─ install-local.mjs
   ├─ kit-manifest.json
   ├─ kit-manifest.sig
   └─ packages/*.tgz
```

顶层 `install.mjs` 只做路径归一化、默认安装目录选择和无 shell 的子进程调用；验签、闭包校验、离线 npm 安装与 Reference smoke 继续由 `offline-kit/install-local.mjs` 负责。安装器先用全部本地 tgz 引导 npm 的离线解析，再在仍然离线的同一 cache 中把最终 `package.json` / lock 规范化为仅有 `@yanbot-harness/local` 一个直接依赖，并以 `npm ls` 验证其传递闭包。测试公钥位于签名 kit 外层，明确标为 internal-test；不能把 payload 内自带的 key 当作生产信任根。

## 3. 构建流程

新增 `scripts/build-internal-delivery.mjs`：

1. 接收同一源提交生成的 common 与 platform 构建目录。
2. 调用既有 `build-offline-kit.mjs`，复用签名 manifest 和依赖闭包装配。
3. 从已验证的 platform report 推导目标，并只允许 `darwin-arm64` 或 `win32-x64`；校验测试签名为真、生产授权为假。
4. 将 kit 与外置信任文件复制到全新 staging，生成说明、入口及外层清单。
5. 枚举所有普通文件并生成排序稳定的 `SHA256SUMS`；拒绝链接和非普通文件。
6. 用既有 ZIP helper 归档到显式输出目录；输出 JSON 报告及 ZIP SHA-256。

产物默认写入被 Git 忽略的 `delivery-output/`。生成器拒绝覆盖同名 ZIP；重复生成时调用者必须选择新的空输出目录或显式清理自己的旧产物。

## 4. 验证流程

新增 `scripts/test-internal-delivery.mjs`，分两层：

- fixture 测试验证清单、路径、链接、篡改、目标平台和现有目录拒绝。
- 实际候选验证在含空格/中文的全新目录解压，核对 ZIP SHA、文件全集与每个 SHA-256，再以空 npm cache 执行 `node install.mjs --prefix <new-dir>`；成功标准为 installer 输出 `run.completed`。

验证使用系统 ZIP 解压器，但在信任任何内容前检查 archive 列表的绝对路径、`..`、重复和顶层目录约束。实际安装仍由签名 kit 的严格验证保护。候选验证抽成可复用脚本，接收一个交付 ZIP，在当前平台完成校验、全新目录解压、一键离线安装及报告输出。

Windows 最终包由 `unified-local-installation.yml` 的 `windows-2022` job 在既有 unified common/platform 验证后生成；同一 job 运行候选验证脚本，并只在成功后上传 ZIP 与验证报告。这样避免在 macOS 上拼装未经 Windows 实际执行的制品。

内测交付采用 GitHub Actions artifact 作为临时下载源：交付说明固定到已通过门禁的 run 和 artifact ID，并记录 Actions 外层 artifact 摘要、内层交付 ZIP 摘要、源提交及过期时间。下载者先解开 Actions 外层 ZIP，再把其中的 `*-internal-test.zip` 作为唯一交付包；本地不重复保存 Windows 大体积制品。

## 5. 安全与发布边界

- ZIP 只含测试公钥，不含任何私钥；签名身份明确为 `offline-kit-test-only`。
- README 和 manifest 同时标注 `productionAuthorized: false`。
- 不复用冻结 preview.2 的目录或文件名。
- 源提交可能含本次交付生成器本身；common/platform 必须在实现提交后重新构建，不能把旧提交产物冒充当前交付。
- 正式交付仍需正式签名、受控 Registry/分发、镜像与厂商再分发许可及三平台认证，不由本方案解除。

## 6. 未采用方案

- **仅发送 `@yanbot-harness/local.tgz`**：离线环境无法解析其 SDK/runtime/platform/第三方依赖，不能安装。
- **把所有依赖物理打进 local.tgz**：破坏已确认的包职责、SDK-only 轻量路径和平台 optional 选择。
- **一个 ZIP 混装三平台**：显著增大体积且容易误用；每个平台应生成独立的单文件交付物。
- **把测试信任根放进签名 kit 并自动信任**：会形成自认证，不保留信任边界。
- **在 macOS 本地拼装 Windows ZIP 后直接交付**：无法证明顶层安装器、Windows 路径与该 ZIP 的真实离线安装行为；改由 Windows runner 原生构建和验收。
