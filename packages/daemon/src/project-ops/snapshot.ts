// "只读的真不写"（268 号票，照 112 号票的自动验收）：验收时调只读查询的测试前后，各记一份项目档案和工作目录里的文件（大小、修改时间），
// 比一比有没有新建、改过、删掉的。日志、缓存、依赖、版本库、SQLite 读的时候会碰的共享内存文件不算（*.log、logs/、node_modules/、.git/、
// __pycache__/、.cache/、.history/、*-shm；新建的空 *-wal、*-journal 也不算：打开数据库就会有）。最多看 SNAPSHOT_MAX 个文件，再多的不看。
import fs from "node:fs";
import path from "node:path";

/** 最多记多少个文件 */
export const SNAPSHOT_MAX = 20_000;

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".cache", ".history", "logs", ".venv", "venv"]);
const skipFile = (name: string) => name.endsWith(".log") || name.endsWith("-shm");
const openedDb = (name: string) => name.endsWith("-wal") || name.endsWith("-journal");

/** 一份快照：绝对路径 → "大小:修改时间" */
export type Snapshot = Map<string, string>;

export function snapshotDirs(dirs: readonly string[]): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string) => {
    if (out.size >= SNAPSHOT_MAX) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= SNAPSHOT_MAX) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && !skipFile(e.name)) {
        try {
          const s = fs.statSync(full);
          out.set(full, `${s.size}:${s.mtimeMs}`);
        } catch {
          // 刚被删掉的不管
        }
      }
    }
  };
  // 同一个目录（外部工作目录不在档案里时两个都看；默认的工作目录在档案里面，只看一遍）
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) walk(dir);
  return out;
}

/** 两份快照之间新建、改过、删掉的文件（相对 base 的路径，正斜杠） */
export function changedFiles(before: Snapshot, after: Snapshot, base: string): string[] {
  const changed: string[] = [];
  for (const [file, sig] of after) {
    const old = before.get(file);
    if (old === sig) continue;
    if (old === undefined && openedDb(file) && sig.startsWith("0:")) continue;
    changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed.map((f) => path.relative(base, f).replace(/\\/g, "/")).toSorted();
}
