# 11 · 现成用户建模系统深挖：Honcho、GUM、Behavior Latticing

- 调研日期：2026-10-07
- 对应内部议题：记忆 01
- 与 05 的关系：调研 05 §1.3 已有这三个系统的概览。本文往下挖到字段名、prompt 原文、触发条件，以及**代码和论文对不上的地方**。05 写过的数字不重复展开。
- 方法：
  - 三个仓库都 clone 到本地逐文件读，版本见下表。
  - 论文读 PDF 全文，不只看摘要页。
  - Honcho 文档读的是仓库里的 mdx 源文件，和 docs.honcho.dev 同源。
  - WebSearch 只用来找 Plastic Labs 博客的地址。
- 标注：
  - 【未核实】：没读到一手原文。
  - 【代码阅读推断】：根据源码推出来的行为，作者没有明说，我也没有实际运行过。
  - 【代码搜索】：在仓库里用 grep 确认过"有"或"没有"。
  - "厂商自报"：基准数字由厂商自己发布，没有第三方复现。

| 系统 | 代码 | 版本 / 提交 | 论文与文档 |
|---|---|---|---|
| Honcho | [plastic-labs/honcho][hrepo] | v3.2.2（2026-09-29）；main @ `e2d2aba`（2026-10-06） | 仓库内 `docs/v3`；VoE 论文 [arXiv 2310.06983][voe]；Plastic Labs 博客 |
| GUM | [GeneralUserModels/gum][grepo] | main @ `3317d94`（2026-05-11） | [arXiv 2505.10831v3][gp]（UIST '25） |
| Behavior Latticing | [StanfordHCI/lattice][brepo]（PyPI `latticing`） | main @ `0d6c946`（2026-04-28） | [arXiv 2604.07629v1][bp]（2026-04-08） |

---

## 0. 结论速览

1. **三家都没有 ergo 想要的那种"命题记录"，但各自提供了一部分零件。**
   - Honcho 的 conclusion：
     - 有证据链：`message_ids` 指向来源消息，`source_ids` 指向前提结论。
     - 有强化计数 `times_derived`。
     - 没有数值置信度。只有 inductive 层带 `high/medium/low`，而且是按证据条数定的。
     - 没有 status，没有衰减，没有修订历史。被替代的行先软删除，再由 reconciler 硬删除（[models.py][hm]；[document.py][hdoc]；[specialists.py][hsp]）。
   - GUM 的 `Proposition`：
     - 有 `confidence`、`decay`、`reasoning`，和观察是多对多链接。
     - 还预留了 `revision_group` 和 `version` 两个字段。
     - 但开源代码里，Revise 的做法是删掉旧命题、新建命题，`version` 永远是 1（[gum.py][gc]）。
   - Behavior Latticing 的 insight：
     - 有 `context`（适用情境）字段和多层证据边。
     - 没有置信度。
     - 代码只实现了 forward pass，`backward()` 直接返回 `"Backward pass not implemented"`（[Lattice.py][bl]）。
   - 结论：字段可以拼起来用。但**状态机、修订历史、用户裁决**这三样，ergo 必须自己做。
2. **Honcho 的 "dialectic" 指的不是"向用户求证"。**
   - 2024-03 的发布文把它定义为 "Agent-to-agent chat over users"，全文没有向用户提问的环节（[博客][pld]）。
   - 今天代码里唯一涉及"问用户"的地方，是 dialectic system prompt 里的一句话：发现矛盾时 "Ask the user which statement is correct"（[dialectic/prompts.py][hdlp]）。这只是教回答模型怎么措辞，系统里没有追问队列。
   - "先预测、再看预测是否落空、再从中学习"这套机制，出现在 Plastic Labs 2023 年的 VoE 论文里（[voe]）。当前代码中已经找不到它【代码搜索】。
3. **Honcho 的演进方向是"收窄"。**
   - peer card 现在只允许 `IDENTITY:`、`ATTRIBUTE:`、`RELATIONSHIP:`、`INSTRUCTION:` 四种前缀，明令禁止 `TRAIT:` 和推断出的行为偏好（[specialists.py][hsp]）。
   - deriver 只抽 explicit 事实，并且要求 "never derive a fact about the target peer from what another peer said"（[deriver/prompts.py][hdp]）。
   - dreamer 不能生成 explicit 层的结论（[agent_tools.py][htools]）。
   - 这和 OpenClaw `USER.md` 的 "Do not turn the file into a dossier" 是同一个取向（调研 05 §1.5）：常驻上下文只放用户明说的东西，推断出来的东西留在可检索层。
4. **GUM 的论文和开源代码有三处对不上。** 05 引用的 GUM 机制里，有一部分只存在于论文中。
   - Audit 模块在代码里默认关闭，而且没有任何调用点【代码搜索】。
   - decay 的语义方向反了：prompt 里 decay=10 表示"长期有效"，公式里 decay 越大衰减越快。
   - 论文说"置信度降到 0 的命题仍然保留，以示透明"；代码的做法是直接删除。
5. **Behavior Latticing 的 L0"观察"里其实混进了推断。** Observer 的 prompt 要求模型写 `think_feel`（他在想什么、感觉如何）。代码把它和 `actions` 拆成两个叶子节点，两者共用同一个 confidence（[Observer.py][bo]；[prompts.py][bpr]）。按四层动机模型的 M1（表象里不许夹带解释），这一层已经不是纯 L1。
6. **对 ergo 最值得借的零件**（详见 §6）：
   - **Honcho**：
     - 推理边 `DocumentSource` 和 `get_reasoning_chain` 工具；
     - "只有消息摄入能写 explicit"这条不变量；
     - 写入前剥离伪造的证据 ID；
     - dreaming 的调度规则：新增 50 条 explicit、冷却 8 小时、空闲 60 分钟，期间来新消息就取消；
     - 删除数据后用 rebuild 模式重建卡片。
   - **GUM**：
     - retrieve → 判 IDENTICAL / SIMILAR / UNRELATED → 带证据 revise 的管线；
     - 保守的置信度提示语。
   - **Behavior Latticing**：
     - 先按"张力、矛盾、重复"分组，再推断动机；
     - insight 的 `context` 字段；
     - 指令时只注入 top-2 条 insight。
   - **VoE**："预测下一步 → 与实际比较 → 从预测落空中学习"，正好可以用来生成澄清问题。
7. **三家都没有把"动机判断"变成问题去问用户。** 但 GUM 和 BL 的参与者、作者都提出过这个需求：
   - GUM 的 P3："if it asked and then used that to give me a suggestion I think I would've been happier"（[GUM][gp] §8.3）。
   - BL 的作者："involving the user in insight generation"（[BL][bp] §8.4.3）。

   用户的立场是"判断可以低置信，但必须生成澄清问题"。这块在三家里都是空白，没有现成实现可抄，但三家的失败案例可以直接当作设计约束（§6.3）。

---

## 1. Honcho（Plastic Labs）

### 1.1 谱系与运行时

**谱系**

| 时间 | 节点 | 来源 |
|---|---|---|
| 2023-10 | VoE 论文，在 AI 导师 Bloom 上做"预测-违背"实验 | [voe] |
| 2024-03-26 | Dialectic API 发布 | [pld] |
| 2025-06 | v2.0.0：peer 范式取代 user（"Peers replace users"） | [CHANGELOG][hcl] |
| 2025-08-19 | 博客 "Memory as Reasoning" | [plm] |
| 2026-01-19 | v3.0.0：Agentic Dreamer、Agentic Dialectic；Observations 改名为 Conclusions | [CHANGELOG][hcl] |
| 2026-09-29 | v3.2.2 | [CHANGELOG][hcl] |

**运行时**有两个进程，共享 Postgres 和 Redis（[CLAUDE.md][hc]）：

- API server：处理 HTTP 请求，dialectic 在请求路径上同步运行。
- deriver worker：从队列消费任务，运行 Deriver、Summarizer、Dreamer，进程内还托管 Reconciler 调度器。

**默认模型**：deriver、两个 dreamer specialist、dialectic 的各个级别，默认都是 `openai/gpt-5.4-mini`（[CHANGELOG][hcl] 3.0.7 #459）。文档说 explicit 抽取用的是他们自训的 Neuromancer XR（[reasoning.mdx][hdreason]）。托管版现在实际用哪个模型【未核实】。

**术语**：对外 API 叫 conclusion，代码里叫 observation / document。所有结论存放在以 `(observer, observed)` 为键的 collection 中（[CLAUDE.md][hc]）。

### 1.2 一条"关于用户的命题"长什么样

#### conclusion（`models.Document`）

| 字段 | 类型 / 取值 | 含义 | 来源 |
|---|---|---|---|
| `id` | 21 位 nanoid | — | [models.py][hm] |
| `content` | TEXT，≤65535 | 结论文本 | [models.py][hm] |
| `level` | `"explicit" \| "deductive" \| "inductive" \| "contradiction"` | 推理层级 | [types.py][hty] |
| `times_derived` | int ≥1 | "Number of times this conclusion has been independently derived"；语义去重命中时 +1 | [api.py][hapi]；[document.py][hdoc] |
| `observer` / `observed` | peer 名 | 谁的视角、关于谁 | [models.py][hm] |
| `session_name` | 可空 | explicit 带所属会话；dream 产物 "synthesized across all sessions"，没有所属会话 | [models.py][hm]；[CHANGELOG][hcl] 3.0.12 |
| `created_at` / `deleted_at` | 时间 | `deleted_at` 是软删除标记，之后由 reconciler 硬删 | [document.py][hdoc] |
| `internal_metadata.message_ids` | 消息 ID 区间列表 | 指回原始消息；"as a document gets deduplicated, additional ranges will be added" | [internal.py][hti] |
| `internal_metadata.message_created_at` | 时间 | 来源消息的时间，不是结论的创建时间 | [internal.py][hti] |
| `internal_metadata.premises` / `sources` | 文本列表 | 人读的前提（deductive）/ 来源（inductive） | [internal.py][hti] |
| `internal_metadata.pattern_type` | `preference \| behavior \| personality \| tendency \| correlation` | inductive 专用 | [internal.py][hti] |
| `internal_metadata.confidence` | `high \| medium \| low` | inductive 专用 | [internal.py][hti] |
| `source_links` → `DocumentSource(derived_id, source_id, position)` | 边表 | 推理树的边，有顺序。"Deliberately not an FK: the dreamer can emit IDs that never resolve" | [models.py][hm] |
| `embedding`、`sync_state`、`last_sync_at`、`sync_attempts` | — | 向量同步状态 | [models.py][hm] |

