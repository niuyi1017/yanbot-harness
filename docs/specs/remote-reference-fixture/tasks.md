# Remote Reference Fixture 任务清单

## 当前状态（2026-09-20）

- [x] 审计 `dual-runtime-compatibility`、contracts、SDK transport、Local Runtime 与 Conformance Kit。
- [x] 冻结 Fixture 非生产边界、兼容请求联合、HTTPS 注入和测试控制面原则。
- [ ] 尚未修改公共 Schema 或实现 Remote Fixture。

## T1. Spec 门禁

- [x] 编写 `requirements.md`、`design.md`、`tasks.md`。
- [ ] 运行格式检查、复核 scope，并将三份文档独立提交。

验收：实现代码开始前存在独立 Spec 提交；文档明确不实现或冒充 `apps/cloud-server`。

## T2. WorkspaceSource 接入 Run 请求

- [ ] 将 `WorkspaceSource` Schema 定义移动到 `CreateRunRequest` 之前，不改变既有 JSON。
- [ ] 把 `CreateRunRequest` 改为严格旧形态/新形态联合，共享字段与默认值保持一致。
- [ ] 增加旧请求、新 local source、uploaded snapshot、git ref、混用字段、非法摘要和非法路径测试。
- [ ] 更新 contracts README 的迁移示例。

验收：旧 preview.3 JSON 解析结果不变；新旧字段不能混用；`pnpm --filter @yanbot-harness/contracts test:unit`
与 typecheck 通过。

## T3. Local Runtime 兼容归一化

- [ ] 在 HTTP/业务边界把旧 grant 与新 `local-path-grant` 归一化为现有内部请求。
- [ ] 对 `git-ref` / `uploaded-snapshot` 返回 `CAPABILITY_UNSUPPORTED`。
- [ ] 确保路径解析、持久化脱敏、幂等 fingerprint 和现有 `/local` 行为不回退。
- [ ] 增加 `/v1` 新形态成功、远端来源拒绝和新旧等价幂等测试。

验收：Local 定向单测通过；旧 E2E 无修改或仅做类型适配；错误体符合公共 Schema。

## T4. Remote Reference Fixture

- [ ] 新建私有 `packages/remote-reference-fixture`，不提供 bin、不发布、不进入产品依赖图。
- [ ] 实现注入式 HTTPS fetch 路由、Bearer token 摘要表、expiry 和 tenant principal。
- [ ] 实现 tenant-scoped snapshot seed、Session/Run/Interaction/Event 内存资源。
- [ ] 使用 `harness-core` 与 Reference Adapter 执行、交互和取消。
- [ ] 实现 `/v1` JSON/SSE 路由、幂等和进程内 replay。
- [ ] 实现关闭时 controller 与临时目录清理。

验收：Fixture build/typecheck 通过；没有网络 listener、数据库、Redis、Docker、真实 Git 或真实模型依赖。

## T5. Remote Conformance

- [ ] 用 `HarnessClient.connect({ mode: 'remote' })` 建立 driver。
- [ ] 为每个场景预置 tenant token 与 uploaded snapshot。
- [ ] 直接运行 P3.3 四个共享场景函数，不复制断言。
- [ ] 验证握手保持 HTTPS、Remote Profile 准确且 SDK 不依赖 Fixture。

验收：discovery/resources、run/idempotency、interaction/replay、cancellation 四场景全部通过。

## T6. 状态与全仓门禁

- [ ] 运行 Prettier、lint、package boundaries、build、typecheck、unit tests 和 probes。
- [ ] 更新 `dual-runtime-compatibility/tasks.md`，只勾选 P3.6。
- [ ] 更新必要的架构/README 链接，明确 P3.7、P3.8 与 Phase 4 仍未完成。
- [ ] 检查 Git diff，确认未纳入用户临时文件、凭据或生成物。

验收：`pnpm check` 通过；P3.6 有可复现测试证据；Remote 兼容矩阵仍不宣称生产可用。

## 后续任务（不在本批）

- P3.7：系统覆盖跨租户拒绝、token 过期、持久化事件重放、恶意工作区清单和日志脱敏。
- P3.8：输出 Local macOS/Windows 与 Remote service 独立矩阵证据。
- Phase 4：建立正式 `apps/cloud-server`、认证、MongoDB/Redis、上传/Git preparation 与审计子 Spec。
- Phase 5：Worker、队列、沙箱和真实 CodeBuddy Remote 认证。
