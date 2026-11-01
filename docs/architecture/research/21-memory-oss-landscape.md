# 调研 21：开源 Agent 记忆项目逐个核实（给记忆 PoC 选型）

> - **调研日期**：2026-10-20（星期二）。没有改产品代码，没有下载、安装任何东西，也没有跑 npm 或 pip。
> - **问题**：要做一个记忆 PoC，内容是"证据库 + 时序知识图谱 + 推理图谱（竞争假设、支持和反对证据、前提依赖、失效传播）+ 混合检索"。PoC 应该从零写、基于某个开源库，还是集成各家所长？二狗是 TypeScript / Node 守护进程，用本地 SQLite。
> - **范围**：JiuwenMemory、Mem0、Graphiti、Hindsight、Honcho、Letta、HippoRAG 2，外加 TypeScript / Node 原生、能用本地 SQLite 的同类库。
> - **方法**：只读一手资料，包括官方 GitHub 的 README、源码、LICENSE，GitHub API 返回的仓库元数据，PyPI，官方文档站和论文。§1 是要点，§2 逐个讲项目，§3 讲 TS / Node 原生的同类库，§4 是给 PoC 的结论，§5 列出没核实到的，§6 是对比表。
> - **标注**：
>   - 不加标的是一手资料，附出处；
>   - 【建议】是作者的看法；
>   - 【未核实】是没查到定论的。
> - **和 05 号调研的关系**：05 号调研（未公开）讲的是概念和产品现状。这次补上运行时、许可证、存储和字段名。有两处要修正 05：
>   - 05 写 Mem0 v3 "用 `linked_memory_ids` 关联新旧记忆"。这次在 OSS 文档、迁移文档、算法博客里都没找到这个字段，改为【未核实】。托管版 API 里能查到的是 `replaced_by`（§2.2）。
>   - 05 写 Hindsight 有带置信度的 opinion 网络。这是论文里的设计；当前文档的 `fact_type` 只有 world、experience、observation 三种，没有 opinion（§2.4）。

---

## 1. 要点

1. **能在 Node 进程里直接用的，只有 Mem0 的 TS 版**（`mem0ai/oss`）。
   - 它默认的"内存"向量库其实写的是 better-sqlite3 文件。检索是全表扫描再算余弦，没有索引。
   - OSS 版已经删掉图记忆。后台巩固（Dream）、时间推理加权、衰减都只在托管版里有。
   - 其余六个项目的核心都是 Python。有的要单独起服务（Honcho、Hindsight、Letta 的 App Server），有的要图数据库（Graphiti），有的要 torch（HippoRAG）。
2. **许可证上只有 Honcho 是 AGPL-3.0**，其余都是 Apache-2.0 或 MIT。
   - Honcho 的代码不能抄进二狗，除非二狗也按 AGPL 开源。
   - 只借它的设计不受影响。
3. **运行时上的硬障碍**：
   - Graphiti 要 Neo4j、FalkorDB 或 Neptune。它唯一的嵌入式后端 Kuzu 已标为弃用，pyproject 的注释写着"上游 Kuzu 项目已无人维护"。
   - Honcho 和 Hindsight 都要 Postgres + pgvector。Hindsight 本地可以用它自带的嵌入式 Postgres（pg0）。
   - JiuwenMemory 的图记忆只有 Milvus 一种图存储。
4. **时间建模最完整的是 Graphiti**：
   - 边上同时有事件时间（`valid_at` / `invalid_at`）和系统时间（`created_at` / `expired_at`），另有 `reference_time`。
   - 新事实和旧事实矛盾时，按事件时间决定让哪条失效，不按写入顺序。
   - Hindsight 也分"发生时间"（`occurred_start` / `occurred_end`）和"提到时间"（`mentioned_at`）。
5. **把"推断类型"和"前提"做成字段的只有 Honcho**：
   - 结论分 `explicit`、`deductive`、`inductive`、`contradiction` 四级，是 `DocumentLevel` 的四个取值。
   - 前提存在 `document_sources` 表里，表的说明是"derived_id 由 source_id 推出"，并带 `position`。
   - 文档里提到溯因（abductive），但写的是"还在开发"，类型定义里没有这一级。
6. **没有一个项目有"竞争假设"或"支持 / 反对证据"这种结构**。
   - 最接近的有三处：Hindsight 论文里 opinion 置信度的"加强 / 减弱 / 矛盾"更新规则；Graphiti 的 `contradicted_facts`；Honcho 的 `contradiction` 级。
   - "前提失效后往下游传播"也没有现成的。最接近的是 Hindsight：删掉源记忆，由它推出的 observation 会被删掉，剩下的源再重新巩固。
7. **【建议】PoC 用 TypeScript 自己写，存储用 SQLite，设计从各家拼**（§4）：
   - 没有一个库同时满足"Node 进程内、SQLite、时序图、推理图"。
   - 真正难的推理图谱部分，开源项目里是空白。
   - 时序图照 Graphiti 的字段和失效规则做；结论层级和前提表照 Honcho；observation 引用证据、删源级联、mental model 的新鲜度照 Hindsight；后台巩固的触发条件参考 Honcho 和 JiuwenMemory；混合检索参考 Mem0 的实体加权和 HippoRAG 的 PPR。
   - 竞争假设和失效传播参照经典的真值维护系统（TMS）自己设计。

---

## 2. 逐个项目

### 2.1 JiuwenMemory（openJiuwen-ai/agent-memory，华为 openJiuwen 社区）

- **语言和运行方式**：
  - Python，要求 3.11 ≤ 版本 < 3.14。
  - 能当库嵌进 Python 进程（`LongTermMemory`），也能起服务：FastAPI 的 `memory-server`，以及 MCP 的 `memory-mcp`（Streamable HTTP，端口 8765）（https://github.com/openJiuwen-ai/agent-memory ）。
  - 没有 TS SDK。仓库里有一个 JS 写的 OpenClaw 生命周期插件，它怎么连到记忆服务【未核实】。
  - 仓库里还有一个 Java 写的 `agent-memory-platform`（租户、配置中心、运维中心等）（https://api.github.com/repos/openJiuwen-ai/agent-memory/git/trees/develop?recursive=1 ）。
