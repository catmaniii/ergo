// 从快照恢复数据目录（规格第 18 节）。命令行入口是 src/restore.ts；守护进程自己不调用。
//
// - 恢复前守护进程必须已经停了（经 LSM 停）：pid 文件里的进程还在运行（进程没退出、启动时间也对得上），
//   或者本机端口上有进程在听，就拒绝，什么也不动。恢复命令自己不启停服务。
//   命令行的备份（npm run backup，335 号票）正在做（备份锁的主人还活着）也拒绝：它正读着数据目录、写着备份区。
// - 快照取本机备份区或同步目录里指定日期的那一份；默认先找本机，本机没有再找同步目录。恢复之前先校验它，不通过就拒绝。
//   按清单还原：本机备份区的文件在日期目录里，同步目录的较大文件在公共池里（见 snapshot.ts）。
// - 数据目录里现在的内容（进备份的那些：配置、数据库、会话、项目……）先整个挪到本机备份区的
//   pre-restore-<时间> 目录（同一个盘上只是改名），再把快照里的文件复制进来（复制，不和快照共用存储，去掉只读）。
//   所以恢复之后数据目录和那份快照一致，快照之后才有的文件不会混进来。pre-restore-* 只留最近 2 份，更早的删掉。
// - 不进备份的东西（nonBackupEntries：密钥区、临时区、本机备份区、pid 文件、模型区、缓存区、导入文件夹）原地不动。
// - 中途出错：已经复制进来的删掉，挪走的挪回来。
// @i18n-ignore-file log：恢复只由命令行用（src/restore.ts），输出给在本机跑命令的人看
import fs from "node:fs";
import path from "node:path";
import type { ErgoConfig } from "../config/config.ts";
import { type DataDirLayout, nonBackupEntries } from "../config/data-dir.ts";
import { daemonRunning } from "../process/pid-file.ts";
import { renameRetryingAsync } from "../util/atomic-file.ts";
import { backupLockFile, liveLockOwner } from "./lock.ts";
import { contentPath, isSnapshotDate, listSnapshots, localStamp, readSnapshot, type Snapshot, snapshotEntries, verifySnapshot } from "./snapshot.ts";
import { syncDirOf } from "./sync-dir.ts";

/** 恢复被拒（守护进程在运行、没有这份快照、快照校验没通过……），message 写明原因 */
export class RestoreRefused extends Error {}

/** 从哪里找快照：本机备份区、同步目录，或者一个装着日期目录的目录 */
export type RestoreSource = "local" | "sync" | { dir: string };

/** 恢复之前的内容挪到的目录名前缀；只留最近这么多份 */
export const PRE_RESTORE_PREFIX = "pre-restore-";
export const PRE_RESTORE_KEEP = 2;

export interface RestoreOptions {
  config: ErgoConfig;
  layout: DataDirLayout;
  /** 快照的日期 YYYY-MM-DD */
  date: string;
  /** 不给就先找本机备份区，再找同步目录 */
  from?: RestoreSource;
  /** 现在（挪走的目录按它起名） */
  now?: Date;
}

export interface RestoreResult {
  date: string;
  /** 用的是哪一份快照（日期目录） */
  snapshot: string;
  /** 恢复之前数据目录里的内容挪到了这里 */
  setAside: string;
}

/** 一个找快照的地方：本机备份区、同步目录（可能用不了）或者用户给的目录 */
interface Place {
  label: string;
  root?: string;
  /** 用不了时的原因 */
  problem?: string;
}

function places(options: Pick<RestoreOptions, "config" | "layout" | "from">): Place[] {
  const local: Place = { label: "本机备份区", root: options.layout.backups };
  const syncDir = syncDirOf(options.config.backup);
  const sync: Place =
    syncDir.kind === "ready"
      ? { label: "同步目录", root: syncDir.dir }
      : { label: "同步目录", problem: syncDir.kind === "none" ? "没有配置" : syncDir.reason };
  const { from } = options;
  if (from === undefined) return [local, sync];
  if (from === "local") return [local];
  if (from === "sync") return [sync];
  return [{ label: from.dir, root: from.dir }];
}

