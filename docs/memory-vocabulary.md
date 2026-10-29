# 记忆系统的词汇对照：推理图谱模板 ↔ 推理库 ↔ 代码

Status: 2026-10-21 定稿；2026-10-27 按 ADR-0032 改了状态、复核标记、身份几行
权威来源：模板以导出器 `packages/memory/src/rg/template-export.ts` 写出的 YAML 为准；库以 `packages/memory/src/store/schema.ts` 为准；代码以 `packages/memory/src/` 为准。

## 这份文档解决什么

同一套概念在三个地方叫法不一样：模板（YAML）叫 `nodes / kind / deps / status / basis / derivation`，库里叫 `claims / tier / inferences / links / epistemic`，代码里又叫 `ClaimTier / Inference / StoredLink`。这份表把三者对上，**以后新增的东西按模板词汇起名，已实现的列名不再改**。

## 对照表

| 概念 | 模板（YAML） | 推理库（rg.db） | 代码 / API | 说明 |
|---|---|---|---|---|
| 图 | `nodes` 一个数组 | 一类对象一张表：`facts` / `claims` / `inferences` / `strategies` / `questions` | `Fact` / `Claim` / `Inference` / `Strategy` / `Question` | 库里按对象分表，不塞一个 `nodes` 表 |
| 节点 id | `id`（`F-` / `J-` / `D-` / `Q-` 前缀惯例） | `facts.id`（`fa-`）、`claims.id`（`cl-`）、`inferences.id`、`strategies.id`、`questions.id` | 同左 | 前缀是方言，语义一样 |
| 断言 | `statement` | `facts.statement` / `claims.statement` | `Fact.statement` / `Claim.statement` | 一致 |
| 认知类型 | `kind: fact / inference / decision / question` | 表：`facts` / `claims` + `inferences` / `strategies` / `questions` | 同左 | 库里用表区分。`claims.kind`（`conclusion` / `hypothesis`）是另一回事：只说这条结论从哪起的（用户明说的 / 推断的），建号定、不改（ADR-0032），不表示验没验证 |
| 依赖边 | `deps` | `inferences.premise_ids` + `inference_premises` 表 | `Inference.premiseIds` | 一致，支持按前提反查（失效传播） |
| 分层 | `layer`（L0–L4，项目方言） | `claims.tier`（`state` / `preference` / `need` / `value`） | `ClaimTier` | 映射：L2 情境意图 ≈ `state`，L3 稳定需求 ≈ `need`，L4 内核 ≈ `value`；L0 情节、L1 观察只留在证据和事实里，不建结论 |
| 状态 | `status`，按 kind 分词表 | `claims.status`（`active` / `contested` / `retracted` / `superseded`）、`facts.status`（`active` / `contested` / `superseded` / `corrected` / `retracted`） | `ClaimStatus` / `FactStatus` | 映射（ADR-0032）：模板 `verified` = 我们 `active`（已验证）、`unverified` = `contested`（猜测，按把握分高低）、`retracted` = `retracted`；`superseded` 是被新的一条取代；模板没有 `proven`、`conditional`，我们也不分。事实的 `contested` 是真冲突里的一边（拿不准），当前提时算没验证。模板 `decision: inactive` 我们没有对应，decision 在本项目落在 `strategies.status` |
| 复核标记 | `dirty`（算出来的，提示要复审） | `claims.needs_review`（0 / 1） | `Claim.needsReview` | 329 号票起"待复核"不再是状态：依据刚变了、等下一次整理重判，不改真值状态。推断的 `needs_review` 状态只表示"前提被彻底删除、停用着等重推"；推断还有 `history`（被直接证实以后原来那条推理链） |
| 凭什么信 | `basis`（machine-proof / experiment / spec…） | `claims.epistemic`（`explicit` / `inferred` / `user_confirmed`）+ `evidence.source_level`（`self` / `agent` / `untrusted` / `system`）+ `evidence.mode`（`say` / `do`） | `EpistemicStatus` / `SourceLevel` / `Mode` | 个人生活没有"机器证明"那一套；我们用"谁说的 + 说的还是做的 + 推断/确认"表达同一件事 |
| 推理有效性 | `derivation`（`deductive` / `defeasible`） | 结论的推断：`inferences.method`（`explicit` / `deduction` / `induction` / `abduction` / `user_confirmation`）；预测节点：`predictions.derivation`（`deductive` / `defeasible`，330 号票照模板词汇起名） | `Method`；`Derivation` | 映射：`deductive` ≈ `deduction`，`defeasible` ≈ `induction` / `abduction`。结论自己的推断都不标演绎（归纳、溯因）；演绎只出现在预测上，谁能标见 ADR-0032（330 号票，R10） |
| 预测 | `predicts`；预测本身是从假说演绎出的节点（`deps` 指假说） | `claims.predicts`（结论上写的文本）+ `predictions` 预测节点（226 号票的账本，330 号票做成节点） | `PredictionRecord` | 节点记 `claim_id / premise_ids / derivation / predicts / made_at / due_at / status / retracted_by / blame`；状态 `open` 未验证、`hit` 应验、`miss` 落空（撤回）、`void` 来源撤了跟着撤、`unclear` 说不清 |
| 追问 | `probes`、`discriminates`、`if_yes` / `if_absent` | `probes` 表：`discriminates` / `ask` / `queries` / `if_found` / `outcome` | `Probe` | 一致 |
| 撤回 | `retracted_by` | `claims.retracted_by` / `facts.retracted_by` | 同左 | 一致，撤回留墓碑。墓碑只指真正推翻它的东西（反证、用户的否认、纠正的话），或者连带撤回、来源失效时不在了的那条前提（ADR-0032） |
| 被回答 | `answered_by`（指向节点） | `questions.answer_evidence_id` + `verdict` | — | 个人记忆里"回答"是一条素材，不是节点 |
| 改动日志 | `changelog` | `revisions`（只追加，触发器挡住改删） | — | 一致，库里有强约束 |
| 复评水位 | `review` | `claims.reviewed_at`；报告里 `reviewDue`（227 号票） | — | 部分：模板有水位，我们有时间戳和计数 |
| 适用范围 | `scope` | 暂不落库 | — | 个人记忆只有一个范围，等以后多范围再说 |
| 项目方言 | `config` | `manifest`（版本、抽取器、向量模型、数据摘要） | — | 语义不同：模板 config 是图规格，manifest 是构建信息 |

