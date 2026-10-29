// "存一份到本地"（307 号票）记在二狗数据目录里的东西（不在存放位置里：那边只放用户要看的照片、日记、vlog 和每天的说明.txt）：
// - 设置：配置区的 looki-archive.json——开没开、位置（不写是默认位置）、存哪几类。只由运行时写（设置 · 数据源里 Looki 那一块）；
// - 索引：数据目录的 looki-archive/days/<日期>.json，一天一份——这天的每个时刻（文件夹、标题、起止、地点、存了哪几类、每个 Looki 文件存成了
//   哪个文件多大、没存齐的、试了几次）、日记、vlog。按 Looki 的 id 去重就是查它；一天一份，存一个时刻只重写那一天的（照片多的一天几千个文件）；
// - 状态：looki-archive/state.json——上次存下东西的时间、补存的进度（守护进程重启后接着显示）。
// 断开（留着或者连已导入的一起删）都不动这些——它们跟着存放位置里的文件走，那是用户自己的档案；移除 Looki 插件并连数据删时删掉（文件不删）。
// 索引丢了也不要紧：存之前先看目标文件在不在，在就算存过（不覆盖、不重下）。
import fs from "node:fs";
import path from "node:path";
import { LOOKI_ARCHIVE_DEFAULT_KINDS, LOOKI_ARCHIVE_KINDS, type LookiArchiveKind, type LookiArchiveSaved, type LookiBackfillView } from "@ergo/protocol";
import { writeFileAtomic } from "../util/atomic-file.ts";

/** 设置文件在配置区里的名字、索引在数据目录里的目录名（移除并连数据删时按它们删） */
export const ARCHIVE_SETTINGS_FILE = "looki-archive.json";
export const ARCHIVE_STATE_DIR = "looki-archive";

export interface ArchiveSettings {
  on: boolean;
  /** 位置；不写是默认位置 */
  folder?: string;
  kinds: Record<LookiArchiveKind, boolean>;
}

/** 存下的一个照片、视频文件 */
export interface SavedFile {
  /** 相对存放位置（正斜杠） */
  path: string;
  size: number;
  kind: "photo" | "clip";
}

/** 索引里的一个时刻 */
export interface MomentEntry {
  /** 时刻的文件夹（相对存放位置） */
  folder: string;
  title: string;
  start: string;
  end?: string;
  place?: string;
  /** 已经存齐了哪几类（照片、原始视频） */
  kinds: Array<"photo" | "clip">;
  /** Looki 文件 id → 存成的文件 */
  files: Record<string, SavedFile>;
  /** 还没存齐（下载失败、存到一半停了、限速了）：下次同步接着补 */
  pending: boolean;
  /** 连着几次没存齐（到 MAX_ATTEMPTS 不再自动试） */
  attempts: number;
}

/** 存下的一篇日记、一个 vlog */
export interface SavedText {
  path: string;
  size: number;
  title: string;
}

/** 一天的索引 */
export interface DayIndex {
  format: 1;
  date: string;
  moments: Record<string, MomentEntry>;
  journals: Record<string, SavedText>;
  vlogs: Record<string, SavedText>;
}

/** 补存的进度（存在 state.json 里的样子和给网页的一样） */
export type BackfillState = LookiBackfillView;

export interface ArchiveState {
  format: 1;
  lastSavedAt?: string;
  backfill?: BackfillState;
}

/** 一天的小计（数已存多少、找没存齐的用；不用每次读全部索引） */
export interface DaySummary {
  photos: number;
  clips: number;
  journals: number;
  vlogs: number;
  bytes: number;
  /** 没存齐、还会自动接着补的时刻 */
  pending: string[];
  /** 试够了次数、不再自动试的时刻 */
  failed: string[];
}

/** 连着几次没存齐就不再自动试（补存那几天、点"现在接着存"时再试） */
export const MAX_ATTEMPTS = 5;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export interface ArchiveStore {
  settings(): ArchiveSettings;
  saveSettings(next: ArchiveSettings): void;
  state(): ArchiveState;
  saveState(next: ArchiveState): void;
  /** 一天的索引（没有是空的） */
  day(date: string): DayIndex;
  saveDay(day: DayIndex): void;
  /** 全部日子的小计（第一次叫时读一遍全部索引，之后跟着 saveDay 变） */
  summaries(): ReadonlyMap<string, DaySummary>;
  /** 加起来：已存多少 */
  totals(): LookiArchiveSaved & { pending: number; failed: number };
}