/** 本机备份区和同步目录里各有哪些日期的快照（同步目录用不了时带上原因） */
export function availableSnapshots(config: ErgoConfig, layout: DataDirLayout): Array<{ label: string; root?: string; problem?: string; dates: string[] }> {
  return places({ config, layout }).map((p) => ({ ...p, dates: p.root === undefined ? [] : listSnapshots(p.root).map((s) => s.date) }));
}

function findSnapshot(options: RestoreOptions): Snapshot {
  const where = places(options);
  for (const { root } of where) {
    const snapshot = root === undefined ? undefined : readSnapshot(path.join(root, options.date));
    if (snapshot) return snapshot;
  }
  const listed = where
    .map(({ label, root, problem }) => {
      if (root === undefined) return `${label}：${problem ?? "用不了"}`;
      const dates = listSnapshots(root).map((s) => s.date);
      return `${label}：${dates.length > 0 ? dates.join("、") : "没有快照"}`;
    })
    .join("；");
  throw new RestoreRefused(`找不到 ${options.date} 的快照。现有的快照——${listed}`);
}

/** 本机备份区里的 pre-restore-* 只留最近 PRE_RESTORE_KEEP 份 */
function prunePreRestore(layout: DataDirLayout): void {
  const dirs = fs
    .readdirSync(layout.backups)
    .filter((name) => name.startsWith(PRE_RESTORE_PREFIX))
    .toSorted();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - PRE_RESTORE_KEEP))) {
    fs.rmSync(path.join(layout.backups, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function restoreSnapshot(options: RestoreOptions): Promise<RestoreResult> {
  const { config, layout, date } = options;
  if (!isSnapshotDate(date)) throw new RestoreRefused(`日期要写成 YYYY-MM-DD，比如 2026-10-08（收到的是 ${date}）`);
  const running = await daemonRunning(layout.pidFile, config.ports.local);
  if (running) throw new RestoreRefused(`守护进程还在运行（${running}）：先在 Local Service Manager 里停掉 ergo-daemon，再恢复`);
  const backingUp = liveLockOwner(backupLockFile(layout));
  if (backingUp) throw new RestoreRefused(`有一份备份正在做（${backingUp.by === "script" ? "命令行" : "守护进程"}，PID ${backingUp.pid}，从 ${backingUp.since} 起）：等它做完再恢复`);

  const snapshot = findSnapshot(options);
  const problems = await verifySnapshot(snapshot.dir);
  if (problems.length > 0) throw new RestoreRefused(`${snapshot.dir} 这份快照没通过校验，没有恢复：${problems.join("；")}`);

  const kept = nonBackupEntries(layout);
  const base = path.join(layout.backups, `${PRE_RESTORE_PREFIX}${localStamp((options.now ?? new Date()).getTime())}`);
  let setAside = base;
  for (let n = 2; fs.existsSync(setAside); n++) setAside = `${base}-${n}`;
  fs.mkdirSync(setAside, { recursive: true });
  const moved: string[] = [];
  try {
    for (const name of fs.readdirSync(layout.root)) {
      if (kept.has(name.toLowerCase())) continue;
      await renameRetryingAsync(path.join(layout.root, name), path.join(setAside, name));
      moved.push(name);
    }
    for (const [rel, entry] of snapshotEntries(snapshot.manifest)) {
      if (kept.has(rel.split("/")[0]!.toLowerCase())) continue;
      const dest = path.join(layout.root, ...rel.split("/"));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(contentPath(snapshot, rel, entry), dest, fs.constants.COPYFILE_EXCL);
      // 本机备份区的快照文件是只读的，复制品会带上只读属性：恢复出来的要能写；源文件本来就只读的（原文副本）照样只读
      await fs.promises.chmod(dest, "readOnly" in entry && entry.readOnly ? 0o444 : 0o666);
    }
  } catch (err) {
    // 撤回：复制进来的删掉，挪走的挪回来
    for (const name of fs.readdirSync(layout.root)) {
      if (!kept.has(name.toLowerCase())) fs.rmSync(path.join(layout.root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const name of moved) await renameRetryingAsync(path.join(setAside, name), path.join(layout.root, name));
    fs.rmSync(setAside, { recursive: true, force: true });
    throw err;
  }
  prunePreRestore(layout);
  return { date, snapshot: snapshot.dir, setAside };
}
