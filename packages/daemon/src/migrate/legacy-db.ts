// 启动时把老位置的库搬到新位置（338 号票的推理库、ADR-0035 的素材库改名都用这一套）：纯文件操作，和库怎么打开无关。
// 为什么单独抽一个：两处迁移的规矩一模一样，只差"从哪搬到哪、记号叫什么"，写两份迟早走样。
// 规矩（见 docs/dev.md 的"推理库的搬家"和"素材库的改名和搬家"）：
// - 只搬一个库这一族文件：库本身 + 旁边的 -wal / -shm；新位置的文件名可以和老的叫法不同（db/memory.db → db/materials.db）；
// - 先复制一份到 <数据目录>/backup/pre-migration-<时间>/，再移动（同盘改名；跨盘或被占着时退回复制 + 删）；
// - 新位置已经有了就不动（幂等）；老位置的几个文件一个都不在就是新装、什么都不做；
// - 写一个记号文件（记号放在哪由调用方定）：从哪来、什么时候、备份在哪；回滚就是把新位置搬回老位置、删掉记号，
//   老位置已经有了就拒绝（不覆盖）；
// - 搬不成（被占用、权限、磁盘满）原样抛出去，由调用方记一条日志、按"还没搬"继续启动；
//   抛之前老库一个字节都不动（复制那一步失败时连移动都还没开始）。
import fs from "node:fs";
import path from "node:path";
import { renameRetrying, writeFileAtomic } from "../util/atomic-file.ts";

/** 一个库这一族文件：库本身、旁边的 -wal、-shm */
function storeFiles(base: string): string[] {
  return [base, `${base}-wal`, `${base}-shm`];
}

/** 两位数 */
const pad = (n: number) => String(n).padStart(2, "0");

/** 备份目录名里的时间：本地时间 20261029-080000 */
function stamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export type LegacyMigrationOutcome = "moved" | "skipped" | "rolledBack";

export interface LegacyMigrationOptions {
  /** 数据目录：备份放 <数据目录>/backup/pre-migration-<时间>/（不放在库旁边） */
  dataDir: string;
  /** 老位置（库文件；旁边的 -wal / -shm 一起搬） */
  from: string;
  /** 新位置（库文件；名字可以和老的叫法不同） */
  to: string;
  /** 记号文件：搬成了写在这里（从哪来、什么时候、备份在哪），回滚时删掉 */
  marker: string;
  /** 时钟（测试用手拨的） */
  now?: () => Date;
}

export interface LegacyMigrationResult {
  outcome: LegacyMigrationOutcome;
  /** moved 时备份在哪（<数据目录>/backup/pre-migration-<时间>/）；没搬是 undefined */
  backupDir?: string;
}

/**
 * 把老位置的库搬到新位置；幂等。
 * 返回 moved（真搬了）、skipped（新位置已经有了，或者老位置的几个文件都不在），搬不成时抛出。
 */
export function migrateLegacyDb(options: LegacyMigrationOptions): LegacyMigrationResult {
  const { dataDir, from, to, marker } = options;
  const now = options.now ?? (() => new Date());
  const sources = storeFiles(from).filter((file) => fs.existsSync(file));
  if (fs.existsSync(to)) return { outcome: "skipped" };
  if (sources.length === 0) return { outcome: "skipped" };
  // 1. 先备份一份（放 <数据目录>/backup/pre-migration-<时间>/）
  const backupDir = path.join(dataDir, "backup", `pre-migration-${stamp(now())}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of sources) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  // 2. 移动（同一块盘上是改名；跨盘时退回复制 + 删。先建目录）
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (const file of sources) {
    // 老位置的 -wal / -shm 跟着库走，落到新名字旁边（memory.db-wal → materials.db-wal）
    const dest = path.join(path.dirname(to), `${path.basename(to)}${file.slice(from.length)}`);
    try {
      renameRetrying(file, dest);
    } catch {
      fs.copyFileSync(file, dest);
      fs.rmSync(file, { force: true });
    }
  }
  // 3. 记号：从哪来、什么时候、备份在哪
  writeFileAtomic(
    marker,
    `${JSON.stringify({ format: 1, at: now().toISOString(), from, backup: path.relative(dataDir, backupDir).replace(/\\/g, "/") }, null, 2)}\n`,
  );
  return { outcome: "moved", backupDir };
}

/**
 * 回滚：把新位置的库搬回老位置、删掉记号。老位置已经有了就拒绝（不覆盖），新位置没有就是没得回。
 */
export function rollbackLegacyDb(options: LegacyMigrationOptions): LegacyMigrationOutcome {
  const { from, to, marker } = options;
  if (!fs.existsSync(to)) return "skipped";
  for (const file of storeFiles(from)) {
    if (fs.existsSync(file)) return "skipped";
  }
  fs.mkdirSync(path.dirname(from), { recursive: true });
  for (const file of storeFiles(to)) {
    if (!fs.existsSync(file)) continue;
    renameRetrying(file, `${from}${file.slice(to.length)}`);
  }
  fs.rmSync(marker, { force: true });
  return "rolledBack";
}
