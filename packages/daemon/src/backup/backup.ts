// 备份（规格第 2、13、18 节）：快照、复制、保留、校验；外加同一批内部作业里的临时区清理。恢复在 restore.ts。
// 快照在盘上的样子见 snapshot.ts 和 ADR-0007。
//
// 一次备份（runBackup）：本机备份区做当天的快照，再复制到同步目录（配置 backup.syncDir）的日期子目录，由同步客户端去同步。
// 写进同步目录就算成功，不等也不查同步客户端。本机留最近 7 份；同步目录留每日 7 份、每周 4 份，清完回收公共池里没人用的文件。
// 周日那份当时没写进同步目录（目录不在等）的，之后写得进去时从本机补写。
// 自动的（到点、补做、npm run backup -- --scheduled）只补齐当天缺的：当天的快照已经在了就不再做、不覆盖（比如刚从旧快照恢复过，
// 当天那份留着）；手动的（"立即备份"、npm run backup）重做当天的快照，换掉已有的。
//
// 335 号票：同一份 runBackup 守护进程和命令行脚本（src/run-backup.ts，npm run backup）都用。两边拿同一把锁（lock.ts，本机备份区的
// backup.lock）：同一时刻只有一份在做，后来的等它做完再做自己的。做完（拿着锁时）写下"最近一次"（record.ts），设置里看得到。
// 谁来定时看配置 backup.schedule：internal（默认）守护进程每天到点自己做；external 交给外部定时器调 npm run backup，守护进程
// 不再到点备份，每天 12:00 看一眼，连着两天没人备份过就提醒一条（定时任务被暂停、删掉了也不会悄悄没了备份）。
//
// 守护进程里的内部作业（错过的开机后补一次，见 scheduler/internal-jobs.ts）：
// - 每晚备份（默认 03:30，配置 backup.time；schedule 是 external 时不登记）；
// - 外部定时器的备份连着两天没跑的提醒（每天 12:00，只在 external 时登记）；
// - 每周校验（周日 04:30）：打开本机备份区和同步目录里最新快照的数据库做完整性检查，文件对一遍大小（也拿备份锁：
//   不会在命令行脚本正换掉当天快照的时候去读它）；
// - 每天清理临时区（04:00）：删 7 天前的文件。
// 这几件在守护进程里排成一条队列依次做；"立即备份"也排在这条队列里。
//
// 写入失败（同步目录不在、空间不够、复制出错）在守护进程里放一条"备份失败"（不卡任务），本机快照照样留着；
// 用户在这条上点"重试"就马上手动备份一次。校验没通过放一条"快照校验失败"。命令行脚本只打出来、写进日志，退出码非 0。
// 守护进程停止时中止正在做的（AbortSignal），半成品删掉。
import path from "node:path";
import { type BackupMode, type BackupResult, type BackupRunner, type BackupStatusView, type NoticeType, nowIso, t } from "@ergo/protocol";
import type { BackupConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type Clock, clockIso } from "../scheduler/clock.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import { nodeSnapshotFiles, type SnapshotFiles } from "./files.ts";
import { acquireBackupLock, BackupBusy, type BackupLockOwner, backupLockFile, liveLockOwner } from "./lock.ts";
import { readBackupRecord, writeBackupRecord } from "./record.ts";
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

export type { BackupMode, BackupResult } from "@ergo/protocol";

/** 内部作业的名字和时间 */
export const BACKUP_JOB = "backup";
export const VERIFY_JOB = "verify_snapshot";
export const CLEAN_TMP_JOB = "clean_tmp";
/** external 时看一眼外部定时器的备份有没有在跑（335 号票） */
export const OVERDUE_JOB = "backup_overdue_check";
/** 每周校验：周日 04:30（当天 03:30 的快照做完之后） */
export const VERIFY_WEEKDAY = 0;
export const VERIFY_TIME = "04:30";
export const CLEAN_TMP_TIME = "04:00";
/** 中午看：夜里的备份早该做完了 */
export const OVERDUE_CHECK_TIME = "12:00";
/** 最近一次备份开始之后这么久还没有下一次，算连着两天没人备份 */
export const OVERDUE_AFTER_MS = 48 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** "备份失败"事项上的"重试"：马上再备份一次 */
export const RETRY = "重试"; // @i18n-ignore fixed：事项的动作按字认
/** "备份连着两天没跑"事项上的"立即备份"：守护进程马上备份一次 */
export const BACKUP_NOW = "立即备份"; // @i18n-ignore fixed：事项的动作按字认