- **许可证**：
  - LICENSE 原文是 "Apache License, Version 2.0, January 2004"，没有附加条款（https://github.com/openJiuwen-ai/agent-memory/blob/develop/LICENSE ）。
  - 没找到托管版【未核实】。
- **版本和活跃度**：
  - PyPI 上最新是 `JiuwenMemory` 0.2.0（2026-09-21），之前有 0.2.0b1（09-07）、0.1.2（09-02）、0.1.1（07-18）、0.1.0（07-01）（https://pypi.org/project/JiuwenMemory/ ）。
  - GitHub 仓库 2026-06-18 创建，最近一次 push 是 2026-10-12；70 星，open issues 104（含 PR），默认分支 `develop`（https://api.github.com/repos/openJiuwen-ai/agent-memory ）。
  - 厂商自报：接进 OpenClaw 后 LoCoMo 准确率提升约 15%，记忆操作的 token 降低 60% 以上（https://news.qq.com/rain/a/20260702A042LL00 ）。
- **存储**：
  - KV：InMemoryKV、ShelveStore、DbBasedKV、Redis。
  - 向量：ChromaDB、Milvus、Elasticsearch、GaussVector。
  - 关系库：SQLite、PostgreSQL、MySQL、GaussDB。
  - 图：只有 Milvus GraphStore。
  - 还有一个文件后端（`index_backend="file"`），用 SQLite + sqlite-vec + FTS5（README）。
  - 主示例要一个嵌入模型，存储用 InMemoryKV + SQLite + ChromaDB。只用文件后端能不能完全不要 ChromaDB【未核实】。
  - 图存储的客户端直接把 `config.uri` 交给 `MilvusClient`（https://github.com/openJiuwen-ai/agent-memory/blob/develop/jiuwen_memory/foundation/store/graph/milvus/milvus_support.py ）。能不能用 Milvus Lite 的本地文件【未核实】。
- **数据模型**：
  - **记忆分层**：L0 原始消息、L1 摘要、L2 结构化记忆（Semantic、Episodic、Variable）、L3 用户画像。抽取出的类型有 `UserProfile`、`SemanticMemory`、`EpisodicMemory`、`Variable`、`Summary`（README）。
  - **时间**：图对象见 `graph_object.py`（https://github.com/openJiuwen-ai/agent-memory/blob/develop/jiuwen_memory/foundation/store/graph/graph_object.py ）：
    - 所有对象都有 `created_at: int`；
    - `Relation` 有 `valid_since`、`valid_until`（默认 -1），以及对应的时区偏移 `offset_since`、`offset_until`；
    - `Episode` 有 `valid_since`；
    - `valid_since` 为 -1 时，校验器把它设成 `created_at`。
    - 只有一条事件时间轴，加一个创建时间，不是完整的双时间轴。
  - **来源**：
    - `Entity.episodes: list[str]`、`Episode.entities: list[str]`。
    - `Episode` 的类型分 CONVERSATION、DOCUMENT、JSON。
    - 但图记忆是独立模块，README 写明它"没接进 `LongTermMemory.add_messages`"。
  - **推断类型**：没有。只有 LLM 抽取。
  - **前提依赖**：没有。
  - **冲突和更新**：
    - 写入前由 `MemUpdateChecker` 让 LLM 判断语义冲突，决定 ADD 或 DELETE。LLM 给出的 UPDATE / DELETE 指令要先过语义校验才执行（https://github.com/openJiuwen-ai/agent-memory/blob/develop/jiuwen_memory/memory_core/manage/update/mem_update_checker.py ，README）。
    - 在线写入和离线写入共用一把用户级锁。
  - **反思和巩固**：
    - Dreaming 默认关闭，用 `start_dreaming(...)` 和 `DreamingConfig` 开启。
    - 分三段：浅睡筛选；REM 由 LLM 抽取和归类；深睡做去重和冲突消解（README；源码在 `jiuwen_memory/memory_core/process/dreaming/`）。
    - 新闻稿还提到"忙碌退避"和断点续扫（https://news.qq.com/rain/a/20260702A042LL00 ）。
    - 另有 MemoryTurbo，按话题分批异步抽取。
  - **竞争假设和反证**：没有。
- **最值得借鉴的一点**：Dreaming 和在线写入共用用户级锁和同一套冲突检测，离线巩固就不会和对话里的实时写入打架。

### 2.2 Mem0（mem0ai/mem0）

- **语言和运行方式**：
  - 有 Python 和 TS 两个 SDK。
  - TS 的 OSS 版从 `mem0ai/oss` 引入，`new Memory()` 就在本进程里跑，要求 Node ≥ 18（https://docs.mem0.ai/open-source/node-quickstart ）。
  - npm 包 `mem0ai` 3.3.1 的必需 peer 依赖有 `better-sqlite3`、`compromise`、`@cloudflare/workers-types`（https://github.com/mem0ai/mem0/blob/main/mem0-ts/package.json ）。
- **许可证**：Apache License 2.0（https://github.com/mem0ai/mem0/blob/main/LICENSE ）。
- **托管版和 OSS 的差别**（https://docs.mem0.ai/platform/platform-vs-oss ）：
  - **图记忆**：托管版有，原话 "Native, always-on graph over extracted entities"；OSS 已删除。
  - 下面这些只有托管版有：
    - Memory Decay；
    - Dream（后台巩固）；
    - 时间推理（按查询里的时间给事件日期匹配的记忆加权）；
    - Webhooks、自定义 categories、批量操作、反馈、导出。
  - OSS 删掉的外部图存储驱动有 Neo4j、Memgraph、Kuzu、Apache AGE、Neptune。官方说不会出 OSS 替代品（https://docs.mem0.ai/migration/oss-v2-to-v3 ）。
