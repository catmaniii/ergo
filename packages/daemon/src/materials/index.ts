// 素材模块对外的东西（规格第 15 节）。别的模块只从这里取；memory.db 的连接不出 materials/。
// - 守护进程装配：openMaterials、createBgeM3Embedder；下载命令：downloadBgeM3；
// - 接入一种素材来源（各票）：MaterialSource、MaterialDraft、userDecisionDraft、segmentPieces / MaterialPiece，见 capture.ts 开头；
// - 用素材（21 号票的检索和删除）：Materials 的读和检索、Material、MaterialKind、EmbeddingUnavailable。
export { openMaterials, type Materials } from "./materials.ts";
export { type MaterialDraft, type MaterialSource, userDecisionDraft } from "./capture.ts";
export { type MaterialPiece, segmentPieces } from "./segments.ts";
export type { Material, MaterialKind } from "./types.ts";
export { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
export { createBgeM3Embedder, downloadBgeM3 } from "./embedding/bge-m3.ts";
