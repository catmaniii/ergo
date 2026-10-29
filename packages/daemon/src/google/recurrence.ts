// 把 iCal 事件展开成一段时间里的每一次（297 号票）：只展开要看的那一段（日历的一个月、问的那几天），不把重复事件铺满。不加 npm 依赖。
// 认的重复规则（RRULE，RFC 5545 3.3.10）：FREQ 是 DAILY / WEEKLY / MONTHLY / YEARLY，INTERVAL、COUNT、UNTIL，BYDAY（每月、每年里可以带序号：
// 1MO 第一个周一、-1FR 最后一个周五）、BYMONTHDAY（负数从月底数）、BYMONTH、BYSETPOS、WKST；再加 RDATE（额外的几次）、EXDATE（去掉的几次）、
// RECURRENCE-ID（改期的那一次：原本那次不算，按改后的时间放；改成取消的就没了）、整个事件 STATUS:CANCELLED 的不出现。
// 认不得的（FREQ=HOURLY 这类、BYWEEKNO、BYYEARDAY、BYHOUR……）只给第一次（DTSTART 那一次），交回 approximate 让调用方记一笔。
// 重复按事件自己的时区的本地时间走（每周一 09:00 纽约时间跨过夏令时还是 09:00），再换成时刻（time-zone.ts）；全天的只看日期。
// 纯函数：日历插件按月取、按需查的工具都用它。
import type { IcalEvent, IcalTime } from "./ical.ts";
import { knownTimeZone, type WallTime, wallToUtc } from "./time-zone.ts";

const DAY_MS = 86_400_000;
/** 一个事件最多走多少个周期（防认不得的规则转不出来） */
const MAX_PERIODS = 50_000;
/** 一个事件在一段时间里最多交回多少次 */
const MAX_IN_WINDOW = 2_000;

/** 展开出的一次 */
export interface Occurrence {
  /** 这一次是哪个 VEVENT（改期的那一次是改后的那个） */
  readonly event: IcalEvent;
  /** 全天的 */
  readonly allDay: boolean;
  /** 开始、结束（不含）的时刻：全天的是这台电脑本地时间那天的零点 */
  readonly start: number;
  readonly end: number;
  /** 全天的：开始那天、结束那天（不含），YYYY-MM-DD */
  readonly startDate?: string;
  readonly endDate?: string;
  /** 这一次的键：UID 加上开始 */
  readonly key: string;
}

export interface ExpandResult {
  occurrences: Occurrence[];
  /** 有认不得的重复规则（只给了第一次）的事件的 UID */
  approximate: string[];
}

// ---- 日期运算（按"第几天"算，1970-01-01 是第 0 天、周四） ----

const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const fromDayNumber = (dn: number) => {
  const date = new Date(dn * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};
const weekdayOf = (dn: number) => (((dn + 4) % 7) + 7) % 7;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
const dateString = (dn: number) => {
  const { y, m, d } = fromDayNumber(dn);
  return `${y}-${pad(m)}-${pad(d)}`;
};
/** 这台电脑本地时间那天的零点 */
const localMidnight = (dn: number) => {
  const { y, m, d } = fromDayNumber(dn);
  return new Date(y, m - 1, d).getTime();
};

// ---- 时间值 ----

/** 一个时间值算出来的样子：全天的只有日期（第几天），其余还有本地时间、时区和时刻 */
interface Resolved {
  allDay: boolean;
  dn: number;
  wall: WallTime;
  /** 按哪个时区走：时区名、"UTC"，不带时区的是 undefined（这台电脑的时区） */
  zone: string | undefined;
  utc: number;
}

function resolve(time: IcalTime, fallbackZone: string | undefined): Resolved | undefined {
  const v = time.value;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dn = dayNumber(y, m, d);
  if (v.length === 8) return { allDay: true, dn, wall: { y, m, d, hh: 0, mi: 0, ss: 0 }, zone: undefined, utc: localMidnight(dn) };
  const wall: WallTime = { y, m, d, hh: Number(v.slice(9, 11)), mi: Number(v.slice(11, 13)), ss: Number(v.slice(13, 15)) };
  const zone = v.endsWith("Z") ? "UTC" : time.tz === undefined ? undefined : knownTimeZone(time.tz) ? time.tz : knownTimeZone(fallbackZone) ? fallbackZone : undefined;
  return { allDay: false, dn, wall, zone, utc: wallToUtc(wall, zone) };
}

/** 时长（DURATION，P1D、PT1H30M、P2W）：毫秒和天数；写法不对的是 undefined */
function parseDuration(text: string): { ms: number; days: number } | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text.trim().toUpperCase());
  if (!m || m[1] === "-") return undefined;
  const [weeks, days, hours, minutes, seconds] = m.slice(2).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  const totalDays = weeks * 7 + days;
  return { ms: totalDays * DAY_MS + ((hours * 60 + minutes) * 60 + seconds) * 1000, days: totalDays };
}