- **版本和活跃度**：
  - Python `mem0ai` 2.2.1（2026-09-25）（https://pypi.org/project/mem0ai/ ）；
  - Node SDK `ts-v3.3.1`（2026-09-25）（https://api.github.com/repos/mem0ai/mem0/releases ）；
  - 仓库 67.5k 星，同一周还发了 pi、OpenCode、OpenClaw 插件。
  - 迁移文档叫 "oss-v2-to-v3"，但没写对应哪个包版本【未核实】。
- **存储**：
  - TS 的向量库可选 `memory`、`qdrant`、`pgvector`、`redis`、`supabase`、`azure-ai-search`、`vectorize`、`milvus`（https://docs.mem0.ai/open-source/configuration ）。
  - 默认用 `memory` 向量库，加 SQLite 存历史（node-quickstart）。
  - `memory` 向量库看源码其实是 better-sqlite3 文件（`new Database(this.dbPath)`）。检索时 `SELECT * FROM vectors` 全表读出，逐条算余弦。另有一个同样全表扫的 BM25 `keywordSearch()`（https://github.com/mem0ai/mem0/blob/main/mem0-ts/src/oss/src/vector_stores/memory.ts ）。
  - 所以**只用 SQLite 能跑**，但数据量大了会线性变慢。
- **数据模型**：
  - **时间**：
    - 托管版 API 的记忆对象有 `created_at`、`updated_at`、`expiration_date`、`structured_attributes`（按创建时间拆出的年、月、星期几等）（https://docs.mem0.ai/api-reference/memory/get-memory ）。
    - `expiration_date`（YYYY-MM-DD）过期后记忆不再被检索到，但不删，"Works on Platform and Open Source"（https://docs.mem0.ai/platform/features/expiration-date ）。
    - `add` 可以传 `timestamp`，指定记忆的发生时间，文档示例只用托管客户端（https://docs.mem0.ai/platform/features/timestamp ）。
    - 没有"有效期"区间。
  - **来源**：
    - 托管版 API 有 `replaced_by`（被哪条记忆取代）、`synthesized`（是不是合成出来的）、`lifecycle_state`（get-memory）。
    - OSS 只有"每条记忆的历史"（platform-vs-oss）。
  - **推断类型**：
    - 只区分事实来自用户还是 agent，agent 说的事实"first-class"（https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm ）。
    - 托管版有个布尔值 `synthesized`。
  - **前提依赖**：没有。
  - **冲突和更新**：
    - v3 新算法是单次 LLM 调用、只 ADD："the new fact is stored alongside the old one"，由检索排序挑出最新的。
    - 完全相同的内容按 MD5 去重（oss-v2-to-v3）。
  - **实体**：自动建 `{collection}_entities` 集合，查询里的实体命中时给相关记忆加分。这和图记忆无关（oss-v2-to-v3）。
  - **反思和巩固**：Dream 只在托管版。
  - **竞争假设和反证**：没有。
- **最值得借鉴的一点**：只追加不覆盖，冲突留到检索时消解；再加实体命中加权，用很低的写入成本换取召回。

### 2.3 Graphiti（getzep/graphiti，Zep 的开源引擎）

- **语言和运行方式**：
  - Python ≥ 3.10，包名 `graphiti-core`。
  - 仓库里的 REST 服务（FastAPI）和 MCP 服务只是参考实现，README 原话："no authentication, no authorization, and no prompt-injection protection"（https://github.com/getzep/graphiti ）。
  - 没有官方 TS 移植。社区有一个 Node 写的 MCP 服务，后端是 Neo4j（https://github.com/steven0lisa/mcp-graphiti ），不是完整移植。
- **许可证**：Apache-2.0（https://pypi.org/project/graphiti-core/ ；README）。
- **托管版（Zep）和开源版的差别**（README 的对比表）：

  | | Zep | Graphiti |
  |---|---|---|
  | 是什么 | "Managed context graph infrastructure" | "Open-source framework for building temporal knowledge graphs" |
  | 图数据库 | 自研 Context Graph Engine | 自带第三方图数据库 |
  | 用户、会话、消息管理 | 内建 | 自己做 |
  | 部署 | 托管，或部署在用户自己的云上 | 只能自己部署 |

  - Zep 托管版另有 Observations、user summary 等（见 05 号调研 §1.2）。Graphiti 开源版里没查到对应功能【未核实】。
- **版本和活跃度**：
  - `graphiti-core` 0.31.1（2026-10-15）；
  - 0.31.0（10-14）把默认 OpenAI 模型换成 gpt-6-luna，MCP 服务升到 MCP SDK 2.x（https://api.github.com/repos/getzep/graphiti/releases ）。
  - 32.0k 星。
- **存储**：
  - 后端有 Neo4j 5.26、FalkorDB 1.1.2、Amazon Neptune（要配 OpenSearch Serverless 做全文检索）、Kuzu 0.11.2（README）。
  - pyproject 里，Neo4j 的 Python 驱动 `neo4j>=5.26.0` 是核心依赖，其他后端是可选 extra。这只说明驱动总会装上，不等于必须用 Neo4j 服务。
  - Kuzu 那个 extra 的注释是 "Deprecated: the upstream Kuzu project is unmaintained"。
  - 另有 `falkordblite` extra，要求 Python ≥ 3.12（https://github.com/getzep/graphiti/blob/main/pyproject.toml ）。它是嵌入式的，但仍是 Python 进程里带一个 Redis + FalkorDB 模块。
  - 不能只用 SQLite。
  - **遥测默认打开**（PostHog），设 `GRAPHITI_TELEMETRY_ENABLED=false` 关闭（README）。
