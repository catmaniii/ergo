// 338 号票：会意的推理库搬进插件自己的数据目录（<数据目录>/memory/subtext/rg.db）。
// 为什么单独一个文件：这一步要在打开引擎之前做，和插件的实现无关；做成纯函数好测（不进 daemon.ts 也能验）。
// 规矩（见 .scratch/ergo-v2/impl/338-memory-data-migration.md）：照 migrate/legacy-db.ts 那一套——
// - 只搬 rg.db（连同 -wal / -shm）；素材库 materials.db 和事件日志归内核，不动；
// - 先复制一份到 backup/pre-migration-<时间>/，再移动；目标已存在就不动（幂等）；
// - 写 migrated.json 记从哪来、什么时候、搬之前多大；回滚就是把它移回 db/。
// @i18n-ignore-file log：迁移过程只进日志（原因给开发者看）
import path from "node:path";
import { type LegacyMigrationOptions, migrateLegacyDb, rollbackLegacyDb } from "../migrate/legacy-db.ts";

export const MIGRATION_MARKER = "migrated.json";

/** 迁移结果：moved 真搬了；skipped 目标已有或旧文件不在；rolledBack 回滚成功 */
export type MigrateOutcome = "moved" | "skipped" | "rolledBack";

export interface MigrateOptions {
  /** 数据目录 */
  dataDir: string;
  /** 现在推理库在哪（通常是 <数据目录>/db/rg.db） */
  from: string;
  /** 插件的数据目录（<数据目录>/memory/subtext） */
  toDir: string;
  storeName: string;
  log: (line: string) => void;
  /** 时钟（测试用手拨的） */
  now?: () => Date;
}

/** 记号和目标的完整路径：这一族的文件由 legacy-db.ts 搬，这里只管日志怎么写 */
function pathsOf(options: MigrateOptions): LegacyMigrationOptions {
  return { dataDir: options.dataDir, from: options.from, to: path.join(options.toDir, options.storeName), marker: path.join(options.toDir, MIGRATION_MARKER), ...(options.now ? { now: options.now } : {}) };
}

/** 把推理库从旧位置搬进插件数据目录；幂等 */
export function migrateReasoningDb(options: MigrateOptions): MigrateOutcome {
  const paths = pathsOf(options);
  const result = migrateLegacyDb(paths);
  if (result.outcome === "moved") options.log(`推理库搬进插件数据目录：${paths.from} → ${paths.to}（备份在 ${result.backupDir}）`);
  return result.outcome;
}

/** 回滚：把插件数据目录里的推理库搬回 db/；目标已有就拒绝 */
export function rollbackReasoningDb(options: MigrateOptions): MigrateOutcome {
  const paths = pathsOf(options);
  const outcome = rollbackLegacyDb(paths);
  options.log(outcome === "rolledBack" ? `推理库搬回：${paths.to} → ${paths.from}` : `回滚不了：${paths.to} 不在了，或者 ${paths.from} 已经有了（先把它挪走）`);
  return outcome;
}
