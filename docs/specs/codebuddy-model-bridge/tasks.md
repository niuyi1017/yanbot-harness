# 任务

- [x] T1 固定 SDK 隔离探针和 Spec；证据：0.3.254 实际 /chat/completions 请求与 success，输出上限 1024。
- [x] T2 文本协议转换与 Guest 通道；依赖 T1；归一化、SSE/JSON、断流和未知字段单测。
- [x] T3 Adapter/Sandbox/Worker/Broker 接线；依赖 T2；配置、能力、授权和文本模式约束单测。
- [x] T4 全量静态/单元回归及实际 Docker/Mongo E2E；依赖 T3；至少九项远端 E2E 无跳过、所有 CI 通过。
- [x] T5 归档证据、部署说明、路线状态并推送；依赖 T4；核对 HEAD/远端及未涉及用户文件。

## 最终证据

代码 `e69f7cf`，8 个 CI 工作流全部通过；9 项远端 Docker E2E 和 28 项 Mongo/Broker 实库验证均零跳过。完整记录见 [验收目录](evidence/e69f7cf/README.md)。本机针对性测试 77 项通过。真实 Key、持久 Session 与生产认证不在本阶段完成范围内。
