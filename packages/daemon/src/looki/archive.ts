// Looki 的"存一份到本地"（307 号票；默认存照片 + 日记 + vlog，原始视频不存）：每天同步时刻时顺带把照片、AI 日记、vlog
// 存到本地一个文件夹（默认是「文档」下的 Looki；能换成任何本地文件夹，比如网盘的同步目录，手机上也就翻得到），
// 按 年-月\日期\时刻（起始时间 标题）\ 分文件夹。
// - 存哪几类各自开关（照片、AI 日记、vlog 默认存，原始视频片段默认不存）；照片、视频原样保存（download.ts：不改一个字节，元数据都在），
//   文件时间设成拍摄时间；AI 日记写进当天文件夹的"日记.md"；vlog 放当天文件夹；每天一份"说明.txt"（这天有哪些时刻、几点、在哪、存了什么）；
// - 下载链接 1 小时失效：列出文件就下，过了 50 分钟先重新列一次；下的时候说过期了（403……）就重新列一次、拿新链接再下一次；
// - 按 Looki 的 id 去重（archive-store.ts 的索引）；没存齐的时刻记着，下次同步接着补（不管它在不在这次同步的日子里），连着 5 次不行就不再自动试；
//   目标文件已经在了就当存过（不覆盖、不重下：索引丢了、用户自己放的都不碰）；
// - 限速照 296 的做法：同步后顺带存的等两次（Retry-After，没有就 60 秒），还限速就停下、下次接着存；补存的一直等（在后台，能停）；
// - 磁盘满（剩不到 200 MB、写的时候 ENOSPC）、没有权限、位置不是文件夹：整个停下，原因写在数据源页 Looki 那一块，下次同步再试；
// - 不进记忆素材、不进备份快照（不在数据目录里；位置也不许放进数据目录）；断开（不管删不删已导入的）都不删这里的文件；
// - "把以前的也存下来"（补存）：按日期范围往回补（默认最近 30 天），一天一批、排在同步后顺带存的后面，能停、能接着补；进度记在 state.json，
//   守护进程重启后停在"已暂停"，点"接着补"接着来（要 Key，重启后手里没有）。
// 一次只做一件（同步后顺带存、补存的一天、现在接着存排着队），不会两边同时下同一个时刻。
// 只写自己这个文件夹（按 年-月 建子文件夹），不碰它旁边别的目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clockLabel,
  LOOKI_ARCHIVE_KINDS,
  LOOKI_BACKFILL_DEFAULT_DAYS,
  LOOKI_BACKFILL_MAX_DAYS,
  type LookiArchiveView,
  type LookiArchiveWorking,
  parseLocalDate,
  t,
  weekdayName,
} from "@ergo/protocol";
import type { DataSourceSecrets } from "../data-sources/api.ts";
import type { LookiJournalPayload, LookiMomentPayload } from "./api.ts";
import { absolute, dayFolder, extensionOf, mediaFileName, momentFolderName, vlogFileName } from "./archive-paths.ts";
import { type RemoteFile, remoteFile, type RemoteVlog, remoteVlog } from "./archive-remote.ts";
import { ARCHIVE_SETTINGS_FILE, ARCHIVE_STATE_DIR, type ArchiveSettings, type ArchiveState, createArchiveStore, type DayIndex, MAX_ATTEMPTS, type MomentEntry } from "./archive-store.ts";
import { LOOKI_FILES_PAGE, LOOKI_RATE_LIMIT_WAIT_MS, type LookiClient, LookiError } from "./client.ts";
import { DownloadError, downloadTo } from "./download.ts";
import { addDays, daysBetween, journalRecords, momentRecord } from "./records.ts";

export { ARCHIVE_SETTINGS_FILE, ARCHIVE_STATE_DIR };

/** 默认存到用户「文档」文件夹下的 Looki（设置里能换成别的文件夹，比如网盘的同步目录，手机上也就翻得到） */
export const LOOKI_ARCHIVE_DEFAULT_FOLDER = path.join(os.homedir(), "Documents", "Looki");
/** 当天文件夹里的日记、说明（文件名定了不跟着语言变：按名字接着往里写、按名字认） */
export const JOURNAL_FILE = "日记.md"; // @i18n-ignore fixed：文件名
export const README_FILE = "说明.txt"; // @i18n-ignore fixed：文件名

/** 剩不到这么多就停下（照片一张几 MB、vlog 上百 MB，别把盘写满） */
const MIN_FREE_BYTES = 200 * 1024 * 1024;
/** 列出来的下载链接过了这么久先重新列（Looki 的链接 1 小时失效） */
const LINK_FRESH_MS = 50 * 60_000;
/** 同步后顺带存的限速了最多再试几次（照 296 的同步） */
const SYNC_RATE_RETRIES = 2;
/** 一个时刻的文件、vlog 最多翻几页 */
const MAX_PAGES = 50;
/** 没存齐的接着补多久以内的 */
const PENDING_SWEEP_DAYS = 120;