**对照票里要求的字段：**

| 票要求的字段 | Honcho 有没有 | 说明 |
|---|---|---|
| 文本 | 有 | `content` |
| 置信度 | 只有 inductive 层有 | 按证据条数定："low (2 sources), medium (3-4), high (5+)"（[specialists.py][hsp]） |
| 证据链接 | 有 | 消息 + 父结论，有顺序 |
| 衰减 | **没有** | 没有 TTL，也没有时间衰减；过时的结论靠 dreamer 删除 |
| 来源 | 有 | `observer` / `observed` / `session_name` / `message_ids` |
| 状态 | **没有** | 只有软删除标记 |
| 修订历史 | **没有** | 被替代的行最终硬删 |

**证据条数的校验：**

- 代码要求：deductive 和 inductive 至少 1 个 `source_ids`，contradiction 至少 2 个（`ObservationInput.validate_level_fields`，[internal.py][hti]）。
- 写入前还会把解析不到真实文档的 ID 剥离掉。剥离后的最低条数是 `min_sources = 2 if obs.level == "contradiction" else 1`（[agent_tools.py][htools]）。
- 但 induction 的 prompt 写的是 "Minimum 2 source observations required"（[specialists.py][hsp]）。所以对 inductive 来说，"至少 2 条证据"只是 prompt 层面的约束，代码不强制【代码阅读推断】。

#### peer card（常驻的"用户卡"）

格式限制（[agent_tools.py][htools] `_validate_peer_card_entry`）：

- 类型是 `list[str]`，最多 40 条（`MAX_PEER_CARD_FACTS = 40`），每条不超过 200 字符。
- 每条必须以四种前缀之一开头，否则在结构层面直接拒绝。

写卡规则摘自 `PEER_CARD_SYSTEM_SECTION`（[specialists.py][hsp]）：

- **Stable**："If the value plausibly changes within six months absent a deliberate announcement, it does not belong on the card."
- **Evidence-grounded**："Only write what the target observee has explicitly stated, or what another participant has explicitly stated about the target observee with the target observee's assent."
- **No behavioral content**："TRAITs, behavioral tendencies, patterns, and inferred preferences belong in observations, not on the peer card."
- `INSTRUCTION:` 一类："Only when explicit; never inferred from behavior."

其他事实：

- 只有 deduction specialist 能写卡。induction specialist 被 `can_update_peer_card = False` 排除在外（[CHANGELOG][hcl] 3.0.7 #686）。
- 文档 [representation.mdx][hdrep] 还在说卡里放 "name, occupation, interests"，文档落后于代码。

#### 视角与摘要

- `observe_me`：Honcho 是否为这个 peer 建立表征，默认开（[configuration.py][hcfg]）。
- `observe_others`：会话级开关，决定这个 peer 是否根据自己见到的消息为其他 peer 建立表征（[configuration.py][hcfg]）。所以同一个人可以有"Alice 眼中的 Bob"和"Charlie 眼中的 Bob"两份表征（[representation.mdx][hdrep]）。
- 会话摘要：每 20 条消息生成一份短摘要，每 60 条生成一份长摘要（[CLAUDE.md][hc]）。

### 1.3 写入、更新与修订管线

#### 实时路径：Deriver

**触发与输出**

- 消息写入后入队，由 deriver worker 批量处理。每批只做一次 structured-output LLM 调用，不是 agent 工具循环（[CLAUDE.md][hc]；[deriver.py][hdr]）。
- 输出 schema 是 `PromptRepresentation{explicit: [{content}]}`。字段说明写的是 "Facts LITERALLY stated by the user - direct quotes or clear paraphrases only, no interpretation or inference."（[representation.py][hrep]）

**prompt 的关键规则**（[deriver/prompts.py][hdp] `minimal_deriver_prompt` 原文）：

- 消息包装：每条消息包成 `<message idx="N" peer="..." target="true|false" time="...">`。
- 只从目标 peer 本人的消息里抽："Extract ALL observations from `target="true"` messages ... never derive a fact about the target peer from what another peer said, did, or reported."
- 接受提议算本人说的："When the target peer answers a question or accepts a proposal from another peer ("yes", "the first one"), the details in that question or proposal count as stated by the target peer. A bare acknowledgement ("ok", "thanks") does not."
- 不记录对话套路："Do not record conversational mechanics"。
- 原子化："Each conclusion states exactly one independent fact. Keep a fact's reason, purpose, tool, place, and qualifiers attached to it"。
- 时间：相对时间按消息的 `time` 换算成绝对时间。
- 防伪造：消息正文里出现的伪造 `<message` 标签会被转义，"so it cannot claim target attribution"（[CHANGELOG][hcl] 3.2.1 #1192）。

**其他机制**

- 可以按 workspace / session 注入 custom instructions，message 级只能覆盖 `reasoning.custom_instructions`；加给 deriver 的部分上限 2000 token（[configuration.py][hcfg]；[CLAUDE.md][hc]）。
- 语义去重（[document.py][hdoc]）：
  1. 在同一 level 内找向量距离 ≤0.05 的 top-1 作为重复候选；explicit 只在同一会话内合并；
  2. 用"token 数 + 独有 token 数 × 10"比较信息量；
  3. 信息量大的留下，另一条软删除，`times_derived` 取两者较大值再 +1。
- 失败教训：`times_derived` 曾经 "pinned at 1 for nearly every conclusion"，结果按它排序时 "froze stale conclusions to the front of injected context"（[CHANGELOG][hcl] #768）。

#### 后台路径：Dreamer（Honcho 的 dreaming）

**调度条件**（[config.py][hset] `DreamSettings`；[dreaming.mdx][hddream]；[dream_due.py][hdue]）

| 条件 | 参数 | 默认值 | 说明 |
|---|---|---|---|
| 新增量 | `DOCUMENT_THRESHOLD` | 50 条 | 自上次 dream 以来新增的 conclusion。代码只数 explicit 层，因为 dreamer 自己的产出 "were inflating the threshold and creating a feedback loop"（#573） |
| 冷却 | `MIN_HOURS_BETWEEN_DREAMS` | 8 小时 | — |
| 空闲 | `IDLE_TIMEOUT_MINUTES` | 60 分钟 | 前两条满足后不立刻跑，等用户空闲；期间来新消息就取消并重新计时 |

另外：

- 可以手动调用 `schedule_dream`，跳过阈值和冷却，但仍然去重；同一对 (observer, observed) 不会并发跑两次 dream。
- 文档明确标注 "Dreaming is an experimental feature"（[dreaming.mdx][hddream]）。

**一次 dream 的步骤**（[orchestrator.py][hor]；[specialists.py][hsp]）

0. **可选的 surprisal 采样**（`SURPRISAL.ENABLED=False`，默认关闭）：
   - 对最近 200 条 explicit / deductive 结论的 embedding 建树，取几何"惊奇度"最高的前 10%。
   - 把这些结论的内容截到 200 字，作为最多 10 条 hints 交给后面的 specialist（[config.py][hset]）。
   - 这一步曾因过滤语法写错，"silently returned 0 results and made the entire Surprisal phase of the Dream cycle a no-op"（#581）。
1. **DeductionSpecialist**（最多 12 轮工具调用）：
   - Knowledge updates："Create a deductive update observation; DELETE the outdated observation immediately"。
   - Logical implications。
   - Contradictions："When statements can't both be true (not just updates), flag them"。
   - 更新 peer card。
2. **InductionSpecialist**（最多 10 轮）：
   - 归纳 behavioral patterns、preferences、personality traits、temporal patterns。
   - prompt 原话："Think like a psychologist identifying behavioral tendencies"。
   - 输出字段：`source_ids`、`sources`、`pattern_type`、`confidence`。

两个 specialist 都是工具循环，能用的工具有 `get_recent_observations`、`search_memory`、`search_messages`、`create_observations_*`、`delete_observations`。

**写入守卫**（[agent_tools.py][htools]）

- Session-purity invariant："Only message ingestion can create 'explicit' observations"。
- 伪造 ID 剥离：剥离伪造的 `source_ids`；剥离后剩余条数不够最低要求，就拒绝这条结论。理由是 "a dangling id becomes permanent false provenance"（#945）。

**删除之后怎么办**

- `card_refresh` 类型的 dream：只刷新 peer card；`rebuild=True` 时不给模型看旧卡，"reconstruct the card solely from observations currently in the collection"（[CHANGELOG][hcl] 3.0.12；[specialists.py][hsp] `CardRefreshSpecialist`）。
- 删除级联：把会话移出 scope 时，"fail-closed cascades to derived documents whose source_ids intersect anything removed, then enqueues a `card_refresh` dream with `rebuild=True`"（[CHANGELOG][hcl] 3.1.0 #904）。

#### 矛盾与取代

| 情形 | 处理方式 | 旧条目 | 来源 |
|---|---|---|---|
| 同一事实出现新值 | 新建一条 deductive "更新"结论，用 `source_ids` 同时指向旧值和新值 | 删除旧的 explicit | [specialists.py][hsp]；dialectic prompt："These observations link to both old and new values via `source_ids`"（[dialectic/prompts.py][hdlp]） |
| 两条陈述不可能同时为真 | 新建一条 `contradiction` 层结论，`source_ids` ≥2 | 双方都保留 | [internal.py][hti]；[representation.py][hrep] `ContradictionObservation`："notes when user has made conflicting statements" |
| 用户纠正错误事实（Hermes 插件） | 不删，写一条更正结论 | 保留 | [tool_schemas.py][hhert] `honcho_conclude`："Deletion exists only for PII removal — for merely wrong facts, write a corrected conclusion instead; Honcho self-heals contradictions over time" |

