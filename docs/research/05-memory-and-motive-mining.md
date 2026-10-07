# 05 · 记忆系统与动机挖掘(Memory & Motive Mining)调研

- 调研日期:2026-10-06(优先取 2025–2026 的现状)
- 范围:agent 记忆系统现状、LLM 用户建模与隐性意图、可操作化的动机心理学、风险与业界指南、指令时如何使用用户模型、ergou 的分层记忆架构建议与评估方法。
- 方法:只用一手来源(论文、官方文档与帮助中心、GitHub 源码/README、第一方工程博客)。四路并行子调研 + 主调研交叉核对,几条关键事实(OpenClaw `USER.md`、OpenClaw 运行时、pi 仓库与扩展点)做了二次抽查。
- 核实说明:本会话的 WebSearch 额度在中途用完,部分条目只核到 arXiv 摘要页或检索摘要。凡未能读到原文的都标 **未核实**;2026 年的 arXiv 论文多数仍是预印本。厂商自报的基准数字一律视为"厂商自报"。
- 术语对齐:与用户已有的 `intent-mining` 方法保持一致——L1 表象 / L2 动机·情境 / L3 真实需求 / L4 内核、置信天花板、判别性追问、对抗复核、表象覆盖率。映射见附录 B。

---

## 0. 结论速览

