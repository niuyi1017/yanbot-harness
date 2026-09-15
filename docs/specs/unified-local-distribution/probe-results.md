# T1 本机机制探针记录

日期：2026-09-15。状态：**本机子集通过，T1 尚未完成，不构成新包发布认证**。

按 spec-workflow，先提交用户已确认的 Spec（`1fd2e44`），再实现隔离探针。未修改产品 SDK/Runtime 代码、版本或 `preview.2` archives；未 push、publish 或触发远端 workflow。

## 环境与复跑

- 实际宿主：macOS arm64；Node 22.23.1、npm 10.9.8、pnpm 11.10.0。
- 安装探针：`pnpm probe:distribution`。
- Runtime 装配探针：先按仓库要求安装 frozen-lock 开发依赖，再执行 `pnpm probe:runtime-deploy`。该命令先 build，再执行离线 deploy。
- 默认在系统临时目录创建独立运行目录，保留 `report.json` 与 fixtures/deploy 供检查；支持 `--output-dir DIRECTORY`。不要把输出放入受源码检查的目录。
- 版本、脚本 SHA-256、制品 SHA-256、用例结果与局限随报告记录；本次摘录见 [probe-evidence.json](probe-evidence.json)。
- 新增 `.github/workflows/distribution-probes.yml`，提供 Mac arm64 / Windows Server 2022 x64 / Linux x64 的实际宿主入口，并只上传 JSON 报告。**本次没有执行远端 CI**，也不以 Windows Server 代替 Windows 10/11 产品验收。

## 安装机制：16/16 通过

| 检查                | 观察结果                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| npm pack 内容       | opaque gzip 文件保留；根 `node_modules` 被排除，但 `files: ['payload']` 下的嵌套 `payload/node_modules` 被保留 |
| npm/pnpm 平台筛选   | 三个平台均提供 metadata，实际只下载 Mac arm64 平台 tarball；正常 export 定位，pnpm 隔离布局通过                |
| SDK-only            | 不安装、不请求 Runtime；没有因统一 local 入口而污染轻量 SDK 图                                                 |
| 禁用 optional       | 安装可结束，但调用 resolver 得到带平台与恢复建议的缺包错误                                                     |
| Registry 拒绝平台包 | 独立 cache/store，同时拒绝 metadata/tarball；必须观测到拒绝请求，不能用缓存成功伪装测试通过                    |
| 同系统锁文件重装    | npm ci / pnpm frozen lock 在新 node_modules 和新 cache/store 下通过                                            |
| npm 空缓存离线      | 同一套 5 个 local/contracts/sdk/runtime/当前平台 tgz 显式安装通过；Registry 请求 0 次                          |
| 离线闭包缺失        | 只提供 local tgz 时失败，Registry 请求仍为 0 次                                                                |
| Runtime-only        | 无 local/SDK 前置，安装后搬迁至中文、空格、`&` 路径可解析                                                      |
| 安装脚本禁用        | 每个 fixture 自带会失败并写标记的 postinstall；整个测试未生成标记                                              |

首次测试纠正了设计中的一处泛化：不能把根 `node_modules` 的 npm 排除规则套用到所有嵌套目录。保留 archive 方案的依据是完整目录/签名摘要/受限展开边界，已同步到 design。

首次 pnpm 拒绝访问测试也暴露了探针的缓存隔离不足：仅指定 store 不够，已增加独立 `cache-dir` 和拒绝请求断言。报告只保留修正后的通过结果，不把早期失败解释为产品缺陷。

这些包使用独立 `@harness-install-probe` scope、`0.0.0-probe.1` 版本和内存 loopback Registry；payload 是字节保留 fixture，**不是真实 tar 目录、厂商 Runtime 或签名实现**。离线证据来自包管理器 offline 模式与拒绝一切请求的本地 Registry，尚未实施系统防火墙断网认证；真实传递闭包还需包含 Zod/解包库等产品依赖。

## Runtime frozen-lock deploy

本机验证：`pnpm --filter @yanbot-harness/local-runtime deploy --prod --offline --frozen-lockfile --ignore-scripts <临时目录>`。

- 使用当前 frozen-lock store，重用 108 项，下载 0 项；根 lock SHA-256 未变化。
- raw deploy 共 6,280 个普通文件、170,904,475 字节、296 条内部链接；没有指向 staging 外部的链接。
- 搬迁后的普通文件树摘要一致，链接目标仍在新目录内。Reference health、Session/Run、终态 `run.completed` 和关闭后 descriptor 清理通过。
- 未发现 TypeScript、Vitest 或 testing workspace 包落入生产包图；报告记录实际生产包版本、声明的 bin 文件和许可证文件清单。
- 厂商清单观测到 agent-sdk 0.3.254 与 codebuddy-code 2.146.0。后者声明 `SEE LICENSE IN README.md`，前者 manifest 声明 MIT 但此部署目录根未发现独立 LICENSE 文件。此处只是文件盘点，**不推断已获再分发许可**。

重要限制：raw deploy 仍有 9 份 manifest 包含本地依赖引用，虚拟 store 路径和 pnpm 元数据也包含构建机信息。该目录只能作为候选装配输入，不能直接作为最终 payload。新构建器仍需归一化发布 metadata、去除本机路径、生成 SBOM/许可证材料，验证合法链接的解引用和厂商动态资源保留。

## 下一段 T1 与发布门禁

- 同一公共 tgz 在不同宿主复用，Mac→Windows lockfile 转移；当前 CI 入口各自生成 fixtures，仅覆盖各宿主机制。
- Linux libc 与 Windows ACL/长路径的实际结果；Windows 10/11 和真实厂商场景单独认证。
- link-free 生产目录装配、动态资产/peer/optional 闭包与再分发审核。
- 最终 manifest/resolver/control contract、解包库精确版本和大小上限。raw deploy 字节数不能直接用作链接解引用后的上限。
- 真实 Registry、签名身份、目标平台资源仍是外部门禁。

本次 `pnpm check` 全通过。P1D 与 T1 保持进行中，T2–T7 不提前勾选。