- **数据模型**：
  - **时间**：`EntityEdge` 有以下时间字段（https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py ）。
    - `valid_at`："datetime of when the fact became true"。对将来的计划或承诺，用 episode 的参考时间，不用将来发生的日期。
    - `invalid_at`："when the fact stopped being true; soft deadlines are not invalid_at"。
    - `expired_at`：系统里把这条置失效的时间。
    - `created_at`：写入时间。
    - `reference_time`：产生这条边的 episode 的参考时间。
    - 也就是事件时间、系统时间两条轴都有。
  - **来源**：
    - `EntityEdge.episodes: list[str]`，记录引用这条边的 episode。
    - `EpisodicNode` 有 `source`（`EpisodeType`：`message` / `json` / `text` / `fact_triple`）、`source_description`、`content`（原文）、`valid_at`（原文档的创建时间）、`entity_edges`、`episode_metadata`（https://github.com/getzep/graphiti/blob/main/graphiti_core/nodes.py ）。
    - 还有两类辅助结构：
      - `SagaNode`：把一串 episode 归成一段"经历"，带滚动摘要和 `last_summarized_at` 水位；
      - `NextEpisodeEdge`：把 episode 串成先后顺序。
  - **推断类型**：没有。边是 LLM 抽取出来的事实。
  - **前提依赖**：没有。只有边到 episode 的来源链接。
  - **冲突和更新**：见 `edge_operations.py`（https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py ）。
    1. LLM 提示 `dedupe_edges.resolve_edge` 返回 `duplicate_facts` 和 `contradicted_facts` 两组下标。端点相同、文字也相同的，先走快速路径直接判重，不调 LLM。
    2. `resolve_edge_contradictions` 处理矛盾的旧边：
       - 两条的有效期不重叠，就不算冲突；
       - 旧边的 `valid_at` 比新边早，就把旧边的 `invalid_at` 设成新边的 `valid_at`，`expired_at` 设成现在；
       - 候选边的 `valid_at` 比新边晚，说明新边描述的是更早的状态，被置失效的是新边自己。
    3. 失效的边不删。
  - **删除 episode**：
    - Zep 托管版的规则：边和节点只在没有其他 episode 引用时才删；被这个 episode 置失效的事实，删了 episode 也保持失效（https://help.getzep.com/deleting-data-from-the-graph ）。
    - 开源版 `remove_episode()` 有一个 PR 说它只看 MENTIONS 边，会留下孤立实体（https://github.com/getzep/graphiti/pull/1130 ）。合并状态【未核实】。
  - **反思和巩固**：
    - 有 `CommunityNode`（社区摘要）；
    - `EntityNode.summary` 是"regional summary of surrounding edges"；
    - `SagaNode` 做增量摘要。
    - 没有独立的离线 reflect 流程【未核实】。
  - **检索**：语义、BM25、图遍历三路混合，可按图距离重排，另有 cross-encoder 重排器（README）。
  - **竞争假设和反证**：没有。`contradicted_facts` 只用来让旧事实失效，不保留两个说法并存的状态。
- **最值得借鉴的一点**：双时间轴，加上"按事件时间判谁失效"。迟到的旧消息不会把新事实冲掉，失效的事实也不删，可以回放某个时刻"当时认为的世界"。

### 2.4 Hindsight（vectorize-io/hindsight）

- **语言和运行方式**：
  - 服务端是 Python（GitHub 语言统计里 Python 约 25 MB，TS 约 5.9 MB，主要是客户端和界面）（https://api.github.com/repos/vectorize-io/hindsight/languages ）。
  - 客户端有 Python `hindsight-client`、Node `@vectorize-io/hindsight-client`、Go、CLI（https://github.com/vectorize-io/hindsight ）。
  - Node 的 `@vectorize-io/hindsight-all` **不是在 Node 进程里跑**。它用 `uvx` 从 PyPI 拉起 `hindsight-embed` 守护进程，原话 "The daemon runs as a **separate OS process** on `127.0.0.1` (not in your Node process)"。要求 Node ≥ 22，PATH 上要有 `uv` / `uvx`（https://hindsight.vectorize.io/sdks/hindsight-all-npm ）。
  - 只有 Python 能嵌进进程（`hindsight-all`）。
- **许可证**：MIT（https://api.github.com/repos/vectorize-io/hindsight ）。
  - 另有 Hindsight Cloud，按用量计费（README）。
  - 托管版和 OSS 的功能差别【未核实】。
- **版本和活跃度**：
  - v1.0.0（2026-10-13），这一版把它注册成 OpenClaw 原生的记忆提供方（https://api.github.com/repos/vectorize-io/hindsight/releases ）。
  - 最近一次 push 是 2026-10-19，51.7k 星。
- **存储**：
  - PostgreSQL 15+ 加 pgvector 0.5.0+，或 Oracle AI Database。
  - 没配数据库 URL 时，自动起嵌入式 Postgres pg0：端口 5555，数据放 `~/.hindsight/pg0/`。
  - 文档没提 SQLite（https://hindsight.vectorize.io/developer/storage ）。
- **数据模型**：
  - **时间**：记忆单元有以下字段（https://hindsight.vectorize.io/developer/api/memories ）。
    - `occurred_start` / `occurred_end`：事情发生的时间，只对事件有；
    - `mentioned_at`：被提到的时间；
    - `created_at`、`updated_at`、`edited_at`。
    - 另有 `state`：`valid` / `invalidated`。
  - **来源**：
    - 记忆带 `document_id`、`chunk_id`、`tags`、`metadata`、`attachments`；
    - reflect 返回的 `based_on` 列出它引用的记忆（https://hindsight.vectorize.io/developer/retain ）；
    - reflect "只能引用真的检索到的 ID"（https://hindsight.vectorize.io/developer/reflect ）。
  - **推断类型**：
    - `fact_type` 取 `world`、`experience`、`observation`（memories API）。
    - 论文里还有第四个网络 opinion。记忆单元带可选的置信度 `c`，更新规则如下（https://arxiv.org/html/2512.12818v1 ，式 26）：
      - 加强：`min(c+α, 1)`；
      - 减弱：`max(c−α, 0)`；
      - 矛盾：`max(c−2α, 0)`。
    - 当前文档里查不到 opinion 和置信度。是删掉了还是改名了【未核实】。
  - **关联**：retain 时建四类链接：实体、时间、语义、因果（retain 文档）。论文里因果链接还分 `causes`、`caused_by`、`enables`、`prevents`（论文）。
  - **前提依赖**：
    - observation "references the specific memories (with quotes) that support it"，并带一个证据计数（proof count，字段名【未核实】）。
    - **删掉源文档或源记忆时，由它推出的 observation 一起删掉，剩下的源重新巩固**（https://hindsight.vectorize.io/developer/observations ）。这是七个项目里唯一一个"源没了，结论跟着动"的机制。
  - **冲突和更新**：
    - 不覆盖。保留原来的理解，另写一条合成的 observation，例如 "Alice works at Meta (previously thought to work at Google)"。
    - 原始事实永远保留（observations 文档）。
  - **反思和巩固**：分三层。
    - **observation**：retain 之后在后台自动巩固。
    - **mental model**：用户定义一个问题，系统在后台维护它的答案。答案带来源、版本历史和"新鲜度"：范围内有新记忆进来，就标为过期；过期的 mental model 仍会给出，但不能直接拿来回答，要往下层核对（https://hindsight.vectorize.io/developer/mental-models ）。
    - **reflect**：agent 循环，最多 10 轮。先查 mental model，再查 observation，最后查原始事实。可以设"怀疑度、字面度、共情度"三个 1–5 的倾向（reflect 文档）。
  - **竞争假设和反证**：文档里没有。最接近的是论文里 opinion 的"矛盾"更新规则。
