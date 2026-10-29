// Looki 回包 → 插件自己的记录（296 号票）：一个时刻一条 looki_moment、一篇 AI 日记一条 looki_journal（负载见 api.ts）。
// 官方文档（调研 38 的 1.3 节）列了字段名，没写清的几处这里宽松地读，等用户拿到 Key 真机核对（296 号票 Comments 列着）：
// - 时间：start_time / end_time 可能是带偏移的 ISO、不带偏移的日期时间、只有钟点（拼上 date）、epoch 秒或毫秒；时区按 tz（IANA 名字或 +08:00），
//   认不出用本机的；一律写成带偏移的 ISO（和协议时间一样到毫秒）；
// - 地点：文档里地点写在文件上（location，"地点描述"），时刻上有没有没写——先取时刻上的（location / place / address），没有取封面文件上的；
//   只认给人看的名字，光是经纬度的不要（scene.place 是给人看的地点）；
// - 媒体：media_types 可能是 ["IMAGE", "VIDEO"] 也可能是计数，只记有没有照片、视频、录音；照片视频本身、封面、预签名链接一概不存；
// - 日记：/journals 按天分组，组里的字段名没写，按"有 content / description 的是一篇"找；日期取组上的、日记上的 date，没有才取 recorded_at 那天。
// 文字一律截到上限（标题 200、描述 2000、日记全文 20000 字），没有标题也没有描述的时刻、没有开始时间的时刻不要。
import { localDate } from "@ergo/protocol";
import type { LookiJournalPayload, LookiMediaKind, LookiMomentPayload } from "./api.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pad = (n: number) => String(n).padStart(2, "0");

/** 一段文字（去掉首尾空白、截短）；不是文字或空的是 undefined */
function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s.length === 0 ? undefined : s.slice(0, max);
}

/** id：字符串或数字 */
function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return textOf(value, 200);
}