export interface SnapshotCheck {
  location: "local" | "sync";
  date: string;
  /** 问题；空表示通过 */
  problems: string[];
}

/** 一次备份里要告诉用户的失败（守护进程放进待处理事项；命令行只打出来） */
export interface BackupFailure {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface RunBackupOptions {
  layout: DataDirLayout;
  config: BackupConfig;
  clock: Clock;
  /** 往备份区写文件；测试换成会出错的实现 */
  files: SnapshotFiles;
  mode: BackupMode;
  signal: AbortSignal;
  /** 一步一行（守护进程进日志；命令行打到屏幕上、写进 logs/backup.log） */
  log: (line: string) => void;
  report: (failure: BackupFailure) => void;
}

/** 写入出错的原因，给人看 */
function describeWriteError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  // SQLite 写满时（VACUUM INTO）没有 errno，只有这句话
  if (code === "ENOSPC" || /disk is full/i.test(err instanceof Error ? err.message : "")) return t("backup.error.noSpace");
  if (code === "EACCES" || code === "EPERM") return t("backup.error.noPermission", { message: (err as Error).message });
  return t("backup.error.copy", { message: err instanceof Error ? err.message : String(err) });
}

/** 是不是因为停止（守护进程停了、命令行被中断）被中止的 */
const aborted = (err: unknown, signal: AbortSignal) => signal.aborted || (err instanceof Error && err.name === "AbortError");

class BackupFailureError extends Error {}

/** 本机快照怎么样了（日志里的说法） */
const LOCAL_WORDS: Record<Exclude<BackupResult["local"], "failed">, string> = {
  created: "做好了", // @i18n-ignore log
  replaced: "重做了（换掉了当天已有的）", // @i18n-ignore log
  kept: "当天已经有了，没动", // @i18n-ignore log
};

/** 做一次备份（不拿锁、不写记录；守护进程和命令行都经 backupWithLock 调它） */
export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  const { layout, config, clock, files, mode, signal, log, report } = options;
  const now = clock.now();
  const date = localDate(now);
  const when = localDateTime(now);

  /** 删掉不在保留之列的快照；出错只记日志（下次再删） */
  const prune = async (root: string, keep: (dates: readonly string[]) => Set<string>) => {
    const dates = listSnapshots(root).map((s) => s.date);
    const kept = keep(dates);
    for (const old of dates) {
      if (kept.has(old)) continue;
      try {
        await files.remove(path.join(root, old));
        log(`备份：删了不再留的旧快照 ${path.join(root, old)}`);
      } catch (err) {
        log(`删旧快照 ${path.join(root, old)} 出错：${String(err)}`);
      }
    }
  };

  /** 本机备份区里最近的周日快照（不算今天的）当时没写进同步目录的，补写进去；补不进去报一条"备份失败" */
  const backfillSunday = async (root: string) => {
    const sunday = listSnapshots(layout.backups)
      .filter((s) => s.date !== date && isSunday(s.date))
      .at(-1);
    if (!sunday || readSnapshot(path.join(root, sunday.date))) return;
    try {
      await copySnapshot({ snapshot: sunday, root, files, signal });
      log(`备份：${sunday.date}（周日）的快照当时没写进同步目录，这次从本机补上了`);
    } catch (err) {
      if (aborted(err, signal)) throw err;
      const reason = describeWriteError(err);
      log(`备份失败（补写周日的快照）：${reason}`);
      report({ title: t("backup.sundayFailed.title"), body: t("backup.sundayFailed.body", { date: sunday.date, reason }), data: { date: sunday.date, stage: "sync_backfill", reason } });
    }
  };

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
      log(`备份：开始做 ${date} 的本机快照`);
      const previous = listSnapshots(layout.backups).at(-1);
      snapshot = await takeSnapshot({ layout, root: layout.backups, date, createdAt: clockIso(clock), previous, files, signal, log });
      local = existing ? "replaced" : "created";
    }
  } catch (err) {
    if (aborted(err, signal)) throw err;
    const reason = describeWriteError(err);
    log(`备份失败（本机快照）：${reason}`);
    report({ title: t("backup.localFailed.title"), body: t("backup.localFailed.body", { when, reason }), data: { date, stage: "local", reason } });
    return { date, local: "failed", sync: "skipped", error: reason };
  }
  log(`备份：本机快照 ${date} ${LOCAL_WORDS[local]}（${snapshot.dir}）`);
  await prune(layout.backups, keepLocal);

  // 2. 复制到同步目录
  const sync = syncDirOf(config);
  if (sync.kind === "none") {
    log(`备份：${date} 的快照做好了；没有配置同步目录（backup.syncDir），只留在本机`);
    return { date, local, sync: "not_configured" };
  }
  try {
    if (sync.kind === "unusable") throw new BackupFailureError(sync.reason);
    const root = sync.dir;
    await removeLeftovers(root, files);
    const existing = readSnapshot(path.join(root, date));
    let status: BackupResult["sync"] = "kept";
    if (mode === "manual" || !existing) {
      log(`备份：开始写进同步目录 ${root}`);
      await copySnapshot({ snapshot, root, files, signal });
      status = existing ? "replaced" : "copied";
    } else {
      log(`备份：同步目录里当天的快照已经有了，没动（${path.join(root, date)}）`);
    }
    await backfillSunday(root);
    await prune(root, keepSync);
    await collectPool(root, files, log);
    log(`备份：${date} 的快照做好了，已写进同步目录 ${root}`);
    return { date, local, sync: status };
  } catch (err) {
    if (aborted(err, signal)) throw err;
    const reason = err instanceof BackupFailureError ? err.message : describeWriteError(err);
    log(`备份失败（同步目录）：${reason}`);
    report({ title: t("backup.syncFailed.title"), body: t("backup.syncFailed.body", { when, date, reason }), data: { date, stage: "sync", reason } });
    return { date, local, sync: "failed", error: reason };
  }
}

