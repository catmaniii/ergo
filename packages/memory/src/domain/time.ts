// 时间工具：带时区的 ISO 8601 字符串（合成数据写 +08:00）。
// 比较一律换成毫秒；算"哪一天、月初、周一"按这个时间自己的时区（用户说"上个月"指的是他那里的上个月），结果保留同一个时区。

const ZONED_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** 带时区的 ISO 时间（Z 或 ±hh:mm）。不带时区的不认：分不清是哪里的时间 */
export function isZonedIso(value: unknown): value is string {
  return typeof value === "string" && ZONED_ISO.test(value) && !Number.isNaN(Date.parse(value));
}

/** 毫秒；不是带时区的 ISO 时间就抛错 */
export function toMs(iso: string): number {
  if (!isZonedIso(iso)) throw new Error(`不是带时区的 ISO 时间：${iso}`);
  return Date.parse(iso);
}

/** 可空的时间换成毫秒 */
export function toMsOrNull(iso: string | null): number | null {
  return iso === null ? null : toMs(iso);
}

/** 按同一时刻比较：a 早于 b 是负数 */
export function compareTime(a: string, b: string): number {
  return toMs(a) - toMs(b);
}

/** 时区偏移（分钟，东八区是 480） */
export function offsetMinutes(iso: string): number {
  const m = ZONED_ISO.exec(iso);
  if (!m) throw new Error(`不是带时区的 ISO 时间：${iso}`);
  const zone = m[7]!;
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
}

interface LocalParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日 */
  weekday: number;
}

/** 在偏移为 offset 分钟的时区里，这个时刻是几年几月几日几点 */
function partsAt(ms: number, offset: number): LocalParts {
  const d = new Date(ms + offset * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function zoneLabel(offset: number): string {
  if (offset === 0) return "Z";
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 在偏移为 offset 的时区里，把"几年几月几日几点"写成 ISO（月、日越界时自动进位，Date.UTC 的规矩） */
function formatAt(year: number, month: number, day: number, hour: number, minute: number, second: number, offset: number): string {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${zoneLabel(offset)}`;
}

/** 这个时间在它自己的时区里是哪一天（YYYY-MM-DD） */
export function localDate(iso: string, offset = offsetMinutes(iso)): string {
  const p = partsAt(toMs(iso), offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 两个时间是不是同一天（按第一个的时区） */
export function sameLocalDay(a: string, b: string): boolean {
  const offset = offsetMinutes(a);
  return localDate(a, offset) === localDate(b, offset);
}

/** 加减几天（保留时区） */
export function addDays(iso: string, days: number): string {
  const offset = offsetMinutes(iso);
  const p = partsAt(toMs(iso), offset);
  return formatAt(p.year, p.month, p.day + days, p.hour, p.minute, p.second, offset);
}

/** 加减几个月（保留时区；月底按 Date.UTC 进位） */
export function addMonths(iso: string, months: number): string {
  const offset = offsetMinutes(iso);
  const p = partsAt(toMs(iso), offset);
  return formatAt(p.year, p.month + months, p.day, p.hour, p.minute, p.second, offset);
}

/** 往前或往后 delta 个月的那个月的 1 号零点 */
export function startOfMonth(iso: string, delta = 0): string {
  const offset = offsetMinutes(iso);
  const p = partsAt(toMs(iso), offset);
  return formatAt(p.year, p.month + delta, 1, 0, 0, 0, offset);
}

/** 往前或往后 delta 年的那一年的 1 月 1 日零点 */
export function startOfYear(iso: string, delta = 0): string {
  const offset = offsetMinutes(iso);
  const p = partsAt(toMs(iso), offset);
  return formatAt(p.year + delta, 1, 1, 0, 0, 0, offset);
}

/** 往前或往后 delta 周的那一周的周一零点（中文习惯一周从周一开始） */
export function startOfWeek(iso: string, delta = 0): string {
  const offset = offsetMinutes(iso);
  const p = partsAt(toMs(iso), offset);
  const sinceMonday = (p.weekday + 6) % 7;
  return formatAt(p.year, p.month, p.day - sinceMonday + delta * 7, 0, 0, 0, offset);
}

/** 某年某月 1 号零点（时区取 ref 的） */
export function monthStart(ref: string, year: number, month: number): string {
  return formatAt(year, month, 1, 0, 0, 0, offsetMinutes(ref));
}

/** ref 在它自己时区里的年、月 */
export function yearMonthOf(iso: string): { year: number; month: number } {
  const p = partsAt(toMs(iso), offsetMinutes(iso));
  return { year: p.year, month: p.month };
}

/** 两个可空的"起"比较：null 当成很早以前 */
export function compareFrom(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareTime(a, b);
}

/** 较早的那个"起"（null 最早） */
export function earlierFrom(a: string | null, b: string | null): string | null {
  return compareFrom(a, b) <= 0 ? a : b;
}

/** 有效期 [from, to) 有没有重叠（from 为 null 是很早以前，to 为 null 是现在仍成立） */
export function intervalsOverlap(a: { validFrom: string | null; validTo: string | null }, b: { validFrom: string | null; validTo: string | null }): boolean {
  const aFrom = a.validFrom === null ? -Infinity : toMs(a.validFrom);
  const aTo = a.validTo === null ? Infinity : toMs(a.validTo);
  const bFrom = b.validFrom === null ? -Infinity : toMs(b.validFrom);
  const bTo = b.validTo === null ? Infinity : toMs(b.validTo);
  return aFrom < bTo && bFrom < aTo;
}

/** 在时间 at 成立：validFrom ≤ at < validTo */
export function validAt(v: { validFrom: string | null; validTo: string | null }, at: string): boolean {
  const t = toMs(at);
  return (v.validFrom === null || toMs(v.validFrom) <= t) && (v.validTo === null || t < toMs(v.validTo));
}