## 三条规矩

1. **已实现的列名不再改**：`claims / tier / epistemic / method / links / inferences` 已经进了代码、测试和评测；改名要迁移库 + 改测试 + 重跑评测，收益只是叫法统一。改的话单独开票。
2. **新增的东西按模板词汇起名**：比如预测账本用 `claim_id / predicts / made_at / due_at / status`；复评水位叫 `reviewDue`；以后要加"节点导出"就照 `id / kind / statement / deps / status` 出。
3. **对外一律用模板词**：导出的 JSON（`memory:dump-claims`）、网页记忆页、给用户看的报告，说的是"层、结论、依赖、状态、预测"；`tier`、`claim`、`link` 这些只在代码里出现。

## 待办（没开票）

- ~~`memory:dump-claims` 加一个 `--format template`~~ **2026-10-23 做了（253 号票）**：`npm run memory:dump-template`（`packages/daemon/test/memory/dump-template.ts`）只读导线上 `rg.db` → 模板 `nodes` 形状的 YAML，给人看图、拿别的工具查（326 号票起每晚校验不用它，改成直接查库的图谱自检）。只做单向导出（rg.db → 模板），反向导入另开票。
- 网页记忆页也照模板词展示（"层 / 状态 / 依赖 / 预测"），不直接暴露数据库字段名。
