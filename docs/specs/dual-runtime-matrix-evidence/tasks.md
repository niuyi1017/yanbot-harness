# 双 Runtime 矩阵证据任务清单

## 当前状态（2026-09-20）

- [x] 审计现有 CI runner、共享 Conformance、Remote Fixture 与历史证据格式。
- [x] 冻结真实 Local、Remote Fixture 和真实 Remote service 的证据身份边界。
- [ ] 实现与验证证据基础设施。
- [ ] P3.8 仍未完成：缺少正式 Remote service 和关联真实 CI run 的归档证据。

## T1. Spec 门禁

- [x] 新增 `requirements.md`、`design.md`、`tasks.md`。
- [x] 格式、范围与诚实性复核后独立提交。

验收：实现前存在独立 Spec commit，且 Remote Fixture 不能填充 Remote service 槽位。

## T2. 单平台证据生成器

- [ ] 实现严格 target/runner 绑定与 Git source metadata。
- [ ] 使用真实 loopback HTTP/SSE Local driver 运行四项共享 Conformance。
- [ ] 使用 injected-fetch Remote Fixture driver运行同四项共享 Conformance。
- [ ] 无论成功或失败均原子写入脱敏 JSON；失败时返回非零退出码。

验收：本机生成的 darwin 报告字段、身份、四场景和清理行为均符合 Spec。

## T3. 聚合器与负例

- [ ] 实现严格 platform report validator 与双 target 聚合器。
- [ ] 拒绝缺失/重复 target、commit 不同、runner 不匹配、场景失败和 Fixture 冒充 service。
- [ ] 输出 `status: incomplete` 和独立 Remote service 缺口。
- [ ] 增加 Node 单测并纳入 `test:probes`。

验收：只有同 commit 的 macOS/Windows 已通过报告可被聚合，且聚合结果不能声称 Remote service 通过。

## T4. CI 矩阵

- [ ] 新增 macos-15/darwin-arm64 与 windows-2022/win32-x64 独立 matrix job。
- [ ] 每个 runner frozen install、build、生成并上传独立证据。
- [ ] aggregate job 下载明确 artifact，生成并上传 summary。
- [ ] workflow 不使用 Secret，不访问真实模型或公网 Runtime。

验收：YAML 格式通过，runner/target 映射由测试锁定；实际远端运行结果必须另行归档后才算平台认证。

## T5. 回归、状态与提交

- [ ] 运行生成器、聚合器测试及 `pnpm check`。
- [ ] 在本 Spec 记录本机证据路径与测试结果。
- [ ] 更新 `dual-runtime-compatibility`，仅勾选 P3.8 基础设施子项，顶层保持未完成。
- [ ] 检查 diff/status，保留用户未跟踪临时文件，提交实现。

验收：本次规划内代码全部完成且全仓门禁通过；未发生 Windows/Remote service 证据夸大。

## P3.8 完成仍需

- [ ] 推送提交后，取得 macOS 与 Windows matrix 成功 run URL、artifact 和 source commit。
- [ ] Phase 4/5 提供正式 Remote service 后，以真实 HTTPS、真实认证、持久化和 workspace preparation 运行同一套证据。
- [ ] 将真实 service report 纳入发布门禁并更新交付兼容表。