- **最值得借鉴的一点**：事实、observation、mental model 三层，每层都能追到下一层的证据，并带"新鲜度"。上层结论过期时不直接用，要往下核对。

### 2.5 Honcho（plastic-labs/honcho）

- **语言和运行方式**：
  - 服务端是 Python FastAPI，本地手动安装要 Python 3.13+（https://github.com/plastic-labs/honcho ）。
  - SDK 有 Python `honcho-ai` 和 TS `@honcho-ai/sdk`，都要连一个 Honcho 服务。
  - 服务可以用托管的 api.honcho.dev，也可以本地 `honcho start` 或自己部署。
  - 后台 deriver 进程负责生成 representation、摘要、peer card，并调度 dreaming。
- **许可证**：
  - **AGPL-3.0**（GNU Affero General Public License v3.0）（https://api.github.com/repos/plastic-labs/honcho ）。
  - 托管版和 OSS 的功能差别【未核实】。
- **版本和活跃度**：
  - v3.3.0（2026-10-14），dream 阶段可以有自己的自定义指令（https://api.github.com/repos/plastic-labs/honcho/releases ）；
  - 最近一次 push 是 2026-10-19，7.7k 星。
- **存储**：
  - 必须用 PostgreSQL + pgvector；Redis 可选，默认关（README）。
  - 不能只用 SQLite。
- **数据模型**：结论存在 `documents` 表（https://github.com/plastic-labs/honcho/blob/main/src/models.py ）。
  - **时间**：
    - 只有 `created_at` 和软删除用的 `deleted_at`。
    - 没有事件时间。v3.2.2 起，相对日期按每条消息的时间戳换算后写进结论正文（releases）。
  - **来源**：
    - 有 `observer`、`observed`（谁对谁下的结论）、`session_name`、`workspace_name`；
    - `times_derived` 记被推出过几次；
    - 前提和来源存在 `document_sources` 表，见下面"前提依赖"。
  - **推断类型**：`DocumentLevel = Literal["explicit", "deductive", "inductive", "contradiction"]`，默认 `explicit`（https://github.com/plastic-labs/honcho/blob/main/src/utils/types.py ）。
    - 文档对各级的说明（https://github.com/plastic-labs/honcho/blob/main/docs/v3/documentation/core-concepts/reasoning.mdx ）：
      - explicit 是"明说的事，作为演绎的前提"；
      - deductive "存了它依据的前提和得出的结论"；
      - inductive 是"跨多条消息的模式"。
    - 文档也提到溯因（abductive），但同时写着"enhanced inductive and abductive reasoning"还在开发。类型定义里没有这一级。
  - **前提依赖**：
    - `document_sources` 表的说明是"derived_id was concluded from source_id"，列有 `derived_id`、`source_id`、`position`、`workspace_name`。
    - `derived_id` 是外键，派生结论删除时级联删掉这些行。
    - `source_id` **不是外键**。所以源结论被删时，数据库层不会带动派生结论。应用层有没有处理【未核实】。
  - **冲突和更新**：dreaming 的演绎阶段做两件事（https://github.com/plastic-labs/honcho/blob/main/docs/v3/documentation/features/advanced/dreaming.mdx ）。
    - 知识更新时，"deletes the outdated conclusion and creates a new one"；
    - 处理矛盾的结论，文档只写了"Conflicting conclusions that need resolution"，没说怎么消解。
  - **反思和巩固**：dreaming 是实验功能，由两个 specialist 依次跑。
    - **演绎**：补上实时处理漏掉的推论，处理知识更新和矛盾，更新 peer card。
    - **归纳**：找行为倾向、偏好、性格、相关性。"Inductive conclusions require evidence from at least two source conclusions"，置信度按支持证据的条数给。`documents` 表没有置信度列，存在哪里【未核实】。
    - **触发条件**：同一个 (workspace, observer, observed) 新增 50 条结论，距上次 dream 至少 8 小时，再等用户 60 分钟没动静。期间来了新消息，就取消重新计时。手动调度可以跳过阈值。
  - **竞争假设和反证**：
    - 没有并存假设的结构。
    - 有 `contradiction` 这一级，但文档没说清它和被矛盾的结论怎么关联【未核实】。
- **最值得借鉴的一点**：把推断类型（显式 / 演绎 / 归纳 / 矛盾）做成一列；再用一张"结论 ← 前提"的有序关联表把推理树落到关系库里。这正是推理图谱需要的骨架。

### 2.6 Letta（letta-ai/letta → letta-ai/letta-code）

