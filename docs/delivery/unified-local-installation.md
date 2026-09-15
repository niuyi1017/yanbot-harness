# 后续 Preview：本地统一安装交付说明草案

**方案已确认，尚未实现，不能用本文命令安装当前 `preview.2`。**
当前使用 [SDK/CLI quickstart](./sdk-cli-quickstart.md) 或 [Windows 手册](./windows-sdk-cli-integration-guide.zh-CN.md)。
设计与实施细节见 [统一分发 Spec](../specs/unified-local-distribution/design.md)。

## 1. 用户选择

| 需要什么              | 推荐安装内容（未来）                                                    | 用户承担什么                                              |
| --------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 在本机跑任务          | `@yanbot-harness/local@<V>`                                             | 安装受支持 Node，配置自己的厂商凭据，显式启动/关闭 handle |
| 只连接 Remote         | `@yanbot-harness/sdk@<V>`                                               | 配置 Remote 端点与平台认证；服务本身仍未交付              |
| 多客户端共享/高级部署 | `@yanbot-harness/runtime@<V>` 或 portable archive，客户端按需装 SDK/CLI | 操作员管理 Runtime 生命周期、状态与升级                   |

新增名字为本次推荐。统一包内部会安装 SDK、Runtime meta 和当前平台 payload，业务代码只 import 本地入口。
SDK 与 Runtime 仍通过 HTTP/SSE 跨进程通信。安装包不含 Node、不安装系统服务、不内置厂商 Key。

## 2. 目标本地体验

在团队批准的私有 Registry 配置就绪后安装精确版本 V；以下仅表达未来调用形态：

```ts
import { startManagedRuntime } from '@yanbot-harness/local';

const runtime = await startManagedRuntime({ reference: true });
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

首次显式启动会验证并在用户缓存目录展开随包安装的 Runtime，无网络下载；后续启动复用该版本缓存并验证完整性。
Reference 验收不需要模型 Key。真正使用 CodeBuddy 时仍需本机 BYOK 文件，并由 Runtime 自己读取；不要把平台 token 当作厂商 Key。

只安装 SDK 的用户仍可使用 `fromDaemon()`、显式连接或带路径的 managed 方法。`preview.2` 的这些已有用法继续保留；
使用新 local 的自动发现只需迁移安装入口和 import，业务 Session/Run/Event 方法复用同一 SDK。

## 3. 离线与企业交付

未来离线套件按 OS/CPU 分发，包含中立包、匹配平台包和全部消费者传递依赖的同版 tgz、签名清单与一个显式安装器。
建议入口 `node install-local.mjs --prefix ./consumer` 尚未实现；它将使用本地文件和 npm offline/ignore-scripts 安装，并验证匹配平台已就位。

“一个入口”不等于万能单 tgz。不要把所有 OS 的平台包一起作为直接依赖安装，不依赖机器已有 npm cache。
只有空 cache、无源码仓库、阻断网络的 Mac/Windows 测试通过后，才能发布离线承诺。消费者侧首轮不要求安装 pnpm。

企业可镜像全部 Registry 元数据和依赖到隔离网。Registry token 只用于包安装；不要将其传入 Runtime 子进程环境。

## 4. 目标平台与诊断

- 必验：Mac arm64、Windows x64；Windows Server CI 与 Windows 10/11 实机分别记录。
- Linux x64 glibc 保留 Reference 回归；Intel Mac、Windows arm64、Linux arm64/musl 尚不在首轮认证范围。
- 按 Node 实际架构选择 payload。Apple Silicon 使用 x64/Rosetta Node 时，不自动改用 arm64 Runtime。
- 如果 optional dependencies 被禁用或 Registry 拒绝平台包，安装可能完成而启动失败；错误应说明目标、版本和补装/重装办法，不自动联网修复。
- Node 不符合范围、payload 校验失败、缓存无写权限或路径不支持时，应停止并给出诊断；不要用关闭签名校验作为修复。
- Electron 是高级宿主，需 ASAR 外资源和经验证的 Node/utilityProcess 启动器；普通 Node 安装验证不能替代 Electron 认证。

## 5. 关闭、状态与版本管理

每个 managed handle 只管理自己的 Runtime；多次 close 幂等。未来新包通过私有控制通道正常关闭，再按需要有界终止受拥有子树。
当前 `preview.2` Windows 仍使用强制树终止，父进程死亡回收未交付，不能引用未来行为作保证。

未传 `stateRoot` 的临时运行状态随 owned 实例关闭清理；显式持久目录、用户工作区和凭据文件保留。payload 缓存在用户目录内按版本/摘要保存，关闭或 npm 卸载不会自动删除它；第一版提供显式清理说明，后续增加自动 GC。

升级应停止/排空后切换整套精确锁定依赖，验证新版本再替换宿主部署。回滚恢复旧 lockfile/整套制品，并检查状态 Schema；
不可逆状态迁移需使用升级前备份。运行中的旧版本缓存不原地覆盖，BYOK 与配置不随包回滚。

## 6. 发布时必须补齐

实际版本 V、Node/npm/pnpm 精确范围、Registry 配置、签名信任根、各平台摘要、安装/冷启动/磁盘占用实测、
SDK 与 Runtime 兼容表、离线与生命周期证据、CodeBuddy 独立认证记录，以及回滚演练结果。齐全前本文保持“草案”。
