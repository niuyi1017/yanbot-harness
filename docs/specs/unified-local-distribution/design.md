# SDK 与 Local Runtime 统一安装设计

状态：**方案已确认，T1 探针进行中，T2–T7 产品实现未开始**。基线：2026-09-15 / `0247627`。
总体进程和凭据边界遵循 [system architecture](../../architecture/system-architecture.md)；当前交付能力仍以 [compatibility](../../delivery/compatibility.md) 为准。

## 1. 评审结论与当前证据

推荐采用 `@yanbot-harness/local` 本地入口，组合轻量 SDK、Runtime meta/resolver 和匹配平台的完整 payload。SDK 与 Runtime 继续独立模块、独立进程；安装层不构成第三种 Runtime 部署形态。

| 审计对象                              | 当前事实                                                                                            | 本次设计的增量                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/sdk/package.json`           | 生产依赖仅 contracts；Runtime 仅 devDependency                                                      | 维持生产依赖边界，增加 resolver 注入点                     |
| `packages/sdk/src/managed-runtime.ts` | 显式路径/env、spawn、descriptor PID 校验、health、幂等 close                                        | 自动定位装配、完整 deadline、控制通道、崩溃回收            |
| 同文件的 Windows 分支                 | `taskkill /T /F` 直接强制终止；POSIX 对 Runtime 发信号                                              | 先正常关闭，再对受拥有的整个树有界兜底                     |
| `apps/local-runtime`                  | private workspace app；独立 loopback 服务                                                           | 继续作为唯一 Runtime 实现来源                              |
| `scripts/build-runtime-bundle.mjs`    | pack 内部 workspace 包，再由 npm 安装生产依赖；构建时可联网且未直接使用 frozen runtime install lock | 生成可追溯锁定的完整 payload，避免第三方传递依赖随构建漂移 |
| `scripts/build-client-packages.mjs`   | contracts/sdk/cli 与 Zod tgz                                                                        | 增加 local/runtime 及其依赖闭包的公共制品阶段              |
| `scripts/assemble-release.mjs`        | common tgz + 每平台 portable archive + SHA256SUMS                                                   | 新发布线增加平台 npm 包、签名清单、离线 kit；保留 portable |
| CI                                    | Mac arm64、Linux x64、Windows Server 2022 Reference matrix                                          | 新增安装矩阵、生命周期故障测试和签名/回滚门禁              |

本机旧 `preview.2` Mac Runtime archive 约 52 MiB，仅用作量级参考；新 npm 包大小、解压体积和冷启动耗时必须重新测量。已有 SHA256SUMS 并不等于具备签名发布。当前 `health()` 等待也没有被整个启动 deadline 包裹；不能将现有描述中的“有界启动”泛化为全部阶段已覆盖。

## 2. 包名、职责与依赖图

新增名称为本次建议，发布前核实 scope 权限与可用性。

| 包/目录                                                       | 职责                                                                  | 消费方式                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| `@yanbot-harness/local` / `packages/local`                    | 本地友好入口，重导出 SDK；为 managed 方法提供默认 resolver 与环境策略 | 普通本地 Node 项目的唯一直接入口           |
| `@yanbot-harness/sdk` / 现有目录                              | HTTP/SSE、公共类型、显式 managed 原语及资源所有权                     | Remote、Daemon、自定义部署；local 内部复用 |
| `@yanbot-harness/runtime` / `packages/runtime`                | 小型 meta 包、platform resolver、校验/展开、独立启动器                | local 的必需依赖；也可单独安装             |
| `@yanbot-harness/runtime-<os>-<cpu>` / 生成的 release staging | 目标平台 manifest、签名、完整 Runtime payload；无初始化副作用         | runtime 的精确版本 optionalDependencies    |
| `@yanbot-harness/cli` / `apps/cli`                            | 继续只消费公共 SDK，保持原命令                                        | 本期仍轻量，按既有显式路径启动或连接       |
| `apps/local-runtime` 及 Core/Adapters                         | Runtime 实现源，保留私有 workspace 包                                 | 编译并封装进 payload，消费者不直接依赖     |

```text
@yanbot-harness/local@V
  ├─ dependency: @yanbot-harness/sdk@V → contracts@V → zod
  └─ dependency: @yanbot-harness/runtime@V
       ├─ optional: runtime-darwin-arm64@V
       ├─ optional: runtime-win32-x64@V
       └─ optional: runtime-linux-x64@V  [glibc]