### 1.4 "Dialectic"到底是什么：Honcho 怎样求证

#### 原始定义（2024-03-26 博客，[pld]）

- "A *dialectic* process is one where two parties seek to arrive at the truth via reasoned dialogue."
- 对话双方是两个 agent："Agent-to-agent chat over users."
- 调用方可以发的查询包括：
  - "A single or list of question(s) about the user"
  - "A user insight to inject directly into a prompt"
  - "A theory of mind prediction about the user's state or behavior"
- 全文没有描述向用户本人提问。

#### 今天的实现

**接口**（[api.py][hapi]；[chat.mdx][hdchat]）

- 端点：`POST /v3/workspaces/{w}/peers/{peer_id}/chat`。
- 请求体 `DialecticOptions` 的字段：
  - `query`：问题文本；
  - `reasoning_level`：`minimal | low | medium | high | max`，默认 `low`；
  - `target`：从哪个 peer 的视角回答；
  - `session_id` / `filters` / `scope`：限定召回范围；
  - `stream`：是否流式；
  - `include_evidence`：是否返回证据（见 §1.5）。

**DialecticAgent**（[agent_tools.py][htools] `DIALECTIC_TOOLS`）

- 在请求路径上跑工具循环。
- 可用工具：`search_memory`、`search_messages`、`get_observation_context`、`grep_messages`、`get_messages_by_date_range`、`search_messages_temporal`、`get_reasoning_chain`。minimal 级只给前两个。
- 写结论的工具 `create_observations_deductive` 在列表里被注释掉了，所以 dialectic 是只读的。

**system prompt 要点**（[dialectic/prompts.py][hdlp]）：

- 偏好优先：遇到建议、推荐类问题，先搜 "prefer"、"like"、"want"、"always"、"never"。
- 检查前提：对 deductive / inductive 结论调用 `get_reasoning_chain` 查看前提，"If the premises seem weak or outdated, note that uncertainty"。
- 矛盾："DO NOT pick one version ... Present BOTH pieces of conflicting information explicitly ... Ask the user which statement is correct"。
- 更新："The MORE RECENT statement supersedes the older one"。
- 弃权："A confident "I don't know" is ALWAYS correct; giving a fabricated answer is ALWAYS wrong."

#### 宿主怎样用 dialectic"自问自答"

Hermes 插件的 dialectic depth 是多轮问答（[dialectic.py][hherd] `_build_dialectic_prompt`、`_signal_sufficient`）：

| 轮次 | 问 Honcho 什么 |
|---|---|
| pass 0（冷启动） | "Who is this person? What are their preferences, goals, and working style?" |
| pass 0（已有上下文） | "what context about this user is most relevant to the current conversation?" |
| pass 1：gap audit | "What gaps remain in your understanding that would help going forward?" |
| pass 2：reconciliation | "Do these assessments cohere? Reconcile any contradictions and produce a final, concise synthesis" |

提前停止条件：上一轮结果超过 100 字且有结构（标题或列表），或者超过 300 字。整个过程是 agent 对 Honcho 的多轮提问，依旧不问用户。

#### VoE 前史（[voe]）

**机制**：每一轮对话有两个任务。

- 任务 1：预测与修订。
  1. 先生成一段 ToM "thought"，内容包括：对用户内在状态的推理、用户下一条输入的几种可能、"A list of any additional data that would be useful to improve the prediction"。
  2. 用最后这份清单去检索以往存下的 VoE 事实。
  3. 结合检索到的事实，修订预测。
- 任务 2：从违背中学习。
  1. 用户真实输入到来后，生成一段"预期是怎样被违背的" thought。
  2. 据此生成关于用户的事实。
  3. 做一次冗余检查，写入向量库。

**A/B 实验结果**：

| 项目 | VoE 组 | 对照组 |
|---|---|---|
| 对话数 | 59 段 | 55 段 |
| 消息数 | 329 条 | 637 条 |

- VoE 组的 "wrong" 评级少 22.4%。
- 卡方检验：χ²(1, 927)=5.97，p<.05。

**局限**：

- 做预测的和当裁判的是同一个 GPT-4。
- 作者承认 VoE 版的额外延迟 "likely contributed to the reduction in conversation turns to nearly half"。

**和当前代码的关系**：

- 当前 `src/` 里没有 predict 或 VoE 相关逻辑【代码搜索】。
- 文档声称系统会产出 abductive 结论（[reasoning.mdx][hdreason]），但代码的 `DocumentLevel` 里没有 abductive。`utils/filter.py` 只在注释里把 "abduction" 当作一个假想的、将来可能加的 level（[filter.py][hflt]）。

**小结**：Honcho 的"求证"是对**存储**的求证（查前提链、回查原消息、标出矛盾），不是对**人**的求证。

### 1.5 指令时怎么用

**三种取用方式**

1. **预取后注入**：
   - `session.context(tokens, summary, peer_target, peer_perspective, search_query)` 返回摘要、消息、`peer_representation`（字符串）、`peer_card`（[get-context.mdx][hdctx]）。
   - `POST /peers/{id}/representation` 支持 `search_query`、`search_top_k`、`max_conclusions`、`include_most_frequent`（[api.py][hapi]）。
2. **注入 dialectic 的回答**：把 `peer.chat(query)` 返回的自然语言答案放进 prompt。
3. **工具调用**：让执行 agent 自己按需调用。

**representation 的文本格式**（[representation.py][hrep] `Representation.__str__`）：

- 分 `EXPLICIT:`、`DEDUCTIVE:`、`INDUCTIVE:`、`CONTRADICTION:` 四段编号列表，每条前面带 `[时间戳]`。
- deductive 条目下面缩进列出前提。
- inductive 条目前缀 `[high|medium|low]`。
- 矛盾条目前缀 `CONTRADICTION:`。

**三个宿主的集成方式**

| 宿主 | 注入点 | 默认注入什么 | 工具 | 来源 |
|---|---|---|---|---|
| Hermes | `system_prompt_block` + `prefetch` | 五个段落：`## Session Summary`、`## User Representation`、`## User Peer Card`、`## AI Self-Representation`、`## AI Identity Card`。`recallMode` 可选 `hybrid` / `context` / `tools`，默认 `hybrid` | `honcho_profile`、`honcho_search`、`honcho_context`、`honcho_conclude` | [hermes.mdx][hdoc-her]；[\_\_init\_\_.py][hher] `_CONTEXT_SECTIONS` |
| OpenClaw | `before_prompt_build` | workspace 级上下文，在每次 prompt 前自动注入 | `honcho_context`（`detail='card'` 或 `'full'`）、`honcho_search_conclusions`、`honcho_search_messages`、`honcho_session`、`honcho_ask`（`depth='quick'` 或 `'thorough'`） | [openclaw.mdx][hdoc-oc]；[openclaw-honcho README][och] |
| pi（`@honcho-ai/pi-honcho`，要求 pi 1.0+） | 会话开始 + 每轮 | 会话开始：peer card + 会话摘要。每轮：默认对用户消息跑一次 dialectic（`medium` 级），也可改为注入最多 15 条 conclusion。注入内容在对话里显示为可折叠的 `◆ honcho` 条目；每轮最多等 30 秒 | `honcho_chat`（并行问 1–5 个问题）、`honcho_search` | [pi-honcho README][pih] |

**审计：`include_evidence=true`**（[evidence.mdx][hdev]）

- 返回内容：dialectic 读过的 conclusions、messages（只有 ID，没有正文），以及成功的工具调用。
- "evidence over-reports"：读过不等于用过。
- 作者特意不让模型自报引用，因为 "Weaker models and lower reasoning levels produce incomplete citations, invented IDs, or none at all"。

### 1.6 隐私控制

**建模开关**

- `observe_me=false`：不为该 peer 做推理（[configuration.py][hcfg]）。
- `reasoning.enabled`：可以在 workspace、session、message 三级关闭。message 级的配置覆盖其他各级；deriver 在 `reasoning.enabled is False` 时直接返回，不处理（[configuration.py][hcfg] `MessageConfiguration`；[deriver.py][hdr]）。
- 另有 `peer_card.use` / `peer_card.create`、`dream.enabled` 两组开关（[configuration.py][hcfg]）。

**读取隔离**

- `scope` 和会话 allowlist 都是 fail-closed。
- 在 allowlist 下，召回只限 explicit 层，`get_reasoning_chain` 不可用。原因是 dream 产物跨会话合成，无法判断它属于哪个会话（[CHANGELOG][hcl] 3.0.12 #882）。
- JWT 可以限定到 workspace / peer / session 级别（[CLAUDE.md][hc]）。

**删除**（[deleting-data.mdx][hddel]）

- 能删：session、workspace、单条 conclusion。
- 不能删："Peers and individual messages cannot be deleted"。
- 删会话不等于删干净："Deleting a session does **not** erase everything Honcho learned in it"。explicit 结论随会话一起删除；deductive / inductive / contradiction 存在 workspace 级，"survive session deletion"，要逐条手动删。

**其他**

- 自托管：可以完全在本地运行（[openclaw.mdx][hdoc-oc]）。
- 第三方建模：OpenClaw 插件在群聊中按 `sender_id` 给每个参与者建 peer，"This gives every participant — humans and any other bots in the room — their own memory and representation in Honcho"（[openclaw-honcho README][och]）。
- 敏感类别：deriver 和 dreamer 的 prompt 里没有关于健康、宗教、政治等敏感类别的过滤指令【代码搜索：`src/deriver/prompts.py`、`src/dreamer/specialists.py`】。
- VoE 论文 §7.4 提出过加密、用户持有密钥、Shamir 秘密分享、TEE、基于属性的访问控制等方向。这些在当前代码中是否实现，本文没有逐项核对【未核实】。

### 1.7 失败模式与评测