/** 毫秒 + 偏移（分钟）→ 带偏移的 ISO（YYYY-MM-DDTHH:mm:ss.sss+08:00） */
export function isoWithOffset(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 23);
  const abs = Math.abs(offsetMinutes);
  return `${local}${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 时区（IANA 名字，或者 +08:00、UTC+8 这种）在某一刻的偏移（分钟）；认不出是 undefined */
export function zoneOffset(tz: string | undefined, ms: number): number | undefined {
  if (tz === undefined) return undefined;
  const s = tz.trim();
  if (/^(UTC|GMT|Z)$/i.test(s)) return 0;
  const fixed = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (fixed) return (fixed[1] === "-" ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0));
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: s, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const offset = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
    return Number.isFinite(offset) ? offset : undefined;
  } catch {
    return undefined;
  }
}

/** 某个时区里的墙上时间 → 毫秒（时区认不出按本机） */
function wallToMs(wall: readonly [number, number, number, number, number, number, number], tz: string | undefined): number {
  const [y, mo, d, h, mi, s, ms] = wall;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const first = zoneOffset(tz, asUtc);
  if (first === undefined) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const guess = asUtc - first * 60_000;
  const second = zoneOffset(tz, guess);
  return second === undefined || second === first ? guess : asUtc - second * 60_000;
}

/** epoch 秒或毫秒 → 毫秒 */
const fromEpoch = (n: number) => (n > 1e12 ? n : n * 1000);

/**
 * Looki 给的一个时间 → 带偏移的 ISO：epoch 秒或毫秒、带偏移或 Z 的 ISO、不带偏移的日期时间、只有钟点（拼上 date）。
 * 偏移按 tz 写（认不出用本机的）；读不出是 undefined
 */
export function lookiTime(value: unknown, date: string | undefined, tz: string | undefined): string | undefined {
  let ms: number | undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) ms = fromEpoch(value);
  else if (typeof value === "string" && value.trim().length > 0) {
    const s = value.trim();
    const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    const day = date !== undefined ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
    if (/^\d+(\.\d+)?$/.test(s)) ms = fromEpoch(Number(s));
    else if (full && full[8] !== undefined) {
      const parsed = Date.parse(s.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      if (Number.isFinite(parsed)) ms = parsed;
    } else if (full) ms = wallToMs([Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4]), Number(full[5]), Number(full[6] ?? 0), Number((full[7] ?? "0").padEnd(3, "0"))], tz);
    else if (clock && day) ms = wallToMs([Number(day[1]), Number(day[2]), Number(day[3]), Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0], tz);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return isoWithOffset(ms, zoneOffset(tz, ms) ?? -new Date(ms).getTimezoneOffset());
}

/** 光是经纬度（"39.99,116.48"，逗号可以是全角的） */
const COORDINATES = /^\s*-?\d+(\.\d+)?\s*[,\uFF0C]\s*-?\d+(\.\d+)?\s*$/;

/** 一个地点字段给人看的名字：字符串，或者对象里的 name / address / display_name……；光是经纬度的不要 */
function placeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const s = textOf(value, 120);
    return s === undefined || COORDINATES.test(s) ? undefined : s;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["name", "display_name", "formatted_address", "address", "title", "description", "poi"]) {
    const s = placeText(value[key]);
    if (s !== undefined) return s;
  }
  return undefined;
}

/** 时刻的地点：时刻上的，没有取封面文件上的 */
function placeOf(raw: Record<string, unknown>): string | undefined {
  const cover = [raw.cover_file, raw.cover, raw.cover_image].find(isRecord);
  for (const candidate of [raw.location, raw.place, raw.address, raw.location_name, raw.poi, cover?.location, cover?.address, cover?.location_name]) {
    const s = placeText(candidate);
    if (s !== undefined) return s;
  }
  return undefined;
}

const MEDIA: Readonly<Record<string, LookiMediaKind>> = { image: "photo", photo: "photo", picture: "photo", video: "video", audio: "audio", voice: "audio" };

/** 有哪些媒体：["IMAGE","VIDEO"]、{ IMAGE: 3 }、"VIDEO" 都认 */
function mediaOf(value: unknown): LookiMediaKind[] {
  const names = Array.isArray(value) ? value : isRecord(value) ? Object.entries(value).flatMap(([k, v]) => (typeof v === "number" ? (v > 0 ? [k] : []) : v ? [k] : [])) : value === undefined ? [] : [value];
  const kinds = names.flatMap((n) => {
    const kind = typeof n === "string" ? MEDIA[n.trim().toLowerCase()] : undefined;
    return kind ? [kind] : [];
  });
  return (["photo", "video", "audio"] as const).filter((k) => kinds.includes(k));
}

/** 一个时刻 → 记录；没有 id、没有开始时间、标题描述都没有的不要 */
export function momentRecord(raw: unknown): LookiMomentPayload | undefined {
  if (!isRecord(raw)) return undefined;
  const momentId = idOf(raw.id ?? raw.moment_id);
  if (momentId === undefined) return undefined;
  const title = textOf(raw.title, 200) ?? "";
  const description = textOf(raw.description ?? raw.summary, 2000) ?? "";
  if (title === "" && description === "") return undefined;
  const tz = textOf(raw.tz ?? raw.timezone ?? raw.time_zone, 64);
  const day = textOf(raw.date, 10);
  const date = day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  const start = lookiTime(raw.start_time ?? raw.started_at ?? raw.start, date, tz);
  if (start === undefined) return undefined;
  const endAt = lookiTime(raw.end_time ?? raw.ended_at ?? raw.end, date, tz);
  const end = endAt !== undefined && Date.parse(endAt) >= Date.parse(start) ? endAt : undefined;
  const place = placeOf(raw);
  const media = mediaOf(raw.media_types ?? raw.media_type ?? raw.media);
  return {
    momentId,
    date: date ?? start.slice(0, 10),
    start,
    ...(end === undefined ? {} : { end }),
    title,
    description,
    ...(place === undefined ? {} : { place }),
    ...(media.length === 0 ? {} : { media }),
    text: [title, description].filter((s) => s.length > 0).join("\n"),
  };
}

/** 一篇日记 → 记录（groupDate：按天分组时组上的日期）；没有 id、一个字都没有的不要 */
export function journalRecord(raw: unknown, groupDate?: string): LookiJournalPayload | undefined {
  if (!isRecord(raw)) return undefined;
  const journalId = idOf(raw.id ?? raw.journal_id);
  if (journalId === undefined) return undefined;
  const title = textOf(raw.title, 200) ?? "";
  const summary = textOf(raw.description ?? raw.summary, 2000) ?? "";
  const content = textOf(raw.content ?? raw.text ?? raw.body, 20_000) ?? "";
  if (title === "" && summary === "" && content === "") return undefined;
  const tz = textOf(raw.tz ?? raw.timezone, 64);
  const day = [textOf(raw.date, 10), groupDate].find((d) => d !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const time = lookiTime(raw.recorded_at ?? raw.created_at ?? raw.time, day, tz) ?? (day === undefined ? undefined : lookiTime(`${day}T00:00:00`, day, tz));
  if (time === undefined) return undefined;
  const date = day ?? time.slice(0, 10);
  const kind = textOf(raw.type, 40);
  // 素材的说明：一看就知道是 Looki 写的（不写死哪种语言的字：采集规则要确定性）
  const label = `Looki · ${title === "" ? date : title}`;
  const brief = summary !== "" ? summary : content.slice(0, 300);
  return { journalId, date, time, ...(kind === undefined ? {} : { kind }), title, summary, content, text: [label, brief].filter((s) => s.length > 0).join("\n") };
}

/** /journals 的回包（按天分组）→ 一篇篇日记：组是 { date, journals: [...] } 这类，有 content / description 的是一篇 */
export function journalRecords(list: readonly unknown[]): LookiJournalPayload[] {
  const out: LookiJournalPayload[] = [];
  const visit = (value: unknown, date: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, date);
      return;
    }
    if (!isRecord(value)) return;
    const own = textOf(value.date, 10);
    const groupDate = own !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(own) ? own : date;
    const isJournal = typeof value.content === "string" || typeof value.description === "string" || typeof value.summary === "string";
    const nested = ["journals", "items", "entries", "list", "data"].map((k) => value[k]).find(Array.isArray);
    if (!isJournal && nested !== undefined) return visit(nested, groupDate);
    const record = journalRecord(value, groupDate);
    if (record) out.push(record);
  };
  visit(list, undefined);
  return out;
}

/** 某一刻在本机是哪一天 */
export function localDay(ms: number): string {
  return localDate(new Date(ms));
}

/** YYYY-MM-DD 加几天 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** 从 first 到 last（都含）的每一天；first 晚于 last 是空的 */
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last && out.length < 400; day = addDays(day, 1)) out.push(day);
  return out;
}