轻量路径：@yanbot-harness/sdk@V → contracts@V → zod
独立路径：@yanbot-harness/runtime@V → 匹配平台 payload
```

Runtime meta 不依赖 SDK/厂商 SDK；与 SDK 交换结构化 launch descriptor。local 只装配，不复制 client。平台包由目标 OS builder 从同一源提交生成；不在源目录复制多套 Runtime 实现。

`@yanbot-harness/local` 比 `sdk-full` 更直接表达本机执行意图；`@yanbot-harness/harness` 含义过宽；不改名既有 `sdk`。如评审更换本地入口名，只影响 facade 命名，不改变上述依赖方向。

## 3. 平台 payload：目录 bundling，而非单文件编译

### 3.1 形态

平台 npm 包建议只包含以下数据：

```text
package.json                 # name/version/os/cpu，Linux 增加 libc
runtime-manifest.json        # 可公开解析的 export，零 JS 执行
runtime-manifest.sig         # 对 manifest 原始字节的发布签名
payload/runtime.tar.gz       # dist + 完整生产 node_modules + 运行资产/启动入口
LICENSE / THIRD_PARTY_NOTICES / sbom.json
```

所有 npm 平台包内部统一 tar.gz，使用经审查、精确锁定的 Node 解包库，无安装脚本、无系统 tar/PowerShell 依赖。已有独立 portable 交付继续使用 Mac/Linux tar.gz、Windows ZIP；Windows 的 `.cmd` 人工入口保留。

采用内嵌 archive 是为了固定完整目录、摘要与受限展开边界，而不是声称 npm 总会排除嵌套 `node_modules`。T1 在 npm 10.9.8 的实际探针发现：`files: ['payload']` 会保留该 fixture 的 `payload/node_modules`；根级 `node_modules` 与嵌套目录必须分别验证，不能泛化。archive 明确保留厂商 SDK 的辅助 CLI、动态资源和目录结构，并使包管理器无法在消费者安装时重解析内部依赖。平台包安装后，resolver 在第一次显式启动时本机展开，**不进行网络请求**。

内部依赖来自确定的锁定集合，构建结果检查 peer/optional 依赖和运行资源齐全。具体实现先验证以 frozen workspace lock 生成 deploy staging 的可行性；若需继续使用隔离 npm install，则从锁定集合生成独立构建 lock 并 `npm ci`，禁止沿用当前无 lock 的传递范围解析。只在一次 release 构建固定 payload，后续各渠道复制相同字节。

T1 本机已验证 pnpm 11.10.0 的 `deploy --prod --offline --frozen-lockfile --ignore-scripts`，搬迁后 Reference 可运行，根 lock 未变化。但 raw deploy 仍包含内部链接、`file:` 本机构建路径以及 pnpm 元数据；**仅作装配输入，禁止直接签名发布**。正式构建需完成链接解引用、发布元数据归一化和路径/资产/许可证扫描，之后再确定展开限值。完整发现见 [probe-results](probe-results.md)。

T1 后续探针优先验证包管理器的 hoisted deploy 能否从同一 frozen lock 生成无链接目录，避免自制依赖扁平化器破坏多版本/peer 解析；失败时保留证据再选装配策略。跨宿主 fixture 采用 Mac 构建一次、上传原始 tgz 与 npm/pnpm lock，其他 runner 下载后原样消费；隔离 Registry 固定 loopback 端口，避免为迁移测试改写 lock URL。记录源/目标宿主、原始 lock/hash 与实际下载平台，端口占用直接失败，不静默重定位。探针 kit 不是正式离线交付产品。

若 hoisted 只剩 Node CLI 的 `.bin` 符号链接，探针用相对路径 POSIX exec shim 保留原文件的运行目录语义，而不是把 CLI 内容复制到 `.bin` 后破坏相对 import。非 `.bin` 链接、非 Node shebang 和越界目标直接拒绝；Windows 已有普通 cmd/shim 文件原样保留、仍须实测。装配前后逐包比较资源摘要与 dependencies/optional/peer 的实际解析图，避免“Reference 能运行”掩盖厂商资产丢失。此候选目录依旧保留 raw deploy 元数据，不冒充可发布制品。

本机 hoisted 探针发现 `content-type@1.0.5` 从一个物理副本变成两个，资源与解析边一致。比较时区分物理副本清单与按 name/version/资源/解析边去重的语义清单，两者均留摘要和数量；允许完全相同的重复副本，不忽略任何版本、资源或解析边变化。这不证明 Node 模块缓存/单例身份等价，厂商/业务回归仍是门禁。

Runtime npm 包不携带 Node；普通 Node 宿主使用受支持的 Node 22。平台并非纯 JS 就可以通用：厂商辅助程序、原生模块、文件权限及生命周期都需要目标环境构建和验收。

首轮 payload 继续装配现有 Reference 与 CodeBuddy SDK Adapter，不预装所有未来厂商 CLI。以后新增 Wrapper/CLI
遵循 `cli-harness-adapter` 的精确版本、再分发许可和独立认证要求；允许外部指定已认证 CLI 路径，禁止安装便利层
绕过厂商许可或在启动时下载 CLI。一个分发版本的 Adapter 清单必须写入 manifest/SBOM。

### 3.2 平台选择

- 初始 manifest 只列本次发布实际产出的 `darwin-arm64`、`win32-x64`、`linux-x64` glibc；Intel Mac `runtime-darwin-x64` 在后续通过门禁时加入，不能依靠不存在的 optional 包暗示支持。
- npm 利用各平台包的 `os/cpu` 做安装过滤；pnpm 的 `supportedArchitectures` 可显式多平台预取，但不等于可以在本机执行另一架构。机制依据见文末官方资料，实际承诺以锁定 npm/pnpm 版本测试为准。
- 默认解析实际 Node 架构，不猜测硬件架构或调用 emulation。Rosetta x64 Node 在 arm64 Mac 上，若 x64 payload 未发布则明确报不支持并提示使用 arm64 Node。
- resolver 从自身模块位置通过包 export 定位 manifest，兼容 npm hoisting、pnpm 隔离 node_modules 和真实路径；不拼接仓库路径，不从 CWD、全局安装、PATH 或任意兄弟依赖搜索。
- optional 缺失可能是禁用安装、Registry 401/404、缺少平台包或 lockfile 漂移。诊断返回候选原因与修复命令模板，不能声称已确定未观察到的原因。此阶段不再在线探测 Registry。

### 3.3 展开与缓存

缓存默认放在当前用户的应用缓存目录：Mac `~/Library/Caches/YanbotHarness/runtimes`，Windows `%LOCALAPPDATA%/YanbotHarness/Cache/runtimes`，Linux `$XDG_CACHE_HOME/yanbot-harness/runtimes` 或用户 `.cache`。不复用或修改 `.yanbot-harness` 业务状态。

目录标识为 `<version>/<target>/<payloadSha256>`。相同版本/digest 可共享只读内容，运行状态和 descriptor 永远按实例独立。路径由程序验证后生成，不接受 manifest 提供的绝对目标路径。

流程：验证包版本/目标/签名 → 验证压缩 payload 摘要 → 获取该 digest 的排他锁 → 在同卷专用临时目录展开 → 检查清单及文件摘要 → 原子 rename 发布缓存 → 返回绝对 Node 入口。

- 解包拒绝绝对路径、`..`、驱动器/UNC/ADS、大小写/规范化重复、符号/硬链接、设备文件与越界 entry；构建期将合法依赖链接解引用，最终 payload 禁止链接。
- 限制 entry 数量、展开总量和单文件大小；实际限值在制品探针后按最大合法包设置并记录。
- Windows 设置当前用户 ACL，POSIX 目录 0700；payload 无用户运行写入、日志或凭据。每次启动验证文件清单，不能信任一个完成标记或只核对 archive 而忽略已展开文件被改动。
- 并发首启只有一个展开者，等待受 deadline 控制；损坏缓存只隔离该 digest，不递归清理用户目录。锁有实例身份和有界恢复，禁止仅凭旧 PID 文件删除活跃锁。
- 缓存不可写时返回清晰错误，支持显式受控 `cacheRoot`；只读 `node_modules` 是支持场景。不得通过关闭校验解决缓存问题。
- 当前机器所有者可篡改客户端与信任根；此机制防传输损坏/未授权发布和误用，不能提供对同用户恶意进程的隔离保证。

## 4. SDK 自动发现与兼容演进

以下是拟新增的类型轮廓，**不是当前可调用 API**；最终类型在实现前经 T0/T1 固化：

```ts
type ManagedRuntimeResolver = (context: { signal: AbortSignal }) => Promise<{
  entryPath: string; // 已校验 payload 内的绝对 Node JS 入口
  runtimeVersion: string;
  protocolVersion: string;
  managedProtocolVersion: 1;
}>;