**代码层面的事故**（都记在 [CHANGELOG][hcl] 里，都已修复）

| 编号 | 问题 |
|---|---|
| #768 | `times_derived` 失效，导致陈旧结论被长期置顶注入 |
| #581 | surprisal 阶段因过滤语法错误，整段静默空转 |
| #573 | dreamer 把自己的产出计入触发阈值，形成自激循环 |
| #945 | dreamer 伪造 `source_ids`，留下永久的虚假来源 |
| #1192 | 靠名字前缀判断说话人，存在被消息内容冒充的风险 |

另外，Hermes 插件不得不专门过滤 summarizer 泄漏出来的规划文本："Honcho summarizers can persist the model's planning text and a trailing `</think>` as the summary body"（[session_context.py][hhers] `usable_honcho_summary`）。

**文档与代码不一致的地方**

- abductive 结论：文档有，代码没有（§1.4）。
- deriver 的产出：[reasoning.mdx][hdreason] 说 deriver "extracts explicit and deductive conclusions"，当前 prompt 只抽 explicit。
- peer card 的内容：见 §1.2。

**评测**（厂商自报，[honcho.dev/evals][hev]，2025-12，原始结果文件在 [honcho-benchmarks][hbench] 的 `a1d689b/` 目录）

| 基准 | Honcho | 基线（Claude Haiku 4.5） |
|---|---|---|
| LongMemEval-S 总分 | 90.4% | 62.6% |
| 其中 single-session-preference | 90.0% | 23.3% |
| LoCoMo | 89.9% | 75.6% |
| BEAM 100K | 0.630 | 0.533 |
| BEAM 500K / 1M / 10M | 0.646 / 0.618 / 0.409 | — |

- BEAM 100K 里的 knowledge update 能力只有 46.3。
- 这些基准测的都是事实召回和偏好遵循，**不测"对用户动机的推断是否正确"**。

VoE 论文的评测局限见 §1.4。

---

## 2. GUM（General User Models）

### 2.1 定位

**论文**（[GUM][gp]）

- 作者：Shaikh、Sapkota、Rizvi、Horvitz、Park、Yang、Bernstein；发表于 UIST '25。
- 输入：任意非结构化的观察，主要是屏幕截图。
- 输出："confidence-weighted natural language propositions"。
- 四个模块：Propose、Retrieve、Revise、Audit。
- 部署立场："All data stays securely on the user's device"。

**代码**

- observer 有 `Screen` 和 `Calendar` 两种（[screen.py][gsc]）。
- 存储用 SQLite + FTS5（[models.py][gm]）。
- LLM 调用走 OpenAI 兼容接口（[gum.py][gc]）。

### 2.2 数据结构

ORM 定义（[models.py][gm]）：

- `Observation`：`id`、`observer_name`、`content`、`content_type`、`created_at`、`updated_at`。
- `Proposition`：`id`、`text`、`reasoning`、`confidence`（int，1–10）、`decay`（int，1–10）、`created_at`、`updated_at`、`revision_group`（36 字符 UUID，有索引）、`version`（int，默认 1）。
- `observation_proposition`：观察与命题的多对多关联表。
- 全文索引：`propositions_fts(text, reasoning)` 和 `observations_fts(content)`，用 porter 分词。

论文对两者的区分（[GUM][gp] §3.1）：

- "Propositions are the assumptions, in text, that GUM constructs through observation."
- 观察则是 "factual records, not inferences"。
- "Each proposition includes grounding: observations supporting the inference, plus generated reasoning"。

**对照票里要求的字段：**

| 票要求的字段 | GUM 有没有 | 说明 |
|---|---|---|
| 文本 | 有 | `text` |
| 置信度 | 有 | 1–10，论文归一化到 0–1 |
| 证据 | 有 | 多对多关联 + `reasoning` |
| 衰减 | 有 | `decay` |
| 来源 | 很粗 | 只有 `observer_name`（哪个 observer 产生的） |
| 状态 | **没有** | — |
| 修订历史 | **字段有，语义没实现** | `revision_group` / `version` 见 §2.3 |

### 2.3 写入与修订管线

1. **观察**：
   - Observer 产生 `Update(content, content_type: input_text | input_image)`。
   - Screen observer 截"操作前、操作后"两帧，用 VLM 处理两次：先逐字转写（"NEVER SUMMARIZE ANYTHING"），再描述动作（"It may not be what the user is actively doing or what they believe, so practice caution when making assumptions"）（[prompts/screen.py][gscp]）。
2. **Propose**（`PROPOSE_PROMPT`，[prompts/gum.py][gpr]）：
   - batcher 把一批观察拼起来交给模型。
   - 要求 "at least 5 distinct, well-supported propositions"，每条包含 `proposition`、`reasoning`、`confidence`、`decay`。
   - 置信度规则：
     - "Be conservative in your confidence estimates. Just because an application appears on {user_name}'s screen does not mean they have deeply engaged with it."
     - "Assign high confidence scores (e.g., 8-10) only when the transcriptions provide explicit, direct evidence"。
   - decay 规则："1 (short-lived) to 10 (long-lasting insight or pattern)"。
   - 要求点名具体实体，方便 BM25 检索。
3. **Retrieve**：对每条草稿，用 `text + reasoning` 做 BM25（FTS5）检索已有命题，打开 decay 加权（[db_utils.py][gdb] `search_propositions_bm25`）。
4. **关系判定**（`SIMILAR_PROMPT`，论文称之为 reranker）：把草稿和检索命中的命题一起交给 LLM，标成 `IDENTICAL`、`SIMILAR` 或 `UNRELATED`（[gum.py][gc] `_filter_propositions`）。
5. **按标签处理**（[gum.py][gc]）：

   | 标签 | 处理 |
   |---|---|
   | `IDENTICAL` | 给这些命题挂上本批观察（`_attach_obs_if_missing`） |
   | `SIMILAR` | 收集这些命题的全部观察 + 本批观察，连同命题本身交给 **Revise**（`REVISE_PROMPT`，最多带 10 条观察）；然后 "Delete all old similar propositions"，用一个新的 `revision_group` 写入新命题，`version=1` |
   | `UNRELATED` | 同样挂上本批观察 |

   两个疑似缺陷【代码阅读推断】：
   - UNRELATED 分支会把本批观察挂到"被检索出来但判为无关"的旧命题上，污染这些命题的证据链。
   - IDENTICAL 分支不删除新草稿，可能留下重复命题。
6. **Revise 的矛盾规则**（`REVISE_PROMPT` 原文）：
   - "Contradictions – If two propositions conflict, keep the one with stronger supporting evidence, or merge them into a conditional statement. Lower the confidence score of weaker or uncertain claims."
   - 允许的操作：Edit、Merge、Split、Add、Remove。
   - 并鼓励 "liberally add new propositions"。
7. **论文和代码在"修订后保留什么"上不一致**：
   - 论文说："We never completely evict propositions that are revised to zero confidence: they remain in the GUM for transparency. However, queries to the GUM will--by default--not surface confidence = 0 propositions."（[GUM][gp] §5.5）
   - 开源代码没有这条逻辑：旧命题直接删除，检索也不按 confidence 过滤（[db_utils.py][gdb] 中没有 confidence 条件）【代码搜索】。
8. **衰减公式与语义方向**：
   - 论文公式：γ = exp(−d·k·age(p))，k=2，age 以天为单位；调整后的相关度 = BM25 相关度 × γ（[GUM][gp] §5.4）。
   - 代码实现：`gamma = -alpha * K_DECAY * age_days`，其中 `alpha = prop.decay`（[db_utils.py][gdb]）。
   - 问题一：方向相反。prompt 里 decay=10 表示"长期有效"，公式里 decay 越大衰减越快。论文自己的例子也互相矛盾："Author is a Ph.D. student decays slowly (score = 1.0)"，而 "debugging a memory leak is transient (score = 0.6)"（[GUM][gp] §3.1）【代码与论文对读推断，未经作者确认】。
   - 问题二：衰减太猛。k=2、按天计算时，decay=5 的命题一天后权重约 e⁻¹⁰，检索结果实际上由"新不新"主导【按公式推算】。
   - 问题三：年龄会被重置。衰减按 `created_at` 计算，而修订是新建命题，所以每次修订都会把命题"变年轻"【代码阅读推断】。
9. **多样性**：用 MMR 选结果，λ=0.5，相似度用 TF-IDF 余弦（[db_utils.py][gdb]；[GUM][gp] §5.4）。

### 2.4 求证：GUM 不问用户

论文里相关的几处表述：

- 参与者 P3 的诉求："Maybe I wasn't familiar with PowerPoint, but if it asked and then used that to give me a suggestion I think I would've been happier with it." P3 还建议 "the system clarify with users when generating low-confidence propositions"（[GUM][gp] §8.3）。
- 作者针对注入攻击提出的缓解办法之一："for the GUM to ask the user to confirm any inputs that seem out of character based on its understanding so far"（[GUM][gp] §9.3）。

Gumbo（基于 GUM 的主动助手）用混合主动原则决定要不要打断用户（[GUM][gp] §4.3.2、附录 B.2.1）：

- 由 GUM 估计几个量：用户觉得有用的概率、benefit、false positive cost、false negative cost、decay。
- 比较"打断"和"不打断"的期望效用，前者大才打断。

注意：这套机制决定的是"什么时候说"，不是"该问什么"。

### 2.5 指令时使用

- **Python API**（[gum.py][gc]）：
  - `gum.query(user_query, limit=3, mode="OR", start_time, end_time)`，返回 `(Proposition, score)` 列表；
  - `gum.recent(...)`、`gum.recent_observations(...)`。
- **MCP**（[gumcp server.py][gmcp]）：
  - 工具：`get_user_context(query, start_hh_mm_ago, end_hh_mm_ago)`。
  - 工具描述原文："Use this liberally, especiialy when something is underspecified or unclear"。
  - 返回 top-3，格式如下：