// ---- 重复规则 ----

interface ByDay {
  /** 序号（0 是不带序号：这个月、这一年里所有的这个星期几） */
  n: number;
  wd: number;
}

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcalTime;
  byDay?: ByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  wkst: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const UNSUPPORTED_PARTS = ["BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND", "BYEASTER"];

const intList = (v: string) => v.split(",").map((x) => Number(x.trim()));

/** 解析 RRULE；认不得的返回 undefined */
function parseRule(text: string, startTz: string | undefined): Rule | undefined {
  const parts = new Map<string, string>();
  for (const seg of text.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim().toUpperCase());
  }
  const freq = parts.get("FREQ") as Rule["freq"] | undefined;
  if (!freq || !FREQS.includes(freq) || UNSUPPORTED_PARTS.some((p) => parts.has(p))) return undefined;
  const rule: Rule = { freq, interval: Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1), wkst: WEEKDAYS[parts.get("WKST") ?? "MO"] ?? 1 };
  const count = parts.get("COUNT");
  if (count !== undefined) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) return undefined;
    rule.count = n;
  }
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    if (!/^\d{8}(T\d{6}Z?)?$/.test(until)) return undefined;
    rule.until = until.length === 8 || until.endsWith("Z") || startTz === undefined ? { value: until } : { value: until, tz: startTz };
  }
  const byDay = parts.get("BYDAY");
  if (byDay !== undefined) {
    const list: ByDay[] = [];
    for (const item of byDay.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item.trim());
      if (!m) return undefined;
      list.push({ n: m[1] === undefined ? 0 : Number(m[1]), wd: WEEKDAYS[m[2]!]! });
    }
    rule.byDay = list;
  }
  for (const [name, key, ok] of [
    ["BYMONTHDAY", "byMonthDay", (n: number) => n !== 0 && Math.abs(n) <= 31],
    ["BYMONTH", "byMonth", (n: number) => n >= 1 && n <= 12],
    ["BYSETPOS", "bySetPos", (n: number) => n !== 0 && Math.abs(n) <= 366],
  ] as const) {
    const value = parts.get(name);
    if (value === undefined) continue;
    const list = intList(value);
    if (!list.every((n) => Number.isInteger(n) && ok(n))) return undefined;
    rule[key] = list;
  }
  return rule;
}

/** 一个周期里的候选日子按 BYSETPOS 挑（几号位，负数从后数） */
function pickSetPos(days: number[], setPos: readonly number[] | undefined): number[] {
  if (!setPos) return days;
  const picked = setPos.flatMap((p) => {
    const at = p > 0 ? p - 1 : days.length + p;
    return at >= 0 && at < days.length ? [days[at]!] : [];
  });
  return [...new Set(picked)].toSorted((a, b) => a - b);
}

