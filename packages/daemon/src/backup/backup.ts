// 备份（规格第 2、13、18 节）：快照、复制、保留、校验；外加同一批内部作业里的临时区清理。恢复在 restore.ts。
// 快照在盘上的样子见 snapshot.ts 和 ADR-0007。
//
// 三个内部作业挂在调度器上（错过的开机后补一次，见 scheduler/internal-jobs.ts）：
// - 每晚备份（默认 03:30，配置 backup.time）：本机备份区做当天的快照，再复制到同步目录（配置 backup.syncDir）的日期子目录，
//   由同步客户端去同步。写进同步目录就算成功，不等也不查同步客户端。本机留最近 7 份；同步目录留每日 7 份、每周 4 份，
//   清完回收公共池里没人用的文件。周日那份当时没写进同步目录（目录不在等）的，之后写得进去时从本机补写。
//   自动的（到点、补做）只补齐当天缺的：当天的快照已经在了就不再做、不覆盖（比如刚从旧快照恢复过，当天那份留着）；
//   手动的"立即备份"重做当天的快照，换掉已有的。
// - 每周校验（周日 04:30）：打开本机备份区和同步目录里最新快照的数据库做完整性检查，文件对一遍大小。
// - 每天清理临时区（04:00）：删 7 天前的文件。
//
// 写入失败（同步目录不在、空间不够、复制出错）在待我处理里放一条"备份失败"（不卡任务），本机快照照样留着；
// 用户在这条上点"重试"就马上手动备份一次。校验没通过放一条"快照校验失败"。三件事在一条队列里依次做，不会同时跑。
// 守护进程停止时中止正在做的（AbortSignal），半成品删掉。
import path from "node:path";
import type { NoticeType } from "@ergou/protocol";
import type { BackupConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type Clock, clockIso } from "../scheduler/clock.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import { nodeSnapshotFiles, type SnapshotFiles } from "./files.ts";
import { isSunday, keepLocal, keepSync } from "./retention.ts";
import {
  collectPool,
  copySnapshot,
  listSnapshotDates,
  listSnapshots,
  localDate,
  localDateTime,
  readSnapshot,
  removeLeftovers,
  type Snapshot,
  takeSnapshot,
  verifySnapshot,
} from "./snapshot.ts";
import { syncDirOf } from "./sync-dir.ts";
import { type CleanResult, cleanTmpDir } from "./tmp-cleanup.ts";

/** 内部作业的名字和时间 */
export const BACKUP_JOB = "backup";
export const VERIFY_JOB = "verify_snapshot";
export const CLEAN_TMP_JOB = "clean_tmp";
/** 每周校验：周日 04:30（当天 03:30 的快照做完之后） */
export const VERIFY_WEEKDAY = 0;
export const VERIFY_TIME = "04:30";
export const CLEAN_TMP_TIME = "04:00";

/** "备份失败"事项上的"重试"：马上再备份一次 */
export const RETRY = "重试";

export type BackupMode = "auto" | "manual";

export interface BackupResult {
  date: string;
  /** 本机快照：新做的、换掉了当天已有的、当天已有没动、失败 */
  local: "created" | "replaced" | "kept" | "failed";
  /** 同步目录：复制了、换掉了当天已有的、当天已有没动、没配同步目录、失败、本机没做成所以没复制 */
  sync: "copied" | "replaced" | "kept" | "not_configured" | "failed" | "skipped";
  /** 失败的原因 */
  error?: string;
}

export interface SnapshotCheck {
  location: "local" | "sync";
  date: string;
  /** 问题；空表示通过 */
  problems: string[];
}

export interface BackupService {
  /** 立即备份（手动）：重做当天的快照（已有的换掉），再复制到同步目录 */
  backupNow(): Promise<BackupResult>;
  /** 校验本机备份区和同步目录里最新的快照；没通过的放进待我处理 */
  verifyLatest(): Promise<SnapshotCheck[]>;
  /** 清理临时区里 7 天前的文件 */
  cleanTmp(): Promise<CleanResult>;
  /** 在内部作业里登记每晚备份、每周校验、每天清理（错过的马上补一次），接上"备份失败"的"重试" */
  start(): void;
  /** 中止正在做的（半成品删掉），等它停下 */
  stop(): Promise<void>;
}

export interface BackupServiceOptions {
  layout: DataDirLayout;
  config: BackupConfig;
  inbox: InboxService;
  clock: Clock;
  internalJobs: InternalJobs;
  /** 往备份区写文件；测试换成会出错的实现 */
  files?: SnapshotFiles;
  log: (line: string) => void;
}