/** 锁的主人是谁（给人看）：守护进程 / 命令行，进程号，从几点起 */
export function lockOwnerText(owner: BackupLockOwner | undefined): string {
  if (!owner) return t("backup.owner.unknown");
  return t("backup.owner.text", { who: t(owner.by === "daemon" ? "backup.runner.daemon" : "backup.runner.script"), pid: owner.pid, since: localDateTime(Date.parse(owner.since)) });
}

export interface BackupWithLockOptions extends RunBackupOptions {
  by: BackupRunner;
  /** 等锁：测试调短 */
  lockWaitMs?: number;
  lockPollMs?: number;
}

/**
 * 拿着备份锁做一次备份，做完写下"最近一次"（守护进程和命令行都走这里）。另一份正在做时等它做完（日志里说在等谁）；
 * 主人已经不在了的锁作废；等太久（BACKUP_LOCK_WAIT_MS）算这次没做成，报一条"备份失败"
 */
export async function backupWithLock(options: BackupWithLockOptions): Promise<BackupResult> {
  const { layout, clock, signal, log, by, mode } = options;
  let lock;
  try {
    lock = await acquireBackupLock({
      file: backupLockFile(layout),
      by,
      nowIso: () => clockIso(clock),
      signal,
      ...(options.lockWaitMs === undefined ? {} : { waitMs: options.lockWaitMs }),
      ...(options.lockPollMs === undefined ? {} : { pollMs: options.lockPollMs }),
      onWait: (owner) => log(`备份：等另一份备份做完——${lockOwnerText(owner)}`),
      onStale: (owner) => log(`备份：锁的主人已经不在了（${lockOwnerText(owner)}），这把锁作废，接着做`),
    });
  } catch (err) {
    if (!(err instanceof BackupBusy)) throw err;
    const reason = t("backup.busy", { owner: lockOwnerText(err.owner) });
    const now = clock.now();
    log(`备份失败：${reason}`);
    options.report({ title: t("backup.localFailed.title"), body: t("backup.localFailed.body", { when: localDateTime(now), reason }), data: { date: localDate(now), stage: "busy", reason } });
    return { date: localDate(now), local: "failed", sync: "skipped", error: reason };
  }
  const startedAt = clockIso(clock);
  try {
    const result = await runBackup(options);
    writeBackupRecord(layout, { by, mode, startedAt, finishedAt: clockIso(clock), ...result });
    return result;
  } catch (err) {
    if (!aborted(err, signal)) {
      const error = err instanceof Error ? err.message : String(err);
      writeBackupRecord(layout, { by, mode, startedAt, finishedAt: clockIso(clock), date: localDate(Date.parse(startedAt)), local: "failed", sync: "skipped", error });
    }
    throw err;
  } finally {
    lock.release();
  }
}

