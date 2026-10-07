# 调研资料索引

ergou 立项前的调研（2026-10-06）。每份文档末尾都有"开放设计问题"一节。

| 文档 | 主题 | 一句话要点 |
|---|---|---|
| [01-ref-agentsense.md](01-ref-agentsense.md) | 参考项目 AgentSense（user_agent_sense_of_security） | 一次授权 + 确定性保险；全局层/要点层是**缩放视图**；安全类别写死在代码里，需要泛化为"关注类别"注册表；无普通聊天模式、无记忆、无子 agent |
| [02-ref-intent-mining.md](02-ref-intent-mining.md) | 参考项目 intent-mining | L1 表象 → L2 情境意图 → L3 需求 → L4 内核，带置信上限；自述只是 L1 证据；代价法、时序法；竞争解释必须配判别观察 |
| [03-openclaw-and-pi.md](03-openclaw-and-pi.md) | OpenClaw 与 pi 现状 | OpenClaw 已离开 pi；pi 1.0（2026-10-01）删除了 AgentHarness；pi-durable 最贴合但实验性；pi-web-ui 停更 |
| [04-multi-agent-teams.md](04-multi-agent-teams.md) | 多 agent 团队/角色模式 | 中心协调能压错误但 token 贵；PM"不动手"必须靠工具权限卡；单写者；经验要筛选、增量合并 |
| [05-memory-and-motive-mining.md](05-memory-and-motive-mining.md) | 记忆系统与动机挖掘 | 生产系统无人做动机建模；GUM/Behavior Latticing 可借鉴；动机推断上限低，只能当假设；记忆放大讨好 |
| [06-long-tasks-hitl-interruptions.md](06-long-tasks-hitl-interruptions.md) | 长任务、人在回路、打断管理 | 类别 × 处置档位 × 计划期授权；授权要有边界；持久化审批表；按紧急度设等待上限和汇总 |
| [07-push-harmonyos-android.md](07-push-harmonyos-android.md) | 系统级推送：HarmonyOS Push Kit / 实况窗、Android 国内通道 | 调试签名不上架也能收 Push，但没有 `WORK` 自分类权益的通知是静默的（MARKETING，每天 2 条）；Push 通知没有按钮，审批只能打开 App 后用生物识别和设备密钥签名完成；实况窗正式权限要求已上架且月活 ≥1000；Android 用自建 ntfy / UnifiedPush（RFC 8291，与 Web Push 共用一个推送库） |
| [08-local-infra.md](08-local-infra.md) | 本机基础设施：audio.cpp、语音识别、LSM、华为家庭存储 | audio.cpp（:8090，Fish S2 Pro，约 60 个参考音色）能做 TTS 但约实时、不能流式、与 drama 共用锁；Whisper 未部署，但 audio.cpp 有 Qwen3-ASR / Fun-ASR-Nano；LSM 是登录后自启，没有按服务的开机自启；家庭存储在 192.168.8.5（SMB） |
| [09-chat-multimedia.md](09-chat-multimedia.md) | 聊天多媒体、消息模型、DeepSeek V4.1 与成本 | `deepseek-flash`（V4.1）能看图，但不支持音频、文档、视频；V4.1 Pro 尚未发布；成本取决于缓存命中率；手写 React，消息模型对齐 AI SDK UIMessage parts，再加 messenger 字段；媒体按 sha256 内容寻址；麦克风要求 HTTPS |
| [10-pi-layer-mapping.md](10-pi-layer-mapping.md) | pi 1.0 各层能力映射：agent-core `Agent` / coding-agent SDK / pi-durable × 二狗 11 项运行时需求 | 推荐 pi-ai + pi-durable，包在二狗自己的 Runtime 端口后面，agent-core 作备胎；durable 不依赖 agent-core，崩溃后能恢复待审批（实测）；AgentSense 的三个 hook 三层都有等价物，原地回退加分支摘要只剩 coding-agent 有；`deepseek-flash` 上分段更新 system prompt 会折叠前缀、打穿缓存；Agent 和 durable 默认关闭思考；四个包精确锁定加 overrides |
| [11-user-modeling-systems.md](11-user-modeling-systems.md) | 现成用户建模系统深挖：Honcho / GUM / Behavior Latticing（源码 + 论文） | 三家都没有带状态机、修订历史、用户裁决的命题记录；Honcho 的 "dialectic" 是 agent 问 Honcho，不向用户求证，peer card 已禁止 TRAIT；GUM 代码里 Audit 没接上、Revise 是删旧建新、decay 方向与 prompt 相反；BL 只有 forward pass，L0 混入推断；可借：Honcho 证据边、摄入独占 L1、伪造 ID 剥离、dream 调度，GUM 的 retrieve→revise，BL 的张力分组与 top-2 注入，VoE 的预测落空→提问 |
