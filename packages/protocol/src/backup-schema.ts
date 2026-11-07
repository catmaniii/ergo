// 备份的状况和"立即备份"，用 TypeBox 定义，守护进程和 Web 共用生成的类型：
// - GET /api/backup：设置里"备份"那一小节——谁来定时、下一次、同步目录能不能用、本机和同步目录里最新的快照、最近一次的结果、
//   现在有没有一份在做；
// - POST /api/backup/run："立即备份"：守护进程排一次（和它自己到点的那次在同一条队列里），马上回现在的状况，做完的结果再取。
// 守护进程自己（到点的、"立即备份"）和命令行脚本（npm run backup，外部定时器调的也是它）写同一份"最近一次"的记录，
// 受同一把锁管（本机备份区的 backup.lock：同一时刻只有一份在做，后来的等）。
// 设置 · 备份是单独一页（#/more/backup），多了这几个接口（改配置只有用户在这一页能改，不给 agent 工具）：
// - PATCH /api/backup/config：改另存的文件夹、每晚几点、谁来定时；写进配置文件（只动 backup 这几个键），不用重启，回现在的状况；
// - POST /api/backup/check-folder：选文件夹时校验一个路径（绝对路径、不在数据目录里、存在、真写一个临时文件试）；
// - GET /api/backup/snapshots：本机和另存文件夹各有哪些快照、多大，取不到的写原因；
// - POST /api/backup/verify：手动校验最新的快照（和备份排同一条队列、拿同一把锁），马上回现在的状况，结果接着取；
// - POST /api/backup/open：在电脑上打开本机备份区或另存的文件夹（只认这两处，不收路径）。
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

/** 快照里没收进去的一个文件：相对数据目录的路径（用 / 分隔；读不了的目录以 / 结尾），读不了的原因（错误原文） */
export const BackupSkippedFile = Type.Object({
  path: Type.String(),
  reason: Type.String(),
});
export type BackupSkippedFile = Static<typeof BackupSkippedFile>;

/**
 * 这次做快照时跳过的文件：被别的程序占着（EBUSY / EPERM / EACCES），短间隔重试了几次还读不了。一共几个，列前若干个。
 * 数据库、配置这类关键文件不跳过（读不了整份算失败），所以有跳过的这次照样算做成了，只是"成功但有跳过"
 */
export const BackupSkipped = Type.Object({
  count: Type.Integer({ minimum: 1 }),
  files: Type.Array(BackupSkippedFile),
});
export type BackupSkipped = Static<typeof BackupSkipped>;

/** 一次备份的结果 */
export const BackupResult = Type.Object({
  /** 快照的日期 YYYY-MM-DD（本地日期） */
  date: Type.String(),
  local: Type.Enum(BACKUP_LOCAL_RESULTS),
  sync: Type.Enum(BACKUP_SYNC_RESULTS),
  /** 失败的原因（给人看） */
  error: Type.Optional(Type.String()),
  /** 这次新做的本机快照里跳过了的文件；没跳过的不带 */
  skipped: Type.Optional(BackupSkipped),
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
  /** 跳过了的文件（"成功但有跳过"）；没跳过的不带 */
  skipped: Type.Optional(BackupSkipped),
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

/** 两处放快照的地方：本机备份区、另存的文件夹（配置 backup.syncDir） */
export const BACKUP_PLACES = ["local", "sync"] as const;
export type BackupPlace = (typeof BACKUP_PLACES)[number];

/** 留几份（backup/retention.ts 的常量，只读）：本机几份；另存文件夹每日几份、每周几份 */
export const BackupRetentionView = Type.Object({
  local: Type.Integer({ minimum: 0 }),
  syncDaily: Type.Integer({ minimum: 0 }),
  syncWeekly: Type.Integer({ minimum: 0 }),
});
export type BackupRetentionView = Static<typeof BackupRetentionView>;

/** 这台电脑上二狗是怎么装的（命令不一样）：ergo 是一行命令、npm 装的，有 ergo 命令；source 是自己 git clone 的，在代码目录里跑 */
export const BACKUP_INSTALLS = ["ergo", "source"] as const;
export type BackupInstall = (typeof BACKUP_INSTALLS)[number];

/** 恢复的一步：一句说明、一条能复制的命令（PowerShell） */
export const BackupRestoreStep = Type.Object({
  note: Type.String(),
  command: Type.String(),
});
export type BackupRestoreStep = Static<typeof BackupRestoreStep>;

/** 和这台电脑的装法对得上的命令（守护进程按自己装在哪现算） */
export const BackupCommandsView = Type.Object({
  install: Type.Enum(BACKUP_INSTALLS),
  /** 交给外部定时器时要定时调的那一条（PowerShell） */
  scheduled: Type.String(),
  /** 怎么恢复，一步一条 */
  restore: Type.Array(BackupRestoreStep),
});
export type BackupCommandsView = Static<typeof BackupCommandsView>;

/** 校验了一处最新的快照：problems 空表示通过 */
export const BackupVerifyCheck = Type.Object({
  location: Type.Enum(BACKUP_PLACES),
  date: Type.String(),
  problems: Type.Array(Type.String()),
});
export type BackupVerifyCheck = Static<typeof BackupVerifyCheck>;

/** 最近一次校验（手动的、每周的；只记在这次运行里）：查了哪几处；另存文件夹用不了没查的写原因；等备份等太久这次没查的写原因 */
export const BackupVerifyRecord = Type.Object({
  finishedAt: Type.String(),
  checks: Type.Array(BackupVerifyCheck),
  syncSkipped: Type.Optional(Type.String()),
  busy: Type.Optional(Type.String()),
});
export type BackupVerifyRecord = Static<typeof BackupVerifyRecord>;

/** GET /api/backup（POST /api/backup/run、/verify，PATCH /config 也回它）：设置 · 备份那一页要的全部，每次现取（快照列表另取） */
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
  /** 本机备份区的完整路径（跟着数据目录走，不单独挪） */
  localDir: Type.String(),
  retention: BackupRetentionView,
  commands: BackupCommandsView,
  /** 排着或正在做一次校验（这时 running 只说备份，不算校验拿着的锁） */
  verifying: Type.Boolean(),
  /** 最近一次校验；这次运行还没校验过不带 */
  lastVerify: Type.Optional(BackupVerifyRecord),
});
export type BackupStatusView = Static<typeof BackupStatusView>;

