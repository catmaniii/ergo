// 显式记忆命令与素材删除（规格第 14、15 节，21 号票）在内核这一侧对外的东西（129 号票起记忆命令、记忆删除卡、秘书的素材检索
// 是记忆插件的：memory/plugin.ts，别的模块只从 memory/api.ts 拿它的东西，test/memory/boundary.test.ts 检查）：
// - 设置里按会话、按时间段批量删除：createBulkMaterialDeletion（记忆插件停用时照常删已有的素材）；
// - 设置里看素材（158 号票：范围里的素材列表、一条的完整内容和来源）：createMaterialBrowser（同上，停用时照样能看）；
// - 素材引着的记录：internalRecordOf、MaterialOwners（项目内部的记录秘书检索不到、删项目时随项目删）；
// - 删项目、删任务时随它彻底删掉由系统记下的素材：registerMaterialsDeletion（"删除参与方"登记表，279 号票）；
// - 彻底删除的改写函数表：PurgeRewriters（内核模块的改写函数在 daemon.ts 里登记，插件的在它的数据契约里）；
// - 彻底删除之后：会话文件要改写什么（sessionRewriteFor）、没人引用的媒体文件（startPurgedMediaCleanup）；
//   被删素材在推理库里的证据编号（purgedEvidenceIds，265 号票：问记忆的结果按证据编号引原话；lookupPurgedEvidence 分得清查不了）；
//   265 号票以前删过的、问记忆结果里还留着的原话，守护进程启动时补抹一次（backfillPurgedQuotes，272 号票）；
// - 推理库的只读视图（233 号票）：概览、结论、一条结论的完整解释、问题箱（createMemoryGraphReader）。
export { internalRecordOf, type MaterialOwners } from "./internal-records.ts";
export { type BulkMaterialDeletion, createBulkMaterialDeletion } from "./bulk.ts";
export { createMaterialBrowser, type MaterialBrowser } from "./browse.ts";
// 推理库的只读视图（233 号票）：网页"记忆"页的概览、结论、证据、问题箱。和素材一样是内核这一侧的：
// 记忆插件停用了照样能看已有的（接口本身不报错），随用随开引擎、用完关
export { createMemoryGraphReader, type MemoryGraphReader } from "./graph.ts";
// 记忆的设置（264 号票）：顺口问开不开。配置区里的一个小 JSON，组合根建一份交给网关的设置接口和记忆插件（KERNEL.memorySettings）
export { createMemorySettings, type MemorySettingsService } from "./settings.ts";
export { type MemoryNightlyRecord } from "./nightly-record.ts";
export { PurgeRewriters } from "./rewriters.ts";
// "删除参与方"登记表里素材库的那一份（279 号票）：删项目、删任务时随它彻底删掉由系统记下的素材（66 号票），组合根登记
export { type MaterialsDeletionDeps, registerMaterialsDeletion } from "./deletion-participants.ts";
export { sessionRewriteFor, startPurgedMediaCleanup } from "./after-purge.ts";
export { lookupPurgedEvidence, purgedEvidenceIds } from "./purged-evidence.ts";
export { backfillPurgedQuotes } from "./purge-backfill.ts";