/** 写入出错的原因，给人看 */
function describeWriteError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  // SQLite 写满时（VACUUM INTO）没有 errno，只有这句话
  if (code === "ENOSPC" || /disk is full/i.test(err instanceof Error ? err.message : "")) return "空间不够";
  if (code === "EACCES" || code === "EPERM") return `没有写入权限（${(err as Error).message}）`;
  return `复制出错（${err instanceof Error ? err.message : String(err)}）`;
}

/** 是不是因为守护进程停止被中止的 */
const aborted = (err: unknown, signal: AbortSignal) => signal.aborted || (err instanceof Error && err.name === "AbortError");

class BackupFailure extends Error {}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { layout, config, inbox, clock, internalJobs, log } = options;
  const files = options.files ?? nodeSnapshotFiles;
  const controller = new AbortController();
  // 备份、校验、清理排成一条队列；作业自己的中止信号（内部作业停止）和这里的（服务停止）任一个置位都中止
  let lane: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: (signal: AbortSignal) => Promise<T>, jobSignal?: AbortSignal): Promise<T> => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    const signal = jobSignal ? AbortSignal.any([controller.signal, jobSignal]) : controller.signal;
    const result = lane.then(() => {
      signal.throwIfAborted();
      return task(signal);
    });
    lane = result.catch(() => {});
    return result;
  };

  const notice = (type: NoticeType, title: string, body: string, data: Record<string, unknown>) =>
    inbox.add({ kind: "notice", notice: type, title, body, source: "备份", urgency: "non_blocking", actions: type === "backup_failed" ? [RETRY, "知道了"] : ["知道了"], data });

  /** 删掉不在保留之列的快照；出错只记日志（下次再删） */
  const prune = async (root: string, keep: (dates: readonly string[]) => Set<string>) => {
    const dates = listSnapshots(root).map((s) => s.date);
    const kept = keep(dates);
    for (const date of dates) {
      if (kept.has(date)) continue;
      try {
        await files.remove(path.join(root, date));
      } catch (err) {
        log(`删旧快照 ${path.join(root, date)} 出错：${String(err)}`);
      }
    }
  };

  /** 本机备份区里最近的周日快照（不算今天的）当时没写进同步目录的，补写进去；补不进去放一条"备份失败" */
  const backfillSunday = async (root: string, today: string, signal: AbortSignal) => {
    const sunday = listSnapshots(layout.backups)
      .filter((s) => s.date !== today && isSunday(s.date))
      .at(-1);
    if (!sunday || readSnapshot(path.join(root, sunday.date))) return;
    try {
      await copySnapshot({ snapshot: sunday, root, files, signal });
      log(`备份：${sunday.date}（周日）的快照当时没写进同步目录，这次从本机补上了`);
    } catch (err) {
      if (aborted(err, signal)) throw err;
      const reason = describeWriteError(err);
      log(`备份失败（补写周日的快照）：${reason}`);
      notice("backup_failed", "备份失败：周日的快照没补进同步目录", `${sunday.date}（周日）的快照当时没写进同步目录，这次补写也没成功：${reason}。`, {
        date: sunday.date,
        stage: "sync_backfill",
        reason,
      });
    }
  };

  const runBackup = async (mode: BackupMode, signal: AbortSignal): Promise<BackupResult> => {
    const now = clock.now();
    const date = localDate(now);
    const when = localDateTime(now);

    // 1. 本机快照
    let snapshot: Snapshot;
    let local: BackupResult["local"];
    try {
      await files.mkdir(layout.backups);
      await removeLeftovers(layout.backups, files);
      const existing = readSnapshot(path.join(layout.backups, date));
      if (mode === "auto" && existing) {
        snapshot = existing;
        local = "kept";
      } else {
        const previous = listSnapshots(layout.backups).at(-1);
        snapshot = await takeSnapshot({ layout, root: layout.backups, date, createdAt: clockIso(clock), previous, files, signal, log });
        local = existing ? "replaced" : "created";
      }
    } catch (err) {
      if (aborted(err, signal)) throw err;
      const reason = describeWriteError(err);
      log(`备份失败（本机快照）：${reason}`);
      notice("backup_failed", "备份失败：本机快照没做成", `${when} 的备份没做成：${reason}。同步目录也没有更新。`, { date, stage: "local", reason });
      return { date, local: "failed", sync: "skipped", error: reason };
    }
    await prune(layout.backups, keepLocal);

    // 2. 复制到同步目录
    const sync = syncDirOf(config);
    if (sync.kind === "none") {
      log(`备份：${date} 的快照做好了；没有配置同步目录（backup.syncDir），只留在本机`);
      return { date, local, sync: "not_configured" };
    }
    try {
      if (sync.kind === "unusable") throw new BackupFailure(sync.reason);
      const root = sync.dir;
      await removeLeftovers(root, files);
      const existing = readSnapshot(path.join(root, date));
      let status: BackupResult["sync"] = "kept";
      if (mode === "manual" || !existing) {
        await copySnapshot({ snapshot, root, files, signal });
        status = existing ? "replaced" : "copied";
      }
      await backfillSunday(root, date, signal);
      await prune(root, keepSync);
      await collectPool(root, files, log);
      log(`备份：${date} 的快照做好了，已写进同步目录 ${root}`);
      return { date, local, sync: status };
    } catch (err) {
      if (aborted(err, signal)) throw err;
      const reason = err instanceof BackupFailure ? err.message : describeWriteError(err);
      log(`备份失败（同步目录）：${reason}`);
      notice(
        "backup_failed",
        "备份失败：没写进同步目录",
        `${when} 的备份：本机快照已经做好（本机备份区的 ${date}），但没写进同步目录：${reason}。`,
        { date, stage: "sync", reason },
      );
      return { date, local, sync: "failed", error: reason };
    }
  };

  const runVerify = async (signal: AbortSignal): Promise<SnapshotCheck[]> => {
    const locations: Array<{ location: SnapshotCheck["location"]; root: string; label: string }> = [{ location: "local", root: layout.backups, label: "本机备份区" }];
    // 同步目录用不了时只校验本机的（备份那边已经报了"备份失败"）
    const sync = syncDirOf(config);
    if (sync.kind === "ready") locations.push({ location: "sync", root: sync.dir, label: "同步目录" });
    const checks: SnapshotCheck[] = [];
    for (const { location, root, label } of locations) {
      signal.throwIfAborted();
      const date = listSnapshotDates(root).at(-1);
      if (date === undefined) continue;
      const problems = await verifySnapshot(path.join(root, date));
      checks.push({ location, date, problems });
      if (problems.length === 0) {
        log(`校验：${label}最新的快照 ${date} 通过`);
        continue;
      }
      log(`校验：${label}最新的快照 ${date} 没通过：${problems.join("；")}`);
      notice(
        "snapshot_check_failed",
        `快照校验失败：${label}的 ${date}`,
        `每周校验：${label}里最新的快照（${date}）没通过完整性检查：${problems.slice(0, 5).join("；")}${problems.length > 5 ? `……共 ${problems.length} 处` : ""}。下一次备份会做新的快照；要从快照恢复时先避开这一份。`,
        { location, date, problems },
      );
    }
    return checks;
  };

  const runClean = async (): Promise<CleanResult> => {
    const result = await cleanTmpDir(layout.tmp, clock.now(), log);
    if (result.removedFiles + result.removedDirs > 0) log(`清理临时区：删了 ${result.removedFiles} 个文件、${result.removedDirs} 个空目录`);
    return result;
  };

  const backupNow = () => enqueue((signal) => runBackup("manual", signal));
  let offRetry: (() => void) | undefined;

  return {
    backupNow,
    verifyLatest: () => enqueue(runVerify),
    cleanTmp: () => enqueue(runClean),
    start() {
      // 用户在"备份失败"上点了"重试"：马上手动备份一次
      offRetry = inbox.onNoticeHandled("backup_failed", RETRY, () => {
        backupNow().catch((err: unknown) => {
          if (!aborted(err, controller.signal)) log(`重试备份出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        });
      });
      internalJobs.register({ name: BACKUP_JOB, schedule: { kind: "daily", time: config.time }, run: (_trigger, signal) => enqueue((s) => runBackup("auto", s), signal) });
      internalJobs.register({ name: VERIFY_JOB, schedule: { kind: "weekly", time: VERIFY_TIME, weekdays: [VERIFY_WEEKDAY] }, run: (_trigger, signal) => enqueue(runVerify, signal) });
      internalJobs.register({ name: CLEAN_TMP_JOB, schedule: { kind: "daily", time: CLEAN_TMP_TIME }, run: (_trigger, signal) => enqueue(runClean, signal) });
    },
    async stop() {
      offRetry?.();
      controller.abort();
      await lane;
    },
  };
}
