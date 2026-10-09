// 显式记忆命令与素材删除（规格第 14、15 节，21 号票）对外的东西：
// - 登记进快速动作的执行器注册表：memoryCommandExecutors（记住、忘掉、彻底删除、别推断）；
// - 卡片：memoryDeleteCardType（记忆删除卡）；
// - 秘书的只读工具：searchMaterialsTool（素材检索，关键词 + 向量）；
// - 设置里按会话、按时间段批量删除：createBulkMaterialDeletion；
// - 彻底删除的改写函数表：PurgeRewriters（各模块的改写函数在 daemon.ts 里登记）；
// - 彻底删除之后：会话文件要改写什么（sessionRewriteFor）、没人引用的媒体文件（startPurgedMediaCleanup）。
export { memoryCommandExecutors, memoryDeleteCardType, REMEMBER_TRIGGERS } from "./memory-commands.ts";
export { SEARCH_MATERIALS, searchMaterialsTool } from "./search-tool.ts";
export { internalRecordOf, type MaterialOwners } from "./internal-records.ts";
export { type BulkMaterialDeletion, createBulkMaterialDeletion } from "./bulk.ts";
export { PurgeRewriters } from "./rewriters.ts";
export { sessionRewriteFor, startPurgedMediaCleanup } from "./after-purge.ts";
