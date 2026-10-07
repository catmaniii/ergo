// 快照（规格第 18 节，ADR-0007）：数据目录在某一天的一致性副本。两层，结构不同：
//
//   本机备份区（backups/）                     同步目录（backup.syncDir）
//   2026-10-08/                               2026-10-08/
//     manifest.json                             manifest.json   清单
//     data/   数据目录的完整镜像                   data/          只有小文件（< 64 KB）
//                                             pool/<sha256>     较大的文件（含数据库、媒体）按内容只存一份，各天的清单共用
//
// 清单记每个文件的大小、内容的 sha256、复制时源文件的大小和修改时间、数据库有哪些、哪些放在公共池里。
//
// 本机备份区：
// - 数据库区里的 *.db（ergou.db，以及存在时的 memory.db）用 VACUUM INTO 生成（工作线程里做，守护进程照常追加事件），
//   是那一刻已提交内容的一致副本；不和别的快照共用存储。
// - 其余文件增量复制：源文件的大小和修改时间都和上一份清单里的一样，就硬链接到上一份里的同一个文件；变了的、新的才复制；
//   复制完发现和上一份（或这一份前面）里内容一样的较大文件，也换成硬链接。删掉更早的快照不影响留下的。
//   做不了硬链接（文件系统不支持、跨盘、链接数到顶）时整份复制，记一条日志。
// - 快照里的文件都设成只读：一份存储可能属于好几天的快照，不能被就地改写。
// 同步目录：同步客户端不认硬链接（会把每个链接当成独立文件上传），所以不用硬链接——较大的文件按内容放进公共池，
// 云端也只有一份；清掉日期目录之后，回收池里不再被任何清单引用的文件（collectPool）。
//
// 两层都一样的：
// - pi 会话的 JSONL 是追加写：复制到最后一个换行为止，最后半行（正在写的）不要，恢复后的文件每一行都完整。
// - 不进备份：nonBackupEntries（密钥区、临时区、本机备份区、pid 文件）；符号链接和目录联接一律不跟进（外部工作目录进不来）。
// - 先写进同一备份区里的 .<日期>.partial，清单最后写，整个改名成日期目录（writeDated）：日期目录只要在，就是完整的。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type DataDirLayout, nonBackupEntries } from "../config/data-dir.ts";
import { integrityCheck, vacuumInto } from "../storage/sqlite.ts";
import type { SnapshotFiles } from "./files.ts";

export const MANIFEST_FILE = "manifest.json";
export const DATA_DIR = "data";
/** 同步目录里的公共池 */
export const POOL_DIR = "pool";
export const SNAPSHOT_FORMAT = 1;
/**
 * 较大文件的下限：本机备份区里内容一样的才换成硬链接（太小的链接省不了什么，还会把大量空文件挂到同一份存储上），
 * 同步目录里才放进公共池
 */
export const LARGE_FILE_BYTES = 64 * 1024;

/** 快照里一个普通文件 */
export interface SnapshotFile {
  /** 快照里存的字节数（会话 JSONL 去掉了最后半行，可能比源文件短） */
  size: number;
  sha256: string;
  /** 复制时源文件的大小和修改时间：下一份快照据此判断"没变" */
  source: { size: number; mtimeMs: number };
  /** 内容在公共池里（同步目录） */
  pooled?: true;
  /** 源文件本来就是只读的（比如素材区的原文副本）：恢复出来照样只读；没有这一项的恢复出来能写 */
  readOnly?: true;
}

/** 源文件只读时清单里加的那一项 */
const readOnlyFlag = (readOnly: boolean | undefined): { readOnly?: true } => (readOnly ? { readOnly: true } : {});

/** 快照里一个数据库（VACUUM INTO 生成的） */
export interface SnapshotDatabase {
  size: number;
  /** 放进公共池的才有 */
  sha256?: string;
  pooled?: true;
}

export interface Manifest {
  format: typeof SNAPSHOT_FORMAT;
  date: string;
  createdAt: string;
  /** 数据库（相对 data/ 的路径，用 / 分隔） */
  databases: Record<string, SnapshotDatabase>;
  /** 其余文件（相对 data/ 的路径，用 / 分隔） */
  files: Record<string, SnapshotFile>;
}

export interface Snapshot {
  date: string;
  dir: string;
  manifest: Manifest;
}

// ───────────────────────── 日期 ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 是不是快照日期目录的名字（YYYY-MM-DD） */
export const isSnapshotDate = (name: string) => DATE_RE.test(name);

