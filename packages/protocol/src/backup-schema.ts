// 备份的状况和"立即备份"（335 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型：
// - GET /api/backup：设置里"备份"那一小节——谁来定时、下一次、同步目录能不能用、本机和同步目录里最新的快照、最近一次的结果、
//   现在有没有一份在做；
// - POST /api/backup/run："立即备份"：守护进程排一次（和它自己到点的那次在同一条队列里），马上回现在的状况，做完的结果再取。
// 守护进程自己（到点的、"立即备份"）和命令行脚本（npm run backup，外部定时器调的也是它）写同一份"最近一次"的记录，
// 受同一把锁管（本机备份区的 backup.lock：同一时刻只有一份在做，后来的等）。
import { type Static, Type } from "typebox";

/** 谁做的：守护进程（到点的、"立即备份"）、命令行脚本（npm run backup） */
export const BACKUP_RUNNERS = ["daemon", "script"] as const;
export type BackupRunner = (typeof BACKUP_RUNNERS)[number];

/**
 * 怎么做：auto 只补齐当天缺的（守护进程到点的、开机补做的，npm run backup -- --scheduled）——当天的快照已经在了就不再做、不覆盖；
 * manual 重做当天的、换掉已有的（"立即备份"、npm run backup）
 */
export const BACKUP_MODES = ["auto", "manual"] as const;
export type BackupMode = (typeof BACKUP_MODES)[number];

/** 本机快照：新做的、换掉了当天已有的、当天已有没动、失败 */
export const BACKUP_LOCAL_RESULTS = ["created", "replaced", "kept", "failed"] as const;
/** 同步目录：复制了、换掉了当天已有的、当天已有没动、没配同步目录、失败、本机没做成所以没复制 */
export const BACKUP_SYNC_RESULTS = ["copied", "replaced", "kept", "not_configured", "failed", "skipped"] as const;

/**
 * 谁来定时（配置 backup.schedule）：internal 守护进程每天到点自己做（默认）；external 交给外部定时器调 npm run backup
 * （守护进程不再自己到点备份，连着两天没人备份时提醒一条；每周校验、临时区清理照旧由守护进程做）
 */
export const BACKUP_SCHEDULES = ["internal", "external"] as const;
export type BackupSchedule = (typeof BACKUP_SCHEDULES)[number];

/** 一次备份的结果 */
export const BackupResult = Type.Object({
  /** 快照的日期 YYYY-MM-DD（本地日期） */
  date: Type.String(),
  local: Type.Enum(BACKUP_LOCAL_RESULTS),
  sync: Type.Enum(BACKUP_SYNC_RESULTS),
  /** 失败的原因（给人看） */
  error: Type.Optional(Type.String()),
});
export type BackupResult = Static<typeof BackupResult>;

/** 最近一次备份的记录（本机备份区的 last-backup.json）：谁做的、怎么做的、什么时候、结果 */
export const BackupRunRecord = Type.Object({
  by: Type.Enum(BACKUP_RUNNERS),
  mode: Type.Enum(BACKUP_MODES),
  /** 拿到锁、开始做的时刻（协议时间） */
  startedAt: Type.String(),
  finishedAt: Type.String(),
  date: Type.String(),
  local: Type.Enum(BACKUP_LOCAL_RESULTS),
  sync: Type.Enum(BACKUP_SYNC_RESULTS),
  error: Type.Optional(Type.String()),
});
export type BackupRunRecord = Static<typeof BackupRunRecord>;

/** 配置里的同步目录现在能不能用：没配（只做本机备份）、能用、配了但用不了（原因给人看） */
export const BackupSyncDirView = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  Type.Object({ kind: Type.Literal("ready"), dir: Type.String() }),
  Type.Object({ kind: Type.Literal("unusable"), dir: Type.String(), reason: Type.String() }),
]);
export type BackupSyncDirView = Static<typeof BackupSyncDirView>;

/** 正拿着备份锁的那一份：谁、进程号、从什么时候起 */
export const BackupRunningView = Type.Object({
  by: Type.Enum(BACKUP_RUNNERS),
  pid: Type.Integer({ minimum: 0 }),
  since: Type.String(),
});
export type BackupRunningView = Static<typeof BackupRunningView>;

/** GET /api/backup（POST /api/backup/run 也回它）：设置里"备份"那一小节要的全部，每次现取 */
export const BackupStatusView = Type.Object({
  schedule: Type.Enum(BACKUP_SCHEDULES),
  /** 每天几点（配置 backup.time，HH:mm）；external 时守护进程不按它备份 */
  time: Type.String(),
  /** 守护进程下一次自己备份的时刻（协议时间）；external 时没有 */
  next: Type.Optional(Type.String()),
  syncDir: BackupSyncDirView,
  /** 本机备份区、同步目录里最新一份快照的日期；没有就不带 */
  latestLocal: Type.Optional(Type.String()),
  latestSync: Type.Optional(Type.String()),
  /** 最近一次（守护进程或命令行做的）；还没做过不带 */
  last: Type.Optional(BackupRunRecord),
  /** 现在正在做的（锁的主人还活着）；没有不带 */
  running: Type.Optional(BackupRunningView),
  /** 守护进程这边排着一次"立即备份"（在等锁或者正在做） */
  queued: Type.Boolean(),
});
export type BackupStatusView = Static<typeof BackupStatusView>;
