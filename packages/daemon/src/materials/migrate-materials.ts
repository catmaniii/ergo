// ADR-0035：素材库的文件名从 db/memory.db 改成 db/materials.db——老名字和记忆插件的数据目录（<数据目录>/memory/<插件 id>/）
// 撞了，容易以为是一个东西。素材库是内核的（ADR-0006），这里只改文件名、不改里面的任何东西。
// 为什么单独一个文件：这一步要在打开素材库之前做，和库怎么打开无关；做成纯函数好测（不进 daemon.ts 也能验）。
// 规矩照 migrate/legacy-db.ts 那一套：
// - 只搬素材库这一族文件（materials.db 连同 -wal / -shm）；原文副本、事件日志归内核、不动；
// - 先复制一份到 <数据目录>/backup/pre-migration-<时间>/，再移动；新位置已经有了就不动（幂等）；
// - 写一个 db/materials-migrated.json 记从哪来、什么时候、备份在哪；回滚就是把它移回 db/memory.db；
// - 搬不成（被占用、权限）抛出去，组合根记一条日志、按"还没搬"继续启动（新的空库会从事件日志重建素材）。
// @i18n-ignore-file log：迁移过程只进日志（原因给开发者看）
import path from "node:path";
import { type LegacyMigrationOptions, type LegacyMigrationOutcome, migrateLegacyDb, rollbackLegacyDb } from "../migrate/legacy-db.ts";

/** 迁移记号的文件名：和素材库放在同一边（db/materials-migrated.json） */
export const MATERIALS_MIGRATION_MARKER = "materials-migrated.json";

/** 迁移结果：moved 真搬了；skipped 新位置已有或老文件不在；rolledBack 回滚成功 */
export type MaterialsMigrationOutcome = LegacyMigrationOutcome;

export interface MaterialsMigrationOptions {
  /** 数据目录（备份放 <数据目录>/backup/pre-migration-<时间>/） */
  dataDir: string;
  /** 老位置（通常是 <数据目录>/db/memory.db，dataDirLayout().legacyMemoryDb） */
  from: string;
  /** 新位置（通常是 <数据目录>/db/materials.db，dataDirLayout().materialsDb） */
  to: string;
  log: (line: string) => void;
  /** 时钟（测试用手拨的） */
  now?: () => Date;
}

function pathsOf(options: MaterialsMigrationOptions): LegacyMigrationOptions {
  return { dataDir: options.dataDir, from: options.from, to: options.to, marker: path.join(path.dirname(options.to), MATERIALS_MIGRATION_MARKER), ...(options.now ? { now: options.now } : {}) };
}

/** 把素材库从老名字搬到新名字；幂等 */
export function migrateMaterialsDb(options: MaterialsMigrationOptions): MaterialsMigrationOutcome {
  const paths = pathsOf(options);
  const result = migrateLegacyDb(paths);
  if (result.outcome === "moved") options.log(`素材库改名：${paths.from} → ${paths.to}（备份在 ${result.backupDir}）`);
  return result.outcome;
}

/** 回滚：把 materials.db 搬回 memory.db、删掉记号；老位置已经有了就拒绝（不覆盖） */
export function rollbackMaterialsDb(options: MaterialsMigrationOptions): MaterialsMigrationOutcome {
  const paths = pathsOf(options);
  const outcome = rollbackLegacyDb(paths);
  options.log(outcome === "rolledBack" ? `素材库搬回：${paths.to} → ${paths.from}` : `回滚不了：${paths.to} 不在了，或者 ${paths.from} 已经有了（先把它挪走）`);
  return outcome;
}
