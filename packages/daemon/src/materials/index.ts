// 素材模块对外的东西（规格第 15 节）。别的模块只从这里取；materials.db 的连接不出 materials/。
// - 守护进程装配：openMaterials（素材库，内核）、createBgeM3Embedder（向量函数，内核交给记忆插件）；BGE_M3（锁定的版本和文件，组件清单核对用）；
// - 接入一种素材来源（各票）：MaterialSource、MaterialDraft、userDecisionDraft、segmentPieces / MaterialPiece，见 capture.ts 开头；
//   素材 id 怎么由事件算出来（materialId：165 号票存网页的接口当场回它）；
//   129 号票起拥有事件的模块声明进素材库：内核的在组合根里 materials.register，插件的在数据契约里 ctx.materialSources.register；
// - 用素材（21 号票的检索和删除）：Materials 的读和检索、Material、MaterialKind、EmbeddingUnavailable；
//   记忆命令事件所在的频道 MATERIALS_CHANNEL（记忆命令模块往这里追加 memory_command，素材模块据此删除、标记素材）；
//   彻底删除时素材来源的事件怎么改写（cardDismissedPurge 内核登记；rememberCommandPurge、cardStalePurge 记忆插件的契约登记）；
//   用户消息里哪些字是自己打的、哪些是引用块（messagePieces，"明确点了"的判定也用它）；
//   素材的摘录（excerptOf：记忆删除卡、检索结果、158 号票设置里的素材列表）、挨着检索词的一段（snippetOf，167 号票挪进来）；
//   记忆 · 素材按种类筛（materialFacets、matchesFacets，167 号票）；
// - 记忆插件（memory/plugin.ts，129 号票）：采成素材（Materials.collect 和它要的 CollectOptions）、它声明的素材来源
//   （memoryCommandSource、cardStaleSource）。
export { type CollectOptions, openMaterials, type Materials } from "./materials.ts";
export { type MaterialDraft, materialId, type MaterialSource, userDecisionDraft } from "./capture.ts";
export { type MaterialPiece, messagePieces, segmentPieces } from "./segments.ts";
export type { Material, MaterialKind } from "./types.ts";
export { MATERIAL_KIND_LABEL } from "./types.ts";
export { excerptOf, queryTerms, snippetOf } from "./excerpt.ts";
export { materialFacets, matchesFacets } from "./facets.ts";
export { MATERIALS_CHANNEL, MEMORY_COMMAND_SOURCE, memoryCommandSource, rememberCommandPurge, scopeLabel } from "./commands.ts";
export { cardDismissedPurge, cardStalePurge, cardStaleSource, conversationKind, interviewQuestionSegments } from "./sources.ts";
export { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
export { BGE_M3, createBgeM3Embedder } from "./embedding/bge-m3.ts";
