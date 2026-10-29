// Looki 插件的"存一份到本地"（307 号票；默认存照片 + 日记 + vlog）：守护进程的 Looki 插件每天同步时刻时顺带把照片、AI 日记、vlog
// 下载到一个本地文件夹（默认在「文档」下的 Looki；换成网盘的同步目录，手机上也翻得到），按 年-月\日期\时刻 分文件夹。设置 · 数据源里 Looki 下面插件画的那一块要的数据（DataSourceView.panel）
// 和填设置时交的值（configure 的 values）的写法在这里。不引用 TypeBox。

/** 存哪几类：照片、AI 日记（存成文字）、vlog、原始视频片段 */
export const LOOKI_ARCHIVE_KINDS = ["photos", "journals", "vlogs", "clips"] as const;
export type LookiArchiveKind = (typeof LOOKI_ARCHIVE_KINDS)[number];

/** 各类默认存不存：照片、AI 日记、vlog 默认存，原始视频片段默认不存（占地方） */
export const LOOKI_ARCHIVE_DEFAULT_KINDS: Readonly<Record<LookiArchiveKind, boolean>> = { photos: true, journals: true, vlogs: true, clips: false };

/** "把以前的也存下来"默认往回补几天 */
export const LOOKI_BACKFILL_DEFAULT_DAYS = 30;
/** 一次最多往回补几天 */
export const LOOKI_BACKFILL_MAX_DAYS = 366;

/**
 * 填设置时交给守护进程的（POST /api/data-sources/looki，action configure）：values.archive 是做哪一样——
 * - settings：改存的设置（on："true" / "false"；folder：位置，空的是默认位置；photos / journals / vlogs / clips："true" / "false"，没给的不动）；
 * - backfill：把以前的也存下来（from、to：YYYY-MM-DD，含两头，往回补：从 to 往前到 from）；
 * - stop：停下补存；resume：接着补；
 * - retry：现在接着存（停下了、有没存齐的时，不等下一次同步）。
 * 不带 archive 的是 296 号票的填 Key、选区域、测试连接
 */
export const LOOKI_ARCHIVE_OPS = ["settings", "backfill", "stop", "resume", "retry"] as const;
export type LookiArchiveOp = (typeof LOOKI_ARCHIVE_OPS)[number];

/** 已经存下来的：照片几张、原始视频几段、日记几篇、vlog 几个，一共多大、几天 */
export interface LookiArchiveSaved {
  photos: number;
  clips: number;
  journals: number;
  vlogs: number;
  bytes: number;
  days: number;
}

/** 补存（把以前的也存下来）的进度 */
export interface LookiBackfillView {
  /** 范围（含两头） */
  from: string;
  to: string;
  /** 下一个要补的日子（往回补：从 to 往前到 from）；补完了没有 */
  next?: string;
  doneDays: number;
  totalDays: number;
  /** running 正在补；stopped 用户点了停；paused 断开了、守护进程重启了、限速太久，点"接着补"；done 补完了 */
  state: "running" | "stopped" | "paused" | "done";
  /** 这次补存下了几个文件 */
  files: number;
}

/** 正在存：同步后顺带存、补存、接着存；哪一天；限速了在等 */
export interface LookiArchiveWorking {
  kind: "sync" | "backfill" | "retry";
  day?: string;
  waiting?: boolean;
}

/** 设置 · 数据源里 Looki 下面"存一份到本地"那一块（DataSourceView.panel） */
export interface LookiArchiveView {
  /** 开没开（开着时每次同步顺带存） */
  on: boolean;
  /** 现在存到哪（电脑上的完整路径） */
  folder: string;
  /** 默认位置（「文档」下的 Looki） */
  defaultFolder: string;
  kinds: Record<LookiArchiveKind, boolean>;
  saved: LookiArchiveSaved;
  /** 上次存下东西的时间（带时区偏移的 ISO） */
  lastSavedAt?: string;
  working?: LookiArchiveWorking;
  /** 停下了的原因（磁盘满了、没有权限、位置不在……）：给人看的 */
  problem?: string;
  /** 上一次改设置、开始补存没做成的原因：给人看的 */
  refused?: string;
  /** 还没存齐、下次同步接着补的时刻 */
  pending: number;
  /** 试了几次都没存下来的时刻（不再自动重试；补存那几天时再试） */
  failed: number;
  backfill?: LookiBackfillView;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 数据源页交来的 panel 是不是"存一份到本地"那一块（网页插件画之前认一下，认不出就不画） */
export function isLookiArchiveView(value: unknown): value is LookiArchiveView {
  return isRecord(value) && typeof value.on === "boolean" && typeof value.folder === "string" && isRecord(value.kinds) && isRecord(value.saved);
}