/** 最近一次有人备份的时刻（毫秒）：记录里的开始时间，和本机备份区最新快照的生成时间（这张票之前做的没有记录），取晚的 */
export function lastBackupAt(layout: DataDirLayout): number | undefined {
  const times: number[] = [];
  const record = readBackupRecord(layout);
  if (record) times.push(Date.parse(record.startedAt));
  const latest = listSnapshotDates(layout.backups).at(-1);
  const snapshot = latest === undefined ? undefined : readSnapshot(path.join(layout.backups, latest));
  if (snapshot) times.push(Date.parse(snapshot.manifest.createdAt));
  const valid = times.filter(Number.isFinite);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

export interface BackupService {
  /** 立即备份（手动）：重做当天的快照（已有的换掉），再复制到同步目录；排在队列里、拿着备份锁做 */
  backupNow(): Promise<BackupResult>;
  /** 设置里的"立即备份"（POST /api/backup/run）：排一次手动备份（已经排着一次就不再排），不等做完，回现在的状况 */
  startNow(): BackupStatusView;
  /** 设置里"备份"那一小节（GET /api/backup）：每次现取 */
  status(): BackupStatusView;
  /** 校验本机备份区和同步目录里最新的快照；没通过的放进待处理事项 */
  verifyLatest(): Promise<SnapshotCheck[]>;
  /** 清理临时区里 7 天前的文件 */
  cleanTmp(): Promise<CleanResult>;
  /** external 时：连着两天没人备份就放一条提醒（已经有一条没处理的就不再放）；平时由每天 12:00 的内部作业调 */
  checkOverdue(): void;
  /**
   * 在内部作业里登记每晚备份（internal）或者没跑的提醒（external）、每周校验、每天清理（错过的马上补一次），
   * 接上"备份失败"的"重试"和"备份连着两天没跑"的"立即备份"
   */
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
  /** 等备份锁时多久看一眼（测试调短） */
  lockPollMs?: number;
  log: (line: string) => void;
}

/** 事项的动作"知道了"（按字认，不翻） */
const GOT_IT = "知道了"; // @i18n-ignore fixed：事项的动作按字认

/** 每种通知的动作 */
const ACTIONS: Partial<Record<NoticeType, string[]>> = { backup_failed: [RETRY, GOT_IT], backup_overdue: [BACKUP_NOW, GOT_IT] };

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
    inbox.add({ kind: "notice", notice: type, title, body, source: t("backup.source"), urgency: "non_blocking", actions: ACTIONS[type] ?? [GOT_IT], data });

  const lockedBackup = (mode: BackupMode, signal: AbortSignal) =>
    backupWithLock({
      layout,
      config,
      clock,
      files,
      mode,
      signal,
      log,
      by: "daemon",
      report: ({ title, body, data }) => notice("backup_failed", title, body, data),
      ...(options.lockPollMs === undefined ? {} : { lockPollMs: options.lockPollMs }),
    });

  const runVerify = async (signal: AbortSignal): Promise<SnapshotCheck[]> => {
    const locations: Array<{ location: SnapshotCheck["location"]; root: string; label: string }> = [{ location: "local", root: layout.backups, label: t("backup.place.local") }];
    // 同步目录用不了时只校验本机的（备份那边已经报了"备份失败"）
    const sync = syncDirOf(config);
    if (sync.kind === "ready") locations.push({ location: "sync", root: sync.dir, label: t("backup.place.sync") });
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
        t("backup.checkFailed.title", { place: label, date }),
        t("backup.checkFailed.body", {
          place: label,
          date,
          problems: problems.slice(0, 5).join(t("backup.problemSep")),
          more: problems.length > 5 ? t("backup.checkFailed.more", { count: problems.length, n: problems.length }) : "",
        }),
        { location, date, problems },
      );
    }
    return checks;
  };

  /** 校验也拿备份锁：命令行脚本正换掉当天快照的时候不去读它；等太久就这次不校验 */
  const lockedVerify = async (signal: AbortSignal): Promise<SnapshotCheck[]> => {
    let lock;
    try {
      lock = await acquireBackupLock({
        file: backupLockFile(layout),
        by: "daemon",
        nowIso: () => clockIso(clock),
        signal,
        ...(options.lockPollMs === undefined ? {} : { pollMs: options.lockPollMs }),
        onWait: (owner) => log(`校验：等另一份备份做完——${lockOwnerText(owner)}`),
      });
    } catch (err) {
      if (!(err instanceof BackupBusy)) throw err;
      log(`校验：${t("backup.busy", { owner: lockOwnerText(err.owner) })}`);
      return [];
    }
    try {
      return await runVerify(signal);
    } finally {
      lock.release();
    }
  };

  const runClean = async (): Promise<CleanResult> => {
    const result = await cleanTmpDir(layout.tmp, clock.now(), log);
    if (result.removedFiles + result.removedDirs > 0) log(`清理临时区：删了 ${result.removedFiles} 个文件、${result.removedDirs} 个空目录`);
    return result;
  };

  /** 排着、正在做的手动备份有几次（设置里的"立即备份"按钮据此灰掉） */
  let pendingManual = 0;
  const backupNow = () => {
    pendingManual++;
    return enqueue((signal) => lockedBackup("manual", signal)).finally(() => pendingManual--);
  };
  /** 点了按钮、事项上的动作：排一次，不等 */
  const backupSoon = () => {
    backupNow().catch((err: unknown) => {
      if (!aborted(err, controller.signal)) log(`立即备份出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
  };

  const status = (): BackupStatusView => {
    const sync = syncDirOf(config);
    const next = config.schedule === "internal" ? internalJobs.nextRun(BACKUP_JOB) : undefined;
    const latestLocal = listSnapshotDates(layout.backups).at(-1);
    const latestSync = sync.kind === "ready" ? listSnapshotDates(sync.dir).at(-1) : undefined;
    const last = readBackupRecord(layout);
    const owner = liveLockOwner(backupLockFile(layout));
    return {
      schedule: config.schedule,
      time: config.time,
      ...(next ? { next: nowIso(next) } : {}),
      syncDir: sync,
      ...(latestLocal ? { latestLocal } : {}),
      ...(latestSync ? { latestSync } : {}),
      ...(last ? { last } : {}),
      ...(owner ? { running: { by: owner.by, pid: owner.pid, since: owner.since } } : {}),
      queued: pendingManual > 0,
    };
  };

  const checkOverdue = () => {
    if (config.schedule !== "external" || liveLockOwner(backupLockFile(layout))) return;
    const now = clock.now();
    const last = lastBackupAt(layout);
    const since = last ?? Date.parse(internalJobs.state(OVERDUE_JOB)?.since ?? nowIso(new Date(now)));
    if (now - since < OVERDUE_AFTER_MS) return;
    if (inbox.list().some((item) => item.kind === "notice" && item.notice === "backup_overdue" && item.handled === undefined)) return;
    const days = Math.floor((now - since) / DAY_MS);
    log(`备份：交给外部定时器以后已经 ${days} 天没人备份了（最近一次 ${last === undefined ? "没有" : localDateTime(last)}），放一条提醒`);
    notice(
      "backup_overdue",
      t("backup.overdue.title", { count: days, n: days }),
      last === undefined ? t("backup.overdue.neverBody", { since: localDateTime(since), count: days, n: days }) : t("backup.overdue.body", { last: localDateTime(last), count: days, n: days }),
      { lastBackupAt: last === undefined ? null : nowIso(new Date(last)), days },
    );
  };

  const offs: Array<() => void> = [];

  return {
    backupNow,
    startNow() {
      if (pendingManual === 0 && !controller.signal.aborted) backupSoon();
      return status();
    },
    status,
    verifyLatest: () => enqueue(lockedVerify),
    cleanTmp: () => enqueue(runClean),
    checkOverdue,
    start() {
      // 用户在"备份失败"上点了"重试"、在"连着两天没跑"上点了"立即备份"：马上手动备份一次
      offs.push(inbox.onNoticeHandled("backup_failed", RETRY, backupSoon));
      offs.push(inbox.onNoticeHandled("backup_overdue", BACKUP_NOW, backupSoon));
      if (config.schedule === "internal") {
        internalJobs.register({ name: BACKUP_JOB, schedule: { kind: "daily", time: config.time }, run: (_trigger, signal) => enqueue((s) => lockedBackup("auto", s), signal) });
      } else {
        internalJobs.register({ name: OVERDUE_JOB, schedule: { kind: "daily", time: OVERDUE_CHECK_TIME }, run: async () => checkOverdue() });
      }
      internalJobs.register({ name: VERIFY_JOB, schedule: { kind: "weekly", time: VERIFY_TIME, weekdays: [VERIFY_WEEKDAY] }, run: (_trigger, signal) => enqueue(lockedVerify, signal) });
      internalJobs.register({ name: CLEAN_TMP_JOB, schedule: { kind: "daily", time: CLEAN_TMP_TIME }, run: (_trigger, signal) => enqueue(runClean, signal) });
    },
    async stop() {
      for (const off of offs.splice(0)) off();
      controller.abort();
      await lane;
    },
  };
}