/** 某个月里按规则挑出的日子（第几天，排好）；startDay 是 DTSTART 的几号（规则里没写日子时用） */
function monthDays(y: number, m: number, rule: Rule, startDay: number): number[] {
  const len = daysInMonth(y, m);
  const first = dayNumber(y, m, 1);
  let set: number[] | undefined;
  if (rule.byMonthDay) set = rule.byMonthDay.map((n) => (n > 0 ? n : len + n + 1)).filter((d) => d >= 1 && d <= len);
  if (rule.byDay) {
    const fromByDay = rule.byDay.flatMap(({ n, wd }) => {
      const all: number[] = [];
      for (let d = 1 + ((wd - weekdayOf(first) + 7) % 7); d <= len; d += 7) all.push(d);
      if (n === 0) return all;
      const at = n > 0 ? n - 1 : all.length + n;
      return at >= 0 && at < all.length ? [all[at]!] : [];
    });
    set = set ? set.filter((d) => fromByDay.includes(d)) : fromByDay;
  }
  if (!set) set = startDay <= len ? [startDay] : [];
  return [...new Set(set)].toSorted((a, b) => a - b).map((d) => first + d - 1);
}

/** 某一年里按 BYDAY 挑（没写 BYMONTH 时，序号按全年数） */
function yearDaysByWeekday(y: number, byDay: readonly ByDay[]): number[] {
  const first = dayNumber(y, 1, 1);
  const last = dayNumber(y, 12, 31);
  const days = byDay.flatMap(({ n, wd }) => {
    const all: number[] = [];
    for (let dn = first + ((wd - weekdayOf(first) + 7) % 7); dn <= last; dn += 7) all.push(dn);
    if (n === 0) return all;
    const at = n > 0 ? n - 1 : all.length + n;
    return at >= 0 && at < all.length ? [all[at]!] : [];
  });
  return [...new Set(days)].toSorted((a, b) => a - b);
}

/**
 * 第 k 个周期：这个周期从哪天起（判断走没走过头），和周期里的候选日子（第几天，排好）。
 * DAILY 一天一个周期，WEEKLY 按 WKST 起的一周，MONTHLY 一个月，YEARLY 一年；周期之间隔 INTERVAL 个
 */
function period(rule: Rule, start: Resolved, k: number): { from: number; days: number[] } {
  const { y, m, d } = start.wall;
  switch (rule.freq) {
    case "DAILY": {
      const dn = start.dn + k * rule.interval;
      const date = fromDayNumber(dn);
      const ok =
        (!rule.byMonth || rule.byMonth.includes(date.m)) &&
        (!rule.byMonthDay || rule.byMonthDay.some((n) => (n > 0 ? n : daysInMonth(date.y, date.m) + n + 1) === date.d)) &&
        (!rule.byDay || rule.byDay.some((b) => b.wd === weekdayOf(dn)));
      return { from: dn, days: ok ? [dn] : [] };
    }
    case "WEEKLY": {
      const weekStart = start.dn - ((weekdayOf(start.dn) - rule.wkst + 7) % 7) + k * rule.interval * 7;
      const weekdays = rule.byDay ? rule.byDay.map((b) => b.wd) : [weekdayOf(start.dn)];
      const days = [...new Set(weekdays.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)))]
        .filter((dn) => !rule.byMonth || rule.byMonth.includes(fromDayNumber(dn).m))
        .toSorted((a, b) => a - b);
      return { from: weekStart, days: pickSetPos(days, rule.bySetPos) };
    }
    case "MONTHLY": {
      const index = y * 12 + (m - 1) + k * rule.interval;
      const yy = Math.floor(index / 12);
      const mm = (index % 12) + 1;
      const days = !rule.byMonth || rule.byMonth.includes(mm) ? monthDays(yy, mm, rule, d) : [];
      return { from: dayNumber(yy, mm, 1), days: pickSetPos(days, rule.bySetPos) };
    }
    case "YEARLY": {
      const yy = y + k * rule.interval;
      let days: number[];
      if (rule.byDay && !rule.byMonth && !rule.byMonthDay) days = yearDaysByWeekday(yy, rule.byDay);
      else {
        // 写了 BYMONTH 按那几个月；只写了 BYMONTHDAY 是每个月；都没写是 DTSTART 那个月的那一天
        const months = rule.byMonth ?? (rule.byMonthDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [m]);
        days = months.flatMap((mm) => monthDays(yy, mm, rule, d)).toSorted((a, b) => a - b);
      }
      return { from: dayNumber(yy, 1, 1), days: pickSetPos(days, rule.bySetPos) };
    }
  }
}

