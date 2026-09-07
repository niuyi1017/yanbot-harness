# Foundation Bootstrap 任务拆解

## 进度快照（2026-09-07）

- 已完成：FB-T1～FB-T7的实现与本地验收（FB-T6使用离线fixture，不访问真实服务）。
- 已完成：FB-T9本地冷启动门禁与远端GitHub Actions验证。
- 待受控执行：FB-T8脚本和能力矩阵已完成；当前环境没有显式`CODEBUDDY_API_KEY`，脚本已验证会安全退出且不产生模型调用。
- 阶段收口：经用户确认，FB-T8真实探针作为发布前门禁保留，但不阻塞M2离线开发；FB-T10按该风险例外完成。

## 执行规则

- 每项任务应形成可独立Review的提交。
- 严格按依赖顺序执行；协议先于Adapter实现。
- 真实CodeBuddy冒烟不进入普通CI，也不在日志中输出凭据。
- 发现SDK行为与Spec不符时，先更新能力矩阵和Spec。

## 需求追踪矩阵

| 需求                          | 实施任务                    |
| ----------------------------- | --------------------------- |
| FB-R1 Workspace基线           | FB-T1、FB-T9                |
| FB-R2 公共协议                | FB-T2                       |
| FB-R3 Adapter SPI             | FB-T3                       |
| FB-R4 Reference Adapter       | FB-T4                       |
| FB-R5 Adapter Conformance Kit | FB-T5                       |
| FB-R6 CodeBuddy Adapter       | FB-T6                       |
| FB-R7 CodeBuddy能力探针       | FB-T8                       |
| FB-R8 Sidecar协议设计         | FB-T7                       |
| FB-R9 安全与仓库卫生          | FB-T1、FB-T6、FB-T8、FB-T9  |
| FB-R10 文档与示例             | FB-T4、FB-T5、FB-T9、FB-T10 |

## FB-T1. 初始化仓库工具链

**依赖**：本Spec获批。

**文件**：

- 根`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。
- `tsconfig.base.json`、ESLint、Prettier、`.gitignore`、`.nvmrc`。
- 基础README与目录。

**工作内容**：

- 固定Node兼容范围`>=22.22.0 <23`、CI基线22.22.0、pnpm 11.10.0和TypeScript 5.9.3。
- 建立workspace、统一脚本和NodeNext ESM规则。
- 创建实际需要的packages，不创建Web/Electron/Admin空壳。

**验收**：

- `pnpm install`生成唯一根lockfile。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`可执行。
- 仓库不存在`package-lock.json`和子包lockfile。

## FB-T2. 建立contracts

**依赖**：FB-T1。

**文件**：`packages/contracts`。

**工作内容**：

- 实现版本、ID、Manifest、Capability、ModelRef、Run、Event、Interaction、Usage和Error Schema。
- 导出Zod Schema与推导类型。
- 添加JSON往返、非法输入和版本校验测试。

**验收**：

- 公共Schema测试通过。
- 搜索不到CodeBuddy类型、`permissionMode`、`settingSources`或厂商消息字段。
- 每种事件都能被统一Envelope Schema解析。

## FB-T3. 实现Adapter API与核心注册表

**依赖**：FB-T2。

**文件**：

- `packages/adapter-api`。
- `packages/harness-core`。

**工作内容**：

- 实现HarnessAdapter、AdapterRuntime和Registry接口。
- 实现能力检查、生命周期保护和统一错误。
- 防止重复adapterId、协议不兼容和能力/方法不一致。

**验收**：

- 注册、选择、初始化、取消和重复释放测试通过。
- 不支持能力稳定返回`CAPABILITY_UNSUPPORTED`。
- 核心包不存在厂商名称条件分支。

## FB-T4. 实现Reference Adapter

**依赖**：FB-T3。

**文件**：

- `packages/adapter-reference`。
- `packages/testing`中的clock、ID和Scenario测试工具。

**工作内容**：

- 实现文本、工具、Interaction、Usage、失败和等待取消Scenario。
- 使用注入式clock和ID保持确定性。
- 提供最小消费示例。

**验收**：

- 无网络、无密钥完成全部Scenario。
- 事件sequence严格递增且只有一个最终事件。
- 取消与dispose幂等测试通过。

## FB-T5. 建立Adapter Kit与Conformance Kit

**依赖**：FB-T3、FB-T4。

**文件**：

