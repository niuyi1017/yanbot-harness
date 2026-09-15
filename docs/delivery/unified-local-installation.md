# 统一安装候选：0.1.0-preview.3

当前是开发/测试签名候选，不是已发布 npm 版本。生产 Registry、信任根、再分发许可、Windows 10/11 与真实厂商认证尚未完成。旧 preview.2 从其冻结制品使用，本指南不替换旧发布证据。

## 已验证路径

本机 macOS arm64 以及 CI macOS/Linux 已通过实际 npm/pnpm 包安装、pnpm 严格隔离布局、SDK-only 不下载 Runtime、平台 optional 缺失/401 诊断。local 的 Reference 文本、权限、提问、取消均通过。Windows 仍在权限/安装链路收口。

离线候选包含 18 个公共/第三方闭包 tgz 加 1 个目标平台 tgz；空 npm cache、npm 10.9.8、offline/ignore-scripts 安装后完成 Reference Run/close。macOS 26.4.1 另使用 OS sandbox 阻断外网（预检 EPERM，仅保留 loopback）重复完成安装和 Reference；同一测试接入 Mac CI。其他 OS 的网络隔离不据此认证。

## 本地 API

得到完整、已授权的同版本包后：

```ts
import { startManagedRuntime } from '@yanbot-harness/local';

const runtime = await startManagedRuntime({
  reference: true,
  trustedKeys: approvedPublicKeys,
  startupTimeoutMs: 120_000,
});
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

`approvedPublicKeys` 必须来自可信外部渠道。当前内置生产信任根为空；不提供测试根或未签名 fallback。显式 trustedKeys 是宿主的信任决定，不能把 payload 自带公钥直接视为可信。默认启动期限仍是 15 秒，但完整候选的跨平台冷启动认证未完成；上例明确使用可配置的 120 秒预算。

覆盖顺序：explicit executablePath → 所选 environment 的 YANBOT_HARNESS_RUNTIME_PATH → runtimeResolver → local 内置 resolver。选中后失败不回退。旧 SDK 显式路径保留兼容等级，不强制要求新 IPC/签名。

只连接既有 Runtime 的用户继续使用轻量 `@yanbot-harness/sdk`，不需要安装 local。CLI 仍是轻量客户端，没有默认携带 payload。

## 凭据、状态与缓存

默认 local 环境只保留必要 OS/路径/代理/CA、Runtime 配置和 credential-file 引用，不继承 Registry token、inline Key、NODE_OPTIONS、NODE_PATH 或动态链接注入。真实厂商建议 CODEBUDDY_API_KEY_FILE；显式 environment 属高级宿主信任边界。

cacheRoot 与 stateRoot 分离；缓存按 version/target/digest 共存，关闭不删除缓存。每次解析核验签名、压缩体与已展开文件；损坏缓存拒绝运行，保留原字节，使用新的私有 cacheRoot 恢复，不自动覆盖/GC。

显式 stateRoot 必须是专用私有目录，新受管路径执行 POSIX owner/mode 或 Windows 当前用户 ACL 校验。调用方状态/工作区/BYOK 文件不会递归删除。临时状态只在已拥有的 Runtime 回收后清理；失败保留诊断。Windows ACL 与复杂进程树场景须以 Windows CI/实机证据为准。

目前仅普通 Node >=22.22.0 <23 的 darwin-arm64、win32-x64、linux-x64 glibc 是候选目标。Rosetta x64 Node、musl、Electron process.execPath 和跨架构 Node 注入明确不在候选认证范围。

## 离线安装

先通过可信渠道核验 bootstrap 安装器与 kit 签名身份，再执行：

```sh
node install-local.mjs --prefix ./new-consumer --trusted-key-file /trusted/channel/release-public-keys.json
```

目标目录必须不存在，安装器不覆盖已有工程。先验证签名和全部 tgz 摘要，再将已验证字节快照保存到 consumer/.harness-packages；npm 只安装这些显式本地文件。保留该目录可让 lockfile 的相对 file 引用继续有效。npm 使用独立空配置和 cache；不读取安装/发布 token。

成功写入 installation-evidence.json，保留可复跑的 .harness-reference-smoke.mjs；失败写入 installation-failure.json 的阶段和隔离诊断目录。不要把失败但存在 node_modules 当作验收通过。当前安装器只认证 npm 10.9.8，其他 npm/pnpm 离线方式需另测。

## 手动升级与回滚

保留 V1 消费者目录、完整 kit、锁文件、用户配置和状态备份。在另一个新目录安装整套 V2，完成验签和 Reference smoke，再停止/排空 V1、检查状态 schema 兼容并切换宿主。

失败时切回完整 V1 目录和锁文件；不要在活动 V1 node_modules/缓存中覆盖文件。当前 Runtime state schema 为 1，未知 schema 拒绝读取；不可逆迁移必须从迁移前备份恢复到独立目录。工作区和 BYOK 始终不属于安装器的清理对象。

## 发布前仍需完成

完整顺序、密钥轮换与人工批准边界见 [正式发布门禁](unified-release-gates.md)。小型签名 fixture 的缓存 V1→V2→V1、持有旧版本文件、锁持有者崩溃恢复、阻塞路径保留及未知状态 schema 拒绝已加入测试；不替代两个真实冻结 release 的完整业务回滚认证。新 SDK 对冻结 preview.2 显式 Runtime 的 Reference Run/close 已在本机通过，旧 ZIP 摘要不变。

- 正式 Registry/scope/镜像 ACL、安装与发布 token 分权、不可变版本与全平台可取性。
- 正式可信发布公钥、轮换/撤销、原生组件签名要求和厂商资产再分发审核。
- Windows 10/11 与 Mac 真实厂商验收；Linux CI Reference 不替代它们。
- 完整 containment：尤其 Runtime 被强杀后的 Windows 孙进程、脱离 POSIX 进程组的后代。IPC ACK、Runtime PID 消失或普通 taskkill 成功均不能替代整树保证。

实现/证据明细见 docs/specs/unified-local-distribution/tasks.md；不得据本指南提前宣布所有门禁已完成。
