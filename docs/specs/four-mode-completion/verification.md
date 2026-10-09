# 验证记录

实现范围：四模式剩余开发，详见 tasks.md。最终 8 个 CI 工作流全部通过，证据已固定于 [124f10f](evidence/124f10f/README.md)。

## 本机

- 固定 Claude Code 2.1.284 和 CodeBuddy SDK 0.3.254 的真实进程，经合成上游完成 Write → AskUserQuestion → 最终回复。两家厂商分别验证 allow / deny；拒绝时文件不存在，对话仍能继续。
- 从 GitHub 下载 octocat/Hello-World 的 commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`，安全解码出 README，13 bytes，SHA256 `03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340`。
- 对 72 个已追踪的 TypeScript 测试文件串行回归：466 passed / 26 skipped。跳过项需要 Mongo、Docker 或其他操作系统。此运行把 Vitest 用例超时设为 30 秒，未改仓库测试阈值；本机并行全量检查曾出现既有 5 秒进程测试超时。完整默认阈值检查以固定源码 CI 为准。
- 最新租约版本和 CodeBuddy interaction UUID 修复：针对性 36 项回归通过，服务端/Adapter 构建与 lint 通过。

## 验收中修复的问题

1. 实测 CodeBuddy 在允许/拒绝工具后发送的消息元数据不同；按实际协议校验并剥离 metadata，保留 tool result 的错误语义。
2. CLI Host 的交互输入回调也纳入执行超时，避免 stdin 写入阻塞绕过总时限。
3. Redis publication 之前写入可领取的 queued attempt，避免快速 Worker 领取后被派发端旧对象覆盖。旧 lease 的撤销先于队列锁清理。
4. Mongo heartbeat / 事件 fencing 在相同毫秒也必须产生写入；递增 fenceRevision，避免 modifiedCount=0 被误判为失去租约。
5. CodeBuddy 工具 ID 只在厂商会话内有意义，公开交互使用独立 UUID，避免不同 Run 的权限回复冲突。
6. Mongo 测试健康探针的 HOME 移到 /tmp，避免 mongosh 临时文件与官方镜像启动时的数据目录 chown 竞争。

## 外部发布门禁

未调用付费模型，未部署生产环境。真实 Anthropic Key、Windows 10/11 实机、生产 TLS/ACL/高可用部署、签名、registry 和许可证仍须外部条件。Windows Server CI 和合成上游不得替代这些验收。