/** 整个停下（磁盘满、没权限、位置不对）：原因给人看 */
class ArchiveStop extends Error {}

/** 写文件的错（Node 的错误码）→ 停下的原因 */
function stopFor(err: unknown, file: string, root: string): ArchiveStop {
  if (err instanceof ArchiveStop) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new ArchiveStop(t("looki.archive.problem.diskFull", { dir: root }));
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new ArchiveStop(t("looki.archive.problem.noPermission", { path: file }));
  if (code === "ENAMETOOLONG") return new ArchiveStop(t("looki.archive.problem.tooLong", { path: file }));
  if (code === "EEXIST" || code === "ENOTDIR") return new ArchiveStop(t("looki.archive.problem.notFolder", { path: file }));
  return new ArchiveStop(t("looki.archive.problem.cantWrite", { path: file, reason: code ?? (err instanceof Error ? err.message : String(err)) }));
}

/** 是不是写文件的错（下载里原样抛出来的 Node 错误） */
const isFileError = (err: unknown) => err instanceof Error && !(err instanceof DownloadError) && !(err instanceof LookiError) && /^E[A-Z]+$/.test(String((err as NodeJS.ErrnoException).code ?? ""));

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 等一会儿（中止了就不等了） */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 比较路径用的写法（Windows 上不分大小写） */
const normPath = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

/** 一条路径在不在另一条里面（Windows 上不分大小写） */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normPath(parent), normPath(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 时刻开始时间里的偏移（+08:00），读文件的拍摄时间只有钟点时用 */
const offsetOf = (iso: string) => /([+-]\d{2}:\d{2}|Z)$/.exec(iso)?.[1];

/** 一篇日记在"日记.md"里的那一段 */
function journalSection(j: LookiJournalPayload): string {
  const lines = [`# ${t("looki.archive.journal.heading", { date: j.date, title: j.title !== "" ? j.title : t("looki.archive.journal.untitled") })}`, "", `> ${t("looki.archive.journal.byline", { time: clockLabel(j.time) })}`, ""];
  if (j.summary !== "" && j.summary !== j.content) lines.push(t("looki.archive.journal.summary", { summary: j.summary }), "");
  if (j.content !== "") lines.push(j.content, "");
  return lines.join("\n");
}

/** 当天的"说明.txt"：这天有哪些时刻（几点到几点、标题、地点、存了几张照片在哪个文件夹）、日记、vlog；手机上翻得懂 */
function readmeText(day: DayIndex): string {
  let weekday = "";
  try {
    weekday = weekdayName(parseLocalDate(day.date).weekday);
  } catch {
    // 日期不对：不写周几
  }
  const lines = [t("looki.archive.readme.title", { date: day.date, weekday }), ""];
  const moments = Object.values(day.moments).toSorted((a, b) => a.start.localeCompare(b.start));
  lines.push(moments.length > 0 ? t("looki.archive.readme.moments", { count: moments.length, n: moments.length }) : t("looki.archive.readme.noMoments"), "");
  for (const m of moments) {
    const span = m.end === undefined ? clockLabel(m.start) : `${clockLabel(m.start)}–${clockLabel(m.end)}`;
    lines.push(`${span}  ${m.title}`);
    if (m.place !== undefined) lines.push(`    ${t("looki.archive.readme.place", { place: m.place })}`);
    const files = Object.values(m.files);
    const photos = files.filter((f) => f.kind === "photo").length;
    const clips = files.length - photos;
    const what = [...(photos > 0 ? [t("looki.archive.readme.photos", { count: photos, n: photos })] : []), ...(clips > 0 ? [t("looki.archive.readme.clips", { count: clips, n: clips })] : [])];
    if (what.length > 0) lines.push(`    ${t("looki.archive.readme.files", { what: what.join(t("looki.archive.readme.sep")), folder: path.posix.basename(m.folder) })}`);
    if (m.pending) lines.push(`    ${t(m.attempts >= MAX_ATTEMPTS ? "looki.archive.readme.failed" : "looki.archive.readme.pending")}`);
    lines.push("");
  }
  const journals = Object.values(day.journals);
  if (journals.length > 0) lines.push(t("looki.archive.readme.journal", { file: JOURNAL_FILE, titles: journals.map((j) => j.title).filter((s) => s !== "").join(t("looki.archive.readme.sep")) }));
  for (const v of Object.values(day.vlogs)) lines.push(t("looki.archive.readme.vlog", { file: path.posix.basename(v.path) }));
  if (journals.length > 0 || Object.keys(day.vlogs).length > 0) lines.push("");
  lines.push("——", t("looki.archive.readme.footer"), "");
  return lines.join("\n");
}

/** 是不是一个认得的日期（YYYY-MM-DD） */
function isDate(d: string): boolean {
  try {
    parseLocalDate(d);
    return true;
  } catch {
    return false;
  }
}

/** 默认的磁盘剩余空间：statfs（读不出就不查） */
function defaultFreeSpace(dir: string): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/** 同步完交来的：这几天的时刻、日记（存一份用），Key 在 secrets 里 */
export interface SyncedDays {
  secrets: DataSourceSecrets;
  days: ReadonlyArray<{ date: string; moments: readonly LookiMomentPayload[] }>;
  journals: readonly LookiJournalPayload[];
  /** 这次同步的日子（含两头） */
  from: string;
  to: string;
}

export interface LookiArchiveOptions {
  /** 设置文件（配置区的 looki-archive.json） */
  settingsFile: string;
  /** 索引和状态（数据目录的 looki-archive/） */
  stateDir: string;
  /** 二狗的数据目录（位置不许放进去：会进备份快照） */
  dataDir: string;
  /** 默认位置；没有（换了接口地址的测试没给）就得用户自己填 */
  defaultFolder: string | undefined;
  /** 现在（带偏移的 ISO）、今天（本机的日期） */
  now(): string;
  today(): string;
  /** 带着 Key 建客户端（没 Key 抛 LookiError no_key） */
  client(secrets: DataSourceSecrets, signal: AbortSignal): LookiClient;
  /** 调接口碰到的错交给服务记状态（Key 不认了、限速了） */
  noteApiError(err: unknown): void;
  /** 限速了等多久（毫秒）；不给按 Retry-After，没有就 60 秒（测试调短） */
  rateLimitWaitMs?: number;
  /** 磁盘还剩多少字节（测试换成假的：模拟磁盘满）；读不出交回 undefined */
  freeSpace?: (dir: string) => number | undefined;
  /** 下载（测试可以换） */
  download?: typeof downloadTo;
  log(line: string): void;
}

export interface LookiArchive {
  /** 设置 · 数据源里那一块的数据 */
  view(): LookiArchiveView;
  /** 断开时要说的一句（开着或者存过东西时） */
  disconnectNote(): string | undefined;
  /** 存放位置（建好的）：数据源页"在电脑上打开"用；建不了抛错（原因给人看） */
  folder(): string;
  /** 填设置（values.archive 是哪一样，见协议包 looki.ts）；做不成的原因记在 view().refused */
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): void;
  /** 同步完了：这几天的照片、日记、vlog 排上队存（不等它） */
  afterSync(synced: SyncedDays): void;
  /** 断开：正在存的、补存的停下（补存停在"已暂停"），等它们停 */
  cancel(): Promise<void>;
  /** 正在做的都做完 */
  whenIdle(): Promise<void>;
}