// 在既有 StartManagedRuntimeOptions 上增量加入：
type ManagedRuntimeAdditions = {
  runtimeResolver?: ManagedRuntimeResolver;
  nodeExecutablePath?: string; // 高级 Node 宿主；默认 process.execPath
};
```

标准调用意图：

```ts
// 目标：npm install --save-exact @yanbot-harness/local@<V>
import { startManagedRuntime } from '@yanbot-harness/local';

const runtime = await startManagedRuntime({ reference: true });
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

local 显式导出其 managed wrapper，其余 `HarnessClient`、`RunHandle`、contracts 直接重导出 SDK。wrapper 调用 SDK 原有实现并补齐 default resolver；没有第二套 SDK，也不需要 SDK 反向依赖 local/runtime。Runtime meta 可公开 `resolveInstalledRuntime({ cacheRoot?, signal })`，返回上述结构兼容的描述；meta 错误在装配层归一化为 SDK 错误。

优先级：

1. 显式 `executablePath`，相对路径维持相对 CWD 的旧语义。
2. `options.environment ?? process.env` 中的 `YANBOT_HARNESS_RUNTIME_PATH`。
3. 显式 `runtimeResolver`。
4. 仅 local wrapper 提供的内置 resolver。
5. 轻量 SDK 无 resolver 则沿用缺少 Runtime 的错误。

