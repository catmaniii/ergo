// @ergo/memory：二狗的记忆系统（docs/memory-system.md、docs/memory-architecture.md；188 号票起叫 memory-lab，326 号票改名，评测、演示和评测数据不在这个包里）。
// 对外的入口是 MemoryEngine；各层也单独导出，给守护进程的记忆插件、评测和测试用。
// ④ 号票加了推理图谱（rg/）、用户模型（user-model/）、模型版（llm/、kg/llm-extractor.ts、rg/llm-reasoner.ts）。
// 196 号票加了为任务调出相关的用户模型（rg/domains、claim-index、value-retrieval）和交互策略（rg/strategies、advice）。
// 201 号票加了模型版往上抽（rg/llm-lift）、模型版编策略（rg/llm-strategies）、它们的费用估算（llm/plan-lift）。
// 202 号票加了回答层的问题分流（rg/question）和相关门槛（rg/relevance）。
// 198 号票加了了解你问题（rg/question-sources、rg/questions）和每日整理（nightly）。
// 199 号票加了知识图谱和推理图谱联动：实体关系（kg/relations、align）、对比模式（kg/motifs）、事实上的标记（kg/marks）、
// 矛盾根源（rg/conflict-roots）、联动（rg/joint）、写回（rg/writeback）。
// 216 号票加了大模型回答器（llm/answerer，模拟秘书）和给它看的记忆简报（llm/brief）。
// 218 号票加了模型输出截断、解析不了时的恢复和分批（llm/robust）、建库的统计（rg/build-stats）。
// 226 号票加了预测账本（rg/predictions）：成立的结论当时写了什么预测、到期判应验没有；330 号票做成预测节点，落空了往回打来源（rg/falsify）。
// 227 号票加了对抗复核（rg/adversarial）、复评水位和表象覆盖（nightly）。
// 234 号票加了彻底删除的登记（purge）：删证据、事实，依赖的结论待复核，相关问题过期，写审计。
// 263 号票加了用户对结论的直接表态（rg/verdicts）：对 / 不对 / 拿不准，走引擎的写接口，整理计分不改回。
// 270 号票加了每晚整理的预算按道花（rg/nightly-lanes）：新证据先、重跑旧追问用剩下的，整理完一条新证据记一条。
// 271 号票加了每晚整理时判顺口问的回答（rg/reply-judge）：问过的问题和用户之后的几句话交给记忆管理员判，答了回写、没答算跳过、拿不准留到下一夜。
// 283 号票加了个人档案和记忆的联动：认人物信息攒成档案的候选（kg/person-info）、档案里的人对到人物实体和新值作废旧事实（kg/profile）、
// 发给模型之前加档案摘要当背景和藏起号码（llm/guarded-chat）。
// 326 号票加了图谱自检（rg/graph-check）：每晚校验整张推理图谱查一遍，规矩和唯一写入口共用一份（rg/graph-rules）。
export * from "./domain/types.ts";
export * from "./domain/ids.ts";
export * from "./domain/time.ts";
export * from "./domain/validate.ts";
export * from "./store/store.ts";
export * from "./evidence/source.ts";
export * from "./evidence/synthetic.ts";
export * from "./evidence/boundary.ts";
export * from "./kg/lexicon.ts";
export * from "./kg/context.ts";
export * from "./kg/signals.ts";
export * from "./kg/change.ts";
export * from "./kg/statement.ts";
export * from "./kg/extractor.ts";
export * from "./kg/graph.ts";
export * from "./kg/llm-extractor.ts";
export * from "./kg/align.ts";
export * from "./kg/relations.ts";
export * from "./kg/motifs.ts";
export * from "./kg/marks.ts";
export * from "./kg/person-info.ts";
export * from "./kg/profile.ts";
export * from "./embedding/embedder.ts";
export * from "./embedding/fake.ts";
export * from "./embedding/transformers.ts";
export * from "./retrieval/types.ts";
export * from "./retrieval/terms.ts";
export * from "./retrieval/plan.ts";
export * from "./retrieval/rrf.ts";
export * from "./retrieval/keyword.ts";
export * from "./retrieval/vector.ts";
export * from "./retrieval/expand.ts";
export * from "./retrieval/search.ts";
export * from "./rg/types.ts";
export * from "./rg/concepts.ts";
export * from "./rg/scoring.ts";
export * from "./rg/templates.ts";
export * from "./rg/rule-reasoner.ts";
export * from "./rg/llm-reasoner.ts";
export * from "./rg/registry.ts";
export * from "./rg/fallback-search.ts";
export * from "./rg/reasoning-graph.ts";
export * from "./rg/status-keeper.ts";
export * from "./rg/explain.ts";
export * from "./rg/answer.ts";
export * from "./rg/rg-search.ts";
export * from "./rg/lift.ts";
export * from "./rg/domains.ts";
export * from "./rg/claim-index.ts";
export * from "./rg/value-retrieval.ts";
export * from "./rg/strategies.ts";
export * from "./rg/advice.ts";
export * from "./rg/llm-lift.ts";
export * from "./rg/llm-strategies.ts";
export * from "./rg/question.ts";
export * from "./rg/relevance.ts";
export * from "./rg/background.ts";
export * from "./rg/question-sources.ts";
export * from "./rg/questions.ts";
export * from "./rg/predictions.ts";
export * from "./rg/falsify.ts";
export * from "./rg/relayed.ts";
export * from "./rg/link-sources.ts";
export { narrowClaim, separatingTags, tagsLabel, targetContext } from "./rg/contradictions.ts";
export * from "./rg/verdicts.ts";
export * from "./rg/nightly-lanes.ts";
export * from "./rg/reply-judge.ts";
export * from "./nightly.ts";
export * from "./full-rejudge.ts";
export * from "./rg/conflict-roots.ts";
export * from "./rg/joint.ts";
export * from "./rg/writeback.ts";
export * from "./user-model/snapshot.ts";
export * from "./llm/chat.ts";
export * from "./llm/deepseek.ts";
export * from "./llm/estimate.ts";
export * from "./llm/json.ts";
export * from "./llm/plan.ts";
export * from "./llm/plan-lift.ts";
export * from "./llm/brief.ts";
export * from "./llm/answerer.ts";
export * from "./llm/robust.ts";
export * from "./llm/guarded-chat.ts";
export * from "./llm/metered.ts";
export * from "./rg/build-stats.ts";
export * from "./rg/adversarial.ts";
export * from "./rg/write-gate.ts";
export * from "./rg/template-export.ts";
export * from "./rg/graph-rules.ts";
export * from "./rg/graph-check.ts";
export * from "./rg/nightly-validate.ts";
export * from "./rg/migrate-rules.ts";
export * from "./purge.ts";
export * from "./engine.ts";