/**
 * PATCH /api/backup/config：改哪项给哪项。syncDir 是另存的文件夹（完整路径），null 是清掉（只留本机那份）；
 * createSyncDir 为真时文件夹不存在就新建（页面问过用户了）；time 是每晚几点（HH:mm）；schedule 是谁来定时
 */
export const BackupConfigBody = Type.Object({
  syncDir: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createSyncDir: Type.Optional(Type.Boolean()),
  time: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.Enum(BACKUP_SCHEDULES)),
});
export type BackupConfigBody = Static<typeof BackupConfigBody>;

/** POST /api/backup/check-folder 的请求 */
export const BackupFolderCheckBody = Type.Object({ dir: Type.String() });
export type BackupFolderCheckBody = Static<typeof BackupFolderCheckBody>;

/** 选文件夹时校验的结果：能用（dir 是规整过的完整路径）、不存在（问一下要不要新建）、不能用（原因给人看） */
export const BackupFolderCheck = Type.Union([
  Type.Object({ kind: Type.Literal("ok"), dir: Type.String() }),
  Type.Object({ kind: Type.Literal("missing"), dir: Type.String() }),
  Type.Object({ kind: Type.Literal("invalid"), dir: Type.String(), reason: Type.String() }),
]);
export type BackupFolderCheck = Static<typeof BackupFolderCheck>;

/** 一份快照：日期、里面文件的总大小；日期目录在但清单读不出来的写原因 */
export const BackupSnapshotItem = Type.Object({
  date: Type.String(),
  bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  problem: Type.Optional(Type.String()),
});
export type BackupSnapshotItem = Static<typeof BackupSnapshotItem>;

/** 一处的快照，从新到旧；取不到（文件夹不在、读不了）写原因 */
export const BackupSnapshotPlace = Type.Object({
  dir: Type.String(),
  snapshots: Type.Array(BackupSnapshotItem),
  problem: Type.Optional(Type.String()),
});
export type BackupSnapshotPlace = Static<typeof BackupSnapshotPlace>;

/** GET /api/backup/snapshots：本机和另存文件夹；没配另存的文件夹不带 sync */
export const BackupSnapshotsView = Type.Object({
  local: BackupSnapshotPlace,
  sync: Type.Optional(BackupSnapshotPlace),
});
export type BackupSnapshotsView = Static<typeof BackupSnapshotsView>;

/** POST /api/backup/open 的请求：打开哪一处 */
export const BackupOpenBody = Type.Object({ place: Type.Enum(BACKUP_PLACES) });
export type BackupOpenBody = Static<typeof BackupOpenBody>;

/** POST /api/backup/open 的回答：打开了没有，没打开写原因 */
export const BackupOpenResult = Type.Object({
  opened: Type.Boolean(),
  error: Type.Optional(Type.String()),
});
export type BackupOpenResult = Static<typeof BackupOpenResult>;
