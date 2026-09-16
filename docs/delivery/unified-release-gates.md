# 统一分发正式发布门禁

版本线：0.1.0-preview.3。当前状态：开发候选，**禁止将测试签名候选作为正式 release 发布**。

## 维护者操作顺序

1. 确认 Registry、scope 和全部六类产品包名权限；消费者 token 只有 read，发布身份只有获准 scope 的 write。此文档不提供或要求提交 token。
2. 完成厂商 SDK、内置 CLI/辅助原生程序和所有第三方资产的再分发审核。SBOM/许可证清单只是输入，不是许可批准；不能为已有 vendor 字节伪造 Apple/Windows 原生签名。
3. 在可信独立渠道分发 Ed25519 公钥/keyId。构建密钥只存在受保护的发布环境；源树/包/kit/日志不携带私钥。正式 Runtime 信任根在审核后固化于包，测试根不自动晋升。
4. 用同一干净冻结 source commit、lock 和 release descriptor 构建：common 只 pack 一次，三个平台分别构建 payload。先冻结 README 等全部输入；不可用同一不可变 npm 版本重新打包不同字节。
5. 逐目标核对平台 tgz 的签名、文件清单、SBOM、payload 哈希；对收到的同一 common tgz 执行真实 npm/pnpm 安装、SDK-only、离线和生命周期矩阵。包、报告和批准记录必须绑定同一 commit/版本/摘要。
6. 在预发布 Registry 检查精确依赖闭包：第三方闭包与 contracts → sdk/cli → 三个 platform → runtime meta → local。平台必须全部可取之后才公开 local 入口；先用非默认 dist-tag。消费者认证包含平台 401/404、optional omission、企业代理/CA 和镜像。
7. 人工确认真实厂商/Windows 10/11、两个生产签名冻结版本回滚及全部外部批准。工程候选 containment、三平台阻网及 preview.2 往返证据见隔离宿主子 Spec；通过外部门禁后仍需另获实际发布授权，再在 protected environment 使用最小权限发布凭据。当前自动 CI 只有 contents:read，不执行 npm publish。
8. 发布后从独立消费者验证准确版本/hash/权限，再切换获准 dist-tag。失败只撤回入口或回退 dist-tag/完整消费者，不覆盖已有版本、不删除活动缓存。

## 轮换、撤销和重放

轮换先发包含旧/新两个获准公钥的兼容 Runtime meta，再签发新 keyId 的平台包；只验证新密钥通过后停止旧密钥签发。撤销必须更新消费者可信根，清除旧 keyId；缓存命中仍验证当前平台签名，不因已有缓存接受撤销密钥。离线用户需通过可信渠道取得新的信任文件。密钥泄漏应停止发布并重新签发新版本，不允许修改原版本 tgz。

签名只是发布者身份，不是版本选择器：manifest/sdk/runtime/platform 必须与调用方所需精确版本一致；正确签名的错误版本同样拒绝。测试已覆盖未知 key、篡改、轮换、撤销后缓存拒绝和签名错误版本。

## 当前不可由代理代为批准的项目

- Registry/scope 所有权、安装/发布 token 和企业镜像权限。
- 正式签名身份与组织公钥分发政策。
- 厂商资产再分发及原生组件签名审核。
- Windows 10/11 与真实厂商凭据/实机验收。

## 工程候选完成、正式认证待外部条件

- 用户已批准原生/VM 宿主范围。Windows 原子 Job host 与 Mac VM 产品路径已通过机制、SDK/Runtime 父强杀、并发隔离、真实 HTTP/SSE、测试签名包及三平台 OS 阻网候选；Mac 还通过连续 SSE 重放后继续请求和 preview.2 往返。详见 [隔离宿主任务](../specs/managed-containment-host/tasks.md) 与其证据文件。原 POSIX 组/taskkill 兼容路径不因此升级为强保证。
- `pnpm probe:managed-containment` 为独立否定门禁：2026-09-15 macOS arm64 实测 detached 孙进程在 managed close 成功后仍存活，命令 exit 1/status blocked。探针通过随机认证的仅本机控制端点回收自己的 fixture，不通过旧 PID 猜测杀进程；默认 30 秒自退出兜底。这是已证实的缺口，不是“还没测试”。
- 两个生产签名冻结版本的完整消费者/真实厂商业务状态升级回滚仍需生产身份与制品；冻结 preview.2 和测试签名 VM candidate 的 Reference 往返已通过，不等于正式业务迁移认证。

上述正式认证依赖生产身份、许可、Registry、硬件与真实厂商输入，不因工程候选通过而被豁免。发布范围若要缩减，必须用户明确批准，不由代理默认修改验收承诺。