- **语言和运行方式**：
  - 原来的 `letta-ai/letta` 现在主要是个指路牌："The current source code lives in letta-ai/letta-code"。V1 API 服务退役后放在 archive 分支（https://github.com/letta-ai/letta ）。
  - `letta-code` 是 TypeScript（https://api.github.com/repos/letta-ai/letta-code ），有 CLI、浏览器端和聊天平台接入。
  - 本地后端会"starts App Server automatically as a subprocess on the current machine"，不在调用方的进程里（https://docs.letta.com/self-hosting ）。
  - 默认后端是 Letta Cloud，可以切到本地（https://github.com/letta-ai/letta-code ）。
- **许可证**：两个仓库都是 Apache-2.0。
- **托管版和本地的差别**：本地后端搜对话记录"只能全文匹配"（https://docs.letta.com/reference/faq ）。其他差别【未核实】。
- **版本和活跃度**：
  - `letta` 最后一版 0.16.8（2026-05-14）（https://api.github.com/repos/letta-ai/letta/releases ）；
  - `letta-code` v0.34.18（2026-10-19），几乎每天发版（https://api.github.com/repos/letta-ai/letta-code/releases ）。
  - `letta` 25.2k 星，`letta-code` 3.7k 星。
- **存储**：
  - 本地状态默认在 `~/.letta/lc-local-backend`，每个 agent 的记忆是 `memfs/<agent-id>/memory` 下的一个仓库（self-hosting）。
  - MemFS 是"a git-tracked collection of Markdown files"，"does not include a semantic or vector index by default"（FAQ）。
  - 用的是哪种数据库，文档没写【未核实】。
- **数据模型**：
  - **时间**：除了 git 提交时间，没有时间字段。
  - **来源**：每次记忆改动都是一次 git 提交，带说明（https://www.letta.com/blog/context-repositories/ ）。
  - **推断类型**：没有。
  - **前提依赖**：没有。
  - **冲突和更新**：
    - agent 自己改文件，历史留在 git 里；
    - 后台子 agent 在各自的 git worktree 里改，改完用 git 合并（context-repositories）。
  - **反思和巩固**：
    - sleep-time 现在叫 dreaming，用 `/sleeptime` 配置，`/dream`、`/reflect` 手动触发（letta-code README）；
    - 另有 defrag 子 agent 拆分、合并、重组记忆文件（context-repositories）；
    - v0.34.18 新增 maintaining-core-memory 和 maintaining-deferred-memory 两个 skill（releases）；
    - `system/` 目录下的文件常驻系统提示（context-repositories）。
  - **竞争假设和反证**：没有。
- **最值得借鉴的一点**：记忆就是 git 里的 Markdown，每次改动可审计、可回滚；后台反思在独立的 worktree 里做，再合并回来，不和前台抢。

### 2.7 HippoRAG 2（OSU-NLP-Group/HippoRAG）

- **语言和运行方式**：
  - Python 3.10，当库用；`setup.py` 里有 `torch==2.5.1`、`transformers==4.45.2`、`python_igraph==0.11.8`、`litellm`，vLLM 是可选的（https://github.com/OSU-NLP-Group/HippoRAG/blob/main/setup.py ）。
  - 有一个 MCP 服务，提供 `index` 和 `delete` 两个工具，可以按原文或 `source_id` 删除段落（https://github.com/OSU-NLP-Group/HippoRAG ）。
- **许可证**：MIT（https://api.github.com/repos/OSU-NLP-Group/HippoRAG ）。没有托管版。
- **版本和活跃度**：
  - PyPI 最新是 `hipporag` 2.0.0a4（2025-06-24），还是预发布（https://pypi.org/project/hipporag/ ）；
  - 仓库里的 `setup.py` 已经是 2.0.0a5；
  - 最近一次 push 是 2026-10-06，4.1k 星。
  - 论文是 ICML 2025（https://arxiv.org/abs/2502.14802 ）。
- **存储**：
  - 嵌入默认存本地 Parquet，可以换 Qdrant、ChromaDB、Milvus；索引放在 `save_dir` 里，带 `index_manifest.json`（README）。
  - 图用 python-igraph（论文）。
  - 不依赖服务，但要 Python + torch。
- **数据模型和方法**（https://arxiv.org/html/2502.14802v2 ）：
  - **节点**：两种。
    - 短语节点：OpenIE 抽出的概念；
    - 段落节点：整段原文。
  - **边**：三种。
    - 关系边：三元组的主语和宾语之间；
    - 同义边：短语嵌入相似度超过 0.8；
    - "contains" 上下文边：段落连到从它抽出的短语。
  - **检索**：
    1. 整个查询做嵌入，去匹配三元组，取前 5 条；
    2. LLM 过滤掉不相关的三元组，论文叫"recognition memory"；
    3. 剩下的三元组给短语节点当种子权重，段落节点也全部当种子（权重 × 0.05）；
    4. 跑 Personalized PageRank，阻尼 0.5，按 PPR 分数给段落排序；
    5. 三元组全被过滤掉时，退回纯向量检索。
  - **时间、推断类型、前提依赖、冲突、反思、竞争假设**：都没有。
- **最值得借鉴的一点**：查询先过一遍"认得出"的过滤，再在"短语 + 原文"混合图上跑 PPR，做多跳联想召回。这可以当混合检索里的一路。

---

## 3. TypeScript / Node 原生、本地 SQLite 的同类库