/** 正在做的这一件 */
interface Job {
  kind: LookiArchiveWorking["kind"];
  client: LookiClient;
  signal: AbortSignal;
  root: string;
  /** 这次存下了几个文件 */
  saved: number;
}

/** 写当天的"说明.txt"（没变不写；写不进去换成 ArchiveStop） */
function writeReadme(job: Pick<Job, "root">, day: DayIndex): void {
  if (Object.keys(day.moments).length === 0 && Object.keys(day.journals).length === 0 && Object.keys(day.vlogs).length === 0) return;
  const file = absolute(job.root, `${dayFolder(day.date)}/${README_FILE}`);
  const text = readmeText(day);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  } catch (err) {
    throw stopFor(err, file, job.root);
  }
}

type Outcome = "ok" | "aborted" | "failed";

export function createLookiArchive(options: LookiArchiveOptions): LookiArchive {
  const { log } = options;
  const store = createArchiveStore({ settingsFile: options.settingsFile, stateDir: options.stateDir, log });
  const download = options.download ?? downloadTo;
  const freeSpace = options.freeSpace ?? defaultFreeSpace;
  let settings: ArchiveSettings = store.settings();
  const state: ArchiveState = store.state();
  // 守护进程重启前还在补的：停在"已暂停"（手里没有 Key，等用户点接着补）
  if (state.backfill?.state === "running") state.backfill.state = "paused";
  let problem: string | undefined;
  let refused: string | undefined;
  let working: LookiArchiveWorking | undefined;
  /** 停下正在做的（断开、关掉、换位置时置位，再换一个新的） */
  let stopper = new AbortController();
  let backfillStopper: AbortController | undefined;
  /** 一次只做一件 */
  let queue: Promise<unknown> = Promise.resolve();
  const tasks = new Set<Promise<unknown>>();

  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const track = (p: Promise<unknown>) => {
    tasks.add(p);
    void p.catch((err: unknown) => log(`Looki 存到本地出错：${describe(err)}`)).finally(() => tasks.delete(p));
  };
  const saveState = () => {
    try {
      store.saveState(state);
    } catch (err) {
      log(`Looki 存到本地的状态写不进去：${describe(err)}`);
    }
  };

  const root = (s: ArchiveSettings = settings): string => s.folder ?? options.defaultFolder ?? "";

  /** 位置建好（不在就建），交回它；不行抛 ArchiveStop */
  const ensureRoot = (s: ArchiveSettings = settings): string => {
    const dir = root(s);
    if (dir === "") throw new ArchiveStop(t("looki.archive.problem.noFolder"));
    if (isInside(dir, options.dataDir)) throw new ArchiveStop(t("looki.archive.problem.insideDataDir"));
    // 默认位置：上一级（「文档」）得在——不在说明这台电脑的用户目录不是常见的样子，不替用户凭空建一串文件夹，写明了让用户自己选位置
    if (s.folder === undefined && !fs.existsSync(path.dirname(dir))) throw new ArchiveStop(t("looki.archive.problem.noDefaultParent", { dir: path.dirname(dir) }));
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
    } catch (err) {
      throw stopFor(err, dir, dir);
    }
    return dir;
  };

  const checkFree = (dir: string) => {
    const free = freeSpace(dir);
    if (free !== undefined && free < MIN_FREE_BYTES) throw new ArchiveStop(t("looki.archive.problem.diskFull", { dir }));
  };

  /** 文件时间设成拍摄时间（设不了只记日志） */
  const setTimes = (file: string, iso: string | undefined) => {
    const ms = iso === undefined ? NaN : Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    try {
      fs.utimesSync(file, new Date(ms), new Date(ms));
    } catch (err) {
      log(`Looki 存到本地：设不了文件时间 ${file}：${describe(err)}`);
    }
  };

  /** 要存的照片、视频（按开关） */
  const wantedMedia = (): Array<"photo" | "clip"> => [...(settings.kinds.photos ? (["photo"] as const) : []), ...(settings.kinds.clips ? (["clip"] as const) : [])];
  const anyKindOn = () => LOOKI_ARCHIVE_KINDS.some((k) => settings.kinds[k]);

  /** 调一次接口：限速了等（同步后顺带存的最多两次，补存的一直等），等的时候写"限速了，等一会儿" */
  const call = async <T>(job: Job, fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LookiError && err.failure === "rate_limit" && (job.kind === "backfill" || attempt < SYNC_RATE_RETRIES)) {
          const wait = options.rateLimitWaitMs ?? err.retryAfterMs ?? LOOKI_RATE_LIMIT_WAIT_MS;
          if (working) working = { ...working, waiting: true };
          log(`Looki 存到本地限速了，等 ${Math.ceil(wait / 1000)} 秒再试`);
          await sleep(wait, job.signal);
          if (working) working = { kind: working.kind, ...(working.day === undefined ? {} : { day: working.day }) };
          continue;
        }
        throw err;
      }
    }
  };

  /** 列一个时刻的全部文件（翻页）：文件 id → 文件，连同列出来的时候（链接从这时起 1 小时失效） */
  const listFiles = async (job: Job, momentId: string, date: string, tz: string | undefined): Promise<{ files: Map<string, RemoteFile>; at: number }> => {
    const files = new Map<string, RemoteFile>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { items, next } = await call(job, () => job.client.files(momentId, cursor));
      let fresh = 0;
      for (const raw of items) {
        const f = remoteFile(raw, date, tz);
        if (f && !files.has(f.id)) {
          files.set(f.id, f);
          fresh += 1;
        }
      }
      // 没给下一页的游标、这一页又是满的：拿最后一个文件的 id 当游标（官方文档的参数叫 cursor_id）
      const last = items.at(-1) as { id?: unknown } | undefined;
      const following = next ?? (items.length >= LOOKI_FILES_PAGE && last && (typeof last.id === "string" || typeof last.id === "number") ? String(last.id) : undefined);
      if (following === undefined || fresh === 0 || seen.has(following)) break;
      seen.add(following);
      cursor = following;
    }
    return { files, at: Date.now() };
  };

  /** 下载一个链接到 file，交回多大；写不进去的错换成 ArchiveStop */
  const fetchTo = async (job: Job, url: string, file: string): Promise<number> => {
    try {
      return (await download(url, file, { signal: job.signal })).size;
    } catch (err) {
      if (isFileError(err)) throw stopFor(err, file, job.root);
      throw err;
    }
  };

  /**
   * 当天的时刻登记进索引（分好文件夹名）；开着的几类还没存齐的标"没存齐"。存之前先登记：中途停下（磁盘满、限速、位置不对）时
   * 没轮到的也记着没存齐，下次同步接着补
   */
  const register = (dir: string, day: DayIndex, moments: readonly LookiMomentPayload[]) => {
    const want = wantedMedia();
    const taken = new Set(Object.values(day.moments).map((m) => path.posix.basename(m.folder).toLowerCase()));
    for (const m of moments) {
      const known = day.moments[m.momentId];
      if (known) {
        if (!want.every((k) => known.kinds.includes(k))) known.pending = true;
        continue;
      }
      const name = momentFolderName(dir, day.date, m.start, m.title !== "" ? m.title : m.description, taken);
      taken.add(name.toLowerCase());
      day.moments[m.momentId] = {
        folder: `${dayFolder(day.date)}/${name}`,
        title: m.title !== "" ? m.title : m.description.slice(0, 60),
        start: m.start,
        ...(m.end === undefined ? {} : { end: m.end }),
        ...(m.place === undefined ? {} : { place: m.place }),
        kinds: [],
        files: {},
        pending: want.length > 0,
        attempts: 0,
      };
    }
  };

  /** 存一个时刻的照片（和开着时的原始视频）；force：试够了次数的也再试（补存、现在接着存） */
  const saveMoment = async (job: Job, day: DayIndex, momentId: string, force: boolean) => {
    const entry: MomentEntry | undefined = day.moments[momentId];
    const want = wantedMedia();
    if (!entry || want.length === 0) return;
    if (!entry.pending && want.every((k) => entry.kinds.includes(k))) return;
    if (!force && entry.attempts >= MAX_ATTEMPTS) return;
    checkFree(job.root);
    const tz = offsetOf(entry.start);
    let listing: { files: Map<string, RemoteFile>; at: number };
    try {
      listing = await listFiles(job, momentId, day.date, tz);
    } catch (err) {
      // 那边出错、连不上、回的不对：这个时刻记着没存齐，接着下一个；Key 不认、还在限速、停了的往上抛
      if (err instanceof LookiError && (err.failure === "server" || err.failure === "network" || err.failure === "response")) {
        entry.pending = true;
        entry.attempts += 1;
        log(`Looki 存到本地：时刻 ${momentId} 的文件列不出来（${err.failure}），下次接着补`);
        return;
      }
      throw err;
    }
    /** 这一份列表是不是"过期了重新列"列出来的（那样还过期就不再列了） */
    let relisted = false;
    let failed = 0;
    for (const f of listing.files.values()) {
      const kind = f.kind === "photo" ? "photo" : f.kind === "video" ? "clip" : undefined;
      if (kind === undefined || !want.includes(kind) || entry.files[f.id]) continue;
      const name = mediaFileName(f.taken ?? entry.start, f.id, extensionOf(f.url, f.kind));
      const rel = `${entry.folder}/${name}`;
      const file = absolute(job.root, rel);
      if (fs.existsSync(file)) {
        // 已经在了（索引丢了、上次存到一半）：当存过，不覆盖、不重下
        entry.files[f.id] = { path: rel, size: fs.statSync(file).size, kind };
        continue;
      }
      checkFree(job.root);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch (err) {
        throw stopFor(err, path.dirname(file), job.root);
      }
      // 列出来过了 50 分钟：先重新列一次（链接 1 小时失效）
      if (Date.now() - listing.at > LINK_FRESH_MS) {
        listing = await listFiles(job, momentId, day.date, tz);
        relisted = false;
      }
      let size: number | undefined;
      for (let attempt = 0; size === undefined; attempt += 1) {
        const url = listing.files.get(f.id)?.url;
        if (url === undefined) break;
        try {
          size = await fetchTo(job, url, file);
        } catch (err) {
          if (err instanceof ArchiveStop || job.signal.aborted) throw err;
          // 链接过期：重新列一次、拿新链接再下（这份已经是重新列的还过期就算了）
          if (err instanceof DownloadError && err.failure === "expired" && !relisted && attempt === 0) {
            log(`Looki 存到本地：时刻 ${momentId} 的下载链接过期了，重新取一次`);
            listing = await listFiles(job, momentId, day.date, tz);
            relisted = true;
            continue;
          }
          log(`Looki 存到本地：时刻 ${momentId} 的文件 ${f.id} 没下下来（${err instanceof DownloadError ? err.failure : describe(err)}），下次接着补`);
          break;
        }
      }
      if (size === undefined) {
        failed += 1;
        continue;
      }
      setTimes(file, f.taken ?? entry.start);
      entry.files[f.id] = { path: rel, size, kind };
      job.saved += 1;
    }
    if (failed === 0) {
      entry.kinds = [...new Set([...entry.kinds, ...want])];
      entry.pending = false;
      entry.attempts = 0;
    } else {
      entry.pending = true;
      entry.attempts += 1;
    }
  };

  /** 存一篇日记：接在当天的"日记.md"后面（已经在里面了的不再写） */
  const saveJournal = (job: Job, day: DayIndex, j: LookiJournalPayload) => {
    if (day.journals[j.journalId]) return;
    const rel = `${dayFolder(day.date)}/${JOURNAL_FILE}`;
    const file = absolute(job.root, rel);
    const section = journalSection(j);
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      // 还没有
    }
    const probe = (j.content !== "" ? j.content : section).slice(0, 200);
    if (existing.includes(probe)) {
      day.journals[j.journalId] = { path: rel, size: 0, title: j.title };
      return;
    }
    const text = existing === "" ? section : `\n---\n\n${section}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text, "utf8");
    } catch (err) {
      throw stopFor(err, file, job.root);
    }
    setTimes(file, j.time);
    day.journals[j.journalId] = { path: rel, size: Buffer.byteLength(text), title: j.title };
    job.saved += 1;
  };

  /** 列一段日子里的 vlog（翻页；回来的再按日期筛一遍） */
  const listVlogs = async (job: Job, from: string, to: string): Promise<RemoteVlog[]> => {
    const out = new Map<string, RemoteVlog>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { items, next } = await call(job, () => job.client.vlogs({ from, to }, cursor));
      for (const raw of items) {
        const v = remoteVlog(raw);
        if (v && v.date >= from && v.date <= to && !out.has(v.id)) out.set(v.id, v);
      }
      if (next === undefined || seen.has(next) || items.length === 0) break;
      seen.add(next);
      cursor = next;
    }
    return [...out.values()];
  };

  /** 存一段日子里的 vlog（vlog 的接口官方文档没写全：回的不对、那边出错只记日志，不耽误照片） */
  const saveVlogs = async (job: Job, from: string, to: string) => {
    if (!settings.kinds.vlogs) return;
    let vlogs: RemoteVlog[];
    try {
      vlogs = await listVlogs(job, from, to);
    } catch (err) {
      if (err instanceof LookiError && (err.failure === "response" || err.failure === "server" || err.failure === "network")) {
        log(`Looki 存到本地：vlog 没列出来（${err.failure}：${err.message}），下次再试`);
        return;
      }
      throw err;
    }
    for (const v of vlogs) {
      const day = store.day(v.date);
      if (day.vlogs[v.id]) continue;
      if (working) working = { kind: working.kind, day: v.date };
      const taken = new Set(Object.values(day.vlogs).map((x) => path.posix.basename(x.path).toLowerCase()));
      const name = vlogFileName(job.root, v.date, v.title, extensionOf(v.file.url, "video"), taken);
      const rel = `${dayFolder(v.date)}/${name}`;
      const file = absolute(job.root, rel);
      let size: number | undefined;
      if (fs.existsSync(file)) size = fs.statSync(file).size;
      else {
        checkFree(job.root);
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
        } catch (err) {
          throw stopFor(err, path.dirname(file), job.root);
        }
        let url: string | undefined = v.file.url;
        for (let attempt = 0; size === undefined && url !== undefined; attempt += 1) {
          try {
            size = await fetchTo(job, url, file);
          } catch (err) {
            if (err instanceof ArchiveStop || job.signal.aborted) throw err;
            if (err instanceof DownloadError && err.failure === "expired" && attempt === 0) {
              log(`Looki 存到本地：vlog ${v.id} 的下载链接过期了，重新取一次`);
              url = (await listVlogs(job, v.date, v.date)).find((x) => x.id === v.id)?.file.url;
              continue;
            }
            log(`Looki 存到本地：vlog ${v.id} 没下下来（${err instanceof DownloadError ? err.failure : describe(err)}），下次再试`);
            break;
          }
        }
        if (size === undefined) continue;
        setTimes(file, v.time ?? v.file.taken);
        job.saved += 1;
      }
      day.vlogs[v.id] = { path: rel, size, title: v.title };
      store.saveDay(day);
      writeReadme(job, day);
    }
  };

  /** 存一天的日记（快、只写字：放在照片前面，照片存到一半停下了日记也已经在了） */
  const saveJournals = (job: Job, date: string, journals: readonly LookiJournalPayload[]) => {
    const mine = journals.filter((j) => j.date === date);
    if (!settings.kinds.journals || mine.length === 0) return;
    const day = store.day(date);
    for (const j of mine) saveJournal(job, day, j);
    store.saveDay(day);
    writeReadme(job, day);
  };

  /** 存一天的时刻（照片、视频）；force：试够了次数的也再试 */
  const saveMoments = async (job: Job, date: string, moments: readonly LookiMomentPayload[], force: boolean) => {
    if (moments.length === 0) return;
    if (working) working = { kind: working.kind, day: date };
    const day = store.day(date);
    register(job.root, day, moments);
    store.saveDay(day);
    for (const m of moments) {
      await saveMoment(job, day, m.momentId, force);
      store.saveDay(day);
    }
    writeReadme(job, day);
  };

  /** 没存齐的接着补（不在 exclude 里的日子，新的先；includeFailed：试够了次数的也再试） */
  const retryPending = async (job: Job, exclude: ReadonlySet<string>, includeFailed: boolean) => {
    const cutoff = addDays(options.today(), -PENDING_SWEEP_DAYS);
    const days = [...store.summaries().entries()].filter(([date, s]) => !exclude.has(date) && date >= cutoff && (s.pending.length > 0 || (includeFailed && s.failed.length > 0)));
    for (const [date, s] of days.toSorted(([a], [b]) => b.localeCompare(a))) {
      if (working) working = { kind: working.kind, day: date };
      const day = store.day(date);
      for (const id of includeFailed ? [...s.pending, ...s.failed] : s.pending) {
        await saveMoment(job, day, id, includeFailed);
        store.saveDay(day);
      }
      writeReadme(job, day);
    }
  };

  /**
   * 做一件（排着队）：prepare 先做（建位置之前：登记要存的时刻，停下了也记着没存齐），再建好位置、看磁盘剩多少、带着 Key 建客户端；
   * 停下的原因记进 problem；做完了 problem 清掉
   */
  const runJob = async (
    kind: Job["kind"],
    secrets: DataSourceSecrets,
    signal: AbortSignal,
    body: (job: Job) => Promise<void>,
    prepare?: (dir: string) => void,
  ): Promise<{ outcome: Outcome; saved: number }> => {
    if (signal.aborted) return { outcome: "aborted", saved: 0 };
    working = { kind };
    let job: Job | undefined;
    try {
      if (prepare && root() !== "") prepare(root());
      const dir = ensureRoot();
      checkFree(dir);
      job = { kind, client: options.client(secrets, signal), signal, root: dir, saved: 0 };
      await body(job);
      problem = undefined;
      return { outcome: "ok", saved: job.saved };
    } catch (err) {
      if (signal.aborted) return { outcome: "aborted", saved: job?.saved ?? 0 };
      if (err instanceof ArchiveStop) problem = err.message;
      else if (err instanceof LookiError) {
        options.noteApiError(err);
        problem = err.failure === "rate_limit" ? t("looki.archive.problem.rateLimit") : t("looki.archive.problem.api", { reason: err.message });
      } else problem = t("looki.archive.problem.api", { reason: describe(err) });
      log(`Looki 存到本地停下了：${problem}`);
      return { outcome: "failed", saved: job?.saved ?? 0 };
    } finally {
      working = undefined;
      if (job && job.saved > 0) {
        state.lastSavedAt = options.now();
        saveState();
        log(`Looki 存到本地（${kind}）：存下 ${job.saved} 个文件`);
      }
    }
  };

  /** 补存：从 next 往回一天一天来（一天一批，排在别的后面），停了、断开了、出错了停下 */
  const runBackfill = (secrets: DataSourceSecrets) => {
    const bf = state.backfill;
    if (!bf) return;
    const controller = new AbortController();
    backfillStopper = controller;
    const signal = AbortSignal.any([stopper.signal, controller.signal]);
    bf.state = "running";
    saveState();
    track(
      (async () => {
        while (bf.state === "running" && bf.next !== undefined) {
          const date = bf.next;
          const { outcome, saved } = await exclusive(() =>
            runJob("backfill", secrets, signal, async (job) => {
              if (working) working = { kind: "backfill", day: date };
              const moments = (await call(job, () => job.client.moments(date))).flatMap((raw) => momentRecord(raw) ?? []);
              let journals: LookiJournalPayload[] = [];
              if (settings.kinds.journals) {
                try {
                  journals = journalRecords(await call(job, () => job.client.journals(date, 1))).filter((j) => j.date === date);
                } catch (err) {
                  if (!(err instanceof LookiError && err.failure === "response")) throw err;
                  log(`Looki 存到本地：${date} 的日记没拉成（当没有）：${err.message}`);
                }
              }
              saveJournals(job, date, journals);
              await saveMoments(job, date, moments, true);
              await saveVlogs(job, date, date);
            }),
          );
          bf.files += saved;
          if (outcome !== "ok") {
            // 用户点了停：停在"已停下"；断开、关掉、换位置、出错：停在"已暂停"
            if (bf.state === "running") bf.state = controller.signal.aborted ? "stopped" : "paused";
            break;
          }
          bf.doneDays += 1;
          const prev = addDays(date, -1);
          if (prev < bf.from) delete bf.next;
          else bf.next = prev;
          saveState();
        }
        if (bf.state === "running" && bf.next === undefined) bf.state = "done";
        if (backfillStopper === controller) backfillStopper = undefined;
        saveState();
      })(),
    );
  };

  /** 停下正在做的（不等）：补存停在"已暂停" */
  const abortRunning = () => {
    stopper.abort();
    stopper = new AbortController();
    if (state.backfill?.state === "running") {
      state.backfill.state = "paused";
      saveState();
    }
  };

  const whenIdle = async () => {
    while (tasks.size > 0) await Promise.allSettled(tasks);
  };

  /** 改设置：开没开、位置、几类开关；位置先建一下，写不进去就不改 */
  const applySettings = (values: Readonly<Record<string, string>>) => {
    const next: ArchiveSettings = { ...settings, kinds: { ...settings.kinds } };
    if (values.on !== undefined) next.on = values.on === "true";
    for (const k of LOOKI_ARCHIVE_KINDS) if (values[k] !== undefined) next.kinds[k] = values[k] === "true";
    if (values.folder !== undefined) {
      const typed = values.folder.trim().replace(/^"(.*)"$/, "$1").trim();
      if (typed === "" || (options.defaultFolder !== undefined && path.resolve(typed).toLowerCase() === path.resolve(options.defaultFolder).toLowerCase())) delete next.folder;
      else if (!path.isAbsolute(typed) || (process.platform === "win32" && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(typed))) {
        refused = t("looki.archive.refused.notAbsolute");
        return;
      } else next.folder = path.resolve(typed);
      try {
        ensureRoot(next);
      } catch (err) {
        refused = err instanceof ArchiveStop ? err.message : describe(err);
        return;
      }
    }
    const moved = root(next) !== root(settings);
    if ((settings.on && !next.on) || moved) abortRunning();
    settings = next;
    store.saveSettings(next);
    if (moved || next.on) problem = undefined;
    log(`Looki 存到本地的设置改了：${next.on ? "开" : "关"}，${next.folder === undefined ? "默认位置" : "自己选的位置"}，${LOOKI_ARCHIVE_KINDS.filter((k) => next.kinds[k]).join("、") || "什么都不存"}`);
  };

  /** 开始补存（from、to 不给：最近 30 天到昨天） */
  const startBackfill = (values: Readonly<Record<string, string>>, secrets: DataSourceSecrets) => {
    if (!secrets.has("key")) return void (refused = t("looki.archive.refused.notConnected"));
    if (!settings.on) return void (refused = t("looki.archive.refused.off"));
    if (state.backfill?.state === "running") return void (refused = t("looki.archive.refused.busy"));
    const yesterday = addDays(options.today(), -1);
    const to = values.to?.trim() || yesterday;
    const from = values.from?.trim() || addDays(options.today(), -LOOKI_BACKFILL_DEFAULT_DAYS);
    if (!isDate(from) || !isDate(to) || from > to || to > yesterday) return void (refused = t("looki.archive.refused.badRange"));
    const total = daysBetween(from, to).length;
    if (total > LOOKI_BACKFILL_MAX_DAYS) return void (refused = t("looki.archive.refused.tooLong", { days: LOOKI_BACKFILL_MAX_DAYS }));
    state.backfill = { from, to, next: to, doneDays: 0, totalDays: total, state: "running", files: 0 };
    log(`Looki 存到本地：开始补存 ${from} 到 ${to}（${total} 天）`);
    runBackfill(secrets);
  };

  return {
    view() {
      const totals = store.totals();
      return {
        on: settings.on,
        folder: root(),
        defaultFolder: options.defaultFolder ?? "",
        kinds: { ...settings.kinds },
        saved: { photos: totals.photos, clips: totals.clips, journals: totals.journals, vlogs: totals.vlogs, bytes: totals.bytes, days: totals.days },
        ...(state.lastSavedAt === undefined ? {} : { lastSavedAt: state.lastSavedAt }),
        ...(working === undefined ? {} : { working: { ...working } }),
        ...(problem === undefined ? {} : { problem }),
        ...(refused === undefined ? {} : { refused }),
        pending: totals.pending,
        failed: totals.failed,
        ...(state.backfill === undefined ? {} : { backfill: { ...state.backfill } }),
      };
    },

    disconnectNote() {
      const totals = store.totals();
      const files = totals.photos + totals.clips + totals.journals + totals.vlogs;
      if (!settings.on && files === 0) return undefined;
      return t("looki.archive.disconnectNote", { folder: root() });
    },

    folder: () => ensureRoot(),

    configure(values, secrets) {
      refused = undefined;
      switch (values.archive) {
        case "settings":
          applySettings(values);
          return;
        case "backfill":
          startBackfill(values, secrets);
          return;
        case "stop":
          if (state.backfill?.state !== "running") return void (refused = t("looki.archive.refused.nothing"));
          state.backfill.state = "stopped";
          saveState();
          backfillStopper?.abort();
          log("Looki 存到本地：补存停下了");
          return;
        case "resume":
          if (!state.backfill || state.backfill.next === undefined || state.backfill.state === "running") return void (refused = t("looki.archive.refused.nothing"));
          if (!secrets.has("key")) return void (refused = t("looki.archive.refused.notConnected"));
          if (!settings.on) return void (refused = t("looki.archive.refused.off"));
          log(`Looki 存到本地：接着补存（从 ${state.backfill.next} 往回）`);
          runBackfill(secrets);
          return;
        case "retry": {
          if (!secrets.has("key")) return void (refused = t("looki.archive.refused.notConnected"));
          if (!settings.on) return void (refused = t("looki.archive.refused.off"));
          problem = undefined;
          const signal = stopper.signal;
          track(exclusive(() => runJob("retry", secrets, signal, (job) => retryPending(job, new Set(), true))));
          return;
        }
        default:
          refused = t("looki.archive.refused.unknown");
      }
    },

    afterSync(synced) {
      if (!settings.on || !anyKindOn()) return;
      const signal = stopper.signal;
      const dates = new Set(synced.days.map((d) => d.date));
      track(
        exclusive(() =>
          runJob(
            "sync",
            synced.secrets,
            signal,
            async (job) => {
              for (const date of dates) saveJournals(job, date, synced.journals);
              for (const { date, moments } of synced.days) await saveMoments(job, date, moments, false);
              await saveVlogs(job, synced.from, synced.to);
              await retryPending(job, dates, false);
            },
            // 先把这几天的时刻都登记上：存到一半停下了，没轮到的下次同步接着补
            (dir) => {
              for (const { date, moments } of synced.days) {
                if (moments.length === 0) continue;
                const day = store.day(date);
                register(dir, day, moments);
                store.saveDay(day);
              }
            },
          ),
        ),
      );
    },

    async cancel() {
      abortRunning();
      await whenIdle();
    },

    whenIdle,
  };
}