高优先级来源损坏、不兼容或启动失败均不回退。Runtime 文件检查完成后才创建临时状态和进程。包解析使用模块导出，payload 读取为数据；校验前不 import 平台可执行代码。

保留现有 options 的完整语义、`ManagedRuntimeHandle` 的字段与幂等 `close()`；增加诊断 reason 时仍保持 `HarnessSdkError.kind` 的既有分类，如 `runtime`、`protocol`、`authentication`，不改变 CLI 退出码。建议 reason 覆盖 `RUNTIME_PACKAGE_MISSING`、`UNSUPPORTED_TARGET`、`VERSION_MISMATCH`、`INTEGRITY_FAILED`、`NODE_UNSUPPORTED`、`CACHE_UNAVAILABLE`、`START_TIMEOUT`、`CLEANUP_FAILED`，名称在公开前冻结。

旧显式路径不强制提供新 manifest/IPC，保持 `.js/.mjs/.cjs`、POSIX launcher、Windows `.cmd` 映射同名 `.js` 的规则；它们只获得旧兼容等级。新受信包必须声明 managed protocol，不能悄悄退化到旧生命周期。显式路径代表宿主信任决定，不能称为已通过包签名验证。

`HarnessClient.connect({ origin, accessToken })`、`fromDaemon()` 和 `fromRuntime()` 不触发 resolver。将来的 `local-managed` RuntimeTarget 复用本启动原语并返回/暴露可关闭资源所有权；不能只返回一个无 dispose 的普通 client。Remote target 没有本地 fallback。

## 5. 独立进程与生命周期

```text
consumer/local wrapper → SDK managed manager
  → 发现 + 校验/展开 [runtime meta，宿主内的小型代码]
  → spawn Node Runtime [独立 PID + 私有 IPC]
  → descriptor + health/profile → handle/client
  → close / 父 IPC 断开 → Runtime cancel/Adapter close
  → 宽限结束后，必要时强制回收 owned process tree
  → 确认退出 → owned descriptor/temp state 清理
```

### 5.1 启动和控制