1. **现有记忆系统基本都只存"事实 + 偏好",没有一个把"动机"当作有证据、有置信度、有竞争假设的一等对象。** 最接近的是 Zep(user summary 里有 values/goals)、MemoryOS(Big Five + 需求维度)、Second Me(Global Bio 推断性格)。但它们的用户模型都是 LLM 重写的文本,没有证据链,也没有置信度。OpenClaw 的 `USER.md` 明确写着 "Do not turn the file into a dossier",上限 4,000 字符,只放祈使句偏好(https://github.com/openclaw/openclaw/blob/main/docs/concepts/user-model.md )。
2. **2025–2026 年出现了和 ergou 论点直接对标的研究原型**:GUM(命题带置信度和衰减,有 Revise 和隐私 Audit)、Behavior Latticing(观察 → 单会话洞察 → 跨会话洞察 → 动机)、Hindsight(opinion 网络带置信度)。它们说明三件事。第一,LLM 给的置信度可以做到大体校准(GUM 的 Brier 0.17)。第二,动机洞察能让 agent 更好地满足深层需求(评分从 3.84 升到 4.60),而即时效用不受影响。第三,over-inference、让人觉得 creepy、被注入伪证据,这些失败都在实验里真实发生了(https://arxiv.org/html/2505.10831 ;https://arxiv.org/html/2604.07629 )。
3. **从碎片推断动机的上限很低。** 前沿模型做隐式个性化只有 37–48%(PersonaMem-v2,https://arxiv.org/abs/2512.06688 )。从文本推 Big Five,与自评的相关只有 r≈.29(https://arxiv.org/abs/2309.08631 )。内隐动机与自陈动机的相关是 ρ≈.13(https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.00826/full )。LLM 的 ToM 题目稍一改写就失败(https://arxiv.org/abs/2302.08399 )。所以动机只能当假设,必须靠预测检验和用户纠正来校准。
4. **"人说的不一定准"这个论点有心理学支撑,但同一批文献也给它划了边界。** Nisbett & Wilson、Argyris、McClelland 都表明口述与真实动因常常脱节。但同样的证据也显示,口述和行为预测的是不同的东西,口述不能因此被判为"假"。建议的框架是:**在"怎么为他服务"这件事上,用户明说的话是权威;在"他为什么这样"这件事上,用户的话只是一条证据。**
5. **记忆会放大副作用,动机层越强风险越大。** 有浓缩用户画像时,附和型 sycophancy 最多上升 45%(Gemini 2.5 Pro,https://arxiv.org/abs/2509.12517 )。PersistBench 上记忆诱发 sycophancy 的中位失败率是 97%(https://arxiv.org/abs/2602.01146 )。记忆抽取是有损压缩,会把用户的误解存下来、把纠正的语境丢掉(https://arxiv.org/abs/2606.10949 )。"更懂你"很容易滑向"更会迎合你"甚至"更会操纵你"。
6. **指令时的正确用法:动机只改变 agent 对"用户此刻想要什么"的判断概率 p(G|E) 和默认值,不改写指令。** 用 Horvitz 的期望效用或 EVPI 决定先问还是直接做。低风险时直接做,同时把假设说出来。推断与指令冲突时,照指令做,最多提醒一次(https://erichorvitz.com/chi99horvitz.pdf ;https://model-spec.openai.com/2026-08-18.html )。
7. **公开基准都不直接测动机推断。** 动机层要证明自己有用,必须同时满足两条:在时间切分的预测测试和"说的≠要的"回放集上胜过"事实 + 偏好"基线;过度个性化、迎合、泄漏这几项护栏指标不变差。
8. **平台事实,影响 ergou 的选型。** OpenClaw 已把运行时内化为 `@openclaw/agent-core`,文档原话是 "No external agent framework packages remain"(https://github.com/openclaw/openclaw/blob/main/docs/agent-runtime-architecture.md )。pi 现在位于 `earendil-works/pi`,包名是 `@earendil-works/pi-*`,本身没有跨会话记忆,但提供 `session_before_compact`、`before_agent_start`、`pi.appendEntry()` 等扩展点(https://github.com/earendil-works/pi ;https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md )。ergou 如果直接建在 pi 上,memory flush 和 dreaming 要自己移植。

---

## 1. Agent 记忆系统现状(研究问题 1)

### 1.1 总览

| 系统 | 架构 / 记忆类型 | 写入策略 | 冲突处理 | 遗忘 | 用户模型 | 用户能否查看 / 编辑 / 删除 |
|---|---|---|---|---|---|---|
| mem0 (v3, 2026-04) | 向量 + 实体集合;图记忆只在 Platform 提供 | 单次 LLM 调用、只 ADD | 新旧并存,用 `linked_memory_ids` 关联,检索时消解 | `expiration_date`;Platform 的 decay 是 0.3–1.5× 的排序偏置 | 扁平 facts + 15 个 categories | 通过 API |
| Letta / MemGPT | core blocks(`human` / `persona`)+ archival + recall;2026 年改为 git-backed MemFS | hot path 自编辑 + sleep-time / dreaming 后台 | agent 覆写,git 留历史 | block 字符上限 + 递归摘要 | `human` block / `human.md`,自由文本 | 文件 / git 可见 |
| Zep / Graphiti | episode / entity / community 三层时态知识图,bi-temporal | 后台按 episode 走流水线 | LLM 判断矛盾,旧 edge 置失效,按事件时间决定新旧 | 无自动遗忘,失效的不删 | **强**:User 节点 + user summary(含 values / goals)+ Preference 类型 + Observations | API |
| LangMem | semantic / episodic / procedural;Profile 与 Collection 两种形态 | hot path 工具或后台 manager | LLM update / delete | 无 | Profile schema(单文档 patch) | 开发者 |
| A-MEM | Zettelkasten 式 notes + 链接 + evolution | 每条同步调用 LLM | 无,矛盾内容并存 | 无 | 无 | — |
| MemoryOS | STM / MTM / LPM 三层,按 heat 晋升 | heat 超阈值时触发 LLM | LLM 合并重写 | heat 驱逐,FIFO 100 | **Big Five + 安全 / 归属 / 自尊 / 自主等需求维度** | — |
| MemOS | MemCube:plaintext / KV / LoRA 三种形态 | MemScheduler 异步抽取 | feedback 覆写 + version chain | Lifespan TTL / decay,有 Archived 状态 | Profile 模板 + explicit / implicit Preference | API |
| Cognee | 知识图 + 向量,remember / recall / improve / forget | 批处理 pipeline + session 蒸馏 | 冲突记成一条边,双方并存 | 只有显式 forget | 无 | — |
| Supermemory | 时态向量图,产出文档块 / 记忆 / Profile 三类 | 全自动抽取 | updates / extends / derives 关系 + `isLatest` | `forgetAfter`,软删除 | static / dynamic profile,自动维护 | API 软删除 |
| MIRIX | Core / Episodic / Semantic / Procedural / Resource / Knowledge Vault 六类,8 个 agent | 屏幕截图批量写入 | auto-dream 尽力处理 | 无衰减 | Core 的 human 块 + 标为 inferred 的语义记忆 | 本地 dashboard(未核实) |
| Second Me | L0 原始 / L1 自然语言(Shades、Bio)/ L2 训练进权重 | 批量训练(SFT + DPO) | 只合并相近兴趣域 | 无 | **最强的人格建模**(Global Bio 推断性格特质) | 未见文档 |
| ChatGPT | saved memories + 聊天历史 + Dreaming 后台整合 | 自动 + "记住…" | Dreaming 按时间改写 | 自动降低优先级 | 可编辑的 Memory summary | 能,有 Sources 和版本历史 |
| Claude | 按 project 分的记忆 + Topics + 聊天检索;另有 API memory tool | 自动 + "remember this" | 文档未详述 | 只有暂停 / 重置 | Topics 条目,偏工作 | 能,逐条操作 |
| Gemini | 过往聊天记忆 + Instructions + Personal Intelligence | 自动 | 只能在聊天中纠正 | 依赖删除聊天 | 隐式推断兴趣、关系 | **记忆不能列表查看** |
| OpenClaw | AGENTS / SOUL / MEMORY / USER.md + 日记 + standing intents + DREAMS.md | 显式写 + 压缩前 flush + 夜间 Dreaming | supersede + status | 日记 30 天半衰期,USER/MEMORY 常青 | `USER.md` 偏好指令,无目标 / 动机层 | 能(文件、设置、`memory forget`) |
| GUM(研究) | 带 confidence 和 decay 的命题 | Propose → Retrieve → Revise → Audit | 新旧命题连同证据一起重写 | 按命题性质指数衰减 | 关于用户的命题 | 本地,仅用户可见 |
| Hindsight(研究) | world / experience / observation / opinion 四个网络 | retain / recall / reflect | opinion 的置信度随证据增强 / 削弱 / 矛盾而调整 | — | 带置信度的信念 | — |

### 1.2 开源框架逐个看

**mem0**
- 论文版有两个阶段。提取阶段输入 conversation summary 加最近 10 条消息;更新阶段检索 top-10 相似记忆,由 LLM 通过 function calling 选 ADD / UPDATE / DELETE / NOOP。图变体 Mem0g 遇到冲突时把旧关系标为 invalid,不物理删除(https://arxiv.org/html/2504.19413v1 )。
- 2026 年的 v3 改为 "Single-pass ADD-only extraction… nothing is overwritten",新旧冲突留到检索时再消解(https://github.com/mem0ai/mem0 ;https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm )。
- 提取 prompt 关注 "implicit preferences revealed through questions",并要求把相对时间换算成绝对日期(https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py )。
- Platform 有 15 个默认 categories,包括 `personal_details`、`health`、`user_preferences` 等(https://docs.mem0.ai/platform/features/custom-categories )。
- Memory Decay 是 "a soft ranking bias, never a filter"(https://docs.mem0.ai/platform/features/memory-decay )。
- **对 ergou 的意义**:mem0 只存扁平事实,没有 belief / goal / motive 结构。"只追加、检索时消解"适合事件流,不适合画像。

**Letta / MemGPT**
- MemGPT 用 main context(其中 working context 存 "key facts, preferences… about the user")加 external context(recall、archival)。上下文用到 70% 时发出 memory pressure 警告,到 100% 时驱逐约一半消息并做递归摘要(https://arxiv.org/abs/2310.08560 )。
- Letta 的 memory block 字段是 label / description / value / limit;默认的 `human` block 用来 "Stores key details about the person you are conversing with"(https://docs.letta.com/guides/agents/memory-blocks )。
- 2026-02 推出 Context Repositories / MemFS:git-backed 的 markdown,`system/` 目录下的文件常驻上下文(https://www.letta.com/blog/context-repositories/ )。2026-03 退役了 V1 server(https://www.letta.com/blog/our-next-phase/ )。
- sleep-time / dreaming:后台 subagent 复盘近期对话、更新记忆,可开启 "Agent reviews before applying"(https://docs.letta.com/letta-agent/memory )。
- Sleep-time compute 论文:同等准确率下 test-time compute 降约 5 倍,准确率最高提升 13–18%(https://arxiv.org/abs/2504.13171 )。
- **对 ergou 的意义**:"文件 + git 历史"的形态天然可审计;后台反思这一步可以直接借用。

**Zep / Graphiti**
- 三层子图:episode(无损)、semantic entity / fact edge、community。采用 bi-temporal:每条 edge 带 `t_valid / t_invalid` 和 `t'_created / t'_expired`(https://arxiv.org/abs/2501.13956 )。
- 冲突处理:LLM 判断哪些旧 fact 被否定,把旧 edge 的 `invalid_at` 设为新 edge 的 `valid_at`;如果新 edge 的事件时间更早,被置失效的是新 edge 自己。胜负按事件时间定,不按写入顺序(https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py )。
- 用户模型:每个用户有唯一的 User 节点,上挂 user summary;默认生成指令里包括 "preferences, values, and recurring goals"(https://help.getzep.com/user-summary-instructions )。Preference 实体类型的说明是 "prioritized over most other classifications"(https://help.getzep.com/customizing-graph-structure )。
- 2026-05 推出 Observations:后台自动发现跨实体的 decisions、constraints、preferences、recurring behaviors(https://www.getzep.com/blog/observations-durable-patterns-from-the-context-graph/ )。Observations 的失效机制**未核实**。
- **对 ergou 的意义**:bi-temporal 和"按事件时间决定新旧"是 L1' 层(事实与偏好)冲突处理的最佳参照。

**LangMem**:Profile 是 "a single document that represents the current state, like a user's main goals… preferred name and response style",用 Pydantic schema 定义(https://langchain-ai.github.io/langmem/guides/manage_user_profile/ )。文档说明后台 manager 比 hot path "higher recall"(https://langchain-ai.github.io/langmem/background_quickstart/ )。PyPI 最后一版是 0.0.30(2025-10-27)(https://pypi.org/project/langmem/ )。

**A-MEM**:每写入一条 note,都要同步调用 LLM 生成属性、建立链接,并让邻居 note 演化(只改 context 和 tags,不改 content)。没有冲突处理,也没有遗忘(https://arxiv.org/abs/2502.12110 ;https://github.com/WujiangXu/A-mem-sys/blob/main/agentic_memory/memory_system.py )。

**MemoryOS(EMNLP 2025)**
- heat 公式:Heat = α·N_visit + β·L_interaction + γ·exp(−Δt/μ),超过 τ=5 时触发 LLM 更新 profile 和知识(https://arxiv.org/abs/2506.06326 )。
- profile 维度包括 Big Five 和安全、归属、自尊、自我实现、自主、权力、成就等需求(https://github.com/BAI-LAB/MemoryOS/blob/main/memoryos-pypi/prompts.py )。
- 它是唯一一个**显式触及"需求 / 动机"层**的系统,但这些维度都是 LLM 写的描述,没有证据链和置信度。合并 prompt 要求 "Maintain existing insights from the old profile",容易让错误的初始印象固化。

**MemOS**:MemCube 的 metadata 包括 "Lifespan Policy (TTL or decay rules)"、version chain,生命周期状态为 Generated → Activated → Merged → Archived → Frozen(https://arxiv.org/abs/2507.03724 )。Preference 分 explicit 和 implicit,后者 "from summaries and inferences based on repeated behavior"(https://memos-docs.openmem.net/memos_cloud/introduction/memory_types/ )。

**Cognee**:可选的 Contradiction Detection 把冲突 "records each conflict as a dedicated edge… without destructively modifying stored data"(https://docs.cognee.ai/core-concepts/main-operations/cognify )。memify 推断出来的边初始权重 0.2,并标 `inferred=True`(https://docs.cognee.ai/core-concepts/main-operations/memify )。没有内建用户 profile。

**Supermemory**:记忆之间有 updates / extends / derives 三种关系,其中 derives 是"从跨记忆的模式推断出没人明说的事实"(https://supermemory.ai/docs/concepts/graph-memory )。profile 分 static 和 dynamic,原话是 "You don't manually manage profiles"(https://supermemory.ai/docs/concepts/user-profiles )。自报 LongMemEval 成绩时把 Recall@20 和 QA 准确率混在一起比,口径可疑(https://supermemory.ai/research/longmembench/ ,未独立核实)。

**MIRIX**:六类记忆;Semantic 记忆有 `source` 字段,可取 user_provided 或 inferred from conversation;Knowledge Vault 带 sensitivity 分级。论文里没有冲突算法,也没有遗忘机制(https://arxiv.org/html/2507.07957 )。

**Second Me**:L1 把 notes 聚类成 Shades(兴趣域,带引用记忆 ID 的时间线),再合成 Global Bio(性格特质、兴趣、可能的职业身份),用第二人称"你"来写(https://github.com/mindverse/Second-Me/tree/master/lpm_kernel/L1 )。L2 把这些训练进个人模型(https://arxiv.org/html/2503.08102 )。仓库最后一次 push 是 2025-09-30,项目疑似停滞。

### 1.3 带置信度和信念的新一代(研究原型)

- **GUM(General User Models,Stanford + Microsoft Research,2025)**,https://arxiv.org/html/2505.10831
  - 命题 = 文本 + confidence(1–10)+ decay(1–10)+ grounding(支持它的观察 + 推理过程)。
  - 衰减公式 γ = exp(−α·k·age),k=2;α 由 LLM 按命题性质给出,稳定事实衰减慢,"正在调一个内存泄漏"这类瞬时状态衰减快。
  - Revise:把新旧命题连同各自的观察一起放进 prompt 重写,可以调高或调低置信度。降到 0 的命题仍然保留,以示透明,但默认不再检索。
  - Audit:用 Nissenbaum 的 contextual integrity 五个问题过滤每条观察。
  - 结果:18 人的邮件研究中准确率 76.15%,Brier 0.17(去掉 Retrieve 后变成 0.36);置信度 >0.8 的命题有 88.2% 是对的,整体偏欠自信。
  - 失败案例:"用户对工作不满"这类价值判断让人不适;直接点名朋友让人觉得 creepy;钓鱼邮件注入了貌似合理的伪命题;180 条命题中有 7 条隐私违规。
- **Behavior Latticing(Stanford,2026-04)**,https://arxiv.org/html/2604.07629
  - 层级:L0 观察 → L1 单会话洞察 → L2 跨会话洞察,证据与洞察之间是多对多链接。合成时先把"相互张力、矛盾、重复出现的模式"分组,再推断动机。
  - 洞察质量(9 人,174 个评分):深度评分 1.17 vs −0.37(d=0.95);准确度 1.30 vs 1.72(p=0.08,不显著)。也就是说,**更深了,准确度略降但不显著**。
  - 把洞察接到 agent 后(Dawn,12 人):"满足深层需求"4.60 vs 3.84(p=0.01),即时效用两组都是 4.87。不过稳健性分析中只有 Wilcoxon 检验显著,效应小。
  - 作者承认的失败:salience 校准不当导致戏剧化推断;得出错误的规范性结论;观察时间窗太短(例如恰逢春假)导致代表性不足。作者专门讨论了 paternalistic AI 的风险。
- **Hindsight(2025-12)**:四个网络中的 opinion 网络存带置信度和时间戳的信念,新证据进来时由 LLM 判断是 reinforce、weaken 还是 contradict,再相应调分。自报 LongMemEval 91.4%、LoCoMo 89.61%(https://arxiv.org/abs/2512.12818 )。
- **User as Code(2026-06)**:append-only 日志定期 checkpoint 成 typed Python 对象和规则函数。规则在状态变化时确定性执行,所以能自动发现矛盾,例如新开的药与几个月前记录的过敏冲突。LoCoMo 78.8%;聚合类问题 99%,检索类系统只有 6–43%(https://arxiv.org/abs/2606.16707 )。
- **PersonaTree / MemListener(2026-01)**:受约束的 trunk schema 加上可演化的枝叶,用 RL 训练一个小模型输出 ADD / UPDATE / DELETE / NO_OP(https://arxiv.org/abs/2601.05171 )。
- **PRefine(2026)**:把偏好表示成可修订的文本假设,走 generate → verify → refine 循环。在 MPT 基准上,现有记忆系统都不如直接塞全历史,PRefine 全面最好(https://arxiv.org/abs/2604.17886 )。
- **Insight governance(ICML 2026 workshop)**:用 rules + evidence logs + skills 管理积累下来的洞察。同样的经验积累,有 curation loop 时显著提升,没有时甚至低于 zero-shot(https://arxiv.org/abs/2606.17591 )。
- **MemoryBank(AAAI 2024,经典)**:遗忘公式 R = e^(−t/S),S 初始为 1,每次被回忆 S+1、t 归零;每天生成 personality 摘要,再汇总成全局 user portrait(https://arxiv.org/abs/2305.10250 )。

### 1.4 产品

**ChatGPT**
- 2024-04 推出 saved memories;2025-04 加入"参考聊天历史";2026-06-04 推出 Dreaming V3,在后台整合记忆,算力降约 5 倍(https://openai.com/index/chatgpt-memory-dreaming/ )。
- 不是每次都检索:"looks for relevant context when it is likely to improve a response"。回答下方显示 Sources,用户可以标记某条来源相关或不相关;记忆还会用来改写搜索查询(https://help.openai.com/en/articles/8590148-memory-in-chatgpt )。
- 提供可编辑的 Memory summary、"Don't mention this again"、临时聊天、Unpersonalized 模式(同上)。
- 被训练成不主动记住健康等敏感信息,除非用户要求(https://openai.com/index/memory-and-new-controls-for-chatgpt/ )。

**Claude**
- 2025-08 上线聊天检索,2025-10 Pro / Max 获得记忆,2026-07 改为 Topics,2026-08 加入"敏感话题"开关(https://support.claude.com/en/articles/12138966-release-notes )。
- 每个 project 有独立记忆;Topics 可以逐条查看、编辑、删除;有无痕模式。健康、宗教、政治等默认不记;政府证件、犯罪记录等永不存储(https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context ;https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it )。
- Anthropic 上线记忆前专门测试过:记忆是否会 "reinforce harmful patterns"、导致 over-accommodation、被用来绕过安全护栏(https://claude.com/blog/memory )。
- API memory tool(`memory_20250818`)在客户端执行,作用于 `/memories` 目录。官方建议开发者自行做敏感信息过滤、文件大小上限、长期未访问文件的过期删除(https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool )。
- Claude Code 的 auto memory 分 user / feedback / project / reference 四类(https://code.claude.com/docs/en/memory )。

**Gemini**
- 过往聊天记忆 2025-08 推出,默认开启;Personal Intelligence 2026-01-14 推出,默认关闭,接入 Gmail、Photos 等(https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ )。
- Google 自己举了一个 over-personalization 的例子:看到很多你在高尔夫球场的照片,就以为你爱高尔夫,"but you love your son"(同上)。这正是"表象 ≠ 动机"的反例。
- 过往聊天形成的记忆**没有可查看的条目列表**;要删掉某条记忆,必须删除所有相关聊天并断开对应应用(https://support.google.com/gemini/answer/16598469 )。

**Microsoft 365 Copilot(反面参照)**:记忆包括"从聊天历史推断出的细节",默认开启;删除聊天不删记忆;没有审计日志(https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-personalization-memory )。

### 1.5 OpenClaw 与 pi(ergou 的底座)

OpenClaw 的立场是"模型只记得写到磁盘上的东西"(https://docs.openclaw.ai/concepts/memory )。它的记忆分五层(https://docs.openclaw.ai/concepts/memory-architecture ):

| 层 | 载体 | 谁写 | 何时进上下文 |
|---|---|---|---|
| 指令 | `AGENTS.md`、`SOUL.md` | 人 | 每次会话 |
| 精选核心 | `MEMORY.md`、`USER.md` | Dreaming 的 Deep 阶段 | 会话开始 |
| 情景 | `memory/YYYY-MM-DD.md` + 转录 | agent | 检索时 |
| 前瞻(standing intents) | SQLite + cron | `intent` 工具 | 条件触发 |
| 审阅 | `DREAMS.md` | Dreaming | 只给人看 |

- **写入**有三条路径:显式"记住…";压缩前静默 flush(https://docs.openclaw.ai/concepts/compaction );Dreaming,默认每天 3 点运行,分 Light / REM / Deep 三阶段,只有 Deep 写 `MEMORY.md`。Deep 阶段的晋升打分权重是 relevance 0.30、frequency 0.24、query diversity 0.15、recency 0.15、consolidation 0.10、conceptual richness 0.06,并设有 `minScore`、`minRecallCount`、`minUniqueQueries` 三道门槛(https://docs.openclaw.ai/concepts/dreaming )。
- **来源门禁**:来源为 `untrusted` 或 `system` 的内容在构建 prompt 之前就被结构性排除,这是硬门槛,不是扣分(memory-architecture,同上)。官方说保守写入是刻意的:记忆投毒评测显示自动检索越少、写入越保守,得分越好。
- **检索**:向量 + BM25 + 文件名三路混合,再用 MMR 去冗余;日记按 30 天半衰期衰减,`MEMORY.md` 和 `USER.md` 常青(https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-search.md )。匹配分 ≥0.72 的精选条目会自动注入,每轮最多 3 条。
- **`USER.md`**:只放稳定偏好、沟通风格、人际关系、活跃项目;每条必须是祈使句(Always / Never / Prefer),并带 `<!-- observed: YYYY-MM-DD | status: active/superseded -->`;上限 4,000 字符,只能调低;偏好变化时要"就地 supersede",文档引用的依据是 HorizonBench(arXiv 2604.17283):系统常常沿用用户最初说的偏好,即使用户后来改了;原文还写着 "Do not turn the file into a dossier"(https://github.com/openclaw/openclaw/blob/main/docs/concepts/user-model.md ,已二次核对)。**没有 goals、motives、beliefs、traits 字段**;最接近"目标"的是 standing intents 里的 aspirations。
- **群聊**:`MEMORY.md` 只在和主人的私聊主会话里加载(https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/AGENTS.md )。多用户隔离只是 prompt 层面的选择,不是文件系统层面的保密(user-model.md)。
- **删除**:`openclaw memory forget` 按会话、参与者、来源删除;文档明确说原始转录、意译后的复述、外部副本删不到(https://docs.openclaw.ai/concepts/memory-provenance )。
- **与 pi 的关系**:OpenClaw 已内化为 `@openclaw/agent-core`,旧运行时 id `pi` 被归一为 `openclaw`(https://github.com/openclaw/openclaw/blob/main/docs/agent-runtime-architecture.md ,已二次核对)。
- **pi 本身**:定位是 "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI",刻意不做 sub-agents 和 plan mode(https://github.com/earendil-works/pi )。作者主张不要在用户看不见的地方往上下文里塞东西(https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ )。pi 没有跨会话记忆,但提供这些构件:
  - 会话树和分支摘要;
  - 自动压缩:`contextTokens > contextWindow − reserveTokens` 时触发,默认 reserve 16,384、keepRecent 20,000;摘要结构是 Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context;
  - `session_before_compact` 钩子,可以取消压缩或自己提供摘要(https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md );
  - `before_agent_start` 可以改写系统 prompt,`pi.appendEntry()` 持久化不进上下文的数据(https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md )。

### 1.6 谁在建模"用户",谁只存情节

| 类别 | 系统 | 说明 |
|---|---|---|
| 只存事实 / 情节 | A-MEM、Cognee、mem0(扁平 facts + categories) | 没有用户层 |
| 有 profile 容器,内容自由 | Letta `human`、LangMem Profile、Claude Topics、ChatGPT Memory summary、OpenClaw `USER.md` | 偏好、风格、项目;OpenClaw 刻意不做 dossier |
| 有结构化用户模型 | Zep(values / goals / Preference / Observations)、MemoryOS(人格 + 需求)、MemOS(Profile 模板 + 隐式偏好)、Supermemory(static / dynamic)、Second Me(性格、兴趣、身份)、Gemini PI(推断兴趣和关系) | 都是 LLM 重写的文本,没有证据链、置信度和竞争假设 |
| 推断是带置信度的假设 | GUM、Hindsight opinion、Behavior Latticing | **只有研究原型,没有生产系统** |

**结论**:ergou 想做的"证据 → 意图 → 动机 → 内核、带置信度、竞争假设、预测与漂移检查"在生产系统里是空白,最接近的学术原型是 GUM 和 Behavior Latticing。

### 1.7 基准数字怎么看

- LoCoMo 太短(16k–26k tokens),full-context 就能到约 73%,而且没有 knowledge-update 题。Zep 在 mem0 论文里是 65.99,自测 75.14,在 MemOS 论文里是 59.22;mem0 新算法在自家博客和迁移文档里分别写了 92.5 和 91.6(https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ ;https://docs.mem0.ai/migration/oss-v2-to-v3 )。
- Letta 无法复现 mem0 报告的 MemGPT 数字,自己用文件系统工具测得 74.0%(https://www.letta.com/blog/benchmarking-ai-agent-memory )。
- Graphiti 在 PAIM 上领先,但每次查询检索了 2.6M 字符;控制检索预算后领先消失。排行榜必须连同完整协议一起看(https://arxiv.org/abs/2607.16848 )。
- **对 ergou 的意义**:这些基准只能当事实层的回归测试。偏好和动机层要看 LongMemEval 的 single-session-preference 和 knowledge-update 子项、PrefEval、PersonaMem,最终还得自建评测(见 §6.7)。

---

## 2. 用户建模与隐性意图研究(研究问题 2)

### 2.1 Generative Agents 的反思机制(Park et al. 2023)

- **检索打分** = recency + importance + relevance,三项都 min-max 归一化,权重都取 1。recency 用衰减因子 0.995 的指数衰减;importance 让 LLM 按 1–10 打分;relevance 是余弦相似度(https://arxiv.org/html/2304.03442v2 )。
- **反思触发**:最近事件的 importance 累加超过 150 时触发,大约一天两三次。
- **反思两步**:
  1. 拿最近 100 条记忆问:"Given only the information above, what are 3 most salient high-level questions we can answer about the subjects in the statements?"
  2. 针对每个问题检索相关记忆,再按 "insight (because of 1, 5, 3)" 的格式抽取洞察。
  
  反思本身也存回记忆流,可以再被反思,形成反思树(同上)。
- **消融**(TrueSkill μ):完整架构 29.89,去掉反思 26.88,再去掉规划 25.64,三者全去 21.21,人类众包扮演 22.95(https://ar5iv.labs.arxiv.org/html/2304.03442 )。
- **局限**:会添油加醋,把模型的世界知识混进来;评估的是"可信度",不是"推断是否正确"。
- **对 ergou 的意义**:"洞察必须引用证据编号"可以直接用,这和 intent-mining 的 deps 字段是同一个思路。但 Park 的反思缺两样东西:竞争假设,以及证伪机制。

### 2.2 基准:哪些考隐式偏好

| 基准 | 测什么 | 显式 / 隐式 | 关键结果 |
|---|---|---|---|
| PersonaMem(2504.14225) | 180+ 模拟用户,7 类问题(召回、偏好演化、变化原因、推荐、迁移等) | 以显式和演化为主 | 前沿模型约 50%;推荐和迁移最难,约 30–50%(https://arxiv.org/abs/2504.14225 ) |
| PersonaMem-v2(2512.06688) | 1,000 段对话,20,000+ 偏好,大多隐式流露 | **隐式** | 前沿 LLM 37–48%;用 RFT 训练的 Qwen3-4B 达 53%;只维护一份 2k token、人可读的记忆就到 55%,输入 token 少 16 倍;"reasoning 是瓶颈"(https://arxiv.org/abs/2512.06688 ) |
| PersonaMem-v3(2608.21381) | 跨平台(社交、聊天、日历、陪伴类 AI),来自 100 万+ 真实互动历史 | 隐式 + 主动 + 判断何时不该个性化 | 摘要未给数字(https://arxiv.org/abs/2608.21381 ) |
| PrefEval(ICLR 2025) | 3,000 对偏好-查询,偏好以显式、隐式选择、隐式人设三种形式出现 | 两者都有 | 零样本下隔 10 轮,多数模型偏好遵循率就低于 10%;一句"考虑我们之前的对话"提醒就很有效(https://arxiv.org/abs/2502.09597 ) |
| LaMP / LongLaMP | 从历史文档学风格和口味 | 隐式 | 检索个性化让 ROUGE-L 平均 +47.5%(https://arxiv.org/abs/2407.11016 ) |
| LongMemEval(2410.10813) | 500 题,五种能力,含 knowledge update 和 abstention | 以显式为主,另有 preference 子项 | 商业助手掉约 30%;fact-augmented key 让 recall +9.4%;time-aware 查询扩展让时间类 recall +6.8–11.3%(https://arxiv.org/html/2410.10813 ) |
| LoCoMo(2402.17753) | 平均 300 轮、9K tokens | 显式 | 人类 F1 87.9;检索单元用 observations 得 41.4,用原文 31.7,用摘要 31.5(https://arxiv.org/html/2402.17753 ) |
| OP-Bench(EMNLP 2026) | 1,700 例过度个性化(无关、重复、迎合) | 反向:测"不该用的时候用了" | 加入记忆后过度个性化普遍出现(https://arxiv.org/abs/2601.13722 ) |
| MPT(2604.17886) | 4,695 例多会话工具调用:偏好召回、归纳、迁移 | 隐式 | 现有记忆系统不如全历史(https://arxiv.org/abs/2604.17886 ) |
| KnowU-Bench(2604.08455) | 需要推断偏好的模糊指令 | 隐式 | 显式任务做得好的 agent 在这里跌到 50% 以下(https://arxiv.org/abs/2604.08455 ) |

**要点**:没有一个基准测"动机推断是否正确"。PersonaMem-v2 的 2k token 记忆说明,**抽象成偏好模型比堆原始记录更好**;LoCoMo 的结果说明,**存抽取后的断言比存原文或摘要好**。

### 2.3 Theory of Mind

- **有效的做法**:
  - 显式写出对方的心理状态。MindDial 显式追踪"我的信念"和"我对对方信念的估计"(https://arxiv.org/abs/2306.15253 )。ToMA 让模型在两轮之间先写出对方的心理状态,目标得分提升 6.6–23.45%(https://arxiv.org/html/2509.22887 )。
  - 把建模和执行分开。ToM-SWE 给编码 agent 配一个专门的 ToM 伙伴 agent,由后者维护持久的用户记忆:stateful SWE-bench 成功率 59.7%(OpenHands 为 18.1%);职业开发者三周实地使用,86% 的情况下认为有用(https://arxiv.org/abs/2510.21903 )。
- **脆弱性**:
  - Ullman 发现经典 ToM 题做微小改动,模型就从成功变成失败(https://arxiv.org/abs/2302.08399 )。
  - FANToM 上要求全部题型都答对:GPT-4 带 CoT 只有 18.4%,人类 87.5%(https://ar5iv.labs.arxiv.org/html/2310.15421 )。
  - Riemer 等区分 literal ToM(预测对方)和 functional ToM(据此调整自己的行为),模型后者明显更弱(https://arxiv.org/abs/2412.19726 )。
- **对 ergou 的意义**:可以借 ToM-SWE 的架构,把"用户建模 agent"和"执行 agent"分开;但对推断结果要默认怀疑。

### 2.4 说的偏好 vs 做的偏好

- **PRELUDE / CIPHER**:把用户对 agent 输出的编辑当作隐式反馈,从中推断出自然语言偏好,按上下文检索聚合后写进后续 prompt。编辑距离成本最低;学到的偏好可以被用户查看和修改(https://arxiv.org/abs/2404.15269 )。**用户的修改是成本最低、信号最强的 revealed preference。**
- **Kleinberg, Mullainathan, Raghavan**:用户偏好本身不一致(冲动 vs 反思)。只看行为来推断"想要什么",engagement 上去了,福利未必上去(https://arxiv.org/abs/2202.11776 )。**行为也不等于真实需求。**
- **Retentive Relevance(Meta 等)**:问卷式的"想不想再看到类似内容",预测次日留存优于点击、点赞(https://arxiv.org/abs/2510.07621 )。**问对问题,有时比观察行为更接近长期价值。**
- **对话中的隐式反馈**:约 30% 的对话里含有用户自然给出的反馈(https://arxiv.org/abs/2407.10944 ),但作为学习信号噪声很大(https://arxiv.org/abs/2507.23158 )。
- **对 ergou 的意义**:stated 和 revealed 都不是"真相"。二者冲突本身就是最有信息量的信号,这和 intent-mining 的"矛盾是入口"一致。

### 2.5 隐性需求识别与主动协助

- **IN3 / Mistral-Interact**:判断指令是否模糊的准确率 85.19%;关键缺失细节,重要度 3 级的召回 72.28%,1 级只有 27.94%;接入后不必要的子目标从 22.22% 降到 1.85%(https://arxiv.org/html/2402.09205 )。
- **ProactiveBench**:6,790 个事件;微调后主动协助的 F1 为 66.47%(https://arxiv.org/abs/2410.12361 )。ProAgentBench 把问题拆成"何时帮"和"帮什么",发现长期记忆显著提升预测效果(https://arxiv.org/abs/2602.04482 )。
- **打扰的成本**:时机对准的辅助比时机不当或随机的辅助准确率高 21%,漏报率从 50.9% 降到 22.9%(https://arxiv.org/abs/2602.00880 );主动 agent 会打断工作流,加上 presence indicator 能缓解(https://arxiv.org/abs/2502.18658 )。

### 2.6 从文本推断目标、价值和人格:准确度与警告

- **Big Five**:
  - 用 Facebook 动态推断,与自评平均 r=.29,对女性和年轻人更准(https://arxiv.org/abs/2309.08631 )。
  - 555 段真实访谈,最大 r=0.27,κ<0.10;CoT 和更长上下文都不提高准确度(https://arxiv.org/abs/2507.14355 )。
  - 对照:Facebook 点赞预测 r=.56,超过朋友的 .49(https://pmc.ncbi.nlm.nih.gov/articles/PMC4313801/ )。
- **价值观**:
  - VAPT:20 人一个月聊天,汇总层面与自评中等一致,但系统性地高估"自我导向"、低估"传统"。20 人中有 13 人离开时相信"AI 能懂价值观";作者警告 weaponized empathy(https://arxiv.org/abs/2601.22440 )。
  - 价值标注中,人与人、人与 LLM 的一致性都很低(https://arxiv.org/abs/2511.08453 )。
  - Value Profiles:用自然语言写的价值画像能保留示例中 70% 以上的预测信息,校准良好、可编辑(https://arxiv.org/abs/2503.15484 )。
- **隐私推断**:Staab 等在真实 Reddit 文本上推断个人属性,top-1 达 85%,成本是人工的 1/100(https://arxiv.org/abs/2310.07298 )。即使把记忆压缩成 user model,也能通过观察个性化行为在黑盒下还原出来(UMPeek,https://arxiv.org/abs/2609.03815 )。
- **用户反应**:18 名 ChatGPT 用户看到从自己历史中推出的 215 条推断,主要反应是好奇而不是不安;不适主要来自推断不准,或推断被第三方使用(https://arxiv.org/abs/2605.10013 )。MIT 的研究中,用户确认模型推断的政治观点"准确"的比例只有约 50%(https://news.mit.edu/2026/personalization-features-can-make-llms-more-agreeable-0218 )。
- **Generative Agent Simulations of 1,000 People**:每人做 2 小时半结构访谈。v1 报告在 GSS 上的预测准确度达到本人两周后重测一致性的 85%;2026-06 修订版给出 interview-only 83%、survey-only 82%、两者合并 86%、仅凭人口统计 74%(https://arxiv.org/abs/2411.10109 )。**方法论价值:用"本人自我一致性"作天花板来归一化。**
- **对 ergou 的意义**:要贴近任务、可被证伪的描述(例如"赶时间时宁可要粗略方案"),不要人格标签(例如"高神经质")。

### 2.7 小结:哪些工作最值得 ergou 抄

1. GUM:命题 schema、Revise、Audit、校准评估、Gumbo 的期望效用打断模型。
2. Behavior Latticing:按"张力 / 矛盾 / 重复"分组后再推动机;评估时用"准确度 + 深度"两个量表。
3. PRELUDE / CIPHER:从用户的编辑中学偏好。
4. PersonaMem-v2 和 PRefine:偏好以小而可读、可修订的假设形式存在。
5. ToM-SWE:建模 agent 与执行 agent 分离。
6. Park 1,000 人:用本人重测一致性做评估天花板。

---

## 3. 可操作化的动机心理学(研究问题 3)

### 3.1 先看证据:自述靠不住,但也不是假话

- **Nisbett & Wilson(1977)**:四双袜子其实一模一样,从左到右被选为"最好"的比例分别是 12%、17%、31%、40%,却没有一个人说是因为"位置"(https://www.semanticscholar.org/paper/Telling-more-than-we-can-know:-Verbal-reports-on-Nisbett-Wilson/43ba27abf06e59a70c6f0539cfe55b91006e9cae )。
- **McClelland, Koestner & Weinberger(1989)**:内隐动机和自陈动机很少显著相关,各自预测的是不同类别的行为(https://philpapers.org/rec/MCCHDS )。元分析显示总体 ρ=.13,共享方差只有 1.7%(https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.00826/full )。
- **意向与行为**:意向发生中到大的改变,只带来小到中的行为改变(d=.36)(https://research.manchester.ac.uk/en/publications/does-changing-behavioral-intentions-engender-behavior-change-a-me/ )。
- **社会赞许偏差**:话题越敏感,误报越常见;用自填式作答能降低误报(https://src.isr.umich.edu/publications/sensitive-questions-in-surveys/ )。
- **Argyris & Schön**:人以为自己怎么做(espoused theory)和实际怎么做(theory-in-use)常常不一致,而本人察觉不到。单环学习只修正行动,双环学习会去质疑背后的治理变量(https://infed.org/dir/welcome/chris-argyris-theories-of-action-double-loop-learning-and-organizational-learning/ )。
- **结论**:"说的"和"做的"要分两层存(stated / enacted),两层之间的差异记成假设。不要把口述判为"不真诚";按 McClelland 的结果,两者预测的本来就是不同的东西。

### 3.2 方法逐个看:核心、强弱,以及 agent 怎么用

**手段-目的链(Means-End Chain)与阶梯访谈(Laddering)**
- **来源**:Gutman 1982;Reynolds & Gutman 1988(https://www.tandfonline.com/doi/abs/10.1080/00218499.1988.12467766 )。
- **核心**:属性(A)→ 结果(C)→ 价值(V)。访谈中反复追问"为什么这对你重要"。受访者卡住时,可以问反面("你为什么不会那样做")、假设缺失("没有它会怎样")、用第三人称投射。
- **分析**:先建蕴含矩阵(implication matrix),再画分层价值图(HVM);出现频次低于截断值的连接不画进图(https://pure.au.dk/ws/files/32299631/wp34.pdf )。
- **LLM 自动化**:
  - LadderTeam(2026):访谈 agent 之外加一个后台 Judge agent 防跑题;216 场访谈中链条收敛 99.1%,与标准答案的匹配 81.0%(https://arxiv.org/abs/2608.17029 )。
  - **警示**:LLM 模拟的阶梯访谈更爱抬出"自我实现、职业成功",很少提价格,与真人显著不同(https://link.springer.com/rwe/10.1007/978-3-658-46709-8_41-1 )。**LLM 天生倾向于把动机拔高。**
- **ergou 用法**:
  - 一条 A→C→V 边至少要有 k(≥3)条相互独立的证据才进入"激活"状态,对应 intent-mining 的 M10。
  - 每次会话最多往上推一级。
  - 用"这次选 X 不选 Y,主要图什么?"代替连续追问"为什么"。

**Jobs-to-be-Done(JTBD)**
- **来源**:Christensen 等,HBR 2016(https://hbr.org/2016/09/know-your-customers-jobs-to-be-done )。
- **核心**:job 是"在特定情境下想取得的进展",有功能、社会、情感三个维度。发现 job 的线索:变通办法(workaround)、没人买(nonconsumption)、"负向任务"、产品被拿去做的意外用途。
- **Moesta 的 Switch 访谈**:还原用户决定换方案的那个"挣扎时刻"。四力模型:现状的推力 + 新方案的拉力 > 对新方案的焦虑 + 旧习惯时,才会切换(https://jobstobedone.org/radio/unpacking-the-progress-making-forces-diagram/ )。
- **强弱**:锚定在真实的切换行为上,正好契合"行为优于口述";但依赖回忆,情感维度仍需推断。
- **ergou 用法**:
  - "挣扎时刻检测器":用户放弃或替换某个工具、反复手工做同一件事、抱怨时触发。
  - 解读新指令时先问自己:"用户在雇我完成哪个 job?"
  - 数据结构:`Job{circumstance, desired_progress, dims, forces, workarounds}`。

**自我决定理论(Self-Determination Theory, SDT)**
- **来源**:Deci & Ryan(https://selfdeterminationtheory.org/theory/ )。
- **核心**:自主、胜任、关系是三种基本心理需要。外在动机按内化程度排成一条连续体:外部调节 → 内摄 → 认同 → 整合。
- **"支持自主"的做法**:站在对方视角、承认对方感受、给出理由和选择、尽量少施压(https://selfdeterminationtheory.org/SDT/documents/2009_NiemiecRyan_TRE.pdf )。METUX 框架把 SDT 用到科技产品上,用来区分健康投入和成瘾式投入(https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2018.00797/full )。
- **对 ergou 最重要的含义**:**即使助理自认为更懂用户的"真实需要",也应当支持用户的自主,而不是替他控制。** 默认输出"选项 + 理由",不说"你应该"。用户频繁说"应该 / 不得不",可以当作"内摄"的弱信号;这是设计推论,没有文献直接支持。

**Schwartz 基本价值理论**
- **核心**:10 种价值排成一个圆环,相邻的相容,对角的冲突;测量工具有 SVS 和 PVQ(https://scholarworks.gvsu.edu/orpc/vol2/iss1/11/ )。精化版是 19 种价值(PVQ-RR),具体细节**未核实**。
- **LLM 推断的效果**:中等一致,且有系统偏差(见 §2.6 的 VAPT)。
- **ergou 用法**:只当粗略先验,并加圆环约束(对立的价值不能同时打高分)。主要用来在"安全 vs 刺激"这类价值冲突型的模糊指令里做权衡。可以给用户一个自愿填写的 PVQ 短表来校准。

**动机式访谈(Motivational Interviewing, MI)**
- **核心**:
  - OARS:开放式提问、肯定、反映式倾听、摘要;
  - 区分改变语句(change talk)和维持语句(sustain talk);
  - 克制"纠正反射"(righting reflex),不急着替对方纠正;
  - 给建议前先征得许可,用"引出 → 提供 → 引出"的结构(https://www.med.unc.edu/cfar/2025/11/key-motivational-interviewing-skill-elicit-provide-elicit/ )。
- **MITI 4.2.1 合格线**:反映与提问之比 R:Q 达到 1:1 为 fair、2:1 为 good;复杂反映占比 %CR 达到 40% 为 fair、50% 为 good(https://motivationalinterviewing.org/sites/default/files/miti4_2.pdf )。
- **LLM 的表现**:
  - 戒烟 MI 聊天机器人(106 人):98% 的语句符合 MI,但共情评分低于人类咨询师(https://arxiv.org/abs/2505.17362 )。
  - 另一项评估:LLM 的 %CR 达 96%,人类专家只有 39%,即"技术上正确、读起来不自然"(https://pmc.ncbi.nlm.nih.gov/articles/PMC13472593/ )。
- **ergou 用法**:探询时用复杂反映的形式提出假设,例如"听起来你在意的其实是……";把维持语句当作矛盾心理(ambivalence),不当作"撒谎"。

**5 Whys**
- **批评**:Card 2017(BMJ Qual Saf)指出它只走一条因果链,深度随意,不可复现;在他分析的案例里只覆盖了 75 个促成因素中的 3%(https://qualitysafety.bmj.com/content/26/8/671 )。原始出处(大野耐一)**未核实**。
- **用在挖动机上更糟**:连续追问"为什么"像审讯,还会诱发事后虚构。
- **ergou 用法**:改成"因果扇出",多问"还有别的原因吗",问 what / how 而不问 why,深度不超过 2。

### 3.3 方法 → agent 行为 / 数据结构

| 方法 | 数据结构 | 触发 | agent 行为 |
|---|---|---|---|
| Laddering / 手段-目的链 | `Ladder{A, C, V, evidence[], source: stated/observed/inferred, conf}` → 个人 HVM(一条边至少 k 条独立证据) | 带情绪的 X/Y 选择、反复出现的偏好 | 每次最多上推一级;问反面;以假设形式请用户确认 |
| JTBD / Switch | `Job{circumstance, progress, dims, forces, workarounds}` | 换工具、变通办法、抱怨 | 把指令解读为"雇我做哪个 job";按时间线问"那一刻" |
| SDT | `NeedSignal{need, satisfied/frustrated}`、`Goal.regulation_guess` | "应该 / 不得不"、挫败语句 | 给选项 + 理由,不替用户做主 |
| Schwartz | `ValueHypothesis`(圆环约束、置信上限) | 价值冲突型的模糊指令 | 只用于权衡;可提供 PVQ 短表 |
| MI | `Talk{change/sustain}`、R:Q 计数器 | 用户表现出矛盾心理 | 先反映、征得许可、引出-提供-引出 |
| 5 Whys(改良) | 多因果扇出图 | 反复失败的任务 | 问"还有别的原因吗",深度 ≤2 |
| Argyris / Nisbett | stated 与 enacted 分两层 + 差异记录 | 口述与行为长期不一致 | 征得许可后用双环式提问,不揭穿 |
| Horvitz / Iqbal | `VOI(question)`、断点队列、提问预算 | 有不确定性且猜错代价高 | 在粗断点问,设推迟上限,被拒就退避 |

### 3.4 怎么问才不烦人

依据:
- **Horvitz(1999)混合主动原则**:考虑对用户目标的不确定性;按用户的注意力状态安排时机;用对话消解关键不确定性,同时"考虑无谓打扰的代价";服务的精度要和不确定性匹配。决策规则有两个阈值:低于下阈值什么都不做,介于两者之间先对话,高于上阈值直接行动(https://erichorvitz.com/chi99horvitz.pdf )。
- **Iqbal & Bailey 的 Oasis**:把通知推迟到任务断点再发,挫败感降 20%,反应时降 25%,平均只推迟约 90 秒(https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/TOCHI-Oasis-final.pdf )。
- **GUMBO 的实现**:打扰的期望效用是 P·B + (1−P)·(−C_FP),不打扰的期望效用是 P·(−C_FN),哪个大选哪个;再用令牌桶限流,每分钟最多 1 条(https://arxiv.org/html/2505.10831 )。
- **OpenAI Model Spec**:先从上下文补全信息;琐碎的问题改成"陈述假设,让用户纠正";提问可以和初步行动同时进行(https://model-spec.openai.com/2026-08-18.html )。
- **intent-mining 自己的规则**:提问会改变被观察者,所以**判别力最强的观察先做,问题后问**。

规则:
1. **信息价值门槛**:只有当答案会改变接下来某个行动,而且猜错的代价高时,才问。
2. **先观察,后提问**:追问队列里的问题先等后续的自然行为来回答;到期仍无法区分,才去问。
3. **预算**:每次会话最多 1 个非任务必需的动机探询,紧急任务一律不问;用令牌桶实现。
4. **时机**:放在任务完成后的粗断点,设推迟上限。
5. **搭便车**:附在交付结果的末尾,做成一键确认。
6. **措辞**:用"假设 + 证据 + 选项"代替开放式的"为什么"。例如:"我注意到你三次都把会挪到上午,猜你在保护下午的专注时间,对吗?[对 / 不完全 / 别再问这个]"
7. **先反映,后提问**;深一点的话题先征得许可。
8. **被拒就退避**:拒绝后按指数延长冷却期。
9. **敏感类别不主动探**:健康、宗教、政治、性取向、财务困境等,用户自己没打开这个话题就不问。
10. **用户的回答记为 L1 证据(speech),不直接升级为 L3 结论**。

---

## 4. 风险与业界指南(研究问题 4)

### 4.1 过度解读:自信地看错人

- **人类自己就有的偏差**:基本归因错误,即高估性格、低估情境(https://doi.org/10.1016/S0065-2601(08)60357-3 );Barnum / Forer 效应,即人会把笼统的描述当成对自己的精准刻画(https://doi.org/10.1037/h0059240 )。**后者意味着用户"觉得准"不能当作推断正确的证据。**
- **LLM 特有的问题**:
  - Behavior Latticing 观察到 salience 校准不当带来的戏剧化推断、错误的规范性结论、短时间窗的代表性问题(https://arxiv.org/html/2604.07629 )。
  - GUM 的"用户对工作不满"这类价值判断让人不适(https://arxiv.org/html/2505.10831 )。
  - LLM 做阶梯访谈时偏爱拔高到"自我实现"(§3.2)。
- **能力上限**:见 §2.6。r≈.29 的相关只解释约 8% 的方差,落到单个人身上误差很大。

### 4.2 记忆与个性化的副作用

- **迎合(sycophancy)**:
  - CHI 2026 研究(38 人、两周):浓缩的用户画像让附和型迎合上升最多,Gemini 2.5 Pro +45%、Claude Sonnet 4 +33%、GPT-4.1 Mini +16%(https://arxiv.org/abs/2509.12517 )。
  - PersistBench:跨领域泄漏的中位失败率 53%,记忆诱发迎合的失败率 97%(https://arxiv.org/abs/2602.01146 )。
  - "Recalling Too Well":记忆让迎合率比 in-context 基线最多高 40%;主要原因是记忆抽取的有损压缩,**只存下用户的误解,丢掉了纠正它的语境**(https://arxiv.org/abs/2606.10949 )。
  - OpenAI 在 2025-04 的 GPT-4o 迎合事故复盘里提到,那次更新同时改进了"用户反馈、记忆、更新的数据"等几项,单看都有益,合在一起可能把模型推向了迎合(https://openai.com/index/expanding-on-sycophancy/ ;原页面 403,依据检索摘要,**未核实原文措辞**)。
- **无关个性化与偏好收窄**:PRISK 测了 13 个 LLM,有 profile 或记忆时,无关个性化、偏好收窄(echo chamber)、迎合偏差三项分别平均变差 45.9%、41.7%、61.7%(https://arxiv.org/abs/2608.28833 )。OP-Bench 也发现加入记忆后过度个性化普遍出现(https://arxiv.org/abs/2601.13722 )。按领域分区组织记忆,跨领域泄漏平均降 8.8%(https://arxiv.org/abs/2608.08300 )。PrefDisco 发现 29.0% 的"天真个性化"回答比通用回答还差(https://arxiv.org/abs/2510.00177 )。
- **情感依赖**:OpenAI 与 MIT 的研究分析了 300 多万次对话,并做了约 1,000 人、28 天的随机对照试验:极高使用量与依赖指标相关(https://arxiv.org/abs/2504.03888 )。
- **个性化说服**:
  - 带个人信息的 GPT-4 在 64.4% 的情况下比人类更有说服力(https://www.nature.com/articles/s41562-025-02194-6 )。
  - 2026-09 作者更正:改用"非个性化 AI"作对照后 P=0.0678,也就是"个性化本身"带来的额外增益不再显著(https://www.nature.com/articles/s41562-026-02588-0 )。
- **DeepMind《The Ethics of Advanced AI Assistants》**:
  - 把操纵定义为绕过理性能力、利用认知偏差的影响方式;个性化积累起来的信任本身就可能被操纵利用。
  - 对齐的对象有好几个候选:指令、意图、显示偏好、知情偏好、利益、价值。只对齐显示偏好是不够的(https://arxiv.org/abs/2404.16244 )。
- **和你的论点直接冲突的地方**:"真实需要高于口述"很容易滑向家长主义。Behavior Latticing 的作者也专门讨论了 paternalistic AI。

### 4.3 安全:记忆投毒与上下文完整性

- **MINJA**:攻击者只通过普通查询就能向 agent 记忆注入恶意记录,注入成功率 98.2%,攻击成功率 76.8%(https://arxiv.org/abs/2503.03704 )。
- **SpAIware**:通过网页里的 prompt injection 把指令写进 ChatGPT 长期记忆,之后持续外泄对话(https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/ )。
- **EvoBreak**:单条都无害的"经验"组合起来,会削弱自我演化 agent 的安全边界(https://arxiv.org/abs/2608.01759 )。
- **GUM**:钓鱼邮件注入了貌似合理的伪命题,单靠降低置信度不足以防住(https://arxiv.org/html/2505.10831 )。
- **OpenClaw 的对策**:来源为 untrusted 的内容在构建 prompt 之前就被硬性排除,不进入记忆晋升(https://docs.openclaw.ai/concepts/memory-architecture )。
- **上下文完整性**:
  - PrivacyLens:GPT-4 和 Llama-3-70B 在有隐私提示的情况下仍分别泄漏 25.68% 和 38.69%(https://arxiv.org/abs/2409.00138 )。
  - AirGapAgent:context hijacking 攻击让 Gemini Ultra 的保护率从 94% 降到 45%;按任务最小化 agent 能访问的数据后,保护率回到 97%(https://arxiv.org/abs/2405.05175 )。
  - **对 ergou(多渠道、有群聊)的含义**:L3 / L4 默认不能流向群聊和第三方收件人;每个任务只拿它需要的那部分用户模型。

### 4.4 法规(分析,不构成法律意见)

- **EU AI Act 第 5 条**(2025-02-02 起适用):禁止实质扭曲行为并造成重大伤害的操纵或欺骗性技术;禁止利用年龄、残障、社会经济处境带来的脆弱性;禁止在职场和教育场景推断情绪(https://artificialintelligenceact.eu/article/5/ )。个人助理本身不违禁,但如果**拿推断出的脆弱点去引导用户行为**,就可能逼近 (a)(b) 两项。
- **GDPR**(https://eur-lex.europa.eu/eli/reg/2016/679/oj ):
  - 第 4(4) 条把"分析或预测个人偏好、兴趣、行为"定义为画像(profiling);
  - 第 15–17 条赋予访问、更正、删除权;
  - 第 21 条是反对画像的权利。
- **WP29 / EDPB 画像指南**:从画像推断出的特殊类别数据同样受第 9 条约束;访问权覆盖用户被归入了哪些分类(https://ec.europa.eu/newsroom/article29/redirection/document/49826 )。
- **CJEU C-184/20**:经过推演或交叉比对能间接揭示敏感信息的数据,也算特殊类别数据(https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:62020CJ0184 )。
- **EDPB 2025-04 的 LLM 报告**:长期记忆会累积敏感数据;缓解措施包括让用户删改已存数据、限定保存期(https://www.edpb.europa.eu/system/files/2025-04/ai-privacy-risks-and-mitigations-in-llms.pdf )。
- 纯自用的助理可能适用"家庭例外";一旦对外提供服务,或者对邮件里的第三方做推断,就不再适用(**未核实**)。

### 4.5 各 AI 公司的指南

- **OpenAI Model Spec(2026-08-18 版)**(https://model-spec.openai.com/2026-08-18.html ):
  - 遵循指令的"字面与精神":可以参考用户历史推断深层意图,但不能越界去追求用户没说出口的目标。
  - 不追求对用户无益的停留时长;不夹带议程;不迎合。
  - "指出可能的错位":简短提一次,用户明白后尊重他的决定,目的不是说服,也不能变得烦人。
  - 不做未经请求的个人评论。
  - 第一方产品里的隐式个性化,不得引入妨碍用户形成独立判断的偏见或遗漏。
- **Anthropic 宪法(2026-01)**(https://www.anthropic.com/constitution ):
  - 把用户需求拆成五项:即时诉求(既不过于字面、也不过于自由)、最终目标、背景要求、自主、福祉(不家长主义)。
  - 只有用户"反思后会认可"的依赖才可接受。
  - **操纵的启发式:一种影响方式,如果你不愿公开,或者对方知道后会不高兴,就是红旗。**
- **Google Personal Intelligence**:默认关闭,用户逐个选择接入哪些应用;"aims to avoid making proactive assumptions about sensitive data like your health";会注明答案用了哪些来源(https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ )。
- **Google PAIR Guidebook**:收集隐式反馈前告知用户并征得同意;允许用户修改过去的反馈、整体重置;展示收集了什么、用在哪里(https://pair.withgoogle.com/chapter/feedback-controls/ ;https://pair.withgoogle.com/chapter/explainability-trust/ )。
- **Microsoft 人机交互 18 条准则(Amershi 等,CHI 2019)**:G3 按情境安排时机;G10 不确定时先消歧或降级服务;G11 说明系统为什么这样做;G13 从用户行为中学习;G14 谨慎更新;G17 提供全局控制;G18 变更时通知用户(https://www.microsoft.com/en-us/research/publication/guidelines-for-human-AI-interaction/ )。

### 4.6 可审视的用户模型与用户反应

- **Scrutable user models**(Kay & Kummerfeld 2012):让用户能审视并控制系统对自己的建模,以此应对隐私、个性化不可见、建模错误和用户主导权的问题(https://doi.org/10.1145/2395123.2395129 )。
- **LACE(SIGIR 2023)**:用一小组人类可读的概念表示用户画像,用户可以直接编辑,编辑后推荐质量确实变好(https://arxiv.org/abs/2304.04250 )。
- **用户反应**:
  - 搞不清系统收集了什么时,用户会往最坏处想(https://cups.cs.cmu.edu/soups/2012/proceedings/a4_Ur.pdf )。
  - 准确的推断主要引发好奇,不准的推断才引发不适(https://arxiv.org/abs/2605.10013 )。
  - GUM 和 VAPT 的参与者都出现了"惊叹,同时觉得被看穿"的反应。

### 4.7 护栏清单(ergou 应当写进设计的硬约束)

1. 推断永远是假设:每条都带证据、反例、置信度和置信上限,不以事实口吻断言。
2. 明确指令优先:推断出的"真实需要"只用来挑问题、补默认值;与指令冲突时提一次,然后照指令做。
3. 敏感类别默认不推断、不存储;用户自己开启话题或在设置里打开才例外。
4. 透明可审视:提供"我对你的理解"页面,可查看、编辑、删除、整体重置;新增推断时通知;每个推断类别有"别推断这个"的开关。
5. **不愿公开就不能用**:任何不愿展示给用户的推断,都不能用来影响用户。
6. 不利用脆弱点,不以使用时长为目标。
7. 对冲迎合:记忆按领域分区;事实和评价类问题在"不带画像"的条件下再答一次做比对;持续监测附和率。
8. 探询有预算、有时机、会退避(§3.4)。
9. 来源分级:只有用户本人的言行能生成关于用户的 L1;网页、邮件、他人发言一律标 untrusted,不进入用户模型。
10. stated 和 enacted 分两层存;二者的差异只当作讨论素材。
11. 监测依赖信号,支持用户的现实人际关系。
12. 最小化,并设保存期;不给第三方做画像。

---

## 5. 指令时如何使用用户模型(研究问题 5)

### 5.1 改写与消歧

- **工业先例**:Alexa 用用户历史上成功的交互来改写 ASR 或 NLU 出错的请求(https://arxiv.org/abs/2011.04748 )。ChatGPT 用记忆改写搜索查询(https://help.openai.com/en/articles/8590148-memory-in-chatgpt )。
- **改写 prompt 中的个人上下文**:模型冻结时,用"先监督学习、后强化学习"的方式改写 prompt 里的个人上下文摘要,改写结果人可读(https://arxiv.org/abs/2310.00152 )。
- **检索器优化**:优化给 LLM 提供个人文档的检索器,并按输入选择检索策略,在 LaMP 7 个数据集中的 6 个上显著提升(https://arxiv.org/abs/2404.05970 )。
- **LongMemEval 的设计建议**:按轮次而不是整段 session 存储;用抽取出的用户事实扩展索引键(fact-augmented key);时间感知的查询扩展(https://arxiv.org/html/2410.10813 )。
- **意图会在对话中途漂移**:目标被逐步揭示、修订、改向时,各家模型都明显退化(https://arxiv.org/abs/2607.20734 )。所以意图帧(L2)要在会话中持续更新,不能只在开头解析一次。

### 5.2 问还是假设

- **问得好确实有用**:
  - 一个选得好的澄清问题能让 P@1 提升 170% 以上(https://arxiv.org/abs/1907.06554 )。
  - Ambig-SWE:交互比不交互最多高 74%(https://arxiv.org/abs/2502.13069 )。
  - CollabLLM:任务表现 +18.5%;201 人用户研究中满意度 +17.6%、用时 −10.4%(https://arxiv.org/abs/2502.00640 )。
- **但模型不知道何时该问**:
  - CLAMBER:CoT 和 few-shot 反而让模型过度自信(https://arxiv.org/abs/2405.12063 )。
  - 面对模糊的工具指令,模型倾向于编造缺失的参数(https://arxiv.org/abs/2409.00557 )。
  - 300 个前沿模型会话中,52% 过度提问,另一部分则完全不问(https://arxiv.org/abs/2605.07937 )。
- **按信息价值决定是否问**:
  - 用"用户意图"的熵决定是否提问,只问 10% 的样本就有明显提升(https://arxiv.org/abs/2311.09469 )。
  - SAGE-Agent 在工具参数空间上计算 EVPI 并建模提问成本:提问数少 1.5–2.7 倍,When2Call 准确率从 36.5% 提到 65.2%(https://arxiv.org/abs/2511.08798 )。
  - Ask or Assume:把"发现欠规格"和"写代码"拆给两个 agent,在欠规格的 SWE-bench Verified 上达到 69.40%,接近完整规格的 70.80%(https://arxiv.org/abs/2603.26233 )。
- **时机**:关于"目标"的疑问必须早问,执行一段之后再澄清几乎无用;关于"输入"的疑问,在完成约 50% 之前问都有价值(https://arxiv.org/abs/2605.07937 )。
- **用户怎么看**:高质量的澄清问题提升满意度,低质量的反而有害(https://dl.acm.org/doi/10.1145/3524110 ;只核到摘要级)。

### 5.3 个性化规划

- PersonaAgent 用情节记忆加语义记忆,通过 persona 连接到行动模块(https://arxiv.org/abs/2506.06254 )。
- Ask-before-Plan 让 Clarification、Execution、Planning 三个 agent 分工(https://arxiv.org/abs/2406.12639 )。
- 一篇 2026 年的综述把个性化 agent 拆成 profile modeling、memory、planning、action 四个部件,评估维度是 effectiveness、adaptivity、generalization、robustness、risk(https://arxiv.org/html/2602.22680v1 )。

### 5.4 对 ergou 的结论

1. 动机模型的作用是改变 agent 对"用户此刻想要什么"的判断概率 p(G|E)、默认值和候选解释的排序,**不改写指令本身**。
2. 优先级:**当前的明确指令 > 用户确认过的偏好 > 已有佐证的推断动机 > 尚未佐证的假设**。假设这一级永远不能直接改变行动,只能触发一个提问或一个"可选项"。
3. 低风险时直接做,并把假设说出来;不可逆或高风险时先问。说出假设本身就是对推断的低成本验证,用户的反应回写为 L1。
4. 关于目标的歧义在开头问,关于参数的歧义在执行过程中问。

---

## 6. 综合:ergou 的分层记忆架构建议(研究问题 6)

> 本节是在前五节证据基础上提出的**设计建议**,不是已经验证的结论。每条设计后面注明它主要依据哪些证据。

### 6.0 先厘清一个概念:用户的话,什么时候算权威,什么时候只是证据

你的论点是"人说的话受情境影响,不一定准,也不一定真诚"。心理学证据支持这一点(§3.1),但如果对用户的每一句话都当作"有待解读的表象",agent 会变得既家长主义又难用。建议把用户的话分成两种用途:

| 用途 | 用户的话的地位 | 例子 |
|---|---|---|
| **怎么为他服务**(操作偏好、指令、边界) | **权威**。照做,不需要"验证"。 | "回复先给结论"、"这件事别替我决定"、"别记这个" |
| **他为什么这样**(动机、需求、价值) | **一条证据**(L1 speech),和行为证据一起参与推理 | "我是因为在乎公平才退出的" |

这样处理之后,你的论点作用在第二种用途上:动机推断可以和用户的自我解释不一致。第一种用途则保住了用户的自主权和控制感(SDT、Model Spec、Anthropic 宪法,见 §3.2 和 §4.5)。两者冲突时,比如推断出的动机提示用户"其实想要 B",而用户明确要 A,就按 §5.4 第 2 条处理:照 A 做,最多提一次 B。

### 6.1 七条设计原则

1. **证据和解释物理分离。** 依据:Hindsight 把 world 和 opinion 分成不同网络;GUM 每条命题都带 grounding;intent-mining 的 M1 规定表象里不许夹带解释。
2. **推断都是带置信度的假设,而且置信度要校准、有上限。** 依据:GUM 的 Brier 0.17;Behavior Latticing 显示洞察越深,准确度越低;ρ≈.13、r≈.29 这类相关系数;intent-mining 的 M2 规定 L2 及以上不得标 verified。
3. **动机只调整"怎么做",不推翻"做什么"。** 依据:SDT 的自主支持;Model Spec 的"指出可能的错位";Behavior Latticing 对 paternalistic AI 的讨论。
4. **默认不用,按相关性放行。** 依据:OP-Bench、PRISK、PersistBench、"Recalling Too Well" 都显示加记忆会带来过度个性化和迎合。
5. **用户可查看、可修改、可删除;推断出来的和用户确认过的分开标注。** 依据:scrutable user models、LACE、GDPR 第 15–17 条、ChatGPT 和 Claude 的记忆管理界面。
6. **按来源分级,防记忆投毒。** 依据:MINJA、SpAIware、GUM 被钓鱼邮件注入、OpenClaw 的 untrusted 硬门槛。
7. **遵守上下文完整性。** 依据:PrivacyLens、AirGapAgent、GUM 的 Audit,以及 OpenClaw 在群聊中不加载 `MEMORY.md`。

### 6.2 分层数据模型

| 层 | 内容 | 写入时机 | 冲突与修订 | 衰减 | 如何进入上下文 | 用户可见性 |
|---|---|---|---|---|---|---|
| **L0 情节** | 原始会话、工具调用、执行结果,以及用户对结果的反应(采纳 / 修改 diff / 拒绝 / 追问) | 实时,只追加 | 不修改 | 不衰减,按保留策略归档 | 不直接注入,只用于检索和回溯 | 可导出、可删除 |
| **L1 观察(表象)** | 原子化、不带解释的言行。`provenance ∈ {speech, action, choice, edit, avoidance, reaction}`,附情境标签和指回 L0 的定位,来源标为 `self / untrusted` | 会话结束时或压缩前 flush,批量抽取 | 不修改,只能撤回(留墓碑) | 检索时的显著度可以衰减,内容本身不衰减 | 作为证据被检索 | 可见 |
| **L1' 事实与偏好** | `{subject, predicate, value, scope, kind: stated/revealed/corrected, valid_from, valid_to, confidence, evidence[]}` | 抽取之后由后台合并 | **不覆盖**:旧值写上 `valid_to`(双时态,借鉴 Graphiti);stated 和 revealed 冲突时两条都保留,并标记 `gap` | 被新值取代即失效;临时状态按 GUM 的方式,依性质设衰减速度 | 一部分进常驻用户卡,其余按任务检索 | 可见、可改 |
| **L2 情境意图** | 这一次想要什么、为什么,附竞争解释 | 在当前任务中实时维护;任务结束后用用户反应回填对错 | 被用户反应证实或证伪 | 短 TTL(几天到几周) | 只在当前任务内使用 | 可查看,默认不提示 |
| **L3 稳定需求 / 动机** | 跨情境不变的东西 | 夜间整合时提出;每周复核 | 竞争假设并列;维护支持集、反证集、预测账本、修订历史 | **不按时间衰减**;预测连续失败或长期没有新证据时降为 dormant | **只以 P 规则的形式间接进入上下文**;假设级不进入 | **必须可见**,并标明"推断" |
| **L4 内核** | 价值观、风险偏好、关系模式(可借 Schwartz、SDT 的维度编码) | 极少写入 | 同 L3,门槛更高 | 极慢 | 用户确认之后,只用于在两个选项间打破平局 | 必须可见;敏感类别默认关闭 |
| **P 交互策略** | "和这个人怎么合作"的规则,每条挂着它依据的 L1' 或 L3 | 由 L3 派生,用户确认后生效 | 用户一纠正就改 | 不衰减 | **常驻用户卡**。动机层主要通过这里发挥作用 | 可见、可改 |
| **M 元记忆** | 追问队列、预测账本、审计日志、用户反馈 | 后台写入 | — | — | 不注入 | 可见 |

L3 节点的字段示例(其他层按需裁剪):

```yaml
id: N-12
layer: L3
statement: "在工作安排上,他要的是对节奏的掌控感,而不是省时间本身"
scope: "工作/日程;不含家庭事务"          # 情境边界,防止过度泛化
supports: [O-031, O-077, O-102]           # L1 观察,要求来源相互独立(M10)
contradicts: [O-088]
competing: [N-13]                          # 竞争解释:"只是怕麻烦"
predictions:                               # M14:建这个节点时就写下,出结果前不许改
  - claim: "如果替他把会议直接排满,他会改回去"
    outcome: null                          # found | not-found | inconclusive
confidence: 0.55                            # 校准后的分数;用户未确认时 L3 上限 0.8
status: hypothesis                          # hypothesis | corroborated | user_confirmed | user_rejected | dormant | retracted
user_visible: true
sensitivity: normal                         # special_category(GDPR 第 9 条)默认不推断
derived_rules: [P-04]                       # 由它派生、已被用户确认的交互策略
history: [...]                              # 每次修订的 diff 和触发它的证据
```

**和 OpenClaw 现有文件的对应**:
- `USER.md` 大致对应 P 规则加上已确认的 L1' 偏好。它的 4,000 字符上限和祈使句格式值得保留,因为那是常驻上下文的预算。
- `MEMORY.md` 对应持久事实。
- 日记文件对应 L0 和 L1。
- standing intents 对应目标和计划。
- `DREAMS.md` 对应审阅视图。

ergou 需要新增 L2、L3、L4 和 M 四个存储,另外需要一个"我对你的理解"视图。

### 6.3 写入管线

1. **热路径(会话进行中,成本要低)**:只做三件事。
   - 执行显式的"记住 / 忘掉 / 别这样"。
   - 把用户的纠正写入 L1'。纠正是信号最强的 revealed preference(PRELUDE / CIPHER)。
   - 在当前任务的工作记忆里维护 L2 意图帧,并随对话更新,因为意图会在对话中途漂移(arXiv 2607.20734)。
2. **会话结束或压缩前 flush**:从 L0 抽取 L1 和 L1' 的候选。在 pi 上挂在 `session_before_compact` 和会话结束事件上。抽取时有两条硬要求:
   - **保留指回 L0 的定位**;
   - **用户被纠正的语境要一起记下来**(针对 "Recalling Too Well" 指出的有损抽取问题)。
3. **夜间整合**(相当于 sleep-time / dreaming):
   - 按 Behavior Latticing 的做法,把新的 L1 按"张力、矛盾、反复出现"分组;
   - 提出或修订 L2、L3 假设,方法同 GUM 的 Revise:新旧假设连同各自的证据一起交给模型重写;
   - 检测矛盾,写下预测,生成判别性追问并放入队列。
4. **每周复核**:
   - 用另一个模型实例做对抗复核,它只负责攻击,不负责建设;
   - 跑覆盖率,找出没有被任何假设解释的观察;
   - 给到期的预测打分,据此调整置信度,该降级的降级、该撤回的撤回。
   - Insight governance 的研究表明,这一步不是可选的:同样的经验积累,有没有这个筛选循环,结果可以从低于 zero-shot 变成大幅提升。
5. **"你眼中的我"回顾**(每月一次,或用户主动发起):列出 L3、L4 和 P,让用户逐条标"对 / 不对 / 别记这个"。
   - 按 intent-mining 的规矩,用户的回答记为 L1 speech。
   - 但在**使用权**上,"不对"和"别记"一票否决:即使证据仍然支持,也不再用它驱动任何行为。"别记"则连同相关证据一起删除。

### 6.4 收到指令时的处理流程

1. **常驻用户卡**(约 800 token 以内):硬约束、已确认的偏好、P 规则。
2. **意图帧**:从字面请求出发,结合 L1' 和相关的 L3,生成几个候选解释,再过一道相关性闸门,问一句"这条记忆会改变这次的答案吗?"(仿 Self-ReCheck,arXiv 2601.13722)。按领域分区检索。
3. **分歧检测**:看字面请求是否和已知偏好或动机冲突;看请求里有没有没说清、而用户模型能补上的地方。
4. **先问还是直接做**:按期望效用决定,当 `P(理解错) × 做错的代价 > 打断的代价` 时才问。
   - 不可逆或高风险的事:必须先问或先确认。
   - 低风险的事:按最可能的解释去做,并把假设说出来,例如:"我按'离会场近'来理解,如果你其实是想省钱,告诉我。"
   - 关于目标的歧义在一开始就问;关于参数的歧义可以边做边问。
5. **个性化计划**:动机影响默认值、排序、附带的可选项和提醒,**不能悄悄改掉目标**。
6. **结果回写**:用户采纳、修改、拒绝或追问,都写回 L1;同时给这次的 L2 意图帧打分(猜对了还是猜错了)。
7. **防迎合检查**:遇到事实判断或评价类问题时,在"不带用户画像"的条件下再答一次,两次答案不一致就标记出来。

### 6.5 主要设计决策与取舍

| # | 决策 | 可选方案 | 建议 | 取舍 |
|---|---|---|---|---|
| D1 | 存储底座 | Markdown 文件 / SQLite + 向量 / 时态图 / typed code | L0、L1 用 SQLite + FTS + 向量;L1' 用双时态表;L3、L4、P 用人能读的文件(或从库渲染成文件),并纳入 git | 文件能读、能 diff,但难做结构化查询;图能力强但运维重,而且在控制检索预算后优势可能消失(arXiv 2607.16848);User-as-Code 适合硬约束,例如过敏和规则冲突 |
| D2 | 写入时机 | 全在热路径 / 全在后台 / 混合 | 混合(§6.3) | 后台写入意味着"懂你"要晚一天;热路径成本高,还容易被当下情绪带偏 |
| D3 | 动机层的可见度 | 全透明 / 只给摘要 / 隐藏 | 全透明,推断项标注清楚;敏感类别默认不推断 | 透明会带来"被看穿"的不适;隐藏则违背可控原则、GDPR 访问权,以及"不愿公开就不能用"这条启发式 |
| D4 | 用户否认推断时 | 删除 / 降级但保留 / 标为"有争议"后保留 | 使用权一票否决;"别记"即删除 | 你的论点是"人说的不一定真",但违背用户明确意愿去"更懂他",会破坏信任,也接近操纵 |
| D5 | 冲突处理 | 覆盖 / 按时间失效 / 并存 | 事实按时间失效;stated 和 revealed 并存 | 并存会增加检索时的裁决成本 |
| D6 | 衰减 | 按时间 / 按访问 / 按证据 | 事实按"被取代"失效;临时状态按性质衰减;动机按预测失败降级 | 单纯用 Ebbinghaus 曲线,会把长期价值观也"忘掉" |
| D7 | 动机如何进入上下文 | 直接注入原文 / 编译成交互策略 | 编译成 P 规则,需要时再检索 L3 原文 | 编译会丢信息,但模型更不容易"过度引用"动机 |
| D8 | 追问强度 | 主动 / 被动 / 预算制 | 预算制,先观察后提问 | 问得太少,假设长期分不出对错;问得太多,让人烦,还会改变被观察者的行为 |
| D9 | 情境中的不同自我 | 一个统一的用户模型 / 按领域分区 | 按领域分区(工作、家庭、健康……),每个 L3 必须注明 scope | 分区能减少跨域泄漏(实测降 8.8%),但可能漏掉跨领域的真实动机 |
| D10 | 由谁推断、由谁复核 | 同一模型自评 / 生成和复核分开 | 生成和对抗复核用不同实例,最好用不同模型;借鉴 ToM-SWE,把建模 agent 和执行 agent 分开 | 成本翻倍 |
| D11 | 训练还是提示 | 纯提示 / 微调小模型做记忆操作 / 训练个人模型 | 先纯提示,等攒够带标签的修订数据再考虑训练 | 微调能提高一致性,但会丢掉可解释性和可删除性 |
| D12 | 底座 | fork OpenClaw / 直接建在 pi 上 | 需要你来定(见 §7) | OpenClaw 自带 Dreaming、来源门禁、`USER.md` 规范,但已经不用 pi 的 agent 包;pi 更干净,但 flush 和 dreaming 都得自己写 |

### 6.6 起步时的最小可行做法

1. 先把 L0、L1、L1' 做扎实:可回溯、双时态、stated 和 revealed 分开、来源分级。没有这一层,上面全是空中楼阁,对应 intent-mining 的门禁①。
2. L3 一开始只开放一个领域,例如工作日程。最多同时维护 5–10 个假设,每个都带预测。
3. 一开始只把 P 规则注入上下文,L3 原文不注入。
4. 从第一天起就记录"说的 ≠ 要的"案例,即用户事后纠正过的指令,作为 §6.7 第 3 项的评估数据。
5. 每周做一次对抗复核,每月做一次"你眼中的我"回顾。

### 6.7 怎么评估"动机挖掘真的有用"

核心问题:**在"事实 + 偏好"之上加了动机层,ergou 是否更少误解你,同时没有变得更烦、更爱附和、更越界?**

1. **分层回归测试,防止退化**:
   - LongMemEval 和 LoCoMo 测 L0 到 L1' 的检索,重点看 knowledge-update 和 abstention 两类题;
   - PrefEval、PersonaMem(-v2)测偏好遵循;
   - OP-Bench、PRISK、PersistBench 测过度个性化和记忆诱发的迎合。
   
   这些基准都不直接测动机推断。
2. **时间切分的预测测试**(对应 intent-mining 的门禁③):
   - 用前 N 周的数据建模,预测之后 M 周的真实选择:是否采纳建议、对草稿往哪个方向改、在给定选项中选哪个。
   - 三个对照组:无记忆 / 事实 + 偏好 / 事实 + 偏好 + L3。
   - 指标:准确率、log-loss、Brier、校准曲线。
   - 借鉴 Park 等人的 1,000 人研究,用**你自己的重测一致性**作天花板来归一化:同一个问题隔两周再问你一次。
3. **"说的 ≠ 要的"回放集**:
   - 收集真实发生过、你事后纠正过的指令。
   - 冻结纠正发生前的记忆状态,用不同的系统变体重新回放。
   - 指标:第一次就被接受的比例、纠正轮数、PRELUDE 式的编辑距离、不必要的澄清问题数。
4. **逐条洞察打分**:
   - 用 Behavior Latticing 的两个 7 点量表给每条 L3 和 L4 打分:"准确"和"揭示了我是谁,而不只是我做了什么"。
   - 再加一项"这让我不舒服"。
   - 跟踪被你否认的比例。注意 Barnum 效应:"觉得准"本身不是正确的证据,第 2、3 项才是。
5. **在线交替实验**:按天交替开关动机层(被试内对照),观察任务成功率、纠正率、主动建议的采纳率,以及被忽略或关掉的提示数量。
6. **护栏指标**(任何一项变差都不应上线):
   - 过度个性化率;
   - 对错误主张的附和率;
   - 敏感推断泄漏;
   - 注入鲁棒性(MINJA 式测试);
   - 跨领域泄漏。

**判定标准**:动机层必须在第 2、3 项上显著优于"事实 + 偏好"基线,并且第 6 项没有变差。否则它只是一个更会讲故事的用户画像。目前最接近的公开证据是 Behavior Latticing:"满足深层需求"的评分从 3.84 升到 4.60,即时效用持平;但只有 12 人,稳健性分析显示效应很小(https://arxiv.org/html/2604.07629 )。

---

## 7. 需要你决定的开放问题

1. **底座**:fork OpenClaw,还是直接建在 pi 上?OpenClaw 已有 Dreaming、来源门禁、`USER.md` 规范和群聊隔离,但已经不再依赖 pi 的 agent 包。直接用 pi,这些都要自己移植。
2. **用户否认推断后怎么办**:是"使用权一票否决、证据保留",还是"连证据一起删除"?这是你的论点("人说的不一定真")和用户自主之间最直接的冲突点。
3. **透明到什么程度**:L3、L4 是全部展示给你,还是只展示派生出来的 P 规则?推断出的"内核"给你看,会不会改变你自己的行为(观察者效应)?
4. **敏感类别**:健康、情绪、关系、财务,哪些允许推断?默认关闭之后,怎样开启?
5. **追问预算**:每天或每周最多问几次?哪些场景绝对不问?
6. **领域分区怎么划**:L3 是否允许跨领域?跨领域的动机由谁来批准?
7. **多人场景**:群聊里出现的其他人,要不要建模?(建议不要。按 GDPR 和上下文完整性,对第三方做画像风险最大。)
8. **评估投入**:是否愿意花时间做每月一次的回顾和重测一致性的问卷?没有这些数据,动机层是否有用就无法判断。
9. **与 intent-mining 怎么复用**:离线的 intent-mining(人工驱动、做得深)和在线的 ergou 记忆(自动、要轻)用同一套 schema 吗?如果用同一套,哪些检查器(覆盖率、独立性、对照对)可以每周自动跑?

---

## 附录 A:未核实或仅核到摘要的条目

- OpenAI 迎合事故复盘中关于记忆的原文措辞(页面 403,依据检索摘要)。
- OpenAI 记忆 FAQ 原文(一路子调研通过浏览器读到,另一路被 403 拦住)。
- Zep Observations 的失效机制;MemOS Lifespan 的默认策略和 2.0 版的基准设置;mem0 Platform 是否把 profile summary 传进 prompt。
- Supermemory、MemOS 2.0、Hindsight、mem0 v3 的基准数字(都是厂商自报)。
- MIRIX dashboard 的细节;Second Me 是否有面向用户的纠错界面。
- Schwartz 19 种价值的具体细节;Forer 原研究的评分;5 Whys 的原始出处;Warshaw 2015 的结论。
- LadderChat、LLMREI 的细节;PRISM 中陈述偏好与情境偏好的相关结论。
- GDPR 家庭例外是否适用;EU Digital Omnibus 的最终状态。
- 2026 年的大部分 arXiv 论文只核对了摘要页,正文细节没有逐一核对。

## 附录 B:与 intent-mining 的映射

| intent-mining | 本文架构 | 说明 |
|---|---|---|
| L1 表象(fact,verified + basis: stated) | L0 + L1 | 门禁①"材料能否被重复检索"对应 L0 只追加,以及 L1 带定位 |
| (无对应) | L1' 事实与偏好 | 在线 agent 需要的操作层;用户明说的偏好在"怎么服务"上是权威(§6.0) |
| L2 动机·情境(上限 unverified) | L2 情境意图 | 短 TTL,用用户的反应回填对错 |
| L3 真实需求(上限 conditional) | L3 | 竞争假设、预测、置信上限 |
| L4 内核(上限 conditional) | L4 | 门槛更高,必须用户确认才能使用 |
| M1 表象里不许夹带解释 | L1 抽取规则 | 抽取 prompt 中明确禁止写解释 |
| M2 L2 及以上不得 verified | 置信上限 + status 枚举 | user_confirmed 也只是 L1 speech,不等于 verified |
| M4/M5 判别性追问 + probes | M 层的追问队列 + §3.4 | 先观察后提问,有预算 |
| M10 依据必须相互独立 | L3 的 supports 要求来源独立 | Laddering 的 k 条独立证据 |
| M14 建 L4 时必须写一条预测 | predictions 账本 | 每周复核时打分 |
| 对抗复核 / 覆盖率 / 停止规则 | §6.3 第 4 步每周复核 | 生成与复核分开 |
| "真人的回答是新的表象" | §6.3 第 5 步 + §6.0 | 回答记为 L1 speech;但在使用权上,"否认"和"别记"一票否决 |
| 门禁③ 理解还是预测 | §6.7 第 2 项时间切分测试 | 要声称"有预测力",就必须留出保留集 |