| 库 | 是什么 | 许可证 | 存储 | 时间 | 活跃度 | 说明 |
|---|---|---|---|---|---|---|
| Mem0 TS OSS（`mem0ai/oss`） | 扁平事实记忆 | Apache-2.0 | better-sqlite3 文件（全表扫描） | 只有 `created_at` / `updated_at` / `expiration_date` 这类（字段名来自托管版 API） | 3.3.1（2026-09-25） | 见 §2.2。OSS 没有图，也没有 Dream |
| TypeGraph（`@nicia-ai/typegraph`） | 嵌入式属性图库，schema 用 Zod 定义 | MIT | SQLite（better-sqlite3、libsql、bun:sqlite、D1）或 PostgreSQL | **双时间轴**：有效时间 `store.asOf(...)`，记录时间 `store.asOfRecorded(...)`，要开 `history: true` | 仓库 2026-02 创建，2026-10-19 还有 push；83 星；网站标 v0.73.1 | 支持 BM25 + 向量混合检索，用 RRF 融合；向量走 sqlite-vec、pgvector 或 libSQL 原生向量（https://github.com/nicia-ai/typegraph ；https://typegraph.dev/ ；https://api.github.com/repos/nicia-ai/typegraph ）。它只是个图库，没有记忆抽取，也没有推理 |
| Mastra Memory（`@mastra/memory`） | agent 框架里的记忆模块：消息历史、working memory、语义召回、observational memory | 主体 Apache-2.0；`ee/` 目录下的代码生产用要企业许可（https://mastra.ai/docs/license.md ） | 存储适配器，示例用 `@mastra/libsql`（`:memory:` 或文件） | 文档没讲 | 没查（读的是 npm 上 1.22.2 附带的文档） | observational memory 由后台 agent 把旧消息压成 observation。working memory 用 Markdown 模板或 Zod schema（https://cdn.jsdelivr.net/npm/@mastra/memory@1.22.2/dist/docs/references/docs-memory-overview.md ）。没有图，也没有推理。记忆模块在不在 `ee/` 里【未核实】 |
| MCP 官方 memory 服务（`@modelcontextprotocol/server-memory`） | 实体、关系、observation 三样的最小知识图 | MIT | 一个 JSONL 文件，写入时加锁 | 没有 | 没查 | 只能当 MCP 服务用，是个参照（https://github.com/modelcontextprotocol/servers/tree/main/src/memory ） |
| OpenClaw 内置记忆检索 | OpenClaw 的一部分 | MIT（https://api.github.com/repos/openclaw/openclaw ） | SQLite 或 PostgreSQL | 日记按 30 天半衰期衰减 | 2026-10-20 还有 push | MMR 用 λ=0.7（https://docs.openclaw.ai/concepts/memory-search ）。文档没提有单独的 npm 包【未核实】 |
| agent-graph-memory、MemoryJS | 个人小项目 | MIT | 单个 SQLite 文件（`node:sqlite`），或 JSONL / SQLite | 自称"time-aware"、"bitemporal" | 分别 1 星、4 星 | 太小，不建议依赖（https://github.com/ZibbyDev/agent-graph-memory ；https://github.com/danielsimonjr/memoryjs ） |

- Graphiti **没有官方 TS 移植**，只有社区写的 Node MCP 服务，后端仍是 Neo4j（§2.3）。
- Zep、Honcho、Hindsight 的 TS SDK 都只是 HTTP 客户端，背后都要一个 Python 服务。

---

## 4. 给 PoC 的结论【建议】

### 4.1 三条路怎么选

| 路线 | 可行性 | 理由 |
|---|---|---|
| 基于某个开源库 | **不推荐** | 能进 Node 进程、又用 SQLite 的只有 Mem0 TS OSS 和 TypeGraph。Mem0 OSS 是扁平事实，图记忆、Dream、时间推理都只在托管版。TypeGraph 只是图存储，而且项目很小。其余项目要么是 Python 服务，要么要图数据库或 Postgres，和"本地 SQLite 守护进程"冲突。推理图谱那部分谁都没有。 |
| 起一个 Python 记忆服务（比如 Graphiti + FalkorDBLite，或 Hindsight + pg0） | 不推荐 | 要多管一个常驻服务：照规矩要进 LSM 托管，还要管 Python 环境和数据库。Graphiti 要 Neo4j 或 FalkorDB，遥测默认开。Honcho 是 AGPL。花了这些代价，竞争假设和失效传播还是要自己写。 |
| **TS + SQLite 自己写，设计照各家拼** | **推荐** | 存储用二狗已有的 SQLite，加上 FTS5 和 sqlite-vec。数据模型照下表借字段和规则，只借设计不抄代码，Honcho 的 AGPL 就不受影响。 |

### 4.2 每块能力照谁做

| PoC 要的能力 | 照谁 | 具体借什么 |
|---|---|---|
| 证据库（原始材料） | Graphiti episode；Hindsight document / chunk | `source`、`source_description`、`content`、`valid_at`；证据带原文引用（Hindsight 的 observation 引用"with quotes"） |
| 时间 | Graphiti `EntityEdge`；Hindsight 记忆单元 | 事件时间 `valid_at` / `invalid_at`，系统时间 `created_at` / `expired_at`；事件区间 `occurred_start` / `occurred_end` 和 `mentioned_at` 分开存；对将来的计划，`valid_at` 取说这话的时间 |
| 事实冲突 | Graphiti `resolve_edge_contradictions` | 有效期不重叠就不算冲突；按事件时间判谁失效；失效的不删 |
| 推断类型 | Honcho `DocumentLevel` | `explicit` / `deductive` / `inductive` / `contradiction`，再加一级 `abductive` |
| 前提依赖 | Honcho `document_sources` | 结论、前提、`position` 三列的关联表。不同的是 `source_id` 要做成真外键，好做传播 |
| 失效传播 | Hindsight 的删源级联重巩固；mental model 的新鲜度 | 源被删或失效时，下游结论标"待复查"，不直接删；上层结论过期时不直接用，要往下核对 |
| 竞争假设、支持和反对证据 | 开源项目里都没有；参照 Hindsight 论文的置信度更新（加强 +α，减弱 −α，矛盾 −2α），以及真值维护系统（Doyle 1979，*Artificial Intelligence* 12:231–272，https://www.csc2.ncsu.edu/faculty/jdoyle2/publications ） | 自己设计。已有的推理图谱做法里的 DAG、竞争假设、判别性追问可以直接当规格 |
| 离线巩固 | Honcho dreaming 的触发条件；JiuwenMemory 的三段 Dreaming 和共用锁；Letta 在 worktree 里反思 | "新增 N 条，且距上次够久，且用户空闲"三个条件都满足才跑；巩固和在线写入共用冲突检测 |
| 混合检索 | Mem0 的实体命中加权；Graphiti 的语义 + BM25 + 图遍历；HippoRAG 2 的"三元组过滤 + PPR"；OpenClaw 的 MMR 和时间衰减 | 前几路用 FTS5 和 sqlite-vec 就能做；PPR 在 TS 里自己写，图小，迭代几十次就够 |

