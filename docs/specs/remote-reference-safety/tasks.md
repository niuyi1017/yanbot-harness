# Remote Reference 安全负例任务清单

## 当前状态（2026-09-20）

- [x] 审计 P3.7、现有 Fixture、Local redaction、Runtime archive manifest/path 校验和文件持久化模式。
- [x] 冻结五类负例、严格错误分类、allowlist audit 与 Fixture-only durable 边界。
- [ ] 尚未实现 P3.7 代码与证据。

## T1. Spec 门禁

- [x] 新增 `requirements.md`、`design.md`、`tasks.md`。
- [ ] 格式与范围复核后独立提交。

验收：实现前存在独立 Spec commit，且未把 Fixture 证据描述为生产 Remote service。

## T2. 恶意工作区 manifest

- [ ] 新增 `src/workspace-manifest.ts` 与严格类型/限制。
- [ ] 验证 exact fields、路径、类型、顺序、父项、碰撞、大小、digest 与敏感文件名。
- [ ] `prepareSnapshot` 使用 canonical manifest digest，并返回固定分类准备错误。
- [ ] 增加 traversal、absolute/drive、backslash、reserved、collision、missing parent、unknown type、oversize、bad digest、
      sensitive entry 和 expected digest mismatch 测试。

验收：所有恶意清单在登记 snapshot 前失败，错误不包含攻击路径；正常空/嵌套 manifest 成功。

## T3. Fixture 持久化与重建

- [ ] 新增严格 `src/state-store.ts`，支持调用方 state root 与自有临时 root。
- [ ] 原子持久化 Session、Run、Event、Snapshot 与 idempotency；排除 token/controller/waiter/cwd/audit。
- [ ] 事件先持久化再通知 SSE；畸形/未知版本状态 fail closed。
- [ ] 已完成 Run 跨 Fixture 实例 get/replay，cursor 后事件与首次执行完全一致。
- [ ] 加载非 terminal Run 时标记 interrupted，不伪恢复执行。

验收：重建测试通过，profile 声明 durable + retention；状态文件 mode 为 0600 且不含 token/绝对 workspace path。

## T4. Tenant 与 token 安全矩阵

- [ ] 扩展 tenant B 对 tenant A Session、Run、cancel、Event、cursor、Interaction、Snapshot 的攻击用例。
- [ ] 统一 foreign/missing 资源错误，确认 tenant A 正常流程不受攻击请求影响。
- [ ] 使用可变时钟验证握手后 token 过期，后续请求重新鉴权并返回 401。
- [ ] 检查 token 未写入持久状态、公共资源、Event 或错误 body。

验收：稳定 `401 AUTHENTICATION_FAILED` / `404 HARNESS_FAILED`；不存在全局 ID 旁路。

## T5. 结构化 audit 与脱敏证据

- [ ] 把 HTTP router 分离为 dispatch + allowlist audit，固定 action，不记录 URL/header/body/ID。
- [ ] workspace preparation 成功/拒绝也写结构化结果，不写 manifest 内容或异常 message。
- [ ] 用 raw token、Authorization、prompt secret、绝对路径、恶意 entry 和 state root marker 搜索全部 audit JSON。
- [ ] 验证失败与成功操作均可审计，且未知异常只记录固定状态。

验收：敏感 marker 全部不存在；audit entry 符合固定类型和字段 allowlist。

## T6. 回归、文档与提交

- [ ] 运行 Remote Fixture 定向测试与 P3.6 四组共享 Conformance。
- [ ] 运行 `pnpm check` 全量门禁。
- [ ] 只勾选 `dual-runtime-compatibility` P3.7；P3.8、Phase 4 保持未完成。
- [ ] 检查 diff/status，保留用户未跟踪临时文件，提交实现与证据。

验收：P3.7 五类证据全部可复现，全仓门禁通过，git 历史包含独立 Spec 与实现提交。

## 后续任务

- P3.8：输出 Local macOS/Windows 与真实 Remote service 独立矩阵证据。
- Phase 4：正式 cloud-server 认证、多租户持久化、workspace preparation、retention、审计与队列子 Spec。
- Phase 5：Worker、sandbox、执行授权和真实 CodeBuddy Remote。
