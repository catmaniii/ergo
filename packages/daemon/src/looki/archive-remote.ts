// "存一份到本地"（307 号票）读 Looki 回来的文件、vlog：官方文档（调研 38 的 1.3 节）列了字段名，没写清的几处这里宽松地读，等用户拿到 Key
// 真机核对（307 号票 Comments 列着）——
// - 文件（GET /moments/{id}/files）：id、media_type（IMAGE / VIDEO / AUDIO）、temporary_url（预签名链接，1 小时失效）、created_at、
//   size、duration、location。id 也认 file_id；链接也认 url / download_url / file_url；种类也认 type / file_type / mime_type（image/jpeg），
//   都没有按链接的扩展名猜；拍摄时间也认 taken_at / captured_at / shot_at / recorded_at / timestamp，按时刻的时区读（records.ts 的 lookiTime）；
//   没有 id 的拿链接路径（不含签名）的哈希当 id；
// - vlog（GET /for_you/items?group=vlog）：id、type（DAILY_VLOG）、title、日期（date / recorded_date / record_date，没有取 recorded_at /
//   created_at 那天）、文件（files / media 数组，或者 file / video 一个，或者条目上直接一个 temporary_url / video_url）。
//   type 写着别的（不含 VLOG）的不要。
import { createHash } from "node:crypto";
import { lookiTime } from "./records.ts";

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

/** 一个文件 → 读好的样子；没有链接、认不出种类的不要。date、tz：时刻的日期和时区（偏移），拍摄时间只有钟点时用 */
export function remoteFile(raw: unknown, date?: string, tz?: string): RemoteFile | undefined {
  if (!isRecord(raw)) return undefined;
  const url = [raw.temporary_url, raw.url, raw.download_url, raw.file_url, raw.presigned_url, raw.video_url].map((v) => textOf(v, 4000)).find((v) => v !== undefined);
  if (url === undefined) return undefined;
  const kind = kindOf(raw, url);
  if (kind === undefined) return undefined;
  let id = idOf(raw.id ?? raw.file_id ?? raw.uuid);
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
  const taken = lookiTime(raw.created_at ?? raw.taken_at ?? raw.captured_at ?? raw.shot_at ?? raw.recorded_at ?? raw.timestamp, date, tz);
  return { id, kind, url, ...(taken === undefined ? {} : { taken }) };
}

/** 一个 vlog 条目 → 读好的样子；不是 vlog、没有 id、没有日期、没有能下的视频的不要 */
export function remoteVlog(raw: unknown): RemoteVlog | undefined {
  if (!isRecord(raw)) return undefined;
  const type = textOf(raw.type, 60);
  if (type !== undefined && !/vlog/i.test(type)) return undefined;
  const id = idOf(raw.id ?? raw.item_id);
  if (id === undefined) return undefined;
  const tz = textOf(raw.tz ?? raw.timezone, 64);
  const time = lookiTime(raw.recorded_at ?? raw.created_at, undefined, tz);
  const day = [raw.date, raw.recorded_date, raw.record_date].map((v) => textOf(v, 10)).find((v) => v !== undefined && DATE.test(v));
  const date = day ?? time?.slice(0, 10);
  if (date === undefined) return undefined;
  const candidates: unknown[] = [];
  for (const v of [raw.files, raw.media]) if (Array.isArray(v)) candidates.push(...v);
  for (const v of [raw.file, raw.video]) if (isRecord(v)) candidates.push(v);
  if (textOf(raw.temporary_url) !== undefined || textOf(raw.video_url) !== undefined) candidates.push({ id: `${id}-video`, media_type: "VIDEO", temporary_url: raw.temporary_url ?? raw.video_url, created_at: raw.recorded_at ?? raw.created_at });
  const files = candidates.flatMap((c) => remoteFile(c, date, tz) ?? []);
  const file = files.find((f) => f.kind === "video");
  if (!file) return undefined;
  return { id, date, title: textOf(raw.title, 200) ?? "", file, ...(time === undefined ? {} : { time }) };
}
