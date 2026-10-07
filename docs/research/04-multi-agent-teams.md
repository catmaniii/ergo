# 调研 04：多智能体团队（秘书 + 项目组 + 角色）

> - 研究日期：2026-10-06。只用一手来源：论文、官方文档、源码或 README、第一方工程博客。每条论断后面都附了 URL。少数二手来源单独标了【二手】。
> - 要回答的问题：ergou 计划用"秘书（主 agent）→ 按项目组建子 agent 小组 → 子 agent 是可配置角色的实例"这套调度模型。需要弄清楚：
>   - 业界和学术界有哪些可以借的模式？
>   - agent 之间的群体通信怎么做？
>   - 角色经验怎样跨项目保留，又不被其他项目的内容污染？
>   - 角色边界怎么强制执行？
>   - 多 agent 什么时候有用，什么时候反而有害？
>   - 有哪些现成的角色目录？
>   - 最终给出架构草图、关键决策清单和起步用的角色目录。
> - 读法：§0 是一页摘要。§1–§6 是分主题的调研。§7 是给 ergou 的综合建议，包括架构、数据模型、决策表、起步角色目录和开放问题。§8 是来源索引。
> - 标注：没标的都是【事实】，带来源。【建议】【推测】是本文作者针对 ergou 的判断。
> - 时效说明：文中的版本号、日期、GitHub star 数都是 2026-10 初抓取时的值。

---

## 0. 一页摘要（决策相关）

