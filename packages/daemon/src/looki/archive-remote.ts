// "存一份到本地"读 Looki 回来的文件、vlog：官方文档（调研 38 的 1.3 节；2026-11 再对过公开的 SKILL.md，424 号票）列了字段名，
// 没写清的几处这里宽松地读，等用户拿真 Key 核对——
// - 文件：id、media_type（IMAGE / VIDEO / AUDIO）、temporary_url（预签名链接，1 小时失效）、created_at、size、duration、location。
//   id 也认 file_id；链接也认 url / download_url / file_url；种类也认 type / file_type / mime_type（image/jpeg），都没有按链接的扩展名猜；
//   拍摄时间也认 taken_at / captured_at / shot_at / recorded_at / timestamp，按时刻的时区读（records.ts 的 lookiTime）；
//   没有 id 的拿链接路径（不含签名）的哈希当 id。
//   文件本身也可能包在一层里：现在的官方文档里时刻的文件（MomentFileModel）是 { id, file: FileModel, thumbnail, location, created_at, tz }，
//   日记的媒体（JournalMediaItemModel）是 { source: FileModel, thumbnail }；FileModel 只有 temporary_url、media_type、size、duration_ms，
//   没有 id。链接、种类先看自己这一层，没有再看 file / source 里的；缩略图（thumbnail）一概不当文件。
// - vlog：2026-11 起 /for_you/items 停用（回 400、code 105，"Please use GET /journals instead"），vlog 是 /journals 里
//   种类为 DAILY_VLOG 的条目（第三方 looki-mcp 实测的种类表里有 DAILY_VLOG，官方文档只举了 DIARY 的例子）：
//   id（UUID）、type、title、description（没有 content）、media_items、date、start_date、tz（+08:00）、recorded_at、created_at；
//   视频在 media_items 里 source 是 VIDEO 的那个（官方没有 vlog 的样例，假设），封面在 thumbnail 里（不存）。
//   日期取条目的 date，没有取组上的 date，再没有取 recorded_at / created_at 那天；
//   以前 for_you 的写法（files / media 数组，file / video 一个，条目上直接一个 temporary_url / video_url）照样认。
//   type 里没有 VLOG 的不要（日记里还有 DIARY、COMIC_PAGE 这些，带的是图片）。
import { createHash } from "node:crypto";
import { isVlogKind, lookiTime } from "./records.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function textOf(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s.length === 0 ? undefined : s.slice(0, max);
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return textOf(value, 200);
}

/** 一个文件的种类 */
export type RemoteKind = "photo" | "video" | "audio";

/** Looki 的一个文件（照片、视频、录音） */
export interface RemoteFile {
  id: string;
  kind: RemoteKind;
  /** 下载链接（1 小时失效） */
  url: string;
  /** 拍摄时间（带偏移的 ISO）；读不出没有 */
  taken?: string;
}

/** Looki 的一个 vlog */
export interface RemoteVlog {
  /** 日记条目的 id（以前 for_you 条目的 id） */
  id: string;
  date: string;
  title: string;
  file: RemoteFile;
  /** 录制 / 生成的时间（文件时间用） */
  time?: string;
}

const KINDS: Readonly<Record<string, RemoteKind>> = { image: "photo", photo: "photo", picture: "photo", img: "photo", video: "video", movie: "video", clip: "video", audio: "audio", voice: "audio", sound: "audio" };
const EXT_KINDS: Readonly<Record<string, RemoteKind>> = { jpg: "photo", jpeg: "photo", png: "photo", heic: "photo", heif: "photo", webp: "photo", gif: "photo", mp4: "video", mov: "video", webm: "video", m4v: "video", mp3: "audio", m4a: "audio", aac: "audio", wav: "audio" };

/** 种类：IMAGE、image/jpeg、photo 都认；认不出按链接的扩展名猜 */
function kindOf(raw: Record<string, unknown>, url: string): RemoteKind | undefined {
  for (const v of [raw.media_type, raw.type, raw.file_type, raw.mime_type, raw.content_type]) {
    if (typeof v !== "string") continue;
    const word = v.trim().toLowerCase().split("/")[0]!;
    if (KINDS[word]) return KINDS[word];
  }
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext && EXT_KINDS[ext]) return EXT_KINDS[ext];
  } catch {
    // 不是地址
  }
  return undefined;
}

/** 一层上的下载链接 */
const urlOf = (raw: Record<string, unknown>) => [raw.temporary_url, raw.url, raw.download_url, raw.file_url, raw.presigned_url, raw.video_url].map((v) => textOf(v, 4000)).find((v) => v !== undefined);

