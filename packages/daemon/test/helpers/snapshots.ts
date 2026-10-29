// 看快照里有什么：文件清单、数据库里的事件、完整性检查、只读、公共池。只读，不改快照。
import fs from "node:fs";
import path from "node:path";
import { contentPath, POOL_DIR, readSnapshot, snapshotEntries } from "../../src/backup/snapshot.ts";
import { openEventStore, type StoredEvent } from "../../src/events/event-store.ts";
import { integrityCheck } from "../../src/storage/sqlite.ts";
import { makeTempDir } from "./temp-dir.ts";

/** 目录里全部文件的相对路径（用 / 分隔，排好序）；不跟进符号链接和目录联接 */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out.toSorted();
}

/** 快照（备份区 root 下的 date）清单里的全部文件（相对数据目录，排好序） */
export function snapshotRels(root: string, date: string): string[] {
  const snapshot = readSnapshot(path.join(root, date));
  if (!snapshot) throw new Error(`${path.join(root, date)} 不是快照`);
  return snapshotEntries(snapshot.manifest)
    .map(([rel]) => rel)
    .toSorted();
}

/** 快照里某个文件（相对数据目录）的内容实际放在哪：日期目录里，或者同步目录的公共池里 */
export function snapshotFile(root: string, date: string, rel: string): string {
  const snapshot = readSnapshot(path.join(root, date));
  if (!snapshot) throw new Error(`${path.join(root, date)} 不是快照`);
  const entry = snapshot.manifest.files[rel] ?? snapshot.manifest.databases[rel];
  if (!entry) throw new Error(`快照 ${date} 里没有 ${rel}`);
  return contentPath(snapshot, rel, entry);
}

/** 同步目录公共池里的文件（按内容的 sha256 起名） */
export function poolFiles(syncDir: string): string[] {
  const pool = path.join(syncDir, POOL_DIR);
  return fs.existsSync(pool) ? fs.readdirSync(pool).toSorted() : [];
}

/** 快照里的事件日志：先复制一份到临时目录再打开（打开事件存储会建表、写 WAL，不能动快照本身） */
export function snapshotEvents(dbFile: string, channel: string): StoredEvent[] {
  const copy = path.join(makeTempDir("ergo-snapshot-db-"), "ergo.db");
  fs.copyFileSync(dbFile, copy);
  // 本机备份区的快照文件是只读的，复制品带着只读属性
  fs.chmodSync(copy, 0o666);
  const store = openEventStore({ file: copy, views: [] });
  try {
    return store.read(channel);
  } finally {
    store.close();
  }
}

/** 数据库的完整性检查：没有问题是空数组 */
export function snapshotIntegrity(dbFile: string): Promise<string[]> {
  return integrityCheck(dbFile);
}

/** 两个路径是不是同一份存储（硬链接） */
export function sameStorage(a: string, b: string): boolean {
  return fs.statSync(a, { bigint: true }).ino === fs.statSync(b, { bigint: true }).ino;
}

/** 是不是只读的：写它会被拒 */
export function isReadOnly(file: string): boolean {
  try {
    fs.appendFileSync(file, "");
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES") return true;
    throw err;
  }
}

/** 人为改坏快照里的文件之前先去掉只读（就像有人硬改） */
export function makeWritable(file: string): void {
  fs.chmodSync(file, 0o666);
}