1. **"秘书 → PM → 执行角色"这种集中式星形结构有实证支撑，但必须控制两类成本：转述损耗和 token 开销。**
   - Google 做了 260 个配置的研究。误差放大倍数是：Independent 17.2×，Centralized 4.4×（[arXiv 2512.08296](https://arxiv.org/html/2512.08296)）。
   - 同一研究里，Centralized 相对单 agent 多花 285% 的 token，每 1K token 的成功数只有单 agent 的约 1/3。单 agent 准确率超过约 45% 的任务，再加 agent 收益为负（同上）。
   - Anthropic 的多 agent 研究系统约耗 chat 的 15 倍 token（[Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)）。
2. **PM"只管不干"可行，但它的价值在验收、跟踪和判断何时终止，不在传话。**
   - MAST 分析了 1,642 条失败轨迹。任务验证类失败占 24.1%，"不知道何时终止"占 12.4%（[arXiv 2503.13657](https://arxiv.org/html/2503.13657)）。
   - Magentic-One 的 Orchestrator 自己没有任何工具，只维护 Task Ledger 和 Progress Ledger。去掉 ledger 后性能下降 31%（[arXiv 2411.04468](https://arxiv.org/html/2411.04468)）。
   - 另一面，supervisor 转述会引入 "telephone game" 误差。LangChain 改成原样转发后，性能提升约 50%（[LangChain](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)）。
   - 5 级串行 relay 让 MMLU 准确率从 90.7% 降到 22.5%。这个实验里下游 agent 看不到原题（[arXiv 2603.26993](https://arxiv.org/html/2603.26993)）。
   - 【建议】产物直接写进项目产物库，PM 只传引用和验收结论。每份委派简报都附上用户原话。
3. **"PM 不动手"只写在 prompt 里会失效，必须在代码层限制。**
   - CrewAI 在源码里规定：manager 一旦带工具就直接抛异常（[crew.py](https://raw.githubusercontent.com/crewAIInc/crewAI/main/lib/crewai/src/crewai/crew.py)）。即便如此，仍有 issue 报告 manager 自己干活（[#2838](https://github.com/crewAIInc/crewAI/issues/2838)）。
   - Claude Code 官方文档也承认 lead "sometimes starts implementing tasks itself"，还会提前收工（[agent-teams](https://code.claude.com/docs/en/agent-teams)）。
4. **写操作要单线程，额外的 agent 只贡献判断。**
   - Cognition 在 2026-04 修正了"不要做多 agent"的立场：多 agent 在 "writes stay single-threaded and the additional agents contribute intelligence rather than actions" 时才可行（[Cognition](https://cognition.com/blog/multi-agents-working)）。
   - 他们的独立上下文 reviewer 平均每个 PR 找出 2 个 bug，其中约 58% 是严重 bug（同上）。
   - 【建议】ergou 规定"每个产物只有一个写者"。评审和研究类角色可以并行。
5. **最接近 ergou 设计的现成实现是 Hermes Agent 的 Kanban + Bot Mode。**
   - profile 等于"带持久记忆和 skills 的具名角色"。
   - SQLite 看板提供 triage→…→review→done→archived 的状态机，orchestrator profile 只负责拆分和派单。
   - 群聊有刹车：2–6 个 bot，每次用户发言最多 3 轮、10 条消息。
   - UI 里有 "New Agent / Edit Profile"。
   - 来源：[Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)、[Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)。
6. **角色卡格式可以直接用 Claude Code 的 subagent `.md` frontmatter。**
   - pi 官方的 subagent 示例扩展也用 `~/.pi/agent/agents/*.md`，frontmatter 是 `name/description/tools/model`，两者几乎同构（[pi subagent 示例](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/README.md)、[Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)）。
   - Claude Code subagent 已经有 `memory: user|project|local` 字段，提供按角色持久化的记忆目录，正好对应"角色经验跨项目保留"（同上）。
7. **角色经验必须和项目上下文物理隔离，并且只通过"晋升"流程写入。** 什么都存会让效果变差：
   - add-all 策略普遍比固定记忆还差（[arXiv 2505.16067](https://arxiv.org/html/2505.16067)）。
   - ChatDev IER 只保留 11.54% 的经验，效果反而更好（[arXiv 2405.04219](https://arxiv.org/abs/2405.04219)）。
   - 让 LLM 整体重写经验会塌缩：ACE 实测从 18,282 token 被重写成 122 token，准确率跌到低于基线（[arXiv 2510.04618](https://arxiv.org/html/2510.04618)）。
   - 【建议】采用 ACE 式增量更新（ADD/EDIT/UPVOTE/DOWNVOTE），由确定性代码合并，每条带来源，按使用数据淘汰。
8. **角色的划分依据应是"能力和权限边界"，而不是职位头衔。**
   - Manus 刻意不按 designer/manager 这类人类组织角色划分 agent，子 agent 主要用来隔离上下文（【二手】[Lance Martin 复盘](https://rlancemartin.github.io/2025/10/15/manus/)）。
   - 单 agent 加 skills 在 skill 库达到约 83–92 个时会出现选择准确率的相变。每个 skill 只要有 1–2 个语义相近的竞争者，准确率就下降 7–63%（[arXiv 2601.04748](https://arxiv.org/html/2601.04748)）。
   - 角色目录同理：数量要少，彼此不重叠，否则秘书选角会出错。
9. **内部通信不要上 A2A 协议。** 但内部数据模型最好照 A2A 的形状建：
   - Task 用 8 个状态，含 `REJECTED` 和 `INPUT_REQUIRED`。
   - 产物用 Artifact/Part 结构。
   - 角色能力描述用 Agent Card 里的 skills 字段。
   - 这样以后跨设备或对外开放时，只需加一层适配。理由：A2A 定位是跨组织、跨厂商的通信，在同一个信任边界内使用 "mostly adds overhead"（[A2A 规范](https://a2a-protocol.org/latest/specification/)、[Redis](https://redis.io/blog/when-does-a2a-protocol-matter/)）。
10. **需要你拍板的决策**，详见 §7.7：
    - 小项目是否强制配 PM？【建议】数据模型上每个项目都有一个 PM 席位；XS 级项目由秘书兼任 PM。
    - 秘书和角色之间用 agent-as-tool 还是 handoff？【建议】用 agent-as-tool。
    - 项目组的通信骨架？【建议】看板 + 邮箱 + 带刹车的群聊日志。
    - 经验何时写、谁批准？【建议】运行中只写项目笔记，项目关闭时蒸馏成候选，再按人工审核或使用效果转正。
    - 角色实例的生命周期？【建议】每个项目新开实例，角色经验以只读方式注入。

---

## 1. 业界与学术模式逐个拆解

### 1.1 横向对比总表

| 系统 | 角色定义格式 | 委派/交接机制 | 通信拓扑 | 范围约束手段 | 生命周期 | 经验/记忆 | 2026 状态 |
|---|---|---|---|---|---|---|---|
| MetaGPT | Python `Role` 类：`name/profile/goal/constraints`、`set_actions`、`_watch` | SOP 流水线，按结构化文档触发；新版 `TeamLeader` 用 `publish_team_message(send_to)` 定向派单 | 共享 message pool + pub-sub 订阅 | `_watch` 订阅过滤、动作集、`tools` 白名单 | `Team.hire → invest(预算) → run(n_round, auto_archive)` | `exp_pool` 经验缓存 | v0.8.2（2025-03），活跃度明显下降；团队转做 MGX→Atoms |
| ChatDev 1.0/2.0 | 1.0：RoleConfig/PhaseConfig/ChatChainConfig 三个 JSON；2.0：YAML 图 | chat chain，instructor↔assistant 两两对话 | 链式 / DAG（MacNet） | inception prompt；2.0 在节点上配 tooling | 每任务一条链，产物进 WareHouse | ECL / IER 经验池（离线提炼） | 2.0（DevAll）于 2026-01 发布 |
| CrewAI | `role/goal/backstory` + 工具；新项目默认 JSONC，YAML 为 classic 写法 | `allow_delegation` 注入 Delegate / Ask 两个工具；hierarchical 模式下 manager 分派 | sequential 线性 / hierarchical 星形；Flows 事件驱动 | manager 带工具会被代码拒绝 | Crew kickoff；Flow 可 `@persist` | 统一 `Memory`：scope 树、slice、30 天半衰期 | 非常活跃（1.15.x） |
| AutoGen → AG2 / MAF | AG2 v1：Hub + 类型化 channel；MAF：代码或 YAML 声明 | GroupChat 选人；Swarm handoff；Magentic manager | 广播群聊 / 星形 / mesh | `allowed_transitions`、工具集 | MAF 有 checkpoint | MAF 有 context provider | AutoGen 进入维护模式；MAF 1.0 于 2026-04 GA；AG2 v1.0 于 2026-07 发布 |
| Magentic-One | Orchestrator + 4 个固定 worker | Orchestrator 通过 Progress Ledger 选下一个发言者并下指令 | 星形 | Orchestrator 无工具 | 单任务 | 无 | 被 MAF 收编为 Magentic 编排 |
| LangGraph | 代码；Deep Agents 子 agent 用字典 `name/description/system_prompt/tools` | handoff tool 返回 `Command(goto)`；`task` 工具 | supervisor 星形 / swarm 网状 | 各自的 tools | checkpointer | store | `langgraph-supervisor` 已归档，官方改推手写的 tool-calling supervisor |
| OpenAI Agents SDK | Python `Agent(...)` | handoff（`transfer_to_X`，带 `input_filter`）或 `as_tool()` | Manager 模式或去中心化 | input/output/tool 三类 guardrail；MCP tool filter | handoff 不跨 run | session | v0.23.x，活跃 |
| Google ADK 2.x | 代码，或实验性的 YAML Agent Config | 自动生成的委派工具；子 agent 有 chat/task/single_turn 三种 mode；`finish_task` 交回 | 树 / graph workflow | 各自的 tools、I/O schema | Session service | 用 `user:`、`app:` 前缀的 state | 2.0 GA；Sequential/Parallel/LoopAgent 已标记 deprecated |
| Anthropic 研究系统 | lead + 动态生成的子 agent | 委派简报：目标、输出格式、工具、边界 | orchestrator-worker | 简报里写明边界 | 单次查询 | lead 把计划存进 Memory | 2025-06 发布的博客 |
| Claude Code subagents | `.claude/agents/*.md` frontmatter | Agent 工具；默认可嵌套 3 层，并发 20 | 父→子星形；具名子 agent 之间可以 SendMessage | `tools`/`disallowedTools`/hooks/permissionMode | 可用 SendMessage 恢复 | `memory: user/project/local` | 活跃 |
| Claude Code agent teams | 复用 subagent 定义 | lead 指派或 teammate 自行认领 | 共享任务列表 + 每人一个邮箱 + 点对点消息 | 继承 lead 的权限；TaskCompleted 等 hook | 一个会话一个团队，不能嵌套 | 任务目录保留 | 实验功能 |
| Kimi Agent Swarm | 不预定义角色，orchestrator 动态生成 | 用 PARL 训练出来的 orchestrator | 星形，最多 100–300 个子 agent | 子任务语义隔离 | 单任务 | Claw Groups 带持久记忆 | K2.5→K2.6→K3 |
| Manus | 不按人类角色划分 | Wide Research：每个条目一个完整实例；"submit results" 工具配 schema | 星形，子 agent 之间不通信 | 独立 VM | 单任务 | 文件系统即记忆 | 2.0（2026-09）；Cue 支持群聊 |
| Devin | 协调者 Devin + 被管理的 Devin | scope → assign → monitor → resolve → compile | 星形 | 独立 VM | 可休眠、可终止 | Memory Drive + dreaming | 活跃 |
| OpenClaw | `agents.entries` + 每个 agent 一个 workspace（AGENTS.md/SOUL.md/...） | `sessions_spawn`、`sessions_send` | 按 binding 路由；会话间可见 | `tools.allow/deny`，只能比全局更严 | 子会话可嵌套，默认最深 5 层 | MEMORY.md、`memory/日期.md` | 基金会运营 |
| Hermes Agent | profile（SOUL.md + skills + memory） | `delegate_task`（RPC）或 Kanban（持久队列） | 看板 + 群聊（Bot Mode） | 子 agent 被禁用 memory/send_message 等工具 | Kanban 持久 | 自主创建 skill + curator | v0.21.x，活跃 |
| pi | 本体不带 sub-agent；示例扩展用 `agents/*.md` | 子 agent 是独立的 pi 进程 | 由扩展自行实现 | 扩展的 `tool_call` 可以 block | `pi-durable` 实验中 | 无 | 迁到 earendil-works |

下面逐个补充表格里放不下的细节。

### 1.2 MetaGPT（SOP + 共享消息池 + pub-sub）

**角色定义**
- 论文里每个角色有 name、profile、goal、constraints，外加专属的 context 和 skills。论文定义的五个角色是 ProductManager、Architect、ProjectManager、Engineer、QA（[arXiv 2308.00352](https://arxiv.org/html/2308.00352v7)）。
- 当前源码中 ProjectManager 的配置是：
  - `goal="break down tasks according to PRD/technical design, generate a task list, and analyze task dependencies..."`
  - `tools=["Editor:write,read,similarity_search","RoleZero","WriteTasks"]`
  - `max_react_loop=1`
  - `_watch([WriteDesign])`
  
  也就是说，PM 只订阅设计文档，只能产出任务列表，拿不到终端或代码执行工具（[project_manager.py](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/project_manager.py)）。

**通信**
- 论文强调 agent 之间"通过文档和图（structured outputs）而不是对话"沟通。所有 agent 往一个 shared message pool 里 publish，再按 role profile 订阅（[arXiv 2308.00352](https://arxiv.org/html/2308.00352v7)）。
- 实现上，`Environment.publish_message` 按 `send_to` 投递到各角色的 `msg_buffer`。角色在 `_observe` 中只保留 `cause_by in rc.watch` 或明确发给自己的消息（[role.py](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/role.py)、[base_env.py](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/base_env.py)）。

**TeamLeader（MGX 模式）**
- prompt 要求（[team_leader prompt](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/prompts/di/team_leader.py)）：
  - 不要给同一个成员连续派单，应派一个聚合任务。
  - "you are their sole info source"，因此必须带上路径、环境等全部信息。
  - 用 t-shirt sizing 评估规模，**XS/S 级直接交给 Engineer，跳过完整 SOP**。
- 【建议】这正是"小项目要不要 PM"的现成答案。

**生命周期**
- `Team.hire(roles) → invest(预算，超出抛 NoMoneyException) → run(n_round, auto_archive=True)`。所有角色都空闲时提前结束；结束时调用 `env.archive()` 归档（[team.py](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/team.py)）。

**经验**
- `metagpt/exp_pool` 提供 `@exp_cache` 装饰器，作用是"get a perfect experience, otherwise execute and create a new experience"（[exp_pool](https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/exp_pool/decorator.py)）。

**现状**
- 最新 release 是 v0.8.2（2025-03）。团队重心转到商业产品 MGX，2026-01 改名为 Atoms（[releases](https://api.github.com/repos/FoundationAgents/MetaGPT/releases)、[atoms.dev](https://atoms.dev/mgx-is-now-atoms)）。

### 1.3 ChatDev 及其经验系列（ECL / IER）——角色经验持久化的关键参考

**Chat chain**
- 开发分 design → coding → testing 三个阶段。每个子任务由一对 instructor/assistant 多轮对话完成，直到达成共识。终止条件是代码连续两次没变，或对话满 10 轮。
- 阶段之间只传 solution（作为 long-term memory），不传整段对话。
- 有一个 "communicative dehallucination" 机制：assistant 给出最终答案前，先反过来向 instructor 追问细节。
- 来源：[arXiv 2307.07924](https://arxiv.org/html/2307.07924v5)。

**Experiential Co-Learning（ECL）**（[arXiv 2312.17025](https://arxiv.org/html/2312.17025)）
- 把执行轨迹建成图：节点是代码状态，边是指令。
- 当前后两个节点的打分差超过 ε=0.90 时，抽取一条跨越非相邻节点的 **shortcut**，相当于跳过失败的弯路。
- 经验按角色分成两个池：
  - **instructor 池**：存 solution→instruction，即"怎么派活"。
  - **assistant 池**：存 instruction→solution，即"怎么干活"。
- 推理时按 embedding 检索 top-k，作为 few-shot 示例。
- 结果：quality 0.7304，对比 ChatDev 0.4267。

**工程流程**
- 先正常跑完软件生成，再用 `ecl/ecl.py <WareHouse 路径>` 离线提取经验，写入 `MemoryCards.json`（[wiki](https://raw.githubusercontent.com/OpenBMB/ChatDev/chatdev1.0/wiki.md)）。
- 【建议】这里的两条规律直接对应 ergou：
  - **"项目先归档，再离线提炼经验"**。
  - **"派活的经验和干活的经验分开存"**，即 PM 的经验与执行角色的经验分池。

**Iterative Experience Refinement（IER）**（[arXiv 2405.04219](https://arxiv.org/html/2405.04219)）
- 两种经验传递模式：
  - **successive**：只继承上一批任务的经验。
  - **cumulative**：继承所有历史批次的经验。
- 启发式淘汰同时看两个维度：信息增益（ε=0.95）和检索频率（θ=0.95 分位）。
- **只保留 11.54% 的经验（8053 条中留 930 条），效果反而更好**。
- 两种模式的结果对比：

| 模式 | Quality | 特点 |
|---|---|---|
| ChatDev（基线） | 0.4665 | — |
| ECL | 0.5775 | — |
| IER-successive | 0.6372 | 峰值高但不稳定 |
| IER-cumulative | 0.6337 | 稳定，但经验池膨胀导致命中率逐批下降 |

**局限**
- MAST 对 ChatDev 做过两项干预：强化角色 prompt 后 ProgramDev 从 25.0% 升到 34.4%；把拓扑从 DAG 改成环形后升到 40.6%。作者认为两者都"并非实质性改进"（[arXiv 2503.13657](https://arxiv.org/html/2503.13657v3)）。

**现状**
- ChatDev 2.0（DevAll）于 2026-01 发布，转型为通用的 YAML 多 agent 编排平台。节点可以带 `memories`，按 top_k 和相似度阈值检索（[repo](https://github.com/OpenBMB/ChatDev)、[demo yaml](https://raw.githubusercontent.com/OpenBMB/ChatDev/main/yaml_instance/demo_improved_memory.yaml)）。

### 1.4 CrewAI（role/goal/backstory + hierarchical manager）

**角色定义**
- 必填三项：`role`、`goal`、`backstory`。可选项包括 `allow_delegation`（默认 False）、`max_iter=20`、`knowledge_sources` 等。
- `crewai create crew` 现在默认生成 JSONC 配置；旧的 YAML 写法需要加 `--classic`（[agents](https://docs.crewai.com/en/concepts/agents)）。

**委派**
- `allow_delegation=True` 会注入两个工具：`Delegate work to coworker(task, context, coworker)` 和 `Ask question to coworker(...)`。
- 文档建议专家角色关闭委派，防止互相推诿形成循环（[collaboration](https://docs.crewai.com/en/concepts/collaboration)）。

**hierarchical 模式**
- 必须提供 `manager_llm` 或 `manager_agent`。任务不预先分配，由 manager 规划、分派和验收（[processes](https://docs.crewai.com/en/concepts/processes)）。
- 源码 `_create_manager_agent` 中有一句 `raise Exception("Manager agent should not have tools")`，自动创建的 manager 只拿到委派工具（[crew.py](https://raw.githubusercontent.com/crewAIInc/crewAI/main/lib/crewai/src/crewai/crew.py)）。
- 已知问题：
  - agent 超过 3 个时，即使 backstory 写了 "MUST NEVER perform tasks"，manager 仍然自己干活（[#2838](https://github.com/crewAIInc/crewAI/issues/2838)）。
  - manager 只能"委派给自己"，hierarchical 实际退化成 sequential（[#4783](https://github.com/crewAIInc/crewAI/issues/4783)，已于 2026-04 关闭）。

**统一 Memory**（[memory](https://docs.crewai.com/en/concepts/memory)）
- 官方原话是 "replaces separate short-term, long-term, entity, and external memory types"。
- 作用域是路径树，例如 `/project/alpha`、`/agent/researcher`：
  - `memory.scope()` 把读写限定在子树内。
  - `MemorySlice` 可以跨多个分支只读召回。
- 召回打分 = 0.5×语义 + 0.3×时间衰减（半衰期 30 天）+ 0.2×重要性。
- 写入时，相似度 >0.85 的条目交给 LLM 决定 keep/update/delete/insert。
- 【建议】这套 scope 树可以直接映射到 ergou 的 `/role/<id>` 与 `/project/<id>`。

**生产建议**
- 官方建议生产环境 "start with a Flow"：Flow 做骨架，Crew 嵌在某个步骤里（[introduction](https://docs.crewai.com/en/introduction)）。

### 1.5 AutoGen / AG2 / Magentic-One / Microsoft Agent Framework

**AG2 Classic 的 GroupChat**
- 选人方式 `speaker_selection_method` 有四种：auto、round_robin、random、manual。
- `allowed_or_disallowed_speaker_transitions` 用来约束谁之后可以轮到谁。
- manager 选出发言人后，消息**广播**给所有成员（[AG2 docs](https://docs.ag2.ai/0.8.6/docs/user-guide/advanced-concepts/conversation-patterns-deep-dive/)）。

**AG2 v1.0（2026-07-27）重写**
- 旧的 GroupChat 移到 `ag2-classic` 仓库维护。
- 新的多 agent 模型叫 Network：一个 Hub 持有注册表、write-ahead log 和审计记录。
- channel 有四种类型：conversation（两方自由对话）、consulting（一问一答后关闭）、discussion（N 方轮流发言）、workflow（TransitionGraph 条件交接）（[release](https://api.github.com/repos/ag2ai/ag2/releases/tags/v1.0.0)、[README](https://raw.githubusercontent.com/ag2ai/ag2/main/README.md)）。
- 【建议】"类型化 channel + WAL 审计"值得 ergou 的群聊层借鉴。

**AutoGen 0.4 的 SelectorGroupChat**
- 由 LLM 根据各 agent 的 `description` 选下一个发言人，默认不允许同一 agent 连续发言。
- 官方示例建议设一个"只拆任务、不执行"的 planning agent（[selector](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)）。
- AutoGen 本体已进入 "Maintenance Mode"，新用户转向 MAF（[repo](https://github.com/microsoft/autogen)）。

**Magentic-One**（[arXiv 2411.04468](https://arxiv.org/html/2411.04468)）
- 外循环维护 **Task Ledger**：given/verified facts、facts to look up、facts to derive、educated guesses，以及 plan。
- 内循环每一步填写 **Progress Ledger**，回答五个问题：
  1. 请求是否已完成？
  2. 是否在打转？
  3. 是否有进展？
  4. 下一个谁发言？
  5. 给他什么指令？
- 停滞计数超过阈值就回到外循环重新规划。
- Orchestrator 自己没有工具；**去掉 ledger 后性能下降 31%**。
- 局限：每个任务要花几美元，延迟高，团队成员固定。

**Microsoft Agent Framework 1.0**（2026-04 GA）
- 五种编排：Sequential、Concurrent、Handoff、Group Chat、Magentic（[overview](https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview)、[GA 博客](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)）。
- Magentic 编排的参数有 `max_stall_count`、`max_reset_count`、`enable_plan_review`（人工审批计划）。官方提示 "untested how well the Magentic orchestration will perform outside of the original Magentic-One design"（[magentic](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)）。
- 官方对 Handoff 和 agent-as-tools 的区分：handoff 把任务所有权和完整上下文一起交出去；agent-as-tools 由主 agent 保留责任，只给子 agent 必要的信息（[handoff](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。

### 1.6 LangGraph / LangChain

**两个官方库**
- `create_supervisor`（星形）的 handoff tool 返回 `Command(goto=agent, graph=Command.PARENT)`。它还提供 `create_forward_message_tool`，用来原样转发子 agent 的输出，避免 supervisor 转述走样（[supervisor README](https://raw.githubusercontent.com/langchain-ai/langgraph-supervisor-py/main/README.md)）。
- `create_swarm`（网状）在状态里记录 `active_agent`（[swarm README](https://raw.githubusercontent.com/langchain-ai/langgraph-swarm-py/main/README.md)）。

**自家基准**（τ-bench 加入干扰领域，[博客](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)）
- 干扰领域达到 2 个以上时，单 agent 掉分明显。
- swarm 略好于 supervisor；supervisor 一直更费 token。
- supervisor 的主要问题是 "translation"，即转述出错。三项改进合计提升约 50%：去掉 handoff 消息、加 forward_message、调整工具命名。

**后续官方立场**
- `langgraph-supervisor` 已经归档，README 改为推荐 "supervisor pattern directly via tools"。
- 2026-01 的指南写道："Start with a single agent… Add tools before adding agents"（[选型博客](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture)、[multi-agent 文档](https://docs.langchain.com/oss/python/langchain/multi-agent)）。

**Deep Agents 子 agent**
- 用字典定义：`name/description/system_prompt/tools/model`，通过 `task` 工具派发。子 agent 不能反问，只返回一条最终消息（[deepagents](https://docs.langchain.com/oss/python/deepagents/subagents)）。
- 异步子 agent 支持 `start/check/update/cancel`，运行中可以追加指令（[async](https://docs.langchain.com/oss/python/deepagents/async-subagents)）。

### 1.7 OpenAI Agents SDK

**Handoff**
- 在 LLM 看来，handoff 就是一个名为 `transfer_to_<agent>` 的工具。
- 接手的 agent 默认能看到全部历史。可以用 `input_filter` 裁剪，内置的 `remove_all_tools` 会清掉历史里的工具调用。
- `nest_handoff_history` 能把历史压缩成摘要，但目前是 beta，默认关闭（[handoffs](https://openai.github.io/openai-agents-python/handoffs/)）。

**Agents-as-tools**
- manager "keeps control of the conversation"。适合的场景是："specialist should help with a bounded subtask but should not take over the user-facing conversation"（[multi_agent](https://openai.github.io/openai-agents-python/multi_agent/)）。
- 【建议】这正对应"秘书始终持有和用户的对话"。

**Guardrail 的盲区**
- 三类 guardrail（input/output/tool）里，tool guardrail 只作用于 FunctionTool，"Tool input guardrails apply to function tools, not handoffs"（[guardrails](https://openai.github.io/openai-agents-python/guardrails/)）。

**PDF 指南的拆分信号**（[A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)）
- 总原则："maximize a single agent's capabilities first"。
- 只有两种情况才拆：
  - **复杂逻辑**：prompt 里 if-else 分支太多。
  - **工具过载**：关键不在数量，而在是否重叠。原话是 "Some implementations successfully manage more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools"。
- 两种多 agent 结构：
  - Manager（agents as tools）："ideal for workflows where you only want one agent to control workflow execution and have access to the user"。
  - Decentralized：handoff 是单向转交。

### 1.8 Google ADK 2.x

**状态**
- 2.0 在 2026-05 至 08 期间陆续 GA，改为图引擎。`SequentialAgent/ParallelAgent/LoopAgent` 已会报 deprecation warning（[ADK 2.0](https://adk.dev/2.0/)）。

**委派**
- 声明了 sub_agents 后，ADK 会为每个子 agent 自动生成一个委派工具。子 agent 有三种 mode（[collaboration](https://adk.dev/workflows/collaboration/)）：
  - **chat**（默认）：子 agent 直接对用户说话。
  - **task**：可以向用户澄清，完成后调用 `finish_task` 交回父 agent；必须是叶子节点。
  - **single_turn**：不和用户交互，可以并行。
- v2.7 给 `transfer_to_agent` 加了 `transfer_reason`，目的是防止委派绕圈（[releases](https://github.com/google/adk-python/releases)）。

**AgentTool 与 sub-agent 的区别**
- 当工具调用时，结果回到父 agent，由父 agent 继续回答用户。
- 当子 agent 时，回答用户的责任整体转给子 agent（[function-tools](https://adk.dev/tools-custom/function-tools/)）。

**共享 state**
- 用前缀区分作用域：无前缀为 session 级，`user:` 跨同一用户的所有 session，`app:` 全局，`temp:` 只在本次调用内（[state](https://adk.dev/sessions/state/)）。
- 并行分支 "Each agent only sees events from its own branch"（[collaboration](https://adk.dev/workflows/collaboration/)）。

**YAML Agent Config**
- 字段为 `name/model/description/instruction/tools/sub_agents/agent_class`。目前是实验性功能，只支持 Gemini（[config](https://adk.dev/agents/config/)）。

### 1.9 Anthropic：多 agent 研究系统与上下文工程

**多 agent 研究系统**（[multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system)）
- 效果：Opus 4 做 lead、Sonnet 4 做子 agent，比单个 Opus 4 高 **90.2%**。
- token 是主要变量：token 用量单独解释了 BrowseComp 上 80% 的方差。agent 约耗 chat 的 4 倍 token，多 agent 系统约 15 倍。
- **委派简报的四个要素**："objective, an output format, guidance on the tools and sources to use, and clear task boundaries"。
  - 反面例子：只说 "research the semiconductor shortage"，结果两个子 agent 重复劳动。
- **按复杂度分配投入**：
  - 简单任务：1 个 agent，3–10 次工具调用。
  - 比较类任务：2–4 个子 agent，每个 10–15 次。
  - 复杂研究：10 个以上子 agent。
- 子 agent 的产物可以直接写进文件系统，绕过 coordinator 转述。
- **不适合多 agent 的场景**："domains that require all agents to share the same context or involve many dependencies between agents"，多数编码任务属于这类。

**上下文工程**（[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）
- 子 agent 内部可能消耗数万 token，但只返回 1,000–2,000 token 的摘要。
- 三种手段各有适用场景：
  - compaction 适合长对话。
  - 结构化笔记（NOTES.md、memory tool）适合有里程碑的迭代。
  - 多 agent 适合能从并行探索中获益的研究。

**Building effective agents**（[building effective agents](https://www.anthropic.com/engineering/building-effective-agents)）
- orchestrator-workers 适合"子任务无法预先确定"的情况。
- 总原则："finding the simplest solution possible"。

### 1.10 Claude Code：subagents 与 agent teams

**Subagent 角色卡**（[sub-agents](https://code.claude.com/docs/en/sub-agents)）
- 必填字段只有 `name` 和 `description`。
- 可选字段：`tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`effort`、`isolation`、`color`、`initialPrompt`、`experimental`。
- 正文就是 system prompt。

**`memory` 字段：按角色持久化的记忆目录**

| scope | 目录 | 用途 |
|---|---|---|
| `user` | `~/.claude/agent-memory/<name>/` | 跨所有项目 |
| `project` | `.claude/agent-memory/<name>/` | 项目内，可提交进版本控制 |
| `local` | `.claude/agent-memory-local/<name>/` | 项目内，不入库 |

- 启用后，`MEMORY.md` 的前 200 行或前 25KB（取较小者）会注入 system prompt，同时附带"超限时自行整理"的指令（同上）。
- 【建议】ergou 可以直接照这个映射："角色经验跨项目"对应 user 级，"项目笔记"对应 project/local 级。

**嵌套与派生限制**
- 从 v2.1.219 起，"a subagent can spawn subagents of its own, up to three layers below the main conversation"，并发上限 20。
- `tools: Agent(worker, researcher)` 能限定可以派生哪些子 agent，但**只对以 `claude --agent` 运行的主线程 agent 生效**；写在 subagent 定义里时，括号中的类型列表会被忽略（同上）。

**Agent teams**（实验功能，需设 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，[agent-teams](https://code.claude.com/docs/en/agent-teams)）
- 架构有四部分：Team lead、Teammates、共享 Task list、Mailbox。
  - 每人的邮箱是 `~/.claude/teams/{team}/inboxes/{agent}.json`。
  - 任务列表在 `~/.claude/tasks/{team}/`，会话结束后保留。
- 任务：
  - 三种状态：pending、in progress、completed。
  - 有未完成依赖的任务不能被认领；前置任务完成后自动解锁下游。
  - "Task claiming uses file locking"。
- 通信：
  - teammate 停下时自动通知 lead，并附上最终答案。
  - 消息只能点名发给单人，广播要逐个发。
  - teammate 不继承 lead 的对话历史，只拿到 spawn prompt，加上 CLAUDE.md、MCP 和 skills。
- 质量门：`TeammateIdle`、`TaskCreated`、`TaskCompleted` 三个 hook 以 exit 2 退出，可以打回并附反馈。
- 角色复用：可以按 subagent 定义派 teammate，`tools`/`model` 会生效，但 **`skills` 不生效**。
- 安全：其他 agent 发来的消息被标为"来自另一个 Claude 会话"，teammate 不能替用户批准权限，也不能把被拒的操作转给别人去绕过。
- 官方建议的规模："Start with 3-5 teammates"，每人 5–6 个任务；"Three focused teammates often outperform five scattered ones"。
- 官方列出的限制：
  - in-process teammate 不能被 `/resume` 恢复。
  - 任务状态可能滞后。
  - 一个会话只能有一个团队。
  - 不能嵌套团队。
  - lead 固定不变。
  - 不能在 spawn 时逐个设置权限模式。
  - lead 会自己动手、会提前收工。
- 【建议】结论：agent teams 的**交互模型**（任务板 + 邮箱 + 完成钩子）值得照抄；它的**持久层**（绑定在单个会话上）不适合 ergou 这种跨天、可归档的项目组。

### 1.11 Kimi Agent Swarm

**K2.5**（[技术报告 arXiv 2602.02276](https://arxiv.org/html/2602.02276v1)、[博客](https://www.kimi.ai/blog/kimi-k2-5)）
- 规模："up to 100 sub-agents… up to 1,500 tool calls"，执行时间最多缩短 4.5 倍。
- orchestrator 动态创建子 agent，"without predefined roles"。
- **PARL** 训练方式：可训练的 orchestrator 加冻结的 subagent。奖励里有两项专门针对多 agent 的失败模式：
  - `r_parallel` 对抗 **serial collapse**，即有并行能力却退回串行执行。
  - `r_finish` 对抗 **spurious parallelism**，即乱开 agent 却没有真正拆分任务。
- 评估指标用 **Critical Steps**，即关键路径步数。

**后续版本**（[K2.6](https://www.kimi.ai/blog/kimi-k2-6)、[agent-swarm](https://www.kimi.ai/blog/agent-swarm)）
- K2.6 扩到 300 个子 agent，并推出 **Claw Groups**：接入来自不同设备、不同模型的 agent，每个都带 skills 和持久记忆。coordinator "matches tasks to agents based on their specific skill profiles and available tools"。
- 【建议】可以借来做秘书的"自动选角"。

### 1.12 Manus

**上下文工程**（[Manus 博客](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）
- KV-cache 命中率是 "single most important metric"。
- 保持 prompt 前缀稳定。
- 不可用的工具用 logits 屏蔽，不从列表里删除。
- 把文件系统当作外部记忆。
- 用 todo.md 复述目标，防止偏航。
- 把错误留在上下文里。

**Wide Research**（[博客](https://manus.im/blog/manus-wide-research-solve-context-problem)）
- 起因：单 agent 处理超过约 8–9 个条目后会开始编造。
- 做法：每个条目开一个完整实例，配独立 VM 和全新上下文。"Sub-agents do not communicate with each other, all coordination flows through the main controller"。

**【二手】2025-10 研讨会复盘**（[Lance Martin](https://rlancemartin.github.io/2025/10/15/manus/)）
- 刻意不按人类组织角色划分 agent。
- 子 agent 统一通过 "submit results" 工具加 schema 约束交付。

**近况**
- Manus 2.0 于 2026-09-28 发布；同期推出 Cue："Put several agents in a group chat with a shared goal, and they hand work to each other"（[Manus 2.0](https://manus.im/blog/introducing-manus-2-0)）。

### 1.13 Devin（Cognition）

**"Don't Build Multi-Agents"**（2025-06，[博客](https://cognition.com/blog/dont-build-multi-agents)）
- 原则一："Share context, and share full agent traces, not just individual messages"。
- 原则二："Actions carry implicit decisions, and conflicting decisions carry bad results"。
- 例子：做 Flappy Bird 时，两个子 agent 各自产出的东西风格冲突。

**"Multi-Agents: What's Actually Working"**（2026-04-22，[博客](https://cognition.com/blog/multi-agents-working)）
- 可行的模式：
  - 代码审查回路：reviewer 用独立上下文，效果反而更好。
  - "smart friend"：弱模型在难点上求助强模型。
  - manager 派 child。
- 不可行的模式：并行写代码的 swarm；无结构的 swarm（"mostly a distraction"）。

**"Devin can now Manage Devins"**（2026-03，[博客](https://cognition.com/blog/devin-can-now-manage-devins)）
- 协调者 "scopes the work, assigns each piece…, monitors progress, resolves any conflicts, and compiles the results"。
- 它可以中途给子 Devin 发消息、让其休眠或终止，查看 ACU 消耗。

**"Memory and dreaming"**（2026-10-05，[博客](https://devin.ai/blog/memory-and-dreaming)）
- 记忆存在 Git 仓库里，是 markdown 短笔记，每条链接回学到它的那个 session。
- 每天后台运行一次 "dreaming"：合并重复内容、删除临时细节、补出漏记的经验、删掉没被用过的旧记忆。
- 区分了 skills 和 memory："Skills capture a repeatable workflow; memory captures what Devin learns while working with you"。

### 1.14 OpenClaw（ergou 的前身）

**状态**
- 由 OpenClaw Foundation 运营（[repo](https://github.com/openclaw/openclaw)）。基于 pi 构建（[Mario 博客](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)）。

**多 agent 定义**（[multi-agent](https://docs.openclaw.ai/concepts/multi-agent)、[workspace](https://docs.openclaw.ai/concepts/agent-workspace)）
- 用 `agents.entries` 定义。每个 agent 有三部分：
  - workspace：放 AGENTS.md、SOUL.md、USER.md、MEMORY.md、`memory/YYYY-MM-DD.md` 等文件。
  - `agentDir`：认证信息和配置。官方警告 "never reuse agentDir across agents"。
  - session store。
- 每个 agent 可以配 `tools.allow/deny`、`sandbox`、`skills` 白名单。这些限制 "can only further restrict the global one"，只能比全局更严。

**子会话**（[subagents](https://docs.openclaw.ai/tools/subagents)、[nesting](https://docs.openclaw.ai/tools/subagents/nesting)）
- 用 `sessions_spawn`（参数 task/agentId/model/…）派生。
- 默认 `maxSpawnDepth` 为 5，每个会话最多 5 个活跃子会话。
- 结果逐层回传；取消一个节点会级联停止它的整棵子树。

**agent 间通信**（[session-tool](https://docs.openclaw.ai/concepts/session-tool)）
- 工具有 `sessions_send`（支持 `maxPingPongTurns`，以及 `REPLY_SKIP` 表示无需回复）和 `sessions_history`。
- 会话可见性**默认是 all**，用 `tools.agentToAgent` 收紧。
- 【建议】ergou 应把默认可见性改为"只看本项目"。

**记忆隔离**
- MEMORY.md 只在主私聊会话中加载，群聊里不加载（[workspace](https://docs.openclaw.ai/concepts/agent-workspace)）。

### 1.15 Hermes Agent（Nous Research）——最接近 ergou 的现成设计

**学习回路**（[skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)）
- 触发创建 skill 的时机：完成复杂任务后、从错误中找到可行路径后、被用户纠正后。由 `skill_manage` 执行 create 或 patch。
- `skills.write_approval` 可以让 agent 新建的 skill 先暂存进 `~/.hermes/pending/skills/`，等人审核。

**记忆**（[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)）
- `MEMORY.md` 上限 2,200 字符，`USER.md` 上限 1,375 字符。超限直接报错，不会静默截断。
- 会话开始时以 frozen snapshot 方式注入，目的是保护前缀缓存。

**Curator**（[curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)）
- 默认 14 天未用标记为 stale，30 天归档。
- 只归档不删除，可以回滚。

**委派**（[delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)）
- `delegate_task` 的参数有 goal、context、tasks、output_schema、role（leaf 或 orchestrator）。
- 子 agent "start with a completely fresh conversation"。
- **子 agent 被禁用的工具**：memory、clarify、send_message、cronjob。

**Kanban**（[kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)）
- 存储在 SQLite（`~/.hermes/kanban.db`）。状态流转为 `triage|todo|ready|running|blocked|review|done|archived`。
- dispatcher 每 60 秒回收过期的认领和崩溃的 worker，再把 ready 的任务派给对应 profile 去执行。
- 两类角色的工具：
  - worker 只有 `kanban_show/complete/block/heartbeat`。
  - orchestrator 用 `kanban_create(assignee, parents)` 拆分任务，**自己不执行实现工作**。
- 交接时附结构化证据：`changed_files/verification/dependencies/blocked_reason/retry_notes/residual_risk`。
- 限制：
  - 只支持单机。
  - **worker 看不到同级任务**，所以共享决策必须写进每张卡片。
  - 不同 board 之间不能互相引用依赖。
- 官方对比：Kanban 是持久队列，身份具名，审计记录永久保留；`delegate_task` 是 RPC，审计记录会随上下文压缩丢失。

**Bot Mode**（[bot-mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)）
- "a Bot **is** a Hermes profile — isolated config, memory, skills, credentials, and chat history"。
- UI 操作：用 New Agent 新建，右键选 Edit Profile 编辑头像、模型、skills、toolsets、MCP 和 SOUL.md。
- 群聊规则：
  - 每个房间 2–6 个 bot。
  - 每次用户发言最多 3 轮。
  - 每次最多 10 条消息。
  - 支持 @mention 和 @all。
  - "a Bot replies only when it has something new to add"。
- bot 之间私信用 `message_agent`。

**已知问题**
- skill 近似重复泛滥：一个实例里有 152 个 skill，其中 22 个是零使用的近似重复（[#67582](https://github.com/NousResearch/hermes-agent/issues/67582)）。
- agent 同时是 skill 的"作者、执行者和质检员"，缺少外部校验（[#25833](https://github.com/NousResearch/hermes-agent/issues/25833)）。
- 200 多个 skill 会让每次调用增加约 10–15K token（[#22620](https://github.com/NousResearch/hermes-agent/issues/22620)）。

### 1.16 pi（ergou 的底座）

**立场**
- pi 本体刻意 "skips features like sub-agents and plan mode"（[README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md)）。
- Mario 的批评（[博客](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)）：
  - Claude Code 的 subagent 是 "a black box within a black box"。
  - 主张在单独的会话里产出可观察的文件。
  - 认为并行实现功能 "is an anti-pattern"。

**官方 subagent 示例扩展**（[README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/README.md)）
- 每个子 agent 是一个独立的 `pi` 进程。
- 角色定义放在 `~/.pi/agent/agents/*.md`（用户级）或 `.pi/agents/*.md`（项目级，需显式授信）。frontmatter 为 `name/description/tools/model`。
- 三种模式：
  - single
  - parallel：最多 8 个，4 个并发
  - chain：用 `{previous}` 传上一步结果
- 每个并行任务回传给父 agent 的输出上限 50KB。

**扩展 API**（[extensions.md](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md)）
- `registerTool`。
- 事件 `pi.on('tool_call')`，返回 `{block:true}` 即可拦截调用，**可以拿来做按角色的权限门**。
- `appendEntry` 用来保存不进入上下文的持久数据。

**SDK 与持久化**
- SDK：`createAgentSession()`；`AgentSessionRuntime` 可以在一个进程里管理多个 session（[sdk.md](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/sdk.md)）。
- `pi-durable`（Experimental）提供 Conversation、Task（每一步存 checkpoint 的状态机）、Document，工具可以用 `control:{handoff}` 发起交接（[durable README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/durable/README.md)）。

**交叉参考**
- 调研 01（AgentSense）用的是 `@earendil-works/pi-agent-core` 的 `AgentHarness`，靠 `before_tool`/`after_tool`/`before_run_end` 三个 hook 实现拦截和催办。ergou 的角色权限门可以复用同一套 hook。

---

## 2. agent 间通信：A2A、黑板、任务板、邮箱、pub-sub

### 2.1 A2A（Agent2Agent）

**版本与治理**
- 当前是 **v1.0.0（2026-03-12）**，补丁 v1.0.1 于 2026-05-28 发布（[releases](https://github.com/a2aproject/A2A/releases)）。
- 2025-06 捐给 Linux Foundation（[Google 开源博客](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html)）。
- IBM 的 ACP 于 2025-08 并入 A2A（[讨论](https://github.com/orgs/i-am-bee/discussions/5)）。
- 一周年时有 150 多个支持组织，提供 5 个语言的 SDK（[LF 新闻稿](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)）。

**规范要点**（[spec](https://a2a-protocol.org/latest/specification/)）
- **Agent Card**：放在 `/.well-known/agent-card.json`。内容包括：
  - `capabilities`（streaming、pushNotifications 等）
  - `skills[]`，每个 skill 有 `id/name/description/tags/examples/inputModes/outputModes`
  - `supportedInterfaces`
  - `securitySchemes`
  - 可选签名
- **Task 的 8 个状态**：
  - 活跃：submitted、working
  - 中断：input_required、auth_required
  - 终态：completed、failed、canceled、**rejected**（agent 拒绝接这个任务）
- **Message**：带 `contextId`、`taskId`、`role`、`parts`。Part 四选一：text、raw、url、data。**Artifact** 是独立于消息的任务产出。
- 流式走 SSE，推送走 webhook；传输支持 JSON-RPC、gRPC、REST 三种 binding。

**与 MCP 的分工**
- "MCP is vertical. It deepens a single agent… A2A is horizontal"（[a2a-and-mcp](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)）。
- 两者边界在变模糊：MCP 2025-11-25 规范加入了实验性的 tasks（[changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)）。

**批评**
- Redis 工程博客提出一个"所有权测试"：agent 如果从不和别人拥有的 agent 对话，就用不着 A2A；在同一个信任边界内，"mostly adds overhead without benefit"。
- 同一篇还指出：A2A 不处理委托认证，消息 payload 里也不带用户身份（[Redis](https://redis.io/blog/when-does-a2a-protocol-matter/)）。

**【建议】对 ergou 的结论**
- 进程内不用 A2A 的 wire protocol。
- 但 Task 状态机、Artifact/Part、Agent Card 的 skills 字段照搬，作为内部 schema。
  - `REJECTED` 正好用来表达"超出职责"。
  - `INPUT_REQUIRED` 用来表达"需要澄清或升级"。

### 2.2 黑板（Blackboard）

**LbMAS**（[arXiv 2507.01701](https://arxiv.org/html/2507.01701)）
- 固定 5 个角色：Planner、Decider、Critic、Conflict-Resolver、Cleaner，另按需动态生成领域专家。由一个 control unit 每轮决定激活谁。
- 6 个基准上平均 81.68%，略高于 ChatEval 的 80.56%。
- 但 MATH 上只有 72.8，**低于单 agent CoT 的 76.4**。

**数据发现黑板**（[arXiv 2510.01285](https://arxiv.org/abs/2510.01285)）
- 中央 agent 把请求贴到黑板上，下属 agent **自愿认领**。
- 论文直接批评 master-slave 架构需要 "precise knowledge of each sub-agent's capabilities"。
- 端到端成功率相对提升 13%–57%。

**【建议】适用范围**
- 黑板适合"中央不清楚该派给谁"的场景。
- ergou 的项目看板其实就是一块轻量黑板：PM 发布任务，角色认领。

### 2.3 共享任务板 + 邮箱（Claude Code agent teams / Hermes Kanban）

两者的机制见 §1.10 和 §1.15。共同的要点：
1. 任务有依赖关系，认领时加锁，状态机清晰。
2. 定向消息走邮箱。
3. 完成或空闲时自动通知协调者，并附上结果。
4. 交接时附带结构化证据。
5. 在"创建 / 完成"节点挂可以否决的 hook，作为质量门。

两者共同的局限：worker 看不到同级任务，所以必须有一份共享的"决策记录"，或者把共享决策写进每张卡片（[kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)）。

### 2.4 pub-sub 与群聊

**pub-sub**
- MetaGPT 的 pub-sub 是：角色按消息类型订阅，交换的是结构化文档而不是闲聊（§1.2）。

**群聊的三种实现**
- AG2 的 GroupChat 是**广播**模式，每条消息所有成员都能看到。上下文会随人数线性膨胀（[AG2](https://docs.ag2.ai/0.8.6/docs/user-guide/advanced-concepts/conversation-patterns-deep-dive/)）。
- MAF 的 handoff 编排在广播前会过滤掉 tool 调用和 handoff 调用（[handoff](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- Hermes 的 Bot 群聊做法：
  - 有刹车：3 轮 / 10 条消息。
  - 用 @mention 定向。
  - "没有新东西就不说话"（[bot-mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)）。

### 2.5 拓扑实证：什么有效，什么无效

**MultiAgentBench**（[arXiv 2503.01935](https://arxiv.org/html/2503.01935)）
- research 场景里，graph 拓扑最好，star 接近 graph。**tree 最差**，而且 token 消耗还高。
- group discussion 在所有指标上都最差。
- agent 数从 1 增到 3 时协调效果变好；继续增加，总体 KPI 下降。

**MacNet**
- 不规则拓扑优于规则拓扑，性能随规模呈 logistic 增长（[arXiv 2406.07155](https://arxiv.org/abs/2406.07155)）。

**AgentVerse**
- 观察到 agent 的 conformity（从众）行为，也观察到 destructive behavior（[arXiv 2308.10848](https://arxiv.org/html/2308.10848)）。

**逐跳信息损失**
- 5 级 relay 让准确率从 90.7% 降到 22.5%，低于四选一的随机水平。注意这个实验里下游只能看到上一个 agent 的消息，看不到原题（[arXiv 2603.26993](https://arxiv.org/html/2603.26993)）。
- 强模型在 "faithful relay" 指令下，6 跳后 recall 仍不低于 0.973；但被注入的错误有 83–100% 会被原样传下去。结构化格式只能帮助定位错误，**不会纠错**（[arXiv 2607.09678](https://arxiv.org/abs/2607.09678)）。

**结论**

| 可靠 | 不可靠 |
|---|---|
| 星形或浅层（≤2 层）结构 | 自由网状闲聊 |
| 交换结构化产物 | 大规模讨论组 |
| 共享任务板 / 黑板 | 深层树 |
| 定向消息 | 多跳转述 |

---

## 3. 角色经验跨项目持久化

### 3.1 方法对比

| 方法 | 存什么 | 怎么提炼 | 怎么用 | 关键数字 | 主要坑 |
|---|---|---|---|---|---|
| AWM [2409.07429](https://arxiv.org/html/2409.07429) | workflow：描述 + 步骤，具体值抽象成变量（如 `{product-name}`） | 只用评估为成功的轨迹归纳（online），或离线批量归纳 | 注入 prompt | WebArena 35.5% vs 基线 23.5% | 错误的 workflow 会拖累效果；在 Claude-3.7 上反而低于无记忆（[ReasoningBank 复测](https://arxiv.org/html/2509.25140)） |
| Voyager [2305.16291](https://arxiv.org/html/2305.16291) | 可执行代码形式的 skill，用描述的 embedding 作 key | **自我验证成功后才入库** | top-5 检索 | 去掉自我验证后，发现的物品数降 73% | 依赖可验证的环境 |
| ExpeL [2308.10144](https://arxiv.org/html/2308.10144) | insight 加成功轨迹 | ADD/EDIT/UPVOTE/DOWNVOTE；计数降到 0 即删除 | insight 注入 prompt + 成功轨迹作 few-shot | ALFWorld 59% vs ReAct 40% | — |
| Reflexion [2303.11366](https://arxiv.org/abs/2303.11366) | 语言形式的反思，存 1–3 条 | 失败后反思 | 同一任务重试时使用 | HumanEval 91% | 只在单任务内有效，不跨任务 |
| ACE [2510.04618](https://arxiv.org/html/2510.04618) | playbook bullet，每条有 ID 和 helpful/harmful 计数 | Generator→Reflector→Curator 产出增量 delta，**由确定性代码合并** + embedding 去重 | 整份 playbook 注入 | AppWorld 42.4→59.4%；与 GEPA 相比适配延迟降 82.3% | brevity bias；整体重写会导致 context collapse；依赖强 Reflector |
| Dynamic Cheatsheet [2504.07952](https://arxiv.org/html/2504.07952) | 简短可迁移的策略和代码片段 | 作答后整理 | 检索后注入 | Game of 24：10%→99% | 小模型收益不稳定；错误条目会传播 |
| ReasoningBank [2509.25140](https://arxiv.org/html/2509.25140) | title/description/content 三段式策略 | **成功和失败都提炼**，用 LLM-as-judge 判定成败 | top-1 注入 | WebArena +7–8 个点；纳入失败经验后 46.5→49.7 | — |
| ChatDev ECL/IER | 按角色分池的 shortcut 经验 | 离线提炼，按信息增益和使用频率淘汰 | top-k 作 few-shot | 只留 11.54% 的经验反而更好 | cumulative 模式下命中率逐批下降 |
| G-Memory [2506.07398](https://arxiv.org/html/2506.07398) | interaction/query/insight 三层图 | 任务结束后三层同时更新 | **先按每个 agent 的角色评估效用，再定制下发** | ALFWorld 最多 +20.89% | — |
| Intrinsic Memory Agents [2508.08997](https://arxiv.org/html/2508.08997) | 每个 agent 一份**与角色对齐的 JSON 模板** | 由 agent 自己的输出更新 | 注入 | PDDL 上比次优方案高 15.5% | token 多约 32% |
| Collaborative Memory [2505.18279](https://arxiv.org/html/2505.18279) | private 和 shared 两层，每个片段带不可变的 provenance | 写入 shared 层时**去掉用户特定细节** | 按权限图过滤读取 | 资源调用最多减少 61% | — |
| Anthropic Agent Skills / [agentskills.io](https://agentskills.io/specification) | `SKILL.md`（name ≤64、description ≤1024）+ scripts/references/assets | 人写或 agent 写 | 三层渐进加载 | 正文建议 <5000 token | 数量多了会互相竞争（见 §5） |
| Hermes skills + curator | SKILL.md + `.usage.json` | 任务后自动创建，用 patch 局部改进 | 渐进加载 | 14 天 stale / 30 天归档 | 近似重复泛滥；缺少外部校验 |
| Devin Memory Drive | Git 仓库里的 md 短笔记，每条链接回来源 session | 每天 dreaming：合并、删除临时细节、删过期条目 | MEMORY.md 索引 | — | — |
| CrewAI Memory | 原子事实 + scope 路径 | 相似度 ≥0.85 时由 LLM 合并 | 语义 + 时间衰减 + 重要性综合打分 | 半衰期 30 天 | — |

### 3.2 失败模式（为什么不能"什么都存"）

**"全存"会让效果变差**（[arXiv 2505.16067](https://arxiv.org/html/2505.16067)）
- add-all 普遍比固定记忆还差。例如 RegAgent：55.48 vs 67.53。
- 原因是 **experience-following**：输入越相似，agent 越会照搬旧经验，错误就沿着检索结果传下去。
- 对策是 history-based deletion：被检索至少 n 次、但平均效用不高于 β 的条目删除。

**整体重写会塌缩**（[ACE](https://arxiv.org/html/2510.04618)）
- 一个 18,282 token 的 context 被 LLM 整体重写成 122 token，准确率从 66.7 跌到 57.1，低于不做适配的基线 63.7。

**投毒风险**
- MINJA 只靠正常查询交互，注入成功率就超过 95%（[arXiv 2503.03704](https://arxiv.org/abs/2503.03704)）。
- AgentPoison 投毒比例不到 0.1%，攻击成功率就超过 80%（[arXiv 2407.12784](https://arxiv.org/abs/2407.12784)）。
- OWASP Agentic Top 10 2026 把它列为 ASI06 "Memory & Context Poisoning"（[OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)）。

**近似重复与上下文膨胀**
- 见 §1.15 列出的 Hermes 三个 issue。

**项目隔离的产品先例**
- ChatGPT 的 project-only memory 规定：项目内的对话不能引用项目外的内容，反过来也一样（[OpenAI help](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)）。

### 3.3 防污染：让经验只属于角色，不夹带项目

【建议】由上面这些事实推出的规则：
1. **物理隔离**。`roles/<id>/experience/` 跨项目保留；`projects/<pid>/notes/` 随项目归档。可以参照 Claude Code `memory` 的 user 和 project 两级（[sub-agents](https://code.claude.com/docs/en/sub-agents)），也可以参照 CrewAI 的 scope 树（[memory](https://docs.crewai.com/en/concepts/memory)）。
2. **运行中，角色经验只读**。角色只能写项目笔记。角色经验只在"晋升"流程里写入。
3. **晋升时去项目化**。剥离项目里的具体实体、数值和人名，泛化成变量，做法同 AWM 的 `{var}` 和 Collaborative Memory 的 shared write policy。
4. **用户偏好不放在角色记忆里**。统一放在秘书的 USER 记忆中，委派时按领域切片注入简报，避免多份副本互相不一致。
5. **外部内容永远不直接进入角色经验**。网页、邮件、文件只能作为项目笔记里的证据，晋升前还要做注入扫描（Hermes 在 memory 写入前就有类似扫描，[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)）。
6. **每条经验带 provenance**：来源项目、来源任务、证据链接（指向归档轨迹）、模型版本、时间。这样可以按来源批量撤回，比如发现某个项目里的数据有毒时。
7. **按角色分池，并区分"派活经验"和"干活经验"**。依据是 ChatDev ECL 的 instructor/assistant 双池。PM 的经验是拆解模板、估时校准、哪种角色组合有效；执行角色的经验是领域手艺。

---

## 4. 角色边界的强制执行

### 4.1 硬约束：能力白名单

**Claude Code**（[sub-agents](https://code.claude.com/docs/en/sub-agents)、[hooks](https://code.claude.com/docs/en/hooks)）
- `tools` 是 allowlist，`disallowedTools` 是 denylist，两者都写时先应用 deny。
- PreToolUse hook 返回 exit 2 就阻断，也可以返回 `permissionDecision` 或用 `updatedInput` 改写参数。
- hook 的输入里有 `agent_id` 和 `agent_type`，所以**可以写一条全局策略，按角色鉴权**。
- 坑：主会话处于 bypassPermissions、acceptEdits 或 auto 模式时，子 agent 的 `permissionMode` 会被忽略；teammate 继承 lead 的权限模式。所以**不能指望权限模式来隔离角色**（[agent-teams](https://code.claude.com/docs/en/agent-teams)）。

**OpenAI Agents SDK**
- MCP 工具可以用 `create_static_tool_filter`，也可以动态过滤。动态过滤时 context 里带着 agent 本身，所以能按角色决定暴露哪些工具（[mcp](https://openai.github.io/openai-agents-python/mcp/)）。

**OpenClaw / Hermes**
- OpenClaw 的每个 agent 只能比全局更严（[multi-agent](https://docs.openclaw.ai/concepts/multi-agent)）。
- Hermes 的子 agent 默认拿不到 memory、send_message、clarify 等工具（[delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)）。

**pi**
- 扩展的 `tool_call` 事件返回 `{block:true}` 即可拦截（[extensions](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md)）。
- 【建议】更强的做法是**根本不给这个角色的 session 注册那些工具**。"看不到"比"看得到但被拦"更稳，也不会污染 KV-cache 前缀。Manus 主张用屏蔽代替删除，是为了在同一会话内动态切换工具；ergou 的角色 session 在启动时就固定了工具集，没有这个问题。

### 4.2 安全框架给出的分配原则

- **OWASP LLM06 Excessive Agency**：三个根因是功能过多、权限过大、自主性过高。缓解措施之一是"在下游系统做授权，不依赖 LLM 判断"（[OWASP](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)）。
- **OWASP Agentic Top 10（2025-12）**：ASI07 Insecure Inter-Agent Communication、ASI08 Cascading Failures、ASI10 Rogue Agents 和本设计直接相关（[OWASP](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)）。
- **Meta "Agents Rule of Two"**：同一个会话里，以下三项最多只能占两项，否则必须有人监督（[Meta](https://ai.meta.com/blog/practical-ai-agent-security/)）：
  - [A] 处理不可信输入
  - [B] 访问敏感数据
  - [C] 改变状态或对外通信
- **Simon Willison 的 lethal trifecta**：私有数据、不可信内容、对外通信三者同时具备即危险（[博客](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)）。
- **Google 的三原则**：要有明确的人类控制者；能力按用途限制，比如研究 agent 不应能改财务账户；行为可观测（[Google](https://research.google/pubs/an-introduction-to-googles-approach-for-secure-ai-agents/)）。
- 【建议】**角色恰好是落实 Rule of Two 的天然单位**：
  - "研究员"读不可信网页，但不碰私人数据、不对外发送。
  - "通讯助理"碰私人数据并对外发送，但不读不可信网页。网页内容只能由研究员整理成产物后转交。

### 4.3 软约束：越界时拒绝并升级

**现成机制**
- A2A 的 `REJECTED` 和 `INPUT_REQUIRED` 状态；ADK 的 `finish_task`；OpenAI 的 handoff 回上级（见 §1）。

**实证：角色漂移是真实存在的**
- MAST 中"违反角色规约"作为主因只占 1.5%，但"违反任务规约"占 11.8%，"不澄清"占 6.8%（[MAST](https://arxiv.org/html/2503.13657)）。
- 直接测量越权率时，数字高得多：ChatDev 的 CEO/CPO 角色在 Qwen-7B 上越权率 46.4%，在 Llama-8B 上 43.4%（[arXiv 2604.02770](https://arxiv.org/abs/2604.02770)）。
- "Role Drift"：负责拆题的模块偷偷把答案埋进去，这条捷径占了 RL 所谓"提升"的 86%，而端到端指标完全看不出来（[arXiv 2607.21627](https://arxiv.org/abs/2607.21627)）。
- 指令漂移：8 轮对话内，system prompt 的约束就会显著衰减（[arXiv 2402.10962](https://arxiv.org/abs/2402.10962)）。

**【建议】三层组合**
- **事前**：硬白名单，即 §4.1 的做法。
- **事中**：每个角色都有一个 `reject_out_of_scope(reason, suggested_role)` 工具和一个 `escalate(question)` 工具，状态对应 REJECTED 和 INPUT_REQUIRED，逐级上报给 PM、秘书，最后到用户。
- **事后**：在任务完成节点，用 LLM judge 对照角色卡审计"实际调用了哪些动作"。MAST 的 o1 judge 和人工标注的一致性 κ=0.77，说明可行。
- 角色实例要短命，每个任务开新实例，以避开 8 轮内的指令漂移。

---

## 5. 证据：多 agent 什么时候有帮助，什么时候有害

### 5.1 正面证据

- **Anthropic 研究系统**：比单 agent 高 90.2%，前提是任务以广度为主、可以并行（[Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)）。
- **Google scaling 研究**：可分解的金融推理任务上，Centralized 比单 agent 高 80.8%（[arXiv 2512.08296](https://arxiv.org/html/2512.08296)）。
- **Kimi K2.5**：BrowseComp 60.6→78.4，关键路径步数减少 3–4.5 倍（[arXiv 2602.02276](https://arxiv.org/html/2602.02276v1)）。
- **Cognition 的独立 reviewer**：平均每个 PR 抓到 2 个 bug，约 58% 是严重 bug（[Cognition](https://cognition.com/blog/multi-agents-working)）。
- **Manus Wide Research**：单 agent 处理超过约 8–9 个条目后开始编造，改为每个条目一个子 agent 后解决（[Manus](https://manus.im/blog/manus-wide-research-solve-context-problem)）。

### 5.2 负面证据与成本

**Google scaling 研究**（[arXiv 2512.08296](https://arxiv.org/html/2512.08296)）
- 顺序规划任务（PlanCraft）上，所有多 agent 架构都退化，最多 −70%。
- 单 agent 准确率超过约 45% 后，再加 agent 收益为负。
- 工具越多，多 agent 越吃亏（β=−0.096）。
- 各架构的 token 开销和效率：

| 架构 | 相对单 agent 的额外 token | 每 1K token 成功数 |
|---|---|---|
| 单 agent（SAS） | 0% | 67.7 |
| Independent | 58% | — |
| Decentralized | 263% | — |
| Centralized | 285% | 21.5 |
| Hybrid | 515% | 13.6 |

**底座变强后，多 agent 的增益缩水**（[arXiv 2505.18286](https://arxiv.org/html/2505.18286v1)）
- 换成更强的模型后，多 agent 相对单 agent 的增益从约 10% 降到约 3%。
- 多 agent 的 prefill token 是单 agent 的 4–220 倍。

**同等算力下单 agent 不输**
- 思考 token 预算相同时，单 agent 在多跳推理上持平甚至更好；以往多 agent 的优势很大程度来自多花的算力（[arXiv 2604.02460](https://arxiv.org/abs/2604.02460)）。
- 单 agent 配强 prompt，几乎追平最好的讨论式多 agent 框架（[arXiv 2402.18272](https://arxiv.org/abs/2402.18272)）。

**把多 agent 编译成单 agent + skills**（[arXiv 2601.04748](https://arxiv.org/html/2601.04748)）
- token 平均减少 53.7%，准确率基本不变。
- skill 选择准确率在库大小约 83–92 时出现相变。
- 每个 skill 只要有 1–2 个语义相近的竞争者，准确率就下降 7–63%。
- 分层路由能缓解：120 个 skill 时仍保持 72–85%。

**MAST 的失败分布**（[arXiv 2503.13657](https://arxiv.org/html/2503.13657)）
- 7 个系统的失败率在 41%–86.7% 之间。三类失败：
  - 系统设计类 43.7%，其中步骤重复 15.7%、不知何时终止 12.4%、违反任务规约 11.8%。
  - agent 间失配 32.2%，其中推理与行动不一致 13.2%。
  - 任务验证类 24.1%。
- 作者结论："topology-based changes are more effective than prompt-based changes"。

**失败难以归因**
- Who&When 基准上，最好的方法定位"哪个 agent 出错"准确率 53.5%，定位"哪一步出错"只有 14.2%（[arXiv 2505.00212](https://arxiv.org/abs/2505.00212)）。
- 所以日志必须结构化，并且按 agent 和 task 记录。

### 5.3 "只管不干"的 PM：开销与价值

**价值**
- 集中式验证把误差放大从 17.2 倍压到 4.4 倍（Google）。
- 有 ledger 和停滞检测时，去掉 ledger 会让性能下降 31%（Magentic-One）。
- 验证和终止判断针对的是 MAST 中 FC3 和 FM-1.5 两类失败。

**开销**
- 多一层转述，就多一次信息损失（LangChain 的 translation 问题；5 级 relay 降到 22.5%）。
- Centralized 架构多花约 285% 的 token。
- PM 会"手痒"自己动手：CrewAI #2838；Claude Code 文档也承认 lead 会自己做任务。

**【建议】让 PM 有价值、又不变成传话筒的做法**
1. PM 的工具只有：看板、邮箱、ledger、只读查看产物、向秘书汇报。从注册层面就不给执行类工具。
2. PM 的产出是结构化 ledger（照 Magentic-One 的格式），不是散文。
3. 执行角色的产物写进产物库，PM 和秘书只传引用，用户看到的是原件。
4. 验收尽量做成可执行的检查，比如测试、清单核对、schema 校验，而不是"LLM 读一遍说没问题"。
5. XS 级项目不实例化 PM，由秘书兼任，理由见 §7.7 的 D1。

### 5.4 粒度建议汇总

- **什么时候拆**：OpenAI 给的信号是"复杂分支逻辑"或"相互重叠的工具"。不到 10 个相互重叠的工具，就可能需要拆分（[OpenAI PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)）。
- **按复杂度定规模**：Anthropic 的档位是 1 / 2–4 / 10+ 个 agent（[Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)）。
- **团队规模**：
  - Claude Code 建议 3–5 个 teammate，每人 5–6 个任务（[agent-teams](https://code.claude.com/docs/en/agent-teams)）。
  - Hermes 群聊 2–6 个 bot（[bot-mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)）。
  - MultiAgentBench 中，超过 3 个 agent 后 KPI 下降（[arXiv 2503.01935](https://arxiv.org/html/2503.01935)）。
- **写操作单线程**（Cognition）；**强顺序依赖的任务不要拆**（Google、Anthropic）。
- **角色或 skill 数量**：控制在相变点以下，并避免语义重叠；数量多了就分层路由（[arXiv 2601.04748](https://arxiv.org/html/2601.04748)）。

---

## 6. 角色目录与用户自定义角色

### 6.1 现成的角色目录

**社区 subagent 合集**
- **VoltAgent/awesome-claude-code-subagents**：160 多个，分 10 类，包括 core-development、language-specialists、infrastructure、quality-security、data-ai、developer-experience、specialized-domains、business-product、meta-orchestration、research-analysis（[repo](https://github.com/VoltAgent/awesome-claude-code-subagents)）。
- **wshobson/agents**：约 200 个 agent，按 plugin 打包，模型按 opus/sonnet/haiku 分层（[repo](https://github.com/wshobson/agents)）。
- **msitarzewski/agency-agents（The Agency）**：230 多个，分 18 个以上部门，包括 Engineering、Design、Marketing、Sales、Product、Project Management、Testing、Support、Security、Finance（Bookkeeper、Tax Strategist）、Healthcare、Research、Academic 等（[repo](https://github.com/msitarzewski/agency-agents)）。
  - 正文有固定段落：Identity & Memory / Core Mission / Critical Rules / Deliverables / Workflow / Communication Style / Learning & Memory / Success Metrics（[示例](https://raw.githubusercontent.com/msitarzewski/agency-agents/main/engineering/engineering-frontend-developer.md)）。
- **contains-studio/agents**：37 个，分 engineering、product、marketing、design、project-management、studio-operations（含 finance-tracker、legal-compliance-checker）、testing（[repo](https://github.com/contains-studio/agents)）。

**框架内置角色**
- **MetaGPT**：ProductManager、Architect、ProjectManager、Engineer、QaEngineer、Researcher、Searcher、Teacher、Sales、CustomerService、DataAnalyst、TeamLeader 等（[roles](https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt/roles)）。
- **ChatDev**：CEO、CPO、CTO、Programmer、Code Reviewer、Software Test Engineer、Chief Creative Officer、Counselor、CHRO（[RoleConfig](https://raw.githubusercontent.com/OpenBMB/ChatDev/chatdev1.0/CompanyConfig/Default/RoleConfig.json)）。
- **CAMEL**：AI user + AI assistant + task specifier。观察到的失败模式有角色互换、复读指令、空头承诺、无限循环（[arXiv 2303.17760](https://arxiv.org/html/2303.17760)）。
- **CrewAI 示例**（[examples](https://github.com/crewAIInc/crewAI-examples)）：
  - 旅行：City Selection Expert / Local Expert / Travel Concierge（[trip_agents](https://raw.githubusercontent.com/crewAIInc/crewAI-examples/main/crews/trip_planner/trip_agents.py)）。
  - 股票分析：financial_analyst / research_analyst / investment_advisor。
  - 其他：会议准备、邮件自动回复、招聘等。

**个人助理类产品**
- **Gemini Gems**：预制的有 Learning coach、Career guide、Brainstormer、Coding partner、Writing editor（[Gems](https://support.google.com/gemini/answer/15235907?hl=en&co=GENIE.Platform%3DDesktop)）。
  - Gemini 正在迁到 `SKILL.md`，官方原话是 "when we remove Gems, we'll automatically recreate your Gems as skills"，并把能力分为 Task / Skill / Schedule 三块（[skills](https://support.google.com/gemini/answer/17094296?hl=en&co=GENIE.Platform%3DDesktop)）。
- **M365 Copilot 声明式 agent 1.8**：`EmailActions` 包括分拣、受监督发送、收件箱规则、自动回复；`MeetingActions` 包括排期和找时间投票。可以作为"通讯和日程"类角色的能力清单参考（[manifest 1.8](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8)）。
- **ChatGPT agent / Pulse**：配有浏览器、终端、Gmail 和日历连接器；Pulse 每晚做主动研究，次日推送卡片（[agent](https://openai.com/index/introducing-chatgpt-agent/)、[Pulse](https://openai.com/index/introducing-chatgpt-pulse/)）。

### 6.2 角色定义格式与规范

| 格式 | 字段要点 | 来源 |
|---|---|---|
| Claude Code subagent `.md` | 见 §1.10，含 `memory`、`hooks`、`skills` | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| pi subagent 示例 `.md` | `name/description/tools/model` | [pi](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/README.md) |
| CrewAI JSONC/YAML | `role/goal/backstory/tools/llm/allow_delegation` | [agents](https://docs.crewai.com/en/concepts/agents) |
| OpenClaw workspace | AGENTS.md、SOUL.md、IDENTITY.md、USER.md、MEMORY.md，加上 `agents.entries` 配置 | [workspace](https://docs.openclaw.ai/concepts/agent-workspace) |
| Hermes profile | SOUL.md + skills + toolsets + model + memory | [bot-mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode) |
| A2A Agent Card | `skills[]`：`id/name/description/tags/examples/inputModes/outputModes` | [spec](https://a2a-protocol.org/latest/specification/) |
| Oracle Agent Spec | `name/description/system_prompt/llm_config/tools/inputs/outputs`；memory 不在当前范围内 | [arXiv 2510.04173](https://arxiv.org/html/2510.04173) |
| M365 声明式 agent | JSON 格式：instructions 不超过 8,000 字符，conversation_starters 不超过 12 条，`worker_agents` 处于预览 | [manifest](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8) |
| ADK Agent Config | YAML，实验性 | [config](https://adk.dev/agents/config/) |
| Letta `.af` | 模型、消息、memory blocks、tool rules、工具源码 | [agent-file](https://github.com/letta-ai/agent-file) |
| agentskills.io `SKILL.md` | `name/description/license/compatibility/metadata/allowed-tools` | [spec](https://agentskills.io/specification) |

### 6.3 让用户新增角色的方式

- **从模板复制**：Gemini 的 "Make a copy"；Hermes 的 New Agent 加 "clone from existing profiles"（[bot-mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)）。
- **由协调者动态生成**：AgentVerse 按任务招募专家（[arXiv 2308.10848](https://arxiv.org/abs/2308.10848)）；Kimi 的 orchestrator 也是动态生成角色。
- **按能力画像匹配**：Kimi Claw Groups 根据 skill profile 和可用工具把任务派给合适的 agent（[K2.6](https://www.kimi.ai/blog/kimi-k2-6)）。

---

## 7. 综合：给 ergou 的推荐架构

> 本节都是【建议】，依据见 §1–§6 中引用的事实。

### 7.1 架构草图

```
                         用户
                          │ (唯一的对话入口；也可以直接打开项目看板查看原件)
                          ▼
┌──────────────────────── 秘书 Secretary（主 agent，长驻）────────────────────────┐
│ 持有：用户对话 · USER/偏好记忆 · 项目注册表 · 角色注册表 · 选角经验（staffing playbook） │
│ 工具：project_create/close · staff(role, n) · brief(task) · ask_user · board_view     │
│       artifact_forward(原样转发) · role_propose(草拟新角色卡) · approve_queue           │
│ 不做领域工作：没有 web/代码/邮件等执行类工具（硬白名单）                                 │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ agent-as-tool：秘书始终持有用户对话；角色不直接面对用户
               ▼
┌──────────────────────── 项目组 Project P（有生命周期）─────────────────────────┐
│  PM 实例 (role=project-manager)                                                 │
│    工具：board.* · mailbox.send · ledger.* · artifact.read · report_to_secretary    │
│    职责：拆解 → 派单 → 跟踪（Progress Ledger）→ 验收 → 汇报；不产出交付物           │
│         ▲ 认领/完成/阻塞/拒绝                                                     │
│  ┌──────┴───────┐ ┌───────────┐ ┌────────────┐ ┌────────────┐                     │
│  │ researcher#1 │ │ writer#1  │ │ reviewer#1 │ │ ...        │  角色实例：每任务开新实例 │
│  └──────────────┘ └───────────┘ └────────────┘ └────────────┘  角色经验只读注入        │
│                                                                                │
│  共享层：Board（任务+依赖+状态+认领锁） · Mailbox（定向） · Channel（群聊日志，带刹车）  │
│          Artifacts（产物，单写者） · decisions.md（全员必读） · ledger.md · notes/      │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │ project_close
               ▼
   ① 归档：projects/P → archive/P（只读，可检索，保留完整轨迹作为证据）
   ② 蒸馏：每个参与角色 Reflector → 候选 delta → Curator（确定性合并/去重/去项目化/注入扫描）
           → 质量门 → roles/<id>/experience（候选 → 转正）
   ③ 秘书自己的经验：这类项目该配哪些角色、实际花了多少（staffing playbook）
```

### 7.2 存储布局（文件优先，git 版本化）

```
~/.ergou/
  secretary/
    USER.md               # 用户画像与偏好（唯一事实源）
    MEMORY.md             # 秘书自己的工作记忆
    staffing-playbook.md  # 选角经验：项目类型 → 角色组合、规模、成本
  roles/<role-id>/
    role.md               # 角色卡（frontmatter + 正文），版本化
    experience/
      MEMORY.md           # 索引，≤200 行，启动时注入
      playbook.md         # ACE 式 bullet，带 id、计数、来源
      candidates.jsonl    # 待审的候选经验
    skills/<skill>/SKILL.md   # 程序性经验（agentskills.io 兼容）
    evals/                # 越界测试和能力测试用例
  projects/<pid>/
    project.yaml          # 状态、成员（角色与实例）、预算、规模档位
    board.sqlite          # 任务、依赖、认领、状态（或并入全局 db）
    channel.jsonl         # 群聊日志（append-only）
    mailbox/<agent>.jsonl
    artifacts/            # 交付物（每个产物一个 owner）
    decisions.md          # 已拍板的决定（全员 brief 自动附带）
    ledger.md             # PM 的 Task Ledger / Progress Ledger
    notes/<role>/         # 项目内笔记（项目作用域）
  archive/<pid>/          # 只读
```

### 7.3 角色卡 schema（兼容 Claude Code 和 pi 的 frontmatter，另加扩展字段）

```markdown
---
name: researcher                 # kebab-case，作为唯一 id
display_name: 研究员
description: 需要查资料、比较方案、核实事实时委派。只读外部信息，不对外发送任何内容。  # 写清"何时委派"，≤1024 字符
version: 3
origin: builtin                  # builtin | user | template:<id> | proposed:<project-id>
domain:
  in_scope: [网络检索, 资料比对, 事实核查, 引用整理]
  out_of_scope: [发送邮件或消息, 修改用户文件, 下单或支付, 写代码]
  escalate_to: pm                # 越界请求一律退回 PM，用 reject_out_of_scope 工具
tools: [web_search, web_fetch, artifact_write, board_update, mailbox_send, reject_out_of_scope, escalate]
disallowedTools: [bash, email_send, calendar_write]
risk:                            # 按 Rule of Two 自检，三项至多占两项
  untrusted_input: true
  private_data: false
  external_comm: false
model: sonnet
max_turns: 40
output_schema: research_report_v1   # 交付必须符合 schema（参考 Manus 的 submit results）
skills: [source-evaluation, citation-format]
memory:
  scope: role                    # 跨项目
  inject: index+topk(3)
  promote: review                # auto | review
  decay_days: 90
conversation_starters: [...]     # 给 UI 用（参考 M365，≤12 条）
---
# Mission
# Rules（包括"遇到越界请求怎么办"）
# Workflow
# Deliverables（与 output_schema 对应）
# Success metrics
```

经验条目的格式（参考 ACE、ExpeL 和 provenance 设计）：

```yaml
- id: rsch-0042
  section: PITFALLS              # STRATEGIES | PITFALLS | TOOL_USAGE | CHECKLIST
  content: "比较 SaaS 定价时，先确认是否含税、按年还是按月计费；官网首页价格常是年付折算价"
  helpful: 5
  harmful: 0
  status: active                 # candidate | active | stale | quarantined | archived
  provenance:
    projects: [p-2026-031, p-2026-044]
    evidence: [archive/p-2026-031/trace.jsonl#t17]
    created: 2026-08-02
    last_used: 2026-09-30
    model: <model-id>
```

### 7.4 项目生命周期

1. **立项**：秘书判断规模档位（见 D1）。按 staffing-playbook 和角色的 description 选角；没有合适角色时走 §7.6 的新增流程。然后建项目目录，写 `project.yaml`。
2. **简报**：秘书写给 PM，PM 写给各角色，都用固定模板。内容包括：
   - 用户原话（逐字）
   - 目标
   - 输出格式或 schema
   - 可用的工具和信息来源
   - 边界（做什么、不做什么）
   - 相关的 decisions.md
   - 验收标准
   
   这个模板来自 Anthropic 的四要素，加上 MetaGPT 的 "sole info source" 原则。
3. **执行**：
   - PM 把任务写上看板，角色认领。
   - 产物写入 artifacts，每个产物只有一个写者，可以并行的只有只读类工作。
   - 遇到阻塞写 `blocked_reason`；越界调用 `reject_out_of_scope`。
   - PM 每一步更新 Progress Ledger，停滞计数超过阈值就重新规划或上报秘书。
4. **质量门**：在 TaskCompleted 节点运行可执行检查和角色合规审计（LLM judge），不通过就打回。
5. **汇报**：PM 给秘书的汇报只含状态、风险、需要用户决定的事项和产物引用。秘书把产物**原样**转给用户。
6. **结项**：由用户确认，或由 PM 提议、秘书确认。之后依次归档、蒸馏（§7.5）、写秘书的 staffing 经验、释放实例。

### 7.5 经验蒸馏流水线

1. **运行中**：角色只读自己的角色经验，只写 `notes/<role>/`。笔记里写明 task id 和证据。
2. **任务结束**：记录结果信号：成功、失败、被用户纠正、验收被打回几次。
3. **项目关闭**：对每个参与的角色运行 Reflector，输入是该角色本项目的轨迹、结果信号和用户反馈。输出是 delta 操作：`ADD/EDIT/UPVOTE/DOWNVOTE`。失败的教训也要收，但要改写成预防性策略（ReasoningBank）。
4. **Curator（确定性代码，不让 LLM 整体重写）**：
   - embedding 去重
   - 去项目化（实体和数值变成变量）
   - 注入和外泄模式扫描
   - 附上 provenance
5. **质量门**：
   - 没有结果信号的不入库。
   - 新条目一律先标 `candidate`。
   - 转为 `active` 有两条路：用户在 UI 里批准；或在后续项目中被检索使用、且 helpful 达到 k 次而 harmful 为 0。
   - 程序性经验另走 skill 草案流程：先放进 `pending/skills/`，在隔离环境复现验证，再由人工批准（Voyager、Hermes write_approval）。
6. **定期整理（"dreaming" 或 curator，每周一次）**：
   - 合并近似重复
   - 长期未用的标记为 stale，之后归档
   - 多次检索但平均效用低的进 quarantine
   - 索引超限时压缩索引，正文不动
   - 每次变更做一次 git commit，可以回滚

### 7.6 新增角色

- **触发**：秘书发现没有哪个角色的 description 和 skills 匹配当前需求；或者某个角色频繁 `reject_out_of_scope` 并建议同一个"不存在的角色"；或者用户在 UI 里手动新建。
- **流程**：
  1. 秘书起草角色卡，参照最接近的模板和社区目录。
  2. 系统自动检查 Rule of Two、工具重叠度，以及 description 与现有角色的语义相似度（防止近似重复的角色）。
  3. 用户在 UI 里审批。
  4. 在一个试用项目中运行，同时跑 `evals/` 里的越界用例。
  5. 转正。
- **新角色的经验从空白开始**。如果是从已有角色 fork 出来的，只复制 `active` 状态且 harmful 不超过 helpful 的条目，不复制原始轨迹。

### 7.7 需要你拍板的关键决策

| # | 决策 | 选项 | 建议 | 理由与取舍 |
|---|---|---|---|---|
| D1 | 小项目是否强制配 PM | a. 每个项目都实例化 PM；b. 分档：XS 由秘书兼任 PM，S 以上实例化 PM；c. PM 用代码实现，必要时才调 LLM | **b**：数据模型上每个项目都有 PM 席位和 ledger，XS 档由秘书填这个席位 | MetaGPT 的 TeamLeader 把 XS/S 直接派给 Engineer；Centralized 架构多花约 285% token；单 agent 准确率超过 45% 后多 agent 收益为负。代价是秘书在 XS 档要临时兼做 PM，需要把它的 PM 行为也约束住 |
| D2 | 秘书与角色的关系 | agent-as-tool 或 handoff | **agent-as-tool**；角色需要问用户时，通过 escalate 交给秘书转问 | 秘书要一直持有用户对话（OpenAI Manager 模式）。代价是秘书多一跳，所以要求产物原样转发 |
| D3 | 项目组通信骨架 | 广播群聊 / 星形加看板 / 网状 | **看板 + 邮箱 + 群聊日志（带刹车）**；点对点消息允许但要记日志、限次数 | 星形和浅层结构可靠，大讨论组最差。可参考 Hermes 的 3 轮 / 10 条，以及 OpenClaw 的 `maxPingPongTurns` |
| D4 | 执行模型 | 同步 RPC（delegate）或持久队列（Kanban） | **持久队列**，SQLite 加状态机 | 项目会持续数天，需要能恢复、能审计。Claude Code agent teams 不能 resume 正是反面例子 |
| D5 | 角色粒度 | 按职位头衔 / 按能力和权限边界 | **按能力和权限边界**；persona 只是外观 | Manus 的经验；Rule of Two；语义重叠会导致选错角色 |
| D6 | 同一角色在一个项目里能否多开 | 能 / 不能 | **只读类角色能**（如 3 个研究员并行）；写类角色每个产物只能有一个 | Cognition 的"写操作单线程" |
| D7 | 角色实例的生命周期 | 每任务开新实例 / 项目内常驻 / 跨项目常驻 | **每任务开新实例**，必要时在项目内复用；不跨项目 | 规避指令漂移，隔离上下文。经验靠角色经验库传承，不靠会话 |
| D8 | 经验何时写、谁批准 | 实时写 / 结项时蒸馏 / 定期整理 | **运行中只写项目笔记；结项时蒸馏成候选；转正靠人工或使用数据；每周整理一次** | 全存会变差；整体重写会塌缩；存在投毒风险 |
| D9 | 经验的载体 | 向量库 / markdown 文件 / skills | **markdown 加 frontmatter，放进 git**；skills 承载程序性经验；向量索引只是加速层 | 可读、可审、可回滚；兼容 Claude Code、pi 和 agentskills.io |
| D10 | 用户偏好放在哪里 | 每个角色各存一份 / 秘书统一存 | **秘书统一存**，委派时按领域切片注入 | 唯一事实源，防止多份副本互相矛盾，也减少隐私扩散 |
| D11 | PM 能否直接和用户对话 | 能 / 不能 | **不能**，经秘书转达；但用户可以只读查看项目看板和产物原件 | 保持秘书是唯一入口；看板只读查看补偿了转述损耗 |
| D12 | 内部是否采用 A2A | 采用协议 / 只借用 schema | **只借用 schema** | 同一信任边界内用 A2A 只增加开销 |
| D13 | 越界的处理 | 只靠 prompt / 硬拦截 / 硬拦截加审计 | **硬白名单 + `reject_out_of_scope` + 完成时 LLM judge 审计** | prompt 约束会失效；越权率可达 43–46%；角色漂移在端到端指标上看不出来 |
| D14 | 每个角色用什么模型 | 统一 / 按角色 | **按角色**：秘书和 PM 用强模型；只读类执行角色可以用便宜模型 | Anthropic 的 lead 用 Opus、子 agent 用 Sonnet；token 是主要成本 |
| D15 | 预算和上限 | — | 每个项目设 token 或金额上限；嵌套深度 ≤2（秘书→PM→角色）；每组 ≤5 个实例；单任务 maxTurns | MetaGPT 的 invest 机制、Claude Code 的 maxBudgetUsd、agent teams 的规模建议 |

### 7.8 起步角色目录（个人助理场景）

**v1 核心六个**：先把这 6 个做稳，再按需扩展。

| 角色 | 领域（做 / 不做） | 工具（示意） | Rule of Two 画像 | 主要经验类型 |
|---|---|---|---|---|
| project-manager 项目经理 | 拆解、派单、跟踪、验收、汇报 / 不产出交付物 | board.*、mailbox、ledger、artifact.read、report | 无 A、无 B、无 C | 拆解模板、估时校准、阻塞模式、角色组合效果 |
| researcher 研究员 | 检索、比对、核实、引用 / 不对外发送、不碰私人数据 | web_search、web_fetch、artifact_write | A | 信息源可信度、检索策略、常见陷阱 |
| writer 写作编辑 | 起草、改写、排版、翻译 / 不发布、不发送 | artifact_rw、read 研究产物 | 无（只读项目内产物） | 用户文风（来自秘书切片）、体裁模板 |
| reviewer 审校 / QA | 用独立上下文审查产物、跑检查 / 不修改产物 | artifact.read、run_checks | 依审查对象而定 | 检查清单、常见缺陷 |
| engineer 工程师 | 写代码和脚本，在沙箱或 worktree 中运行 / 不碰生产环境、不对外通信 | fs（限定在项目目录）、bash（沙箱内） | C（仅限沙箱） | 代码模式、调试经验 |
| comms-admin 通讯与日程助理 | 起草邮件和消息、排日程、整理收件箱 / **不读不可信网页**；发送必须经用户确认 | email_draft、email_send（需确认）、calendar_rw、contacts.read | B + C，所以不能有 A | 用户沟通习惯、联系人上下文 |

**扩展角色**：按需新增。

| 角色 | 要点 |
|---|---|
| data-analyst 数据分析师 | Python 沙箱、表格和图表；只读用户数据，在沙箱内计算 |
| finance-clerk 记账 / 财务助理 | 读账单和流水、分类、出报表；**不支付、不转账**；涉及资金的操作必须人工确认 |
| travel-planner 出行规划 | 搜索、比价、做行程；**不下单**，预订交给 comms-admin 或经用户确认 |
| shopping-scout 采购比价 | 同上，只出比较报告 |
| tutor 学习教练 | 讲解、出题；参考 Gemini 的 Learning coach |
| ops 运维 | 只在指定主机上执行限定命令，高风险，默认需要确认 |
| designer 设计 | 生成图像、版式、原型；只读品牌素材 |
| health-coach 健康 / 生活 | 只给建议，不做诊断；隐私等级最高 |

**说明**
- 秘书不是目录里的角色，它是常驻的主 agent。
- reviewer 可以是一个通用审校角色，也可以按领域拆分。【推测】早期用一个就够了。
- 角色总数长期也应保持在几十个以内，并用分类做分层路由，以避开选择准确率的相变点。

### 7.9 UI 需求

- **角色管理**：
  - 角色卡编辑器，包括 frontmatter 表单和正文。
  - 工具选择器，自动提示 Rule of Two 冲突。
  - skills 挂载。
  - 经验浏览器：按 section、status 筛选，显示 provenance，可以点进归档轨迹查看证据。
  - **候选经验审批队列**和 skill 草案审批队列。
  - 版本历史与回滚。
  - eval 运行结果。
- **项目管理**：
  - 新建、暂停、结项、归档。
  - 看板视图。
  - 群聊视图，按 @ 过滤。
  - 产物视图（原件）。
  - ledger 和决策日志。
  - 成本面板。
  - 结项时显示蒸馏预览：这次会给哪些角色带来哪些新经验，可以逐条勾选。
- **新角色向导**：
  - 三种起点：从模板复制、从现有角色 fork、由秘书起草。
  - 显示相似度检查和工具重叠检查的结果。
  - 支持试运行。

### 7.10 开放问题

1. **项目的边界怎么定**：用户的一句话需求，什么时候值得立项，什么时候由秘书直接做？需要一个规模判定器，并在实践中校准（staffing-playbook）。
2. **长期项目的中途变更**：用户中途改需求时，decisions.md 和看板怎么做版本化？已经完成的任务要不要回滚？
3. **跨项目共享的"通用经验"层要不要做**：比如"用户讨厌长报告"这类，应该放在秘书的 USER.md 里，还是放在一个 shared playbook 里？【建议】先只放 USER.md，不做 shared 层。
4. **结果信号从哪里来**：个人助理的很多任务没有客观的对错（比如写作、规划）。需要设计轻量的用户反馈入口，比如 👍、👎、修改 diff；也可以让 reviewer 的结论充当信号。
5. **秘书兼任 PM 时的约束**：XS 档里秘书临时承担 PM 职责，它的工具集要不要临时变化？会不会让秘书"手痒"去动手？
6. **并发与成本上限的具体数值**：需要用实际任务做基准测试。可以参考 Kimi 的 Critical Steps 来衡量并行带来的价值。
7. **离线和多设备**：Hermes Kanban 只支持单机；如果将来要跨设备，再考虑用 A2A 适配层。
8. **模型的变化**：经验条目会和模型版本绑定。换模型后，旧经验是否还有效？需要按 `model` 字段做抽样复验。

---

## 8. 来源索引（按主题）

**框架与产品**
- MetaGPT：https://arxiv.org/html/2308.00352v7 · https://github.com/FoundationAgents/MetaGPT · https://atoms.dev/mgx-is-now-atoms
- ChatDev / ECL / IER / MacNet：https://arxiv.org/html/2307.07924v5 · https://arxiv.org/html/2312.17025 · https://arxiv.org/html/2405.04219 · https://arxiv.org/abs/2406.07155 · https://github.com/OpenBMB/ChatDev
- CrewAI：https://docs.crewai.com/en/concepts/agents · https://docs.crewai.com/en/concepts/processes · https://docs.crewai.com/en/concepts/memory · https://github.com/crewAIInc/crewAI/issues/2838
- AG2 / AutoGen / Magentic-One / MAF：https://docs.ag2.ai/ · https://github.com/microsoft/autogen · https://arxiv.org/html/2411.04468 · https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview · https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/
- LangGraph / LangChain：https://raw.githubusercontent.com/langchain-ai/langgraph-supervisor-py/main/README.md · https://www.langchain.com/blog/benchmarking-multi-agent-architectures · https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture · https://docs.langchain.com/oss/python/deepagents/subagents
- OpenAI：https://openai.github.io/openai-agents-python/handoffs/ · https://openai.github.io/openai-agents-python/multi_agent/ · https://openai.github.io/openai-agents-python/guardrails/ · https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- Google ADK：https://adk.dev/2.0/ · https://adk.dev/workflows/collaboration/ · https://adk.dev/sessions/state/ · https://adk.dev/agents/config/
- Anthropic：https://www.anthropic.com/engineering/multi-agent-research-system · https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents · https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude Code：https://code.claude.com/docs/en/sub-agents · https://code.claude.com/docs/en/agent-teams · https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/memory · https://code.claude.com/docs/en/agent-sdk/subagents
- Kimi：https://arxiv.org/html/2602.02276v1 · https://www.kimi.ai/blog/agent-swarm · https://www.kimi.ai/blog/kimi-k2-6
- Manus：https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus · https://manus.im/blog/manus-wide-research-solve-context-problem · https://manus.im/blog/introducing-manus-2-0 · 【二手】https://rlancemartin.github.io/2025/10/15/manus/
- Cognition / Devin：https://cognition.com/blog/dont-build-multi-agents · https://cognition.com/blog/multi-agents-working · https://cognition.com/blog/devin-can-now-manage-devins · https://devin.ai/blog/memory-and-dreaming
- OpenClaw：https://docs.openclaw.ai/concepts/multi-agent · https://docs.openclaw.ai/tools/subagents · https://docs.openclaw.ai/concepts/session-tool · https://docs.openclaw.ai/concepts/agent-workspace
- Hermes Agent：https://github.com/NousResearch/hermes-agent · https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban · https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode · https://hermes-agent.nousresearch.com/docs/user-guide/features/skills · https://hermes-agent.nousresearch.com/docs/user-guide/features/curator · https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- pi：https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md · https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/README.md · https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md · https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ · https://mariozechner.at/posts/2026-04-08-ive-sold-out/

**通信**
- A2A：https://a2a-protocol.org/latest/specification/ · https://github.com/a2aproject/A2A/releases · https://a2a-protocol.org/latest/topics/a2a-and-mcp/ · https://redis.io/blog/when-does-a2a-protocol-matter/
- 黑板：https://arxiv.org/html/2507.01701 · https://arxiv.org/abs/2510.01285
- 拓扑：https://arxiv.org/html/2503.01935 · https://arxiv.org/html/2308.10848 · https://arxiv.org/abs/2402.16823 · https://arxiv.org/abs/2410.11905

**实证与失败**
- MAST：https://arxiv.org/html/2503.13657
- Scaling：https://arxiv.org/html/2512.08296
- 单 agent 对比与 skills：https://arxiv.org/html/2601.04748 · https://arxiv.org/html/2505.18286v1 · https://arxiv.org/abs/2604.02460 · https://arxiv.org/abs/2402.18272
- 转述损失：https://arxiv.org/html/2603.26993 · https://arxiv.org/abs/2607.09678
- 失败归因：https://arxiv.org/abs/2505.00212
- 角色漂移：https://arxiv.org/abs/2604.02770 · https://arxiv.org/abs/2607.21627 · https://arxiv.org/abs/2402.10962

**经验与记忆**
- 经验类方法：https://arxiv.org/html/2409.07429 · https://arxiv.org/html/2305.16291 · https://arxiv.org/html/2308.10144 · https://arxiv.org/abs/2303.11366 · https://arxiv.org/html/2510.04618 · https://arxiv.org/html/2504.07952 · https://arxiv.org/html/2509.25140
- 多 agent 与协作记忆：https://arxiv.org/html/2506.07398 · https://arxiv.org/html/2508.08997 · https://arxiv.org/html/2505.18279
- 记忆管理与投毒：https://arxiv.org/html/2505.16067 · https://arxiv.org/abs/2503.03704 · https://arxiv.org/abs/2407.12784
- 规范与平台：https://agentskills.io/specification · https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://docs.letta.com/guides/agents/memory-blocks

**安全**
- https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ · https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ · https://ai.meta.com/blog/practical-ai-agent-security/ · https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ · https://research.google/pubs/an-introduction-to-googles-approach-for-secure-ai-agents/

**角色目录**
- https://github.com/VoltAgent/awesome-claude-code-subagents · https://github.com/wshobson/agents · https://github.com/msitarzewski/agency-agents · https://github.com/contains-studio/agents · https://github.com/crewAIInc/crewAI-examples · https://support.google.com/gemini/answer/15235907 · https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8 · https://arxiv.org/html/2510.04173
