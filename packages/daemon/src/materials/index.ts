// 素材模块对外的东西（规格第 15 节）。别的模块只从这里取；memory.db 的连接不出 materials/。
// 接入一种素材来源：见 capture.ts 开头的说明（在 daemon.ts 里、materials.start() 之前 materials.register(...)）。
export { openMaterials, type Materials, type MaterialsOptions, type MaterialFilter, type MaterialHit, type VectorStatus } from "./materials.ts";
export { type MaterialDraft, type MaterialSource, userDecisionDraft } from "./capture.ts";
export { type MaterialPiece, messagePieces, segmentMessage, segmentPieces } from "./segments.ts";
export { DEFAULT_STALE_CARD_DAYS, STALE_WATCHED_CARD_TYPES } from "./avoidance.ts";
export { NON_MATERIAL_CARD_TYPES } from "./sources.ts";
export { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
export { createBgeM3Embedder } from "./embedding/bge-m3.ts";
export * from "./types.ts";