- 新 payload 总是通过 Node 的 JS 入口直接 spawn、`shell: false`、参数数组、Windows `windowsHide`。避免 shell wrapper PID 与 Runtime PID 不一致。
- 新 Runtime 以 IPC 标识 managed 模式，专用通道只承载版本化控制消息与 ack，不承载 Run/厂商 Key；业务仍走 HTTP/SSE，descriptor schema 1 无需扩字段（旧读者严格校验六个字段）。
- 正常 `close()` 经 IPC 请求 Runtime 取消活动工作、关闭 Adapter/厂商进程、清 descriptor、ack 并退出。父通道断开执行相同有界关闭；Runtime 无 IPC 的独立 Daemon 模式不启用父死亡策略。
- 默认 startup timeout 延续 15 秒，覆盖 resolver/展开/health，允许调用方在既有上限内增加。解包必须可取消；迟到的异步任务不能在 API 已失败后提交缓存或创建进程。
- stdout/stderr 只作为有界、脱敏诊断，不作 readiness 协议。优先返回阶段、退出码、target、version 和 reason，避免把环境、token 或厂商原始输出塞进 Error.cause。

### 5.2 强制收口与责任

- Runtime/Adapter 管理厂商 SDK 自建进程；后续 Sidecar Supervisor 管理 Wrapper/CLI。SDK 管理自己创建的 Runtime，不接管其他 Daemon。
- POSIX 为新 managed 子树建立独立进程组，正常终止后检查子树；Windows 先 IPC 正常关闭，再基于仍有效的 owned child 使用进程树终止。避免 PID 复用、无关系扫描或误伤其他实例。
- 父/Runtime 被强杀、厂商脱离进程组等情况需要独立故障门禁。IPC disconnect 只能处理 Runtime 仍能响应的情况；若不足以保证树回收，T4 必须引入平台 containment/watchdog（Windows Job Object 等）的独立设计/许可检查再发版，不能把 parent PID 轮询包装为保证。
- 强制终止失败时不先删仍使用中的状态/lease。返回 `CLEANUP_FAILED`，保留安全诊断和后续显式恢复入口。
- 自动临时 `stateRoot` 可在确认 owned 实例退出后删除；显式 `stateRoot` 仅删除匹配 instanceId 的 descriptor，保存 Session。掉电留下的临时目录由后续显式 doctor/cleanup 按所有权记录处理；不靠 module import 注册全局清扫器。

缓存 active lease 与进程身份绑定，避免只用 PID 判断占用。不会在 `close()`、npm uninstall 或普通启动时自动 GC 共享版本；第一版通过显式清理说明保留旧缓存，后续 `prune` 只清理已确认无使用者的版本。该选择优先保证并发和回滚，磁盘成本需在交付说明中告知。

## 6. 凭据、环境和 Electron

推荐 Local BYOK 使用 `CODEBUDDY_API_KEY_FILE`：宿主传路径，Runtime 自己读受保护文件。`environment` 高级选项仍可传入 Key，因而“厂商 Key 永远不在 SDK 进程”只对受控文件/独立 Daemon 流程成立，对任意宿主环境不成立。

local wrapper 在没有显式 `environment` 时构建最小子环境：OS/路径/temp/用户目录、经认可的代理/CA 设置、非敏感 Runtime 配置与 credential-file 引用。不得继承 `NPM_TOKEN`、`NODE_AUTH_TOKEN`、发布/平台 token、`NODE_OPTIONS`、`NODE_PATH`、动态链接注入变量或任意 CI secrets；inline 厂商 Key 不属于默认集合，改用文件或显式 environment。具体白名单在 T3 按 Windows/厂商启动所需变量验证并冻结。旧 SDK 默认 environment 继承行为不在本次偷偷改变。

认证文件、cache、state 在 Windows 使用当前用户 ACL；故障时 fail closed。Registry 凭据只参与包管理器安装，Runtime resolver 没有 Registry client。SDK 提供 Reference 启动不需要 BYOK；真实厂商初次调用可能联网，不属于“安装与 Reference 离线”承诺。

Electron 继续独立安装/随应用资源携带 Runtime：资源位于 ASAR 外、只读且经过签名，main 进程负责 lifecycle。`process.execPath` 在 Electron 中指向 Electron，不应默认当作 Node；显式选择已认证 Node 可执行文件并校验架构/版本，或后续评审 Electron utilityProcess 适配器。当前统一 npm 包仅认证普通 Node 宿主；保留路径和 resolver 扩展点不等于 Electron 已认证。

## 7. Registry 与离线交付

### 7.1 私有 Registry

