// iCal 里"某个时区的本地时间"换成时刻（297 号票）：DTSTART;TZID=America/New_York:20261026T090000 这种。用 Node 自带的 Intl
// （IANA 时区库），不加依赖、不读日历里附带的 VTIMEZONE。
// - 认不得的时区名（Outlook 的 Windows 名字、自定义的）由调用方退回日历的默认时区，再退回这台电脑的时区；
// - 夏令时跳过去的那一段（本地时间不存在）按跳之前的偏移算（RFC 5545 3.3.5：时刻往后挪）；
//   回拨重复的那一段（本地时间出现两次）取第一次。
// 纯函数，iCal 解析和重复规则展开（ical.ts、recurrence.ts）用。

/** 本地时间的各个字段（月 1–12） */
export interface WallTime {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hh: number;
  readonly mi: number;
  readonly ss: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterOf(zone: string): Intl.DateTimeFormat | undefined {
  if (!formatters.has(zone)) {
    try {
      formatters.set(
        zone,
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }),
      );
    } catch {
      formatters.set(zone, null);
    }
  }
  return formatters.get(zone) ?? undefined;
}

/** Intl 认不认得这个时区名 */
export function knownTimeZone(zone: string | undefined): zone is string {
  return zone !== undefined && zone !== "" && formatterOf(zone) !== undefined;
}

/** 某个时刻在这个时区里的本地时间 */
function wallAt(utc: number, f: Intl.DateTimeFormat): WallTime {
  const parts = f.formatToParts(new Date(utc));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mi: get("minute"), ss: get("second") };
}

const asUtc = (w: WallTime) => Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi, w.ss);
const sameWall = (a: WallTime, b: WallTime) => a.y === b.y && a.m === b.m && a.d === b.d && a.hh === b.hh && a.mi === b.mi && a.ss === b.ss;

/** 这个时刻在这个时区里比 UTC 快多少毫秒 */
function offsetAt(utc: number, f: Intl.DateTimeFormat): number {
  const whole = Math.floor(utc / 1000) * 1000;
  return asUtc(wallAt(whole, f)) - whole;
}

/**
 * 某个时区的本地时间 → 时刻（毫秒）。zone 不给或认不得时按这台电脑的时区（不带时区的"浮动时间"也是这样）；
 * 给 "UTC" 就是 UTC
 */
export function wallToUtc(w: WallTime, zone: string | undefined): number {
  const f = zone === undefined ? undefined : formatterOf(zone);
  if (!f) return new Date(w.y, w.m - 1, w.d, w.hh, w.mi, w.ss).getTime();
  const base = asUtc(w);
  // 前后一天的偏移都试一遍：夏令时切换当天用哪个偏移才对上本地时间
  const before = offsetAt(base - DAY_MS, f);
  const candidates = [...new Set([before, offsetAt(base, f), offsetAt(base + DAY_MS, f)].map((o) => base - o))];
  const matching = candidates.filter((c) => sameWall(wallAt(c, f), w));
  if (matching.length > 0) return Math.min(...matching);
  // 跳过去的那一段：按跳之前的偏移
  return base - before;
}