### 4.3 风险

- 自己写意味着抽取提示词、去重、实体合并都要自己调。Graphiti 的 `prompt_library`（如 `dedupe_edges.resolve_edge`）可以当参考，它是 Apache-2.0，注明出处就能改写。
- Mem0 默认用 OpenAI 的 `gpt-5-mini` 和 `text-embedding-3-small`（README）；Graphiti 默认用 OpenAI，并说"works best with LLM services that support Structured Output"（README）。二狗默认用 DeepSeek，抽取、去重这类结构化输出的质量要自己测【未核实】。

---

## 5. 没核实到的

- **JiuwenMemory**：
  - 有没有托管版；
  - OpenClaw 插件怎么连到记忆服务；
  - 只用文件后端能不能完全不要 ChromaDB；
  - 图存储能不能用 Milvus Lite 的本地文件。
- **Mem0**：
  - `linked_memory_ids` 是否存在（05 号调研写过，这次没找到）；
  - "oss-v2-to-v3" 对应哪个包版本；
  - OSS 版每条记忆的字段名（`created_at` 等是托管版 API 的字段）。
- **Graphiti**：
  - 开源版有没有 Zep 的 Observations；
  - `remove_episode` 孤立实体的修复（PR #1130）合并了没有。
- **Hindsight**：
  - 论文里的 opinion 网络和置信度，在当前版本里是删了还是改名了；
  - observation 的证据计数字段叫什么；
  - Cloud 和 OSS 的功能差别。
- **Honcho**：
  - 托管版和 OSS 的差别；
  - `contradiction` 级的结论怎么关联到被矛盾的结论；
  - 源结论删除后，应用层会不会处理派生结论；
  - 归纳结论的置信度存在哪里。
- **Letta**：本地后端用的是哪种数据库。
- **Mastra**：记忆模块在不在 `ee/` 企业许可的目录里。
- **OpenClaw**：内置记忆检索有没有单独的 npm 包。

---

## 6. 对比表

"可嵌入 Node"指能不能在二狗的 Node 进程里直接调用，不另起服务或子进程。

| 项目 | 语言 | 许可证 | 存储 | 可嵌入 Node | 时间 | 推断类型 | 前提依赖 | 竞争假设或反证 | 反思 |
|---|---|---|---|---|---|---|---|---|---|
| JiuwenMemory | Python | Apache-2.0 | SQLite / PG / MySQL + ChromaDB / Milvus 等；图记忆只能用 Milvus；有 SQLite + sqlite-vec + FTS5 的文件后端 | 否（Python 库，或 FastAPI / MCP 服务） | 关系 `valid_since` / `valid_until` + `created_at`（单条事件时间轴） | 无 | 无（只有 `Entity.episodes`） | 无 | Dreaming：浅睡、REM、深睡三段，默认关 |
| Mem0 | Python + TS | Apache-2.0 | TS OSS 用 better-sqlite3（全表扫描），可换 Qdrant、pgvector 等；图只在托管版 | **是**（`mem0ai/oss`） | `created_at` / `updated_at` / `expiration_date`；`timestamp`；事件时间加权只在托管版 | 无（只分用户还是 agent；托管版有 `synthesized`） | 无（托管版有 `replaced_by`） | 无（ADD-only，新旧并存） | Dream 只在托管版 |
| Graphiti | Python | Apache-2.0 | Neo4j / FalkorDB / FalkorDBLite（Python ≥ 3.12）/ Neptune；Kuzu 弃用；不能只用 SQLite | 否 | **双时间轴**：`valid_at` / `invalid_at` + `created_at` / `expired_at` + `reference_time` | 无 | 无（边 → `episodes`） | 只有 `contradicted_facts` 让旧事实失效 | community、entity summary、saga 增量摘要 |
| Hindsight | Python 服务；TS / Go 客户端 | MIT | PG 15+ / pgvector 0.5+ 或 Oracle；嵌入式 pg0 | 否（Node 包用 uvx 起 Python 守护进程） | `occurred_start` / `occurred_end` / `mentioned_at` / `created_at`；`state` 有效或失效 | `world` / `experience` / `observation`（论文还有 opinion） | observation 引用源记忆；**删源时派生的 observation 跟着删再重新巩固** | 论文里 opinion 有置信度，按加强 / 减弱 / 矛盾更新；当前文档里没有 | observation 自动巩固 + mental model（带新鲜度）+ reflect agent |
| Honcho | Python 服务；TS / Python SDK | **AGPL-3.0** | PG + pgvector；Redis 可选 | 否（SDK 连 FastAPI 服务） | 只有 `created_at` / `deleted_at`；相对日期换算后写进正文 | **`explicit` / `deductive` / `inductive` / `contradiction`**（abductive 在开发） | **`document_sources`（derived ← source，带 `position`）** | 有 `contradiction` 级，没有并存假设 | dreaming：先演绎再归纳；新增 50 条、间隔 8 小时、空闲 60 分钟才跑 |
| Letta（letta-code） | TypeScript | Apache-2.0 | git 跟踪的 Markdown（MemFS），本地在 `~/.letta/lc-local-backend` | 否（本地后端起 App Server 子进程） | 只有 git 历史 | 无 | 无 | 无 | sleep-time / dreaming、reflect、defrag，在 worktree 里改再合并 |
| HippoRAG 2 | Python（torch） | MIT | 本地 Parquet + igraph；可换 Qdrant / Chroma / Milvus | 否 | 无 | 无 | 无（段落 → 短语用 "contains" 边连） | 无 | 无 |
| TypeGraph（参照） | TypeScript | MIT | SQLite / PG；sqlite-vec | **是** | **双时间轴**（`asOf` / `asOfRecorded`） | 无（只是图库） | 自己建模 | 无 | 无 |
