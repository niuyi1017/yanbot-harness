# 统一分发实施决策记录

## 2026-09-15：方案确认，授权启动 T1

- 用户已确认 local/sdk/runtime/platform 拆分、统一安装和独立进程方案，并在切换模型后授权开始开发。
- 当前执行节点为 T1 打包与包管理器可行性探针；使用隔离的测试包名/版本，不发布产品包、不改写现有 release archive。
- 文档/开发基线：`zb-dev`，规划前 HEAD `0247627`。本机现有 Mac `preview.2` archive 的 manifest 源提交为 `1055355fe62690625013113fe09ea509876b1c3f`、`gitDirty: false`。
- 本机制品 `yanbot-harness-0.1.0-preview.2-darwin-arm64.zip` SHA-256：`109ae675089927f7244ce4a0754b5604414e937cd213e48e0f857e5cc4e8c1b0`。此摘要只固定当前 Mac 制品，不替代 Windows 或正式冻结认证。
- 测试版本使用独立 probe 标识；正式下一 Preview 版本在 T2 产品打包前确定。不得以修改后的 README/源代码重新生成同身份 `preview.2` tgz。
- 当前可用本机：macOS arm64，Node 22.23.1、npm 10.9.8、pnpm 11.10.0。Windows/Linux 的结果需由相应 runner/实机执行取得，不用平台模拟替代认证。

## 外部发布门禁

以下条件不阻止隔离探针，但未完成前不做真实发布：

- 私有 Registry/镜像地址、scope/包名占用与读写权限。
- 正式签名身份、可信公钥分发与轮换流程。
- Runtime 内部厂商资产的再分发许可审核。
- Windows 10/11、其他目标平台与真实厂商认证证据。

T1 发现影响方案的机制差异时，先更新 Spec 和本记录，再进入正式实现。

## 2026-09-15：T1 本机机制结果

- npm/pnpm 安装机制探针 16/16 通过；pnpm frozen-lock 离线 deploy 与搬迁后的 Reference Run/close 通过。
- 修正 npm pack 排除规则的泛化，维持 archive 的完整目录与校验边界设计。
- raw pnpm deploy 仍含内部链接和本机路径，确定仅作为候选装配输入，不能直接发布；具体 link-free 装配与资源核查尚未完成。
- 新增三平台 CI 入口但未远端执行；共享 tgz/跨系统 lockfile、最终解包/control 契约继续作为 T1 未完成项。
- 证据与复跑方式见 [probe-results](probe-results.md)。现有 preview.2 制品保持不变，不新增真实 Registry/签名承诺。

## 2026-09-15：T1b 制品转移与无链接候选目录

- 本机 export 16/16、使用原始 kit 的 import 18/18 通过；npm/pnpm 原始 lock 摘要未变。同机测试不计作 Windows/Linux 证据。
- CI 改为 Mac 构建一次 fixtures/locks 后上传，三平台下载并按相同 loopback Registry origin 消费，不重新 pack 公共 tgz、不改写 lock。
- hoisted deploy 不需要自制依赖扁平化器；仅两个 `.bin` Node 链接转换为相对 exec shim 后得到零链接目录。普通资源与依赖上下文必须等价，完全相同的重复物理副本单独记录。
- 本机额外的 content-type 副本不等于语义或单例等价认证；真实厂商回归、发布 metadata 清理和许可证/签名门禁仍保留。
- 审计器增加 peer 上下文细化，避免同版本同字节包引用不同 peer 时被误判相同；独立单测纳入 `pnpm check`。