/** 跳过窗口之前的周期（没有 COUNT 时）：从第几个周期开始走 */
function firstPeriod(rule: Rule, start: Resolved, beforeDn: number): number {
  if (rule.count !== undefined || beforeDn <= start.dn) return 0;
  const { y, m } = start.wall;
  const target = fromDayNumber(beforeDn);
  switch (rule.freq) {
    case "DAILY":
      return Math.max(0, Math.floor((beforeDn - start.dn) / rule.interval) - 1);
    case "WEEKLY":
      return Math.max(0, Math.floor((beforeDn - start.dn) / (7 * rule.interval)) - 1);
    case "MONTHLY":
      return Math.max(0, Math.floor((target.y * 12 + target.m - (y * 12 + m)) / rule.interval) - 1);
    case "YEARLY":
      return Math.max(0, Math.floor((target.y - y) / rule.interval) - 1);
  }
}

// ---- 展开 ----

export interface ExpandOptions {
  /** 时区名认不得时退回哪个（日历的 X-WR-TIMEZONE） */
  readonly timeZone?: string;
}

/** 这一次和这段时间有没有交集（没有时长的按开始那一刻） */
const overlaps = (start: number, end: number, from: number, to: number) => (end > start ? start < to && end > from : start >= from && start < to);

/**
 * EXDATE、RECURRENCE-ID 对上哪一次：带时刻的按时刻（T…），只写日期的按事件自己那天的日期（D…，同一天只有一次）。
 * 不带时区的时刻按事件自己的时区算
 */
function skipKey(time: IcalTime, startZone: string | undefined, fallback: string | undefined): string | undefined {
  const floating = time.tz === undefined && time.value.length > 8 && !time.value.endsWith("Z");
  const r = resolve(floating && startZone !== undefined ? { value: time.value, tz: startZone } : time, fallback);
  return r && (r.allDay ? `D${r.dn}` : `T${r.utc}`);
}

/**
 * 一组 VEVENT（同一份日历的）在 [from, to) 这段时间里的每一次，按开始排好（同一刻全天的在前）。
 * 改期的那一次（RECURRENCE-ID）按改后的时间放、原本那次不算；整个取消的、取消的那一次不出现；没有主事件的改期当一次单独的
 */
