// 素材模块对外的东西（规格第 15 节）。别的模块只从这里取；memory.db 的连接不出 materials/。
// - 守护进程装配：openMaterials、createBgeM3Embedder；下载命令：downloadBgeM3；
// - 接入一种素材来源（各票）：MaterialSource、MaterialDraft、userDecisionDraft、segmentPieces / MaterialPiece，见 capture.ts 开头；
// - 用素材（21 号票的检索和删除）：Materials 的读和检索、Material、MaterialKind、EmbeddingUnavailable；
//   记忆命令事件所在的频道 MATERIALS_CHANNEL（记忆命令模块往这里追加 memory_command，素材模块据此删除、标记素材）；
//   彻底删除时素材来源的事件怎么改写（rememberCommandPurge、cardSignalPurge，登记进记忆模块的改写函数表）；
//   用户消息里哪些字是自己打的、哪些是引用块（messagePieces，"明确点了"的判定也用它）。
export { openMaterials, type Materials } from "./materials.ts";
export { type MaterialDraft, type MaterialSource, userDecisionDraft } from "./capture.ts";
export { type MaterialPiece, messagePieces, segmentPieces } from "./segments.ts";
export type { Material, MaterialKind } from "./types.ts";
export { MATERIAL_KIND_LABEL } from "./types.ts";
export { MATERIALS_CHANNEL, rememberCommandPurge, scopeLabel } from "./commands.ts";
export { cardSignalPurge, conversationKind } from "./sources.ts";
export { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
export { createBgeM3Embedder, downloadBgeM3 } from "./embedding/bge-m3.ts";