```
• {text}
  Reasoning: {reasoning}
  Confidence: {confidence}
  Relevance Score: {score}
  Supporting Observations:
    - [{observer_name}] {content}
```

- **Gumbo**：基于 GUM 生成建议并执行。论文的 Gumbo 评估中关闭了 computer use（[GUM][gp] §4.3 脚注 2）。

### 2.6 隐私控制

- **本地优先**：作者 "strongly recommend that all GUMs are trained and hosted on the end-users' computer or on personal infrastructure"（[GUM][gp] §9.3）。
- **Audit**：
  - 论文：用 Nissenbaum contextual integrity 的几个问题过滤观察（[GUM][gp] §5.2）。
  - 代码：`AUDIT_PROMPT` 的输出字段是 `is_new_information`、`data_type`、`subject`、`recipient`、`transmit_data`（[prompts/gum.py][gpr]）。
  - 但 `audit_enabled` 默认是 `False`，而且 `_handle_audit` 在仓库里没有任何调用点（[gum.py][gc]）【代码搜索】。
- **采集端**：Screen observer 有 `skip_when_visible` 参数，指定的应用在屏幕上可见时不截屏（[screen.py][gsc]）。

### 2.7 失败模式与评测

**邮件研究**（N=18，[GUM][gp] §6）

| 指标 | 结果 |
|---|---|
| 全部命题的准确率 | 76.15±5.85% |
| confidence=10 的命题 | 100% 正确 |
| confidence>0.8 的命题 | 88.2% 正确 |
| Brier | 0.17±0.03，误差几乎都来自低估 |
| 各消融版本的准确率 | 74.41 / 73.28 / 76.15，差异不显著 |
| 排序胜率 | Full 0.618，No Retrieve 0.463，No Retrieve+Revise 0.420 |

**隐私评测**（[GUM][gp] §7、§9.3）

- 180 条命题中，7 条被参与者标为 contextual integrity 违规。
- 命题里直接点出朋友的名字，让参与者感到意外。
- 钓鱼邮件被当成用户本人的兴趣："the model thought it was me and my interest rather than just a phishing attempt"。作者的总结是："Spam email, ingested by the GUM, maliciously edited a GUM's underlying propositions"。

**Gumbo 部署**（N=5，5 天，[GUM][gp] §8）

| 指标 | 结果 |
|---|---|
| 命题准确率 | 0.79 |
| Brier | 0.28 |
| 被评为 strong / excellent 的建议 | 25% |
| 方向对但执行失败的建议 | 20.69% |

定性发现：

- 价值判断类命题（如 "P4 is unhappy with their job"）：有人觉得被评判，有人借此自省。
- 有参与者说："I'd hide [propositions on ability], honestly. Even if they were true!"
- "Eager beavers"：Gumbo 会抢在用户自己完成之前给建议。
- 敏感话题上 Audit 判断错误。P1 提出 "the Audit module should itself be auditable"。
- 参与者会对被观察这件事习惯化："after a day I was like, whatever F it"。

**样本偏差**：参与者多为作者的熟人，且都是技术用户（[GUM][gp] §9.4）。

---

## 3. Behavior Latticing

### 3.1 定位

- 论文：Zhao、Lam、Yang、Bernstein（Stanford），[arXiv 2604.07629v1][bp]（2026-04-08）。
- 目标：推断用户"为什么这样做"，而不只是"做了什么"。
- 配套系统 Dawn：用 insight 驱动个人 agent。
- 代码：[StanfordHCI/lattice][brepo]，PyPI 包名 `latticing`。
- 输入格式：session 列表，每个 session 包含 `interactions[{interaction, metadata}]` 和 `time`（[data-format.md][bdf]）。

### 3.2 数据结构

**L0 观察节点**（[Observer.py][bo]）

- 节点格式：`{id, observation, confidence, metadata: {input_session, time}}`。
- LLM 每产出一条 `{think_feel, actions, confidence}`，代码就把 `think_feel` 和 `actions` 拆成两个独立节点，共用同一个 confidence，两个节点之间不建边。

**Insight**（[models.py][bm]）

| 字段 | 含义 |
|---|---|
| `title` | 标题 |
| `tagline` | 一两句话的概括 |
| `insight` | 三四句话的正文 |
| `context` | "1-2 sentences when this insight might apply"（适用情境） |
| `supporting_evidence` | 证据，文本形式 |
| `merged` | 下层节点的 ID 列表 |
| `metadata` | `{input_session, time}` |
| `id` | 节点 ID |

**边**（[Lattice.py][bl]）

- 存储格式：`lattice["edges"][layer] = [{source: insight_id, target: lower_id}]`。
- 第一层的边：用 `MAP_EVIDENCE_PROMPT` 让 LLM 把 `supporting_evidence` 文本映射成观察 ID。
- 更高层的边：直接用模型输出的 `merged`。
- 节点 ID 在每一层都从 0 重新编号，跨层引用时必须带上层号【代码阅读】。

**定义了但没用上的结构**：[models.py][bm] 里还有 `InsightSupportResponse{evidence, confidence, reasoning}` 和 `FinalInsight{..., reasoning}`，但 [Lattice.py][bl] 没有用到它们【代码搜索】。所以 insight 本身没有置信度。

**对照票里要求的字段：**

| 票要求的字段 | BL 有没有 | 说明 |
|---|---|---|
| 文本 | 有 | title / tagline / insight / context 四种粒度 |
| 置信度 | 只在观察层有 | insight 没有 |
| 证据 | 有 | 多对多，跨层 |
| 衰减 | **没有** | — |
| 来源 | 很粗 | 只有 session 和 time |
| 状态 | **没有** | — |
| 修订 | **没有** | — |

### 3.3 生成管线

**整体形态**

- 一次性批处理：`build()` 调用 `forward()`；`backward()` 未实现（[Lattice.py][bl]）。
- 论文原话："Our current implementation only builds the lattice upward"（[BL][bp] §3.2.2）。
- 没有增量更新，也没有修订。

**Observe**（`OBSERVE_PROMPT`，[prompts.py][bpr]）

- 用滑动窗口（`window_size`）把交互记录分段交给模型。
- 原则 "Focus on Behavior, Not Just Content"，例子是 "reading a sad article on CNN doesn't mean the user is sad"。
- 置信度分档："1-4 (Weak) ... 5-7 (Medium) ... 8-10 (Strong): Explicit, directly stated evidence"。
- 默认低置信："Unless there is explicit evidence of the user's emotional state or thoughts, the confidence will be low (< 5)."
- 看不出明显的心理状态时，输出空列表。

**分组方式**（[Layers.py][bly]，`LatticeLayer.split`）

| 类 | 分组规则 |
|---|---|
| `SessionLayer(n)` | 每 n 个 session 一组 |
| `TimeLayer(by=day\|week\|month\|year)` | 按日历周期分组 |
| `NumberLayer(n)` | 每 n 个节点一组，不管 session 和时间 |
| `AllLayer()` | 全部合成一组 |
| `CustomLayer(fn)` | 自定义分组函数 |

**第一层**（观察 → insight）

1. 每组观察交给 `OBSERVATION_TO_INSIGHT_PROMPT`。prompt 的定义是：insight "often grow from contradictions between two user observations or from asking yourself "Why?" when you notice strange behavior. One way to identify the seeds of insights is to capture "tensions" and "contradictions""。
2. 用 `FORMAT_INSIGHT_PROMPT` 整理成 JSON。
3. 用 `MAP_EVIDENCE_PROMPT` 建边。

**更高层**（insight → insight，`INSIGHT_SYNTHESIS_PROMPT`）

- 要求模型从四类关系去合成：
  1. "Recurring themes or patterns ... EVEN if the context is different"；
  2. "Specific situations or for specific people"；
  3. "Contradiction and tension"；
  4. "Explanations and motivations"。
- 并要求不丢掉没被合并的 insight（[prompts.py][bpr]）。

**参数与模型**

- 论文用三层：观察层、按天的 insight、跨天的 insight。理由是层数多了 "risk producing overly abstract insights"（[BL][bp] §3.2.4）。
- `auto_config()` 可以按交互条数用对数自动决定层数（[Lattice.py][bl]）。
- 模型分工（[BL][bp] §4.2）：

  | 用途 | 模型 |
  |---|---|
  | 截屏转写 | Gemini 2.0 Flash Lite |
  | 生成 insight | Claude Sonnet 4.6 |
  | 提议动作 | Claude Sonnet 4.5 |
  | 执行 agent | Gemini 3 Pro |

**矛盾与取代**：矛盾不被消解，而是当作生成 insight 的原料。没有取代机制。

### 3.4 求证：系统不问用户

- Dawn 在执行 agent 之前，允许用户补充信息（[BL][bp] 图 4 D）。
- 作者在讨论部分提出了几个方向：
  - 借鉴设计研究里的 contextual inquiry，"combine observation with conversation and interviewing"（§8.2）；
  - "Bridging the gap entails involving the user in insight generation for first-person perspectives"（§8.4.3）；
  - 缓解过度解读，可以 "incorporating uncertainty estimation or allowing models to abstain"（§8.4.2）。

### 3.5 指令时使用（Dawn）

1. **找任务**：从截屏推出当天的低层任务，再合成高层任务。用 LLM 给每个任务打 0–1 分（衡量个人助理相对通用 agent 能多带来多少价值），只保留 ≥0.75 的（[BL][bp] §4.1.2）。
2. **选 insight**：每个任务用 cross-encoder（Voyage rerank-2.5）取 top-2 条 insight。理由是 "including too many insights led to generic outputs"。
3. **提议动作**（附录 A.6 的 prompt）：
   - 先把 insight 改写成 HMW（How Might We）式的问题重构；
   - 发散出多个动作，按 insight 排序；
   - 用实现约束过滤掉做不到的；
   - 选 top-2。
4. **执行**：ReAct agent，能读写 Google Drive、本地文件、Apple Calendar，能联网搜索。

### 3.6 隐私控制

（[BL][bp] 附录 D.4）