export function expandEvents(events: readonly IcalEvent[], window: { from: number; to: number }, options: ExpandOptions = {}): ExpandResult {
  const fallback = options.timeZone;
  const out: Occurrence[] = [];
  const approximate: string[] = [];
  // 改期、取消的那一次：按 UID 记下原本是哪几次（主事件展开时跳过）
  const startZoneOf = new Map<string, string | undefined>();
  for (const e of events) if (!e.recurrenceId) startZoneOf.set(e.uid, resolve(e.start, fallback)?.zone);
  const overrides = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.recurrenceId) continue;
    const key = skipKey(e.recurrenceId, startZoneOf.get(e.uid), fallback);
    if (key === undefined) continue;
    overrides.set(e.uid, (overrides.get(e.uid) ?? new Set<string>()).add(key));
  }
  const cancelledMasters = new Set(events.filter((e) => !e.recurrenceId && e.status === "cancelled").map((e) => e.uid));

  for (const e of events) {
    if (e.status === "cancelled") continue;
    // 主事件整个取消了：改期的那几次也不要
    if (e.recurrenceId && cancelledMasters.has(e.uid)) continue;
    const start = resolve(e.start, fallback);
    if (!start) continue;
    const endResolved = e.end ? resolve(e.end, fallback) : undefined;
    const duration = e.duration ? parseDuration(e.duration) : undefined;
    const days = start.allDay ? Math.max(1, endResolved ? endResolved.dn - start.dn : duration ? Math.ceil(duration.ms / DAY_MS) : 1) : 0;
    const ms = start.allDay ? 0 : Math.max(0, endResolved ? endResolved.utc - start.utc : (duration?.ms ?? 0));
    let inWindow = 0;
    /** 放进一次：全天的按那一天，其余按时刻 */
    const emit = (dn: number, utc: number) => {
      const occStart = start.allDay ? localMidnight(dn) : utc;
      const occEnd = start.allDay ? localMidnight(dn + days) : utc + ms;
      if (inWindow >= MAX_IN_WINDOW || !overlaps(occStart, occEnd, window.from, window.to)) return;
      inWindow += 1;
      out.push({
        event: e,
        allDay: start.allDay,
        start: occStart,
        end: occEnd,
        ...(start.allDay ? { startDate: dateString(dn), endDate: dateString(dn + days) } : {}),
        key: `${e.uid}@${start.allDay ? dateString(dn) : occStart}`,
      });
    };

    // 改期的那一次、不重复的：就这一次
    if (e.recurrenceId || (!e.rrule && !e.rdates)) {
      emit(start.dn, start.utc);
      continue;
    }

    const skip = new Set<string>(overrides.get(e.uid) ?? []);
    for (const ex of e.exdates ?? []) {
      const key = skipKey(ex, start.zone, fallback);
      if (key !== undefined) skip.add(key);
    }
    const skipped = (dn: number, utc: number) => skip.has(`D${dn}`) || (!start.allDay && skip.has(`T${utc}`));
    const instantOf = (dn: number) => (start.allDay ? localMidnight(dn) : wallToUtc({ ...fromDayNumber(dn), hh: start.wall.hh, mi: start.wall.mi, ss: start.wall.ss }, start.zone));

    // 额外的几次（RDATE）
    for (const rd of e.rdates ?? []) {
      const r = resolve(rd, fallback);
      if (r && !skipped(r.dn, r.utc)) emit(r.dn, r.utc);
    }
    if (!e.rrule) continue;
    // DTSTART 总是第一次
    if (!skipped(start.dn, start.utc)) emit(start.dn, start.utc);
    const rule = parseRule(e.rrule, start.zone !== "UTC" ? start.zone : undefined);
    if (!rule) {
      approximate.push(e.uid);
      continue;
    }
    const until = rule.until ? resolve(rule.until, fallback) : undefined;
    const pastUntil = (dn: number, utc: number) => until !== undefined && (until.allDay || start.allDay ? dn > until.dn : utc > until.utc);
    const toDn = Math.floor(window.to / DAY_MS) + 2;
    const beforeDn = Math.floor((window.from - ms) / DAY_MS) - days - 2;
    let count = 1;
    let done = false;
    for (let k = firstPeriod(rule, start, beforeDn), n = 0; !done && n < MAX_PERIODS; k++, n++) {
      const p = period(rule, start, k);
      if (p.from > toDn) break;
      for (const dn of p.days) {
        if (dn <= start.dn) continue;
        const utc = instantOf(dn);
        count += 1;
        if (pastUntil(dn, utc) || (rule.count !== undefined && count > rule.count) || utc >= window.to) {
          done = true;
          break;
        }
        if (!skipped(dn, utc)) emit(dn, utc);
      }
    }
  }
  out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.event.summary.localeCompare(b.event.summary));
  return { occurrences: out, approximate };
}
