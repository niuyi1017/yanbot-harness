# Remote Reference 安全负例需求

## 1. 背景

Remote Reference Fixture 已通过与 Local Runtime 相同的四组公共 Conformance，并具备最小 Bearer token、tenant、
uploaded snapshot 与进程内事件重放边界。`dual-runtime-compatibility` P3.7 仍要求取得五类明确的安全负例证据：
跨租户拒绝、token 过期、持久化事件重放、恶意工作区清单和日志脱敏。

本阶段继续增强私有测试 Fixture，不建设或替代正式 `apps/cloud-server`。目标是让未来控制平面有一组可执行的安全
语义基线，同时诚实区分“Fixture 文件持久化证据”和“生产数据库、队列、对象存储与沙箱认证”。

## 2. 目标

- 对 Session、Run、Event、Interaction 和 Workspace 建立完整 tenant 条件访问负例。
- 验证 token 在连接成功后过期时，后续每个请求仍会重新鉴权并稳定失败。
- 为 Fixture 增加可重建的文件状态，使已完成 Run 的事件能跨 Fixture 实例按 cursor 重放。
- 为测试控制面的 uploaded snapshot 增加严格文件清单验证，拒绝路径逃逸、特殊文件、碰撞、超限和敏感文件名。
- 增加结构化 allowlist 审计记录，并以攻击输入证明 token、header、body、本机路径和恶意清单内容不会进入日志。
- 全部负例产生稳定 HTTP/Harness 错误分类或稳定准备错误，且不泄漏其他租户资源是否存在。

## 3. 验收标准

### RS1. 跨租户拒绝

- tenant B 即使知道 tenant A 的 Session ID、Run ID、Event ID、Interaction request ID 或 upload ID，也不能读取、
  取消、响应或用于创建 Run。
- Session、Run、Event 和 Snapshot 的查询键必须包含 tenant ID，不能先按全局 ID 命中再做返回层过滤。
- 跨租户 Session/Run/Event/Workspace 使用与不存在资源相同的 `404 + HARNESS_FAILED` 形态。
- Interaction 对未知和跨租户 request ID 使用同一稳定拒绝，不暴露其是否仍处于 pending。
- tenant A 的正常 Run、Interaction 和 replay 在攻击请求后继续可用。

### RS2. Token 过期

- token 记录绑定 tenant、subject 和绝对 expiry，但持久化状态与审计日志不保存 raw token。
- Remote 握手成功后推进可注入时钟至 expiry，下一次资源请求返回
  `401 + AUTHENTICATION_FAILED`。
- 过期 token 不因已有 Session、SSE cursor 或先前成功握手获得宽限或回退。
- 失败响应不得回显 token、tenant 输入或内部 token digest。

### RS3. 持久化事件重放

- 调用方可显式提供测试 `stateRoot`；Fixture 以原子替换方式保存 tenant-scoped Session、Run、Snapshot、幂等记录和
  Event，不保存 token、controller、临时 waiter 或 raw HTTP 数据。
- 事件必须先持久化成功再向 SSE subscriber 发布。
- 完成 Run 后关闭 Fixture，并使用同一 `stateRoot` 创建新 Fixture；新 token 可读取原 Run 并从旧 event cursor
  精确重放剩余事件。
- 重建后的 Runtime Profile 声明 `eventReplay.durability = durable` 与明确 retention；未提供 `stateRoot` 的临时
  Fixture 也使用文件状态，但关闭时清理自有目录。
- 畸形、未知版本或不符合 public Schema 的状态文件必须 fail closed，不得部分加载。

### RS4. 恶意工作区清单

- snapshot preparation 接受严格版本化 manifest；每项只能是普通 file 或 directory。
- 拒绝绝对路径、反斜杠/盘符、`..`/`.`/空段、控制字符、Windows 非法或保留名、尾随点/空格、Unicode/大小写
  碰撞、重复路径、缺失/非目录父项和未排序项。
- 拒绝 symlink/hardlink/device/FIFO 等未知 type、单文件/总大小/条目数超限、非法 SHA-256 和未知字段。
- 拒绝 `.git`、非示例 `.env`、`.npmrc`、私钥/证书容器等敏感条目。
- accepted manifest 经规范化后计算 `sha256:` digest；调用方不能提供与清单不一致的 digest。
- 准备失败返回 `CONFIGURATION_INVALID` 类测试错误，错误和日志不包含攻击者路径原文。

### RS5. 日志脱敏

- Fixture 暴露只读测试控制面的结构化 audit entries，不新增 HTTP 日志接口。
- audit 字段采用固定 allowlist：timestamp、requestId、action、outcome、status、errorCode；不保存 URL、query、header、
  body、tenant/subject 原文、token/digest、workspace cwd、prompt 或 manifest entry。
- token 过期、跨租户访问、恶意 manifest 和包含 credential/path marker 的请求均生成可审计结果。
- 测试序列化全部 audit entries，确认 raw access token、Authorization header、恶意路径、prompt secret 和本机状态根
  均不存在。

### RS6. 回归与状态

- P3.6 四组共享 Remote Conformance 继续通过。
- 新增五类 P3.7 定向测试，并验证错误响应符合公共 `ApiError`。
- `pnpm check` 全量通过后只勾选 P3.7；P3.8 和 Phase 4 继续保持未完成。

## 4. 非功能要求

- **确定性**：时钟、ID 与 state root 可注入；测试不访问外网或真实模型。
- **持久化安全**：状态写入使用私有目录、0600 文件和同目录原子 rename；不得删除调用方提供的 state root。
- **保密性**：认证 token 仅保存在当前进程的摘要索引；不进入状态文件、事件、公共资源或审计。
- **兼容性**：不改变 SDK/CLI public API、Harness Protocol 或 P3.6 Conformance driver。
- **诚实性**：Fixture durable 证据不等于 MongoDB/Redis/对象存储、网关 HA 或生产 retention 已实现。

## 5. 范围

- `packages/remote-reference-fixture` 的状态存储、manifest 验证、结构化审计与安全测试。
- P3.7 任务状态和对应 Spec/README 说明。
- 必要的测试工具或类型，不增加产品运行时依赖。

## 6. 非目标

- 不实现正式上传字节流、压缩包解压、病毒扫描、Git clone 或对象存储。
- 不实现 JWT/refresh token、撤销列表、设备登录或生产密钥管理。
- 不实现数据库事务、分布式锁、Redis Queue、Worker lease 或多进程并发写入。
- 不实现公开 audit API、管理后台或日志采集系统。
- 不完成 P3.8 跨平台/Remote service 矩阵，也不修改兼容表为生产 Remote 可用。
- 不创建 `apps/cloud-server` 或 `apps/cloud-worker`。

## 7. 依赖

- `docs/specs/remote-reference-fixture/` 与 `dual-runtime-compatibility` P3.1-P3.6。
- `packages/contracts` 的 Session、Run、Event、ApiError 与 WorkspaceSource Schema。
- `packages/harness-core`、`packages/adapter-reference`、`packages/sdk`、`packages/testing`。
- 仓库既有 `packages/runtime/lib/archive.mjs` / `inventory.mjs` 的安全规则作为设计参考；Fixture 不直接依赖发行包内部文件。