- `packages/adapter-kit`。
- `packages/testing`中的黑盒测试套件。
- `docs/architecture/adapter-protocol.md`。

**工作内容**：

- 提供Manifest、能力和事件构建辅助函数。
- 建立可由任意Adapter调用的Conformance测试入口。
- 覆盖生命周期、事件、取消、错误、可选能力和敏感信息检查。

**验收**：

- Reference Adapter通过全部Conformance测试。
- 故意声明错误能力或产生乱序事件的测试Adapter被准确拒绝。
- 第三方实现只需依赖公开Adapter Kit和测试入口。

## FB-T6. 实现CodeBuddy Adapter fixture闭环

**依赖**：FB-T5。

**文件**：

- `packages/adapter-codebuddy`。
- `packages/testing/fixtures/codebuddy`。
- 包边界检查脚本。

**工作内容**：

- 精确锁定`@tencent-ai/agent-sdk@0.3.43`。
- 实现认证环境allowlist、query选项、权限和配置映射。
- 实现system、stream、assistant、tool_result和result消息归一化。
- 实现resume、取消、模型列表facade和错误分类。
- 通过依赖注入或窄SDK facade使用fixture测试，不访问公网。

**验收**：

- CodeBuddy fixture Adapter通过Conformance Kit。
- 覆盖嵌入式与顶层tool_result、重复tool、无result结束和中断。
- `@tencent-ai/agent-sdk`只在本包出现。
- 日志和测试快照不存在env、Key和绝对路径。

## FB-T7. 定义Sidecar协议Schema

**依赖**：FB-T2、FB-T3。

**文件**：`packages/adapter-sidecar`。

**工作内容**：

- 定义JSON-RPC初始化、能力、运行、恢复、交互、取消、事件和关闭Schema。
- 定义协议版本协商和标准错误映射。
- 不添加`child_process`、不实现进程监管。

**验收**：

- 请求、响应和通知通过JSONL序列化测试。
- 不兼容主版本被拒绝。
- 包中不存在可执行Sidecar和厂商实现。

## FB-T8. CodeBuddy真实能力探针

**依赖**：FB-T6。

**文件**：

- `scripts/smoke-codebuddy.mjs`。
- `docs/architecture/codebuddy-capability-matrix.md`。

**工作内容**：

- 在临时fixture工作区运行文本、工具、权限、问题、resume和cancel场景。
- 验证MCP、Skill、Agent、Hook、模型列表和用量字段。
- 记录中国版/当前团队环境、CLI版本、SDK版本、结果和限制。
- 脚本只读取明确allowlist环境变量，不打印值。

**验收**：

- 冒烟脚本缺少凭据时安全退出并给出配置项名称。
- 受控环境至少完成一次成功Run、一次resume和一次cancel。
- 能力矩阵区分官方文档、fixture和真实验证证据。
- 所有临时文件位于安全临时目录并在结束后清理。

## FB-T9. CI与仓库边界门禁

**依赖**：FB-T1–FB-T7；FB-T8真实冒烟不阻塞普通CI。

**文件**：

- `.github/workflows/ci.yml`。
- `scripts/check-package-boundaries.mjs`。
- Secret与禁止文件检查配置。
- README。

**工作内容**：

- 建立安装、格式、Lint、边界、类型、测试和构建流水线。
- 检查厂商依赖位置、跨包src导入、嵌套lockfile、`.env`和敏感文件。
- 补全开发、测试和受控冒烟说明。

**验收**：

- 本地全量命令通过。
- CI不需要CodeBuddy Key即可通过。
- 人为添加禁止依赖或`.env`时门禁测试会失败。

## FB-T10. 阶段收口

**依赖**：FB-T9。FB-T8脚本和证据矩阵必须准备完成；真实执行缺少显式凭据时可作为发布前风险保留。

**文件**：本Spec、能力矩阵、README和变更记录。

**工作内容**：

- 对照FB-R1–FB-R10逐项验收。
- 根据已有证据修订能力声明和风险；真实探针未执行时保持`pending`，不得推断结论。
- 记录未解决问题及M2输入条件。
- 确认下一阶段只通过公开exports使用本阶段包。

**验收**：

- 所有普通CI命令通过。
- 能力矩阵区分文档、fixture和真实验证；未执行的真实探针有明确风险记录且无敏感信息。
- 总体Spec、子Spec和代码一致。
- 明确允许进入M2离线开发；真实CodeBuddy发布门禁继续保留。