- 随时可以暂停录制。
- 本地 OCR 识别敏感域名关键词（金融、医疗等 URL），命中的截图不保存。
- 处理前可以审阅截图并删除。
- 截图只保存在本机。
- 模型调用走学校自有的服务器。

作者在 §8.3 讨论了三类风险：surveillance / persuasion、paternalistic AI、"being perceived by an AI"。

### 3.7 失败模式与评测

**技术评估**（9 人，174 个评分，量表 -3~+3；[BL][bp] §6、附录）

| 指标 | BL | GUM | 统计 |
|---|---|---|---|
| 深度 | 1.17 | -0.37 | t=7.78，p<.001，d=0.95 |
| 准确度 | 1.30 | 1.72 | t=-1.76，p=0.08；Wilcoxon 下 p=0.04，差异显著 |

**端到端评估**（12 人，140 个动作评分；[BL][bp] §7）

| 指标 | Dawn | Baseline | 统计 |
|---|---|---|---|
| 满足深层需求 | 4.60±1.72 | 3.84±1.56 | t=2.69，p=0.01 |
| 即时效用 | 4.87 | 4.87 | 无差异 |

**作者列出的失败**（[BL][bp] §6.2、§8.4）

- **错误的规范性结论**：把 P10 和朋友做饭的时间放在与科研的"张力"里，并判断这种张力是有害的。P10 的反应："do I have a problem?"
- **观察时间窗太短**：P14 只被观察了春假期间。
- **过度解读无意识行为**："overindexing on P3's unconscious behaviors"。
- **戏剧化**：P21 说有些 insight 读起来 "dramatized"。
- **第三方视角的局限**：系统只能从外部观察用户。

**样本**：参与者都是北美高校的学生（附录 D.3）。

---

## 4. 横向对照

| 维度 | Honcho | GUM | Behavior Latticing |
|---|---|---|---|
| 命题单位 | conclusion（一句话一个事实） | proposition（一到两句 + reasoning） | observation（`think_feel` / `actions`）和 insight（title / tagline / insight / context） |
| 层级 | `explicit` / `deductive` / `inductive` / `contradiction` | 无层级字段 | L0 观察 → L1 单会话 insight → L2 跨会话 insight |
| 置信度 | 只有 inductive 有，按证据条数 | 1–10，由 LLM 自评，提示语偏保守 | 只有观察层有，1–10 |
| 证据 | `message_ids` + 有序的 `source_ids` | 观察多对多 + `reasoning` | 跨层多对多的边 |
| 衰减 | 无 | `decay` 1–10（方向有疑问） | 无 |
| 修订 | 删除旧条目 + 新建一条"更新"结论 | 删除旧命题 + 新建 | 无，只能重建 |
| 矛盾 | 作为 `contradiction` 层保留 | 取证据更强的一方，或合并成条件句 | 作为生成 insight 的原料 |
| 触发 | 每批消息；dream 由阈值、冷却、空闲共同触发 | 每批观察 | 离线批处理 |
| 向用户求证 | 无（仅有一句 prompt 措辞） | 无（参与者希望有） | 无（作者认为应该有） |
| 指令时使用 | 卡片 + representation 注入 / dialectic / 工具 | `query` / MCP top-3 | 每个任务注入 top-2 insight |
| 隐私 | 建模开关、scope、message 级关闭；删除不彻底 | 本地运行；Audit 在代码里未接入 | 暂停、敏感域过滤、处理前审阅 |
| 评测 | 召回类基准（厂商自报） | 准确度 + 校准（事实型命题为主） | 深度 vs 准确度 + 是否满足深层需求 |

---

## 5. 映射到四层动机模型

四层的定义见调研 02 §2.2：

- L1 表象：说、做、回避、情境，天花板 `verified`；
- L2 情境意图：这一次为什么这样，天花板 `unverified`；
- L3 真实需求：跨情境不变的东西，天花板 `conditional`；
- L4 内核：经历、价值观、风险偏好、关系模式，天花板 `conditional`。

调研 05 §6.2 在 L1 和 L2 之间另加了一层 L1'（事实与偏好）。

### 5.1 对照表

| 四层动机模型 | Honcho | GUM | Behavior Latticing |
|---|---|---|---|
| **L1 表象** | `explicit`。只覆盖"说"（加上"用户接受的提议"），没有 did / avoided / setting 的区分。"never derive from what another peer said" 相当于来源门禁；`message_ids` 加 `get_observation_context` 相当于 M3（可回到原文） | `Observation`（截屏转写）是 L1 的原料；但命题表本身把各层混在一起 | L0 的 `actions` 节点接近 L1；`think_feel` 节点越过了 M1 |
| **L1' 事实与偏好** | `deductive`（knowledge update、逻辑蕴含）+ peer card（`IDENTITY` / `ATTRIBUTE` / `RELATIONSHIP` / `INSTRUCTION`）。其中 `INSTRUCTION` 正好对应 05 §6.0 所说"在怎么服务上，用户的话是权威" | 高置信的事实型命题，例如 "P3 works on research related to civil and environmental engineering" | 无 |
| **L2 情境意图** | 没有专门的层；dialectic 的回答是临时的，不落库 | 推测型命题，例如 "User needs to buy or rent a suit for the wedding"（[GUM][gp] §3.1） | L0 的 `think_feel` + 单会话 insight |
| **L3 真实需求** | `inductive`（`pattern_type` 为 preference / behavior / personality / tendency / correlation）。这是最接近的一层，但它描述的是"规律"，不是"需求" | 模式型命题，例如 "User is regularly distracted by ice cream recipes" | 跨会话 insight，例如 "P8's productivity tools signal an intent to work but do not always direct behavior" |
| **L4 内核** | 明确不做：卡片上禁止 `TRAIT:`，人格类推断只能留在 inductive 层 | 偶尔出现价值判断，例如 "P4 is unhappy with their job"，恰恰是被嫌 "judgmental" 的那一类 | 顶层 insight 会触及自我评价，例如 "self-assessment is often based on external metrics"（[BL][bp] §6.1）；作者认为它们 "capture something core about how users view themselves"（§8.2） |
| 矛盾是入口 | `contradiction` 层，双方保留 | Revise 时把矛盾消解掉 | 把矛盾当作推动机的入口，与四层动机模型一致 |
| 置信天花板 | 无 | 无（单一刻度） | 无 |
| 竞争假设 + 判别性追问（M4/M5） | 无 | 无 | 无 |
| 预测与预注册（M14） | 只有 VoE（预测下一条用户输入），当前代码里不存在 | 无 | 无 |
| 撤回与墓碑 | 软删除后硬删除，不留墓碑 | 直接删除 | 无 |

### 5.2 几点判断

1. **三家各管一段。**
   - Honcho 把 L1 和 L1' 做得最干净：来源门禁、只许摄入写 explicit、有序的证据边、伪造 ID 剥离。但它主动放弃了在常驻上下文里使用 L3 和 L4。
   - GUM 用一张表装下所有层，靠一个 confidence 区分强弱。
   - BL 专攻 L2 到 L3，用准确度换深度。
2. **三家都缺"层"这个标签**，没有一家能回答"这条命题是哪一层的断言"。ergo 必须显式加 `layer` 字段，否则四层动机模型的天花板规则（M2）无从执行。
3. **"置信度"在三家里是三种不同的东西**：Honcho 是证据条数，GUM 是 LLM 对证据清晰度的自评，BL 是观察层的推断强度。ergo 应该把"证据支持度"（可计数、可检验独立性）和"模型主观置信"分开存，并按层设上限。
4. **GUM 和 BL 是同一组人前后两篇工作**（Bernstein、Yang 都是共同作者）。BL 直接拿 GUM 当对照组，结论是"更深，准确度略降"（[BL][bp] §6）。这正好对应用户的立场：**动机判断不必高置信，比现状强就是进步**。不过 BL 的失败案例（规范性结论、时间窗太短、戏剧化）也说明，低置信的判断不能以陈述句出现在用户面前，只能以问题出现（§6.3）。

---

## 6. ergo 可以借什么

### 6.1 素材存储

1. **原始消息单独成表，向量和正文解耦。** Honcho 用 `MessageEmbedding` 加 `sync_state`，由 reconciler 异步补齐 embedding，消息写入不被嵌入调用阻塞（[CLAUDE.md][hc]）。
2. **每条 L1 都能回到原文。**
   - Honcho：`message_ids` 记录区间，`get_observation_context` 按结论取周边消息（[agent_tools.py][htools]）。
   - GUM：观察和命题多对多关联。
3. **抽取时用带标签的消息包装。**
   - 每条消息包进带说话人和 `target` 标记的标签，并转义正文里伪造的标签（[deriver/prompts.py][hdp]）。
   - 两条规则可以直接写进 ergo 的 L1 抽取规范：
     - "只从用户本人的消息里抽关于用户的事实，别人的话只当上下文"；
     - "用户接受了别人的提议，提议内容算他说的；单纯的'好''谢谢'不算"。
   - 按四层动机模型的要求，"接受 agent 的提议"要另外记一条 `setting`，写明是 agent 先提出的。理由是 agent 自己也是外生冲击（调研 02 §7.1）。
4. **只有消息摄入能写 L1。** 这是 Honcho 的 session-purity invariant。在 ergo 里对应：dreaming 和指令时的推理只能产出推断层，不能产出 L1。
5. **采集端设隐私闸门。** 可借的做法有：
   - BL：暂停录制、本地 OCR 敏感关键词过滤、处理前审阅删除；
   - GUM：`skip_when_visible`；
   - Honcho：message 级 `reasoning.enabled=false`。
6. **不要照抄 Honcho 的删除语义。** Honcho 不能删单条消息和 peer，派生结论在删会话后仍然存活（[deleting-data.mdx][hddel]）。ergo 应该这样做：
   - 删除 L0 时，沿证据边级联删除所有派生命题。可以借 Honcho scope 移除时的逻辑："fail-closed cascades to derived documents whose source_ids intersect anything removed"（[CHANGELOG][hcl] #904）。
   - 删除之后用 rebuild 模式重建用户卡，也就是不给模型看旧卡。

