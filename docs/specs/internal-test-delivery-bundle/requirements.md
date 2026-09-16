# 内测单文件交付需求

状态：2026-09-16 方案冻结，面向 `0.1.0-preview.3` 的 Apple Silicon Mac 测试签名候选；不代表正式发布。

## 目标

为没有仓库工作区、不能访问内部 Registry 的同事生成一个可复制的 ZIP。解压后，同事只执行一个安装入口，最终项目只直接安装 `@yanbot-harness/local`。SDK、Runtime meta、当前平台 Runtime payload 及第三方依赖仅作为该入口的离线依赖闭包，不作为需要同事分别理解或安装的产品包。

## 验收需求

- D1：交付物必须只有一个外层 ZIP，名称明确包含版本、`darwin-arm64` 和 `internal-test`；不得覆盖冻结的 `preview.2` 制品。
- D2：ZIP 内必须包含签名离线 kit、测试信任文件、中文交付说明、顶层一键安装入口、交付清单和 SHA-256 校验文件。
- D3：一键入口必须调用既有离线安装器并只以 `@yanbot-harness/local` 为根安装包；不得要求分别执行 SDK 或 Runtime 安装命令。
- D4：依赖闭包必须包含与 local 同版本的 SDK、Runtime meta、目标平台 Runtime payload 及全部必需第三方包；安装期不得访问网络。
- D5：构建必须拒绝 common/platform 的版本、源提交或 lock 摘要不一致，拒绝非 `darwin-arm64` 目标，拒绝非测试签名候选或任何声称已获生产发布授权的输入。
- D6：外层清单必须标注 `testSigning: true`、`productionAuthorized: false`、目标平台、Node/npm 前提、源提交和 kit 摘要；不得包含私钥、令牌、本机源码绝对路径或 Runtime descriptor。
- D7：SHA-256 清单必须覆盖 ZIP 内除自身外的所有普通文件；构建及验证都必须拒绝符号链接、越界路径、重复路径和未登记文件。
- D8：必须在全新、包含空格及中文的临时目录中解压并从空 npm cache 完成安装和 Reference smoke；现有目标目录不得被覆盖。
- D9：交付说明必须清楚说明这是 Apple Silicon Mac 内测包、要求 Node 22、使用测试信任根且不可作为正式生产发布；Windows/Linux 或 Intel Mac 需要各自平台制品。
- D10：生成的大体积 ZIP 属于本地交付产物，不进入 Git；生成器、测试、Spec 和交付模板进入 Git 并推送 `zb-dev`。

## 非目标

- 不发布 npm Registry，不引入或读取正式签名密钥。
- 不把 SDK 与 Runtime 实现复制成第三套代码，也不改变 `@yanbot-harness/local → sdk + runtime → platform` 的包边界。
- 不宣称通过真实厂商、Windows 10/11、正式镜像许可或生产签名门禁。
- 不在一个 ZIP 中混装多个操作系统/CPU 的 Runtime payload。