/** 一个文件 → 读好的样子；没有链接、认不出种类的不要。date、tz：时刻的日期和时区（偏移），拍摄时间只有钟点时用 */
export function remoteFile(raw: unknown, date?: string, tz?: string): RemoteFile | undefined {
  if (!isRecord(raw)) return undefined;
  // 自己这一层没有链接：文件包在 file（时刻的文件）或 source（日记的媒体）里
  const own = urlOf(raw);
  const inner = own === undefined ? [raw.file, raw.source].find((v): v is Record<string, unknown> => isRecord(v) && urlOf(v) !== undefined) : undefined;
  const body = inner ?? raw;
  const url = own ?? (inner === undefined ? undefined : urlOf(inner));
  if (url === undefined) return undefined;
  const kind = kindOf(body, url) ?? (inner === undefined ? undefined : kindOf(raw, url));
  if (kind === undefined) return undefined;
  let id = idOf(raw.id ?? raw.file_id ?? raw.uuid ?? body.id ?? body.file_id);
  if (id === undefined) {
    let stable = url;
    try {
      const u = new URL(url);
      stable = `${u.host}${u.pathname}`;
    } catch {
      // 原样
    }
    id = `u${createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
  }
  const zone = textOf(raw.tz ?? raw.timezone, 64) ?? tz;
  const taken = lookiTime(raw.created_at ?? raw.taken_at ?? raw.captured_at ?? raw.shot_at ?? raw.recorded_at ?? raw.timestamp ?? body.created_at, date, zone);
  return { id, kind, url, ...(taken === undefined ? {} : { taken }) };
}

/** 一个 vlog 条目（日记条目，或者以前 for_you 的条目）→ 读好的样子；种类不是 vlog、没有 id、没有日期、没有能下的视频的不要。groupDate：按天分组时组上的日期 */
export function remoteVlog(raw: unknown, groupDate?: string): RemoteVlog | undefined {
  if (!isRecord(raw)) return undefined;
  const type = textOf(raw.type, 60);
  if (!isVlogKind(type)) return undefined;
  const id = idOf(raw.id ?? raw.journal_id ?? raw.item_id);
  if (id === undefined) return undefined;
  const tz = textOf(raw.tz ?? raw.timezone, 64);
  const time = lookiTime(raw.recorded_at ?? raw.created_at, undefined, tz);
  const day = [raw.date, raw.recorded_date, raw.record_date, groupDate].map((v) => textOf(v, 10)).find((v) => v !== undefined && DATE.test(v));
  const date = day ?? time?.slice(0, 10);
  if (date === undefined) return undefined;
  const candidates: unknown[] = [];
  for (const v of [raw.media_items, raw.files, raw.media]) if (Array.isArray(v)) candidates.push(...v);
  for (const v of [raw.file, raw.video]) if (isRecord(v)) candidates.push(v);
  if (textOf(raw.temporary_url) !== undefined || textOf(raw.video_url) !== undefined) candidates.push({ id: `${id}-video`, media_type: "VIDEO", temporary_url: raw.temporary_url ?? raw.video_url, created_at: raw.recorded_at ?? raw.created_at });
  const files = candidates.flatMap((c) => remoteFile(c, date, tz) ?? []);
  const file = files.find((f) => f.kind === "video");
  if (!file) return undefined;
  return { id, date, title: textOf(raw.title, 200) ?? "", file, ...(time === undefined ? {} : { time }) };
}

/** /journals 的回包（按天分组：{ date, start_date, journals: [...] }）→ 里面的 vlog（同一个 id 只要一次） */
export function journalVlogs(list: readonly unknown[]): RemoteVlog[] {
  const out = new Map<string, RemoteVlog>();
  const visit = (value: unknown, date: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, date);
      return;
    }
    if (!isRecord(value)) return;
    const own = textOf(value.date, 10);
    const groupDate = own !== undefined && DATE.test(own) ? own : date;
    // 一组（没有自己的 id、底下是一串日记）：往下找
    const nested = [value.journals, value.items, value.entries, value.list].find(Array.isArray);
    if (nested !== undefined && idOf(value.id ?? value.journal_id) === undefined) return visit(nested, groupDate);
    const v = remoteVlog(value, date);
    if (v && !out.has(v.id)) out.set(v.id, v);
  };
  visit(list, undefined);
  return [...out.values()];
}