### 6.2 命题记录（带证据和置信度）

建议的 schema（注释里标出每个字段借自哪家）：

```yaml
id: P-000123
layer: L3                         # 四层动机模型的层；三家都没有
text: "在对上沟通里，他要的是不被挑出错"      # 三家都有
tagline: "对上求稳"                 # BL tagline，用于卡片和问题里的简称
context: "工作沟通；不含家庭事务"     # BL context，等同于四层动机模型的 scope
reasoning: "……"                   # GUM reasoning
evidence:
  observations: [O-031, O-077]    # GUM 多对多；Honcho message_ids
  premises: [P-000088]            # Honcho DocumentSource(derived_id, source_id, position)，不设外键
  counter: [O-088]                # 反证；三家都没有
support:
  n_independent: 3                # 把 Honcho induction 的计数规则改成"独立来源数"（M10）
  times_derived: 4                # Honcho 的强化计数（注意 #768 的教训）
confidence: 0.45                  # GUM 式 LLM 自评（1–10 归一化）
confidence_cap: 0.8               # 四层动机模型的层天花板；用户确认前 L3 不超过此值
pattern_type: tendency            # Honcho inductive 的分类
volatility: stable                # GUM decay 的本意；只用于 L1'/L2，方向要写清楚
status: hypothesis                # hypothesis | corroborated | user_confirmed | user_rejected | dormant | superseded | retracted
supersedes: [P-000101]            # Honcho 的 deductive "更新"做法，但旧条目留作墓碑
contradicts: [P-000140]           # 把 Honcho 的 contradiction 层改成一等关系
revision: {group: 7f3c…, version: 3}   # GUM 的字段，真正递增
predictions: [{claim: "…", outcome: null}]   # 四层动机模型 M14；VoE 的思路
questions: [Q-0042]               # 用户立场：L2 及以上的命题必须挂至少一个问题
user_verdict: null                # null | confirmed | partly | rejected | forbidden
```

配套规则：

- **校验证据 ID。** 写入时检查证据 ID 是否真实存在，剥离伪造的 ID；剥离后不足最低条数就拒绝写入（Honcho #945）。
- **修订一律追加新版本，不删旧版本。** 这既纠正了 GUM 代码"删旧建新"的做法，也兑现了 GUM 论文"保留零置信命题"的承诺。衰减按"最初出现时间"计算，不按"最近一次修订时间"。
- **置信度提示语用 GUM 和 BL 的保守写法。**
  - GUM 原句："Just because an application appears on screen does not mean they have deeply engaged with it." ergo 的版本可以是："用户提到一个东西，不代表他在意它。"
  - BL 观察层的 "Unless there is explicit evidence ... the confidence will be low (< 5)" 可以直接作为 L2 的默认规则。
- **不要把证据条数当真值。**
  - Honcho 的 low / medium / high 只是计数。
  - GUM 的 Brier 0.17 是在事实型命题上测出来的，动机层没有校准证据（[GUM][gp] §6；调研 05 §0 第 3 条）。

### 6.3 生成澄清问题

用户的立场是：动机判断可以低置信（"比现状强就是进步"），但每个判断都要配上澄清问题。三家都没有现成实现。下面是能从它们身上拆出来的六种"问题来源"：

| # | 来源 | 何时触发 | 问法示例 | 依据 |
|---|---|---|---|---|
| 1 | **矛盾 → 问** | 出现 `contradicts` 关系 | "你之前说 X，后来又说 Y，现在哪个对？" | Honcho dialectic prompt 的 "Present BOTH ... Ask the user which statement is correct"。这是对 L1 / L1' 的求证，答案记为新的 L1，成本最低 |
| 2 | **低置信但高价值 → 确认** | 命题会改变某个将来的行动（benefit 高），但置信度低 | 把假设说出来，请用户确认 | GUM P3 的诉求；Gumbo 的期望效用公式（调研 05 §3.4 已经整理过） |
| 3 | **张力 → 判别性问题** | BL 式 insight 生成时 | 问具体事件，不问动机 | BL 的 insight 本来就起于 "tensions and contradictions"，每条至少对应两个竞争解释。按四层动机模型 M4/M5 写成 Q，问题文本要过领读检测（调研 02 §2.6） |
| 4 | **规范性判断 → 只能以问题出现** | 命题含"有害""应该""不快乐"一类判断 | 问"要不要我帮你把做饭和赶论文的时间排一下？"，不说"做饭影响了你的科研" | BL P10 做饭的案例、GUM "unhappy with job" 的案例都说明，这类判断以陈述句出现会让人觉得被评判（[BL][bp] §6.2；[GUM][gp] §8.3） |
| 5 | **预测落空 → 问** | 对 L2 / L3 预先写下的预测被实际行为推翻 | 生成一个问题，而不是静默改写命题 | 把 VoE 的循环（预测 → 比较 → 从违背中学）搬过来（[voe]）；同时满足四层动机模型的 M14 |
| 6 | **反常 → 先确认再入库** | 新观察和已有模型明显不符 | 先问用户确认 | Honcho surprisal 能挑出几何上的离群点；GUM 作者建议对 "out of character" 的输入先向用户确认。这同时也是防注入的手段（[GUM][gp] §9.3） |

**问题对象的字段建议**：

```yaml
id: Q-0042
target_props: [P-000123]
kind: contradiction | confirm | discriminate | prediction_violation | out_of_character
text: "……"
why_now: "……"
if_yes: "……"
if_no: "……"
expires_at: …
asked_at: …
answer_obs: O-…        # 用户的回答记为 L1 speech
```

**什么时候问**：

- 发问闸门沿用调研 05 §3.4：预算、在任务断点问、被拒就退避。
- 问题主要在 dreaming 里生成，在指令时"搭便车"问。

### 6.4 夜间 dreaming 整合

**调度**：直接借 Honcho 的参数，换成 ergo 的语义。

- 新增 L1 ≥ N 才触发。只数 L1，避免 #573 那样把自己的产出算进去形成自激。
- 距上次 ≥8 小时。
- 用户空闲 ≥60 分钟；期间来新消息就取消。
- 另设每日次数上限；允许手动触发。
- `last_dream_at` 在 dream 成功之后才写，失败或重复入队不重置冷却（#573 修复的要点之一）。

**阶段（建议顺序）**：

1. **卫生检查**：剥离伪造的证据 ID；合并近似重复（Honcho 的 0.05 距离阈值 + 信息量比较）；更新 `times_derived`。
2. **Deduction**（借 Honcho）：同一事实出现新值的，标 `supersedes`；真矛盾的，标 `contradicts`，并生成一个矛盾问题。
3. **Revise**（借 GUM）：
   - 用新的 L1 检索相关命题，判 IDENTICAL / SIMILAR / UNRELATED；
   - 对 SIMILAR 的簇，带上证据重写，版本号 +1；
   - 只给真正相关的命题挂证据，避开 GUM UNRELATED 分支的污染问题。
4. **Latticing**（借 BL）：
   - 把当天的 L1 按"张力 / 矛盾 / 重复 / 互相解释"分组，生成日级的 L2 insight；
   - 每周用 `TimeLayer(by="week")` 再合成一次，得到 L3 候选；
   - 总层数不超过 3（BL 的经验：层数多了会过度抽象）。
5. **预测记分与降级**（四层动机模型）：给到期的预测打分；预测连续落空的命题降为 `dormant`。
6. **生成问题**：按 §6.3 生成并入队。
7. **刷新用户卡**：只写用户明说的身份、属性、关系、指令（Honcho peer card 的四种前缀 + OpenClaw `USER.md` 的规则）。删除操作之后用 rebuild 模式。
8. **输出审阅视图**：把当晚的变更写成 diff，作用相当于 OpenClaw 的 `DREAMS.md`（调研 05 §1.5）。

**预算控制**：

- Honcho 给每个 specialist 设了迭代上限（deduction 12 轮、induction 10 轮）。
- surprisal 可以把有限的预算投到离群的观察上。
- BL 用 `window_size` 和层数控制成本。

**注入策略**：

- 用户卡常驻。
- 每条指令只取 top-2 条相关 insight（BL 的经验）。
- 像 Honcho representation 那样把 `CONTRADICTION:` 单独列一段，让执行 agent 看见哪里还不确定。

### 6.5 不建议照搬的做法

| 做法 | 来源 | 为什么不搬 |
|---|---|---|
| "错误事实不删，写一条更正结论，系统会自愈" | Honcho（Hermes 插件的工具说明） | 和调研 05 §6.3 的规则冲突：用户说"别记"就删除，说"不对"就一票否决 |
| 在群聊中为每个发言者建 peer | Honcho 的 OpenClaw 插件 | 和调研 05 §4.7 第 9 条、§7 第 7 条冲突（不为第三方建模）。ergo 对主人以外的人应默认 `observe_me=false` |
| 一张表装所有层、只有一个 confidence | GUM | 无法执行层天花板 |
| 把 `think_feel` 当叶子节点 | BL | 违反 M1，推断混进了表象层 |
| 把三家的评测数字当作"动机推断可行"的证据 | 三家 | Honcho 测的是召回；GUM 的高准确度主要来自事实型命题；BL 的准确度略有下降，样本是学生 |

---

## 7. 意外发现