/** 本地日期 YYYY-MM-DD：快照日期目录的名字 */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地日期和钟点 YYYY-MM-DD HH:mm（给人看） */
export function localDateTime(ms: number): string {
  const d = new Date(ms);
  return `${localDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时间戳 YYYYMMDD-HHmmss（目录名用） */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${localDate(ms).replaceAll("-", "")}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// ───────────────────────── 读快照 ─────────────────────────

/** 读一个日期目录的清单；不是快照（没有清单、读不懂）是 undefined */
export function readSnapshot(dir: string): Snapshot | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    if (manifest.format !== SNAPSHOT_FORMAT || typeof manifest.files !== "object" || typeof manifest.databases !== "object") return undefined;
    return { date: path.basename(dir), dir, manifest };
  } catch {
    return undefined;
  }
}

/** 备份区里的日期目录（不管完整不完整），按日期从早到晚；备份区不存在时是空的 */
export function listSnapshotDates(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSnapshotDate(e.name))
      .map((e) => e.name)
      .toSorted();
  } catch {
    return [];
  }
}

/** 备份区里完整的快照，按日期从早到晚 */
export function listSnapshots(root: string): Snapshot[] {
  return listSnapshotDates(root).flatMap((date) => readSnapshot(path.join(root, date)) ?? []);
}

/** 快照里的全部条目（数据库和其余文件），相对 data/ 的路径 */
export function snapshotEntries(manifest: Manifest): Array<[rel: string, entry: SnapshotFile | SnapshotDatabase]> {
  return [...Object.entries(manifest.databases), ...Object.entries(manifest.files)];
}

/** 快照里一个文件的内容在哪：放进了公共池的在池里，否则在日期目录的 data/ 下 */
export function contentPath(snapshot: { dir: string }, rel: string, entry: { pooled?: true; sha256?: string }): string {
  if (entry.pooled && entry.sha256) return path.join(path.dirname(snapshot.dir), POOL_DIR, entry.sha256);
  return path.join(snapshot.dir, DATA_DIR, ...rel.split("/"));
}

// ───────────────────────── 写快照 ─────────────────────────

/** 上次被打断留下的半成品（.<日期>.partial、.<日期>.old） */
export async function removeLeftovers(root: string, files: SnapshotFiles): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^\.(.+)\.(partial|old)$/.exec(name);
    if (m && isSnapshotDate(m[1]!)) await files.remove(path.join(root, name));
  }
}

/**
 * 写一个日期目录的整套流程：先写进 .<日期>.partial，fill 往里放内容并给出清单，清单最后写，
 * 再整个改名成日期目录（当天已有的换掉）。中途出错删掉半成品。protect 时清单也设成只读（本机备份区）。
 */
async function writeDated(root: string, date: string, files: SnapshotFiles, protect: boolean, fill: (dir: string) => Promise<Manifest>): Promise<Snapshot> {
  const partial = path.join(root, `.${date}.partial`);
  await files.remove(partial);
  await files.mkdir(path.join(partial, DATA_DIR));
  try {
    const manifest = await fill(partial);
    const manifestFile = path.join(partial, MANIFEST_FILE);
    await files.writeFile(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
    if (protect) await files.protect(manifestFile);
    const final = path.join(root, date);
    const old = path.join(root, `.${date}.old`);
    const replacing = fs.existsSync(final);
    if (replacing) await files.rename(final, old);
    await files.rename(partial, final);
    if (replacing) await files.remove(old);
    return { date, dir: final, manifest };
  } catch (err) {
    await files.remove(partial).catch(() => {});
    throw err;
  }
}

/** 往一个日期目录的 data/ 下放文件时，父目录只建一次 */
function parentMaker(dir: string, files: SnapshotFiles) {
  const made = new Set<string>();
  return async (rel: string): Promise<string> => {
    const dest = path.join(dir, DATA_DIR, ...rel.split("/"));
    const parent = path.dirname(dest);
    if (!made.has(parent)) {
      await files.mkdir(parent);
      made.add(parent);
    }
    return dest;
  };
}

/** 一个要进快照的源文件 */
interface SourceFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** 没有写权限（Windows 上是"只读"属性） */
  readOnly: boolean;
}

/** 数据目录里要进备份的东西：数据库和其余文件 */
async function collect(layout: DataDirLayout): Promise<{ databases: SourceFile[]; files: SourceFile[] }> {
  const excluded = nonBackupEntries(layout);
  const dbDir = path.relative(layout.root, layout.db).toLowerCase();
  const databases: SourceFile[] = [];
  const files: SourceFile[] = [];
  const walk = async (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 刚被删掉的目录
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (rel === "" && excluded.has(entry.name.toLowerCase())) continue;
      // 符号链接、目录联接不跟进：外部工作目录、别处的文件不进备份
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs, entryRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const inDbDir = rel.toLowerCase() === dbDir;
      // WAL、共享内存和回滚日志不单独备份：VACUUM INTO 已经把已提交的内容都写进了快照
      if (inDbDir && /\.db-(wal|shm|journal)$/i.test(entry.name)) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(abs);
      } catch {
        continue;
      }
      const source = { rel: entryRel, abs, size: stat.size, mtimeMs: stat.mtimeMs, readOnly: (stat.mode & 0o200) === 0 };
      if (inDbDir && /\.db$/i.test(entry.name)) databases.push(source);
      else files.push(source);
    }
  };
  await walk(layout.root, "");
  return { databases, files };
}

/** 追加写的 JSONL 到最后一个换行为止的长度：最后半行（还在写）不要 */
async function completeLinesLength(file: string, size: number): Promise<number> {
  const handle = await fs.promises.open(file, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const nl = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (nl >= 0) return start + nl + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

export interface TakeSnapshotOptions {
  layout: DataDirLayout;
  /** 本机备份区 */
  root: string;
  date: string;
  createdAt: string;
  /** 用来增量复制的上一份快照（本机备份区里的） */
  previous: Snapshot | undefined;
  files: SnapshotFiles;
  signal: AbortSignal;
  log: (line: string) => void;
}

/** 给数据目录做一份快照，放进本机备份区的日期目录（当天已有的换掉） */
export function takeSnapshot(options: TakeSnapshotOptions): Promise<Snapshot> {
  const { layout, root, date, previous, files, signal, log } = options;
  return writeDated(root, date, files, true, async (dir) => {
    const target = parentMaker(dir, files);
    // 内容（sha256）→ 已经在这里或上一份里的较大文件：一样的换成硬链接
    const byHash = new Map<string, string>();
    for (const [rel, entry] of Object.entries(previous?.manifest.files ?? {})) {
      if (entry.size >= LARGE_FILE_BYTES) byHash.set(entry.sha256, contentPath(previous!, rel, entry));
    }
    const fallbacks: string[] = [];
    const link = async (existing: string, dest: string) => {
      const result = await files.link(existing, dest);
      if (!result.linked) fallbacks.push(result.reason);
    };

    const sources = await collect(layout);
    const manifest: Manifest = { format: SNAPSHOT_FORMAT, date, createdAt: options.createdAt, databases: {}, files: {} };
    // 先做数据库：快照的时间点以它为准
    for (const db of sources.databases) {
      signal.throwIfAborted();
      const dest = await target(db.rel);
      await vacuumInto(db.abs, dest);
      await files.protect(dest);
      manifest.databases[db.rel] = { size: fs.statSync(dest).size };
    }
    for (const file of sources.files) {
      signal.throwIfAborted();
      const before = previous?.manifest.files[file.rel];
      const dest = await target(file.rel);
      if (before && before.source.size === file.size && before.source.mtimeMs === file.mtimeMs) {
        await link(contentPath(previous!, file.rel, before), dest);
        // 改只读属性不改修改时间：只读这一项按这次看到的记
        manifest.files[file.rel] = { size: before.size, sha256: before.sha256, source: before.source, ...readOnlyFlag(file.readOnly) };
        continue;
      }
      let copied;
      try {
        const length = file.rel.toLowerCase().endsWith(".jsonl") ? await completeLinesLength(file.abs, file.size) : file.size;
        copied = await files.copy(file.abs, dest, length);
      } catch (err) {
        // 列出来之后又被删掉的文件：跳过
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(file.abs)) {
          await files.remove(dest);
          continue;
        }
        throw err;
      }
      const same = copied.size >= LARGE_FILE_BYTES ? byHash.get(copied.sha256) : undefined;
      if (same) {
        await files.remove(dest);
        await link(same, dest);
      } else {
        await files.protect(dest);
        if (copied.size >= LARGE_FILE_BYTES) byHash.set(copied.sha256, dest);
      }
      manifest.files[file.rel] = { ...copied, source: { size: file.size, mtimeMs: file.mtimeMs }, ...readOnlyFlag(file.readOnly) };
    }
    signal.throwIfAborted();
    if (fallbacks.length > 0) log(`备份：${date} 的快照里有 ${fallbacks.length} 个文件没能硬链接，整份复制了（${fallbacks[0]}）`);
    return manifest;
  });
}

export interface CopySnapshotOptions {
  /** 本机备份区里的一份快照 */
  snapshot: Snapshot;
  /** 同步目录 */
  root: string;
  files: SnapshotFiles;
  signal: AbortSignal;
}

/** 把一份快照复制到同步目录的同一日期目录（已有的换掉）：较大的文件放进公共池，池里已经有的不再复制 */
export async function copySnapshot(options: CopySnapshotOptions): Promise<Snapshot> {
  const { snapshot, root, files, signal } = options;
  const pool = path.join(root, POOL_DIR);
  await files.mkdir(pool);

  /** 放进公共池，给出内容的 sha256：已知内容且池里有了就不复制；先写临时文件，算完 sha256 再改名 */
  const toPool = async (src: string, size: number, known: string | undefined): Promise<string> => {
    if (known !== undefined && fs.existsSync(path.join(pool, known))) return known;
    const temp = path.join(pool, `.tmp-${randomUUID()}`);
    try {
      const { sha256 } = await files.copy(src, temp, size);
      if (fs.existsSync(path.join(pool, sha256))) await files.remove(temp);
      else await files.rename(temp, path.join(pool, sha256));
      return sha256;
    } catch (err) {
      await files.remove(temp).catch(() => {});
      throw err;
    }
  };

  return writeDated(root, snapshot.date, files, false, async (dir) => {
    const target = parentMaker(dir, files);
    const manifest: Manifest = { ...snapshot.manifest, databases: {}, files: {} };
    for (const [rel, db] of Object.entries(snapshot.manifest.databases)) {
      signal.throwIfAborted();
      const src = contentPath(snapshot, rel, db);
      if (db.size >= LARGE_FILE_BYTES) {
        manifest.databases[rel] = { size: db.size, sha256: await toPool(src, db.size, db.sha256), pooled: true };
      } else {
        await files.copy(src, await target(rel), db.size);
        manifest.databases[rel] = { size: db.size };
      }
    }
    for (const [rel, entry] of Object.entries(snapshot.manifest.files)) {
      signal.throwIfAborted();
      const src = contentPath(snapshot, rel, entry);
      const { size, source } = entry;
      if (size >= LARGE_FILE_BYTES) {
        manifest.files[rel] = { size, sha256: await toPool(src, size, entry.sha256), source, pooled: true, ...readOnlyFlag(entry.readOnly) };
      } else {
        const copied = await files.copy(src, await target(rel), size);
        manifest.files[rel] = { size, sha256: copied.sha256, source, ...readOnlyFlag(entry.readOnly) };
      }
    }
    signal.throwIfAborted();
    return manifest;
  });
}

/**
 * 回收同步目录公共池里不再被任何清单引用的文件（清掉日期目录之后）。
 * 有读不出清单的日期目录时这次不回收：不知道它引用了什么，宁可多留。
 */
export async function collectPool(root: string, files: SnapshotFiles, log: (line: string) => void): Promise<void> {
  const pool = path.join(root, POOL_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(pool);
  } catch {
    return;
  }
  const dates = listSnapshotDates(root);
  const snapshots = dates.map((date) => readSnapshot(path.join(root, date)));
  const unreadable = dates.filter((_, i) => snapshots[i] === undefined);
  if (unreadable.length > 0) {
    log(`同步目录里 ${unreadable.join("、")} 的清单读不出来，公共池这次不回收`);
    return;
  }
  const used = new Set(snapshots.flatMap((s) => snapshotEntries(s!.manifest).flatMap(([, e]) => (e.pooled && e.sha256 ? [e.sha256] : []))));
  for (const name of names) if (!used.has(name)) await files.remove(path.join(pool, name));
}

// ───────────────────────── 校验 ─────────────────────────

/** 文件的大小；不在是 undefined */
function sizeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

/** 校验一份快照：清单读得出来、数据库通过完整性检查、文件都在（公共池里的也算）且大小对得上。返回问题，空表示通过 */
export async function verifySnapshot(dir: string): Promise<string[]> {
  const snapshot = readSnapshot(dir);
  if (!snapshot) return [`快照清单 ${MANIFEST_FILE} 读不出来`];
  const problems: string[] = [];
  const check = (rel: string, entry: SnapshotFile | SnapshotDatabase): boolean => {
    const size = sizeOf(contentPath(snapshot, rel, entry));
    if (size === undefined) problems.push(`${rel}：不见了`);
    else if (size !== entry.size) problems.push(`${rel}：大小不对（应为 ${entry.size}，实际 ${size}）`);
    return size === entry.size;
  };
  for (const [rel, db] of Object.entries(snapshot.manifest.databases)) {
    if (check(rel, db)) for (const p of await integrityCheck(contentPath(snapshot, rel, db))) problems.push(`${rel}：${p}`);
  }
  for (const [rel, entry] of Object.entries(snapshot.manifest.files)) check(rel, entry);
  return problems;
}