推荐在团队批准的私有 npm Registry 发布同一 scope 下全部公共包，内部 workspace 包保持 private；第三方公共依赖走受控代理/镜像。不预选供应商、不假设公共 npm 已开放。

- consumer 使用 scope registry 映射，认证限制到确切 host/path；读取 token 与发布 token 分权，不在 README/命令或产物内写真实值。
- `registry.example.invalid` 当前是阻断误发布的占位符，只有发布门禁通过后配置真实端点；不能仅改为公网默认。
- 顺序：公共底层依赖和平台包 → runtime meta → local → 逐平台安装 smoke → 推进受控 dist-tag。dist-tag 仅用于人工选版本，实际依赖精确锁定。
- Registry 要有不可变版本、权限审核和所有 mandatory target 的访问检查；optional 平台包权限错误不能被整体 install 成功掩盖。
- 未配置真实 Registry/发布密钥时，可用测试 Registry 验证机制；不执行真实发布。

### 7.2 离线套件

首版推荐**每平台一个离线套件 + 一个显式安装命令**，不承诺一个万能 tgz。套件含同一 release 的 local、sdk、contracts、runtime、目标平台包，以及 Zod、解包库等所有消费者侧传递依赖；平台 payload 的内部依赖已经在 archive 内，不再从 Registry 获取。

拟提供 `node install-local.mjs --prefix ./consumer`：只操作新建/明确指定的消费者目录，先校验受信发布清单，枚举允许的中立 tgz 和当前平台 tgz，再以参数数组调用 npm `install --offline --ignore-scripts --no-audit --no-fund` 同时安装这些**显式本地路径**，最后验证依赖版本与 `resolveInstalledRuntime`。这是用户主动执行的离线安装器，不是 npm lifecycle hook；不要扫描或修改已有应用 package.json，现有工程提供人工集成步骤。

此方法可能在消费者 manifest 中记录多个本地依赖，用户代码仍只 import local。kit 不批量直接安装其他 OS 的平台 tgz，避免 `EBADPLATFORM`。meta 中未选平台的 optional 缺失由包管理器处理；必须通过空 cache、阻网实测，若锁定包管理器仍需元数据，则套件补齐该版本的离线元数据/锁文件支持，再通过测试，不能依赖用户已有缓存或偷偷打开网络。

`packages/*.tgz` 不能作为新套件的无差别安装指令。首轮离线 kit 以精确锁定 npm（当前本机可测 10.9.8）为门禁；pnpm 11.10.0 另测正常私有 Registry 安装和跨 OS frozen lockfile，离线 pnpm 在有独立证据前不承诺。脚本语法和正式 npm 版本在 T1/T6 冻结。

大型企业可镜像整套 Registry metadata/tarballs 到隔离网，再正常安装 local；目标机无需连接公网。在线和离线复用相同已签包，不针对平台重写 local/sdk/runtime meta 的 tarball。

## 8. 版本、校验、发布与回滚

平台 manifest 拟包含 `schemaVersion`、`packageName/version`、`sourceCommit`、`target`、Node range、protocol version、managed protocol version、精确 SDK 兼容版本、payload path/size/SHA256、文件清单摘要、厂商版本、构建 lock 摘要和签名 keyId。版本字段从单一 release descriptor 生成，避免当前 Runtime main 中的手写版本漂移。

新 bundled 路径在 spawn 前要求 local/sdk/contracts/meta/platform 同一 V；协议兼容仍由 health/profile 校验，不能用同版本包替代协议握手。显式 external/旧路径允许文档化的兼容组合，不强制远端服务随 npm 客户端每次同步升级。

信任分三层：

1. npm lock integrity / Registry TLS 与权限保护交付的包；签名清单和固定发布身份保护 offline 入口。
2. 平台 manifest 建议使用 Ed25519 签名，resolver 通过受信 meta 内固定的发布公钥验证；payload 与所有执行文件均绑定摘要。公钥轮换通过受信升级或旧根签新根，不能从 payload 自报新根并直接信任。
3. 可签名的原生 helper/app/exe 按分发场景采用 macOS codesign/notarization 或 Windows Authenticode；JS/tgz 不假装适用原生可执行签名。Node 由宿主提供，其来源与版本由部署方负责。

签名身份、许可证与实际系统签名要求在 T0/T5 审查。仅测试密钥通过不构成对外发布；不从同一未验证 ZIP 内的“公钥+摘要”自证可信。

