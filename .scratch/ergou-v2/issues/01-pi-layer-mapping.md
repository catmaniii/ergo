# pi 1.0 各层能力映射

Type: research
Status: resolved

## Question

对照二狗的运行时需求，逐项判断 pi 1.0 的三层能提供什么、缺什么。三层分别是：
- `pi-agent-core` 的 `Agent`；
- `pi-coding-agent` 的 SDK 加扩展；
- `pi-durable`。

最后推荐用哪一层，并列出需要自建的部分。

需求清单：
1. 工具调用前能拦截、能改参数、能异步等待用户决定（对应 AgentSense 的 `before_tool`）。
2. 工具调用后能附加判定结果（对应 `after_tool`）。
3. 一轮运行结束前能催促模型继续（对应 `before_run_end` 的 followUp）。
4. 能写不进入模型上下文的自定义记录（对应 `appendCustomEntry`）。
5. 会话树能回退，并能生成分支摘要（对应 `navigateTree`）。
6. 进程崩溃后能续跑；守护进程重启后能恢复待审批的状态。
7. 能创建子会话或子 agent：各自配置模型、工具和指令，父子之间能通信。
8. 有可供 UI 订阅的事件流。
9. 系统提示词能分段注入记忆，且不破坏缓存。
10. DeepSeek provider 的思考模式和推理内容回传是否正确（参考 `docs/research/09-chat-multimedia.md` 里列出的两个坑）。
11. 锁定版本的方式和升级成本。

## Context

- `docs/research/03-openclaw-and-pi.md`：A 节，以及 C2「AgentSense 的迁移路径」。
- `docs/research/01-ref-agentsense.md` §4：AgentSense 怎么用 pi。
- 产出写到 `docs/research/10-pi-layer-mapping.md`。

## Answer

详见 `docs/research/10-pi-layer-mapping.md`（依据 1.0.4 发布包与源码，另有 4 个探针脚本实测）。

- **推荐组合**：
  - 运行时引擎用 **pi-ai + pi-durable**，外面包一层二狗自己的薄封装，pi 的类型不出这一层。
  - `pi-agent-core` 的 `Agent` 留作备胎，它的 hook 能和 AgentSense 一一对应。
  - `pi-coding-agent` 不作为运行时，只借鉴它的分支摘要和扩展写法。
  - 理由：崩溃续跑、恢复待审批、子 agent 这三件事最难自己做对，只有 durable 原生提供。实测在等待审批时 SIGKILL 杀掉进程，重启后能恢复并完成这一轮。
- **二狗必须自建**：
  1. 审批表：记录、推送、超时都放在二狗自己的数据库，durable 的 hook 只存审批 id。
  2. 强制守卫：durable 没有全局 hook，封装层要保证每个会话都挂上守卫。
  3. 回退：durable 只有 fork，分支摘要要自己做。
  4. UI 事件流的断线续传。
  5. 按时段计价的成本账本。
  6. 对 DeepSeek 的适配：显式设置思考档位。
  7. 子 agent 协议、任务登记处，以及作为升级闸门的合同测试。
- **影响后续设计的事实**：
  - durable 不依赖 `pi-agent-core`，选它等于换了一套循环。
  - 在 `deepseek-flash` 上分段更新 system prompt 会打穿缓存，记忆注入方式要另行设计。
  - 同一会话中途换模型会把推理改写成模型"说过的话"，所以每个会话固定一个模型。
  - 四个包要用精确版本、`overrides` 和 lockfile 锁死，durable 仍是实验性的。

## 修正

2026-10-07 用户修正了两点：

1. **排除 pi-durable。** 它标着实验性，不作为二狗的基础。底座只能在两者之间选：(A) `pi-agent-core` 的 `Agent` 加全部自建，或 (B) `pi-coding-agent` 的 SDK。这个选择移交给「运行时架构」。
2. **不做按时段计价。** 这不是用户提的需求。用户只要求"能看到消耗"，所以只记 token 用量：缓存命中、未命中、输出。即使显示金额，也只标为粗略估算。