export function createArchiveStore(options: { settingsFile: string; stateDir: string; log(line: string): void }): ArchiveStore {
  const daysDir = path.join(options.stateDir, "days");
  const stateFile = path.join(options.stateDir, "state.json");
  let summaryCache: Map<string, DaySummary> | undefined;

  const settings = (): ArchiveSettings => {
    const raw = readJson(options.settingsFile);
    const kinds = { ...LOOKI_ARCHIVE_DEFAULT_KINDS };
    if (!isRecord(raw)) return { on: true, kinds };
    if (isRecord(raw.kinds)) for (const k of LOOKI_ARCHIVE_KINDS) if (typeof raw.kinds[k] === "boolean") kinds[k] = raw.kinds[k];
    const folder = typeof raw.folder === "string" && raw.folder.trim() !== "" ? raw.folder : undefined;
    return { on: raw.on !== false, ...(folder === undefined ? {} : { folder }), kinds };
  };

  const summarize = (day: DayIndex): DaySummary => {
    const s: DaySummary = { photos: 0, clips: 0, journals: 0, vlogs: 0, bytes: 0, pending: [], failed: [] };
    for (const [id, m] of Object.entries(day.moments)) {
      for (const f of Object.values(m.files)) {
        if (f.kind === "photo") s.photos += 1;
        else s.clips += 1;
        s.bytes += f.size;
      }
      if (m.pending) (m.attempts >= MAX_ATTEMPTS ? s.failed : s.pending).push(id);
    }
    for (const j of Object.values(day.journals)) {
      s.journals += 1;
      s.bytes += j.size;
    }
    for (const v of Object.values(day.vlogs)) {
      s.vlogs += 1;
      s.bytes += v.size;
    }
    return s;
  };

  const day = (date: string): DayIndex => {
    const raw = readJson(path.join(daysDir, `${date}.json`));
    if (!isRecord(raw)) return { format: 1, date, moments: {}, journals: {}, vlogs: {} };
    return {
      format: 1,
      date,
      moments: isRecord(raw.moments) ? (raw.moments as Record<string, MomentEntry>) : {},
      journals: isRecord(raw.journals) ? (raw.journals as Record<string, SavedText>) : {},
      vlogs: isRecord(raw.vlogs) ? (raw.vlogs as Record<string, SavedText>) : {},
    };
  };

  const summaries = (): Map<string, DaySummary> => {
    if (summaryCache) return summaryCache;
    const cache = new Map<string, DaySummary>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(daysDir);
    } catch {
      // 还没存过
    }
    for (const name of names.toSorted()) {
      const date = name.replace(/\.json$/, "");
      if (!DATE.test(date) || !name.endsWith(".json")) continue;
      cache.set(date, summarize(day(date)));
    }
    summaryCache = cache;
    return cache;
  };

  return {
    settings,
    saveSettings(next) {
      writeFileAtomic(options.settingsFile, `${JSON.stringify({ format: 1, on: next.on, ...(next.folder === undefined ? {} : { folder: next.folder }), kinds: next.kinds }, null, 2)}\n`);
    },
    state() {
      const raw = readJson(stateFile);
      if (!isRecord(raw)) return { format: 1 };
      return {
        format: 1,
        ...(typeof raw.lastSavedAt === "string" ? { lastSavedAt: raw.lastSavedAt } : {}),
        ...(isRecord(raw.backfill) && typeof raw.backfill.from === "string" && typeof raw.backfill.to === "string" ? { backfill: raw.backfill as unknown as BackfillState } : {}),
      };
    },
    saveState(next) {
      writeFileAtomic(stateFile, `${JSON.stringify(next, null, 2)}\n`);
    },
    day,
    saveDay(next) {
      writeFileAtomic(path.join(daysDir, `${next.date}.json`), `${JSON.stringify(next)}\n`);
      summaries().set(next.date, summarize(next));
    },
    summaries,
    totals() {
      const t = { photos: 0, clips: 0, journals: 0, vlogs: 0, bytes: 0, days: 0, pending: 0, failed: 0 };
      for (const s of summaries().values()) {
        const files = s.photos + s.clips + s.journals + s.vlogs;
        if (files > 0) t.days += 1;
        t.photos += s.photos;
        t.clips += s.clips;
        t.journals += s.journals;
        t.vlogs += s.vlogs;
        t.bytes += s.bytes;
        t.pending += s.pending.length;
        t.failed += s.failed.length;
      }
      return t;
    },
  };
}