消费者升级：停止/排空活动实例 → 在新依赖部署目录按锁文件装整套 V2 → 校验/展开 V2 → Reference smoke → 切换宿主部署 → 保留 V1 与状态备份。运行中 V1 从 digest 缓存读取，不会因 npm 操作中途加载半套新版依赖。

失败回滚：宿主恢复 V1 锁文件与整套制品，确认状态 Schema 可读/写兼容后启动；若 V2 有不可逆迁移，用迁移前备份恢复到独立 stateRoot。旧缓存、workspaces、BYOK 文件各自独立管理。Runtime 不执行 npm install/update、不写 node_modules，也不自动替换 Daemon。

独立 Runtime archive 的版本目录 + 临时目录/原子切换由未来 Runtime Manager 任务实现。Windows 文件被占用时必须保留旧目录，不能以原地覆盖换取“更新成功”。

## 9. 取舍记录

| 方案                                                     | 结论与理由                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SDK optional-depend Runtime                              | 拒绝。默认安装仍会尝试拉取 Runtime，无法保证 Remote 用户轻量                                                    |
| local facade + runtime meta + optional 平台包            | 推荐。一个本地入口、平台筛选、独立 Runtime、高级覆盖均可保留；代价是必须诊断 optional 缺失                      |
| 把所有平台放进一个 local 大包                            | 拒绝作为默认，下载/解压放大，多平台签名更新耦合                                                                 |
| postinstall/首次 Run 在线下载                            | 拒绝，离线、代理、脚本禁用、供应链与浮动版本不可控                                                              |
| 把 SDK 与 Runtime/厂商 SDK 编译到同一进程                | 拒绝，破坏进程、凭据与生命周期边界                                                                              |
| 单文件 JS、Node SEA、内嵌 Node                           | 本期不选；厂商动态资源、原生程序和再分发验证成本高                                                              |
| npm `bundleDependencies` 把整个 local 依赖闭包打进单 tgz | 可作为未来独立命名的 offline convenience artifact；本期不选，避免平台裁剪、重复身份字节、去重和 pnpm 行为复杂度 |
| 平台包内 opaque payload archive                          | 推荐目录级 bundling：保持 Runtime 依赖结构；代价是首次本机展开、缓存占用与校验耗时                              |
| 自动共享 Daemon / SDK 全局注册 resolver                  | 拒绝作为默认，多个包版本和多个宿主的生命周期/所有权容易混淆                                                     |

## 10. 复用与文档同步

- 复用 SDK `managed-runtime.ts` 的 handle、错误和路径规则，`daemon.ts` 的 descriptor 校验，`client.ts` 的业务方法；不把 Runtime 解析反向耦合进 SDK 依赖图。
- 复用 Runtime `server.ts` 的原子 descriptor/instanceId 清理、`run-supervisor.ts` 与 Adapter dispose；增加 `managed-control.ts` 等独立生命周期入口，不改变业务 HTTP 协议。
- 复用 `build-runtime-bundle.mjs` 的生产目录构建概念、`build-client-packages.mjs` common artifacts、`assemble-release.mjs`、release check/clean-room 与 protected CodeBuddy workflow；新 staging 与现有 `preview.2` 分离。
- 更新 package boundary checker 的准确分层规则：SDK 不依赖 Runtime，local 仅装配 SDK/meta，Runtime 实现仍独立；不能为平台包生成放开所有 Adapter 导入限制。
- 同步顺序：本 Spec → system architecture/SVG/PNG → foundation/roadmap → managed/dual-runtime 与历史发布 Spec 适用范围 → README/交付矩阵/后续指南。未来涉及其他业务仓库的迁移另建其仓库 Spec。

## 11. 官方机制依据

2026-09-15 查阅以下一手文档；它们说明机制，不替代本项目精确包管理器版本的验收：

- [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)：optional 失败容忍、os/cpu、bundled dependencies；本设计据此要求缺包诊断与独立平台制品。
- [pnpm dependency resolution](https://pnpm.io/settings/dependency-resolution#supportedarchitectures)：可显式获取非当前架构的 optional packages；生产执行仍按实际 Node 目标选择。
- [npm registry-scoped authentication](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/#auth-related-configuration)：认证限定 host/path，避免安装凭据发往其他服务。