1. **"dialectic" 这个名字容易误导。** 本票把 dialectic 放在"怎样提问或对话来求证"这一问下面，[03][r03] §B6 也只写了"用 Honcho 做 dialectic 式用户建模"，字面上很容易读成"通过对话向用户求证"。一手来源显示：dialectic 是应用 agent 和 Honcho 之间的问答；向用户求证在设计里从来不是一等公民。Plastic Labs 唯一做过"预测-验证"的 VoE，在当前代码中已经不存在。
2. **Honcho 是在主动后撤。** 从 "theory of mind" 起家的公司，现在的卡片规则写着 "No behavioral content"，抽取规则写着只抽字面事实。行为模式和人格推断还在 inductive 层，但被挡在常驻上下文之外。这和 OpenClaw 的立场一致，说明**生产系统普遍认为：推断出来的心理特征不适合常驻注入**。
3. **GUM 论文里最打动人的几个机制，在开源代码里都不存在**：Audit、保留零置信命题、合理的衰减方向。05 是按论文写的。如果 ergo 想 fork GUM 代码，这三处都要自己补。
4. **BL 的代码只有 forward pass。** 它更像一次性的"用户画像报告生成器"，不是在线记忆系统。要用于每晚的 dreaming，ergo 必须自己设计增量合成和修订。
5. **三家都把"该不该问用户"推给了未来工作。** 但 GUM 和 BL 的参与者、作者都明确提出了这个需求。ergo 在这里做出差异化，有一手证据支持。
6. **Honcho 有现成的 pi 扩展**（`@honcho-ai/pi-honcho`，要求 pi 1.0+）。它在对话中把注入内容显示为可折叠的 `◆ honcho` 条目（[pi-honcho][pih]），和 pi 作者"不在用户看不见的地方往上下文塞东西"的主张一致（调研 05 §1.5）。如果 ergo 建在 pi 上，这个扩展可以当作"把外部记忆接进 pi"的参考实现，也可以当作 L1 / L1' 层的临时外包方案。

---

## 8. 需要你决定的问题

1. **L1 / L1' 要不要先外包给 Honcho**（自托管 + pi-honcho），ergo 只自建 L2 到 L4 和问题队列？
   - 好处：抽取、去重、证据边、dreaming 调度都现成。
   - 代价：Honcho 删不掉单条消息，派生结论在删会话后存活，没有修订历史，也没有敏感类别过滤（§1.6）。这些都和 05 的护栏冲突。
2. **问题由谁去问。** 选项有三个：每晚汇总成"我想问你的"面板；在指令时搭便车问；两者都要。如果两者都要，每天的预算是多少？
3. **规范性判断要不要一律禁止以陈述句出现在用户面前**（§6.3 第 4 条）？还是允许用户在设置里打开"直说模式"？
4. **衰减怎么定。** 建议：L1' 和 L2 按 GUM 的 volatility 衰减（先把方向定义清楚）；L3 和 L4 不按时间衰减，只按预测失败降级（调研 05 D6）。你是否同意？
5. **BL 式合成要不要跨领域。** 例如做饭和科研之间的"张力"，跨领域的 insight 最深，但也最容易越界（BL 的 P10 案例；调研 05 D9）。

---

## 附录 A　未核实、推断与口径说明

- **【未核实】**
  - Honcho 托管版当前是否使用 Neuromancer XR。
  - VoE 论文 §7.4 提出的加密、TEE、ABAC 等方向是否已经实现。
  - Plastic Labs 博客 "Memory as Reasoning" 的全文。只读到经抓取工具转述的摘录，没有逐字核对。
- **【代码阅读推断】**（没有运行过代码）
  - Honcho inductive 层"至少 2 条证据"只靠 prompt 约束。
  - GUM UNRELATED 分支会污染旧命题的证据链；IDENTICAL 分支可能留下重复命题。
  - GUM 的衰减方向与 prompt 语义相反；修订会重置命题的"年龄"。
  - BL 每层节点 ID 从 0 重新编号。
- **厂商自报**：Honcho 的全部基准数字（[honcho.dev/evals][hev]）。
- **样本局限**：GUM 和 BL 的用户研究样本都很小（N=18 / N=5、N=9 / N=12），参与者以技术背景的学生为主。

## 附录 B　来源

**本项目内部**

- [03-openclaw-and-pi.md][r03]；调研 02、05 未公开

**Honcho**

- 仓库：[repo][hrepo]，提交 `e2d2aba`
- 说明与变更：[CLAUDE.md][hc] · [CHANGELOG.md][hcl]
- 数据模型与 schema：[models.py][hm] · [schemas/internal.py][hti] · [schemas/api.py][hapi] · [schemas/configuration.py][hcfg] · [config.py][hset] · [utils/types.py][hty]
- Deriver：[deriver/prompts.py][hdp] · [deriver/deriver.py][hdr] · [crud/document.py][hdoc]
- Dreamer：[dreamer/specialists.py][hsp] · [dreamer/orchestrator.py][hor] · [dreamer/dream_due.py][hdue]
- Dialectic 与工具：[dialectic/prompts.py][hdlp] · [utils/agent_tools.py][htools] · [utils/representation.py][hrep] · [utils/filter.py][hflt]
- 文档：[reasoning.mdx][hdreason] · [representation.mdx][hdrep] · [dreaming.mdx][hddream] · [evidence.mdx][hdev] · [deleting-data.mdx][hddel] · [chat.mdx][hdchat] · [get-context.mdx][hdctx] · [openclaw.mdx][hdoc-oc] · [hermes.mdx][hdoc-her]
- Hermes 插件：[\_\_init\_\_.py][hher] · [dialectic.py][hherd] · [tool_schemas.py][hhert] · [session_context.py][hhers]
- 其他集成：[pi-honcho][pih] · [openclaw-honcho][och]
- 评测：[honcho.dev/evals][hev] · [honcho-benchmarks][hbench]
- Plastic Labs 一手发表：[Introducing Honcho's Dialectic API（2024-03-26）][pld] · [Memory as Reasoning（2025-08-19）][plm] · [VoE 论文 arXiv 2310.06983][voe]

**GUM**

- 论文：[arXiv 2505.10831v3][gp]
- 代码：[repo][grepo]，提交 `3317d94`：[models.py][gm] · [gum.py][gc] · [prompts/gum.py][gpr] · [db_utils.py][gdb] · [observers/screen.py][gsc] · [prompts/screen.py][gscp]
- MCP：[gumcp server.py][gmcp]

**Behavior Latticing**

- 论文：[arXiv 2604.07629v1][bp]
- 代码：[repo][brepo]，提交 `0d6c946`：[models.py][bm] · [prompts.py][bpr] · [Lattice.py][bl] · [Layers.py][bly] · [Observer.py][bo] · [data-format.md][bdf]

[r03]: 03-openclaw-and-pi.md
[hrepo]: https://github.com/plastic-labs/honcho/tree/e2d2aba
[hc]: https://github.com/plastic-labs/honcho/blob/e2d2aba/CLAUDE.md
[hcl]: https://github.com/plastic-labs/honcho/blob/e2d2aba/CHANGELOG.md
[hm]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/models.py
[hti]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/schemas/internal.py
[hapi]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/schemas/api.py
[hcfg]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/schemas/configuration.py
[hset]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/config.py
[hty]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/utils/types.py
[hdp]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/deriver/prompts.py
[hdr]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/deriver/deriver.py
[hdoc]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/crud/document.py
[hsp]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/dreamer/specialists.py
[hor]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/dreamer/orchestrator.py
[hdue]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/dreamer/dream_due.py
[hdlp]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/dialectic/prompts.py
[htools]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/utils/agent_tools.py
[hrep]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/utils/representation.py
[hflt]: https://github.com/plastic-labs/honcho/blob/e2d2aba/src/utils/filter.py
[hdreason]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/core-concepts/reasoning.mdx
[hdrep]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/core-concepts/representation.mdx
[hddream]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/features/advanced/dreaming.mdx
[hdev]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/features/advanced/evidence.mdx
[hddel]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/features/advanced/deleting-data.mdx
[hdchat]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/features/chat.mdx
[hdctx]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/documentation/features/get-context.mdx
[hdoc-oc]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/guides/integrations/openclaw.mdx
[hdoc-her]: https://github.com/plastic-labs/honcho/blob/e2d2aba/docs/v3/guides/integrations/hermes.mdx
[hher]: https://github.com/plastic-labs/honcho/blob/e2d2aba/hermes-plugin-honcho/__init__.py
[hherd]: https://github.com/plastic-labs/honcho/blob/e2d2aba/hermes-plugin-honcho/dialectic.py
[hhert]: https://github.com/plastic-labs/honcho/blob/e2d2aba/hermes-plugin-honcho/tool_schemas.py
[hhers]: https://github.com/plastic-labs/honcho/blob/e2d2aba/hermes-plugin-honcho/session_context.py
[pih]: https://github.com/plastic-labs/pi-honcho
[och]: https://github.com/plastic-labs/openclaw-honcho
[hev]: https://honcho.dev/evals/
[hbench]: https://github.com/plastic-labs/honcho-benchmarks
[pld]: https://plasticlabs.ai/blog/archive/ARCHIVED;-Introducing-Honcho's-Dialectic-API
[plm]: https://plasticlabs.ai/blog/posts/Memory-as-Reasoning
[voe]: https://arxiv.org/abs/2310.06983
[gp]: https://arxiv.org/abs/2505.10831
[grepo]: https://github.com/GeneralUserModels/gum/tree/3317d94
[gm]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/models.py
[gc]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/gum.py
[gpr]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/prompts/gum.py
[gdb]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/db_utils.py
[gsc]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/observers/screen.py
[gscp]: https://github.com/GeneralUserModels/gum/blob/3317d94/gum/prompts/screen.py
[gmcp]: https://github.com/GeneralUserModels/gumcp/blob/main/server.py
[bp]: https://arxiv.org/abs/2604.07629
[brepo]: https://github.com/StanfordHCI/lattice/tree/0d6c946
[bm]: https://github.com/StanfordHCI/lattice/blob/0d6c946/src/latticing/models.py
[bpr]: https://github.com/StanfordHCI/lattice/blob/0d6c946/src/latticing/prompts.py
[bl]: https://github.com/StanfordHCI/lattice/blob/0d6c946/src/latticing/Lattice.py
[bly]: https://github.com/StanfordHCI/lattice/blob/0d6c946/src/latticing/Layers.py
[bo]: https://github.com/StanfordHCI/lattice/blob/0d6c946/src/latticing/Observer.py
[bdf]: https://github.com/StanfordHCI/lattice/blob/0d6c946/website/docs/guides/data-format.md
