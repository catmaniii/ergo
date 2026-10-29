// 从写的话里认出时间（97 号票，纯函数，此刻由调用方给）：发起任务时"要做什么"那段话里说了几点（"明天早上8点调研一下……"
// "每天早上8点出一份早报"），定时就按那个时间定。认出的是一次（具体哪天几点，或者只有钟点）还是反复（每天、每周几、
// 工作日、每月几号），连同认出的原话片段（对话框里写"按你写的「明天早上8点」定在……"）。
//
// 认的是一个钟点（8点、8点半、8点一刻、8点15分、8:30、两点、十点半、二十点……），连同紧挨在它前面的时段（早上、下午、晚上……）
// 和哪天或者反复（明天、下周一、10月20号、15号、每天、每周一三五、工作日、每月15号……；和时段、钟点之间可以有空格、"的"）。
// 只写了哪天没写钟点的不认；说的是过去的时间（昨晚8点、今天早上8点而现在已经晚上了）不认——那是在说之前的事，
// 接着往后找下一个钟点。光一个"3点"前后像是在数条目的（总结成3点、3点建议、第2点、快一点）不认。
// @i18n-ignore-file data：整个文件是认中文写的时间的解析器（用户写的话），里面的中文都是认字用的正则和字表，没有给用户看的字（170 号票）
import { nextClockTime, nowIso, pad2, type ReminderSchedule } from "./protocol.ts";
import type { TimedMode } from "./triggers.ts";

/** 从写的话里认出的时间 */
export interface TextTime {
  /** 一次的是具体时刻（once）；反复的是每天、每周几、每月几号、按我的工作日 */
  schedule: ReminderSchedule;
  /** 某个时间做一次（at）还是按时间表反复做（repeat） */
  mode: TimedMode;
  /** 认出的原话片段："明天早上8点" */
  quote: string;
}

/** 一段话里第一个认得出、而且不在过去的时间；没有是 undefined */
export function timeFromText(text: string, now: Date): TextTime | undefined {
  for (const clock of clocksIn(text)) {
    const found = withContext(text, clock, now);
    if (found) return found;
  }
  return undefined;
}

// ───────────────────────── 数字 ─────────────────────────

const CN_DIGIT: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 阿拉伯数字，或者 0–99 的中文数字（八、十、十二、二十三、零五）；认不出是 NaN */
function numberOf(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (tens) return (tens[1] ? CN_DIGIT[tens[1]]! : 1) * 10 + (tens[2] ? CN_DIGIT[tens[2]]! : 0);
  const one = /^[零〇]?([零〇一二两三四五六七八九])$/.exec(s);
  return one ? CN_DIGIT[one[1]!]! : NaN;
}

/** 几号、几月里的数 */
const DAY_NUM = "\\d{1,2}|[一二三四五六七八九十]{1,3}";

// ───────────────────────── 钟点 ─────────────────────────

/** 一个钟点在话里的位置和值（时段、哪天还没算） */
interface Clock {
  start: number;
  end: number;
  hour: number;
  minute: number;
  /** "8点"这种：没有分钟，也不是 8:00 的写法；前面也没有时段、哪天时要多看看是不是在数条目 */
  bare: boolean;
  /** 钟点是中文的"一"（"快一点"的一点） */
  cnOne: boolean;
}

/** 8:30 / 8：30；8点；八点（一串中文数字，周几的字可能连在前面：周三八点、每周一三五八点） */
const CLOCK = /(?<![\d.:：])(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)|(?<![\d.])(\d{1,2})\s*[点點]|([零〇一二两三四五六七八九十]+)\s*[点點]/g;
/** 分钟后面跟着这些就是在数东西（8点10条新闻），不是分钟 */
const COUNTED = "(?!\\s*[个条首篇份张本项件次天号日月年岁遍位名人块元页行字秒])";
/** 点后面的分钟：[写法, 几分] */
const MINUTE_FORMS: ReadonlyArray<[RegExp, (m: RegExpExecArray) => number]> = [
  [/^\s*半/, () => 30],
  [/^\s*一刻/, () => 15],
  [/^\s*三刻/, () => 45],
  [/^\s*(\d{1,2})\s*分(?!钟)/, (m) => Number(m[1])],
  [new RegExp(`^\\s*(\\d{2})(?!\\d)${COUNTED}`), (m) => Number(m[1])],
  [/^\s*([零〇]?[一二三四五六七八九]|[一二三四五]?十[一二三四五六七八九]?)\s*分(?!钟)/, (m) => numberOf(m[1]!)],
  [new RegExp(`^\\s*([一二三四五]?十[一二三四五六七八九]?)${COUNTED}`), (m) => numberOf(m[1]!)],
  [/^\s*[整钟]/, () => 0],
];

/** 话里每一个像钟点的地方，按先后 */
function clocksIn(text: string): Clock[] {
  const out: Clock[] = [];
  for (const m of text.matchAll(CLOCK)) {
    let start = m.index;
    let end = start + m[0].length;
    if (m[1] !== undefined) {
      out.push({ start, end, hour: Number(m[1]), minute: Number(m[2]), bare: false, cnOne: false });
      continue;
    }
    let hour = Number(m[3]);
    if (m[4] !== undefined) {
      const cn = chineseHour(m[4], /(?:周|星期|礼拜)$/.test(text.slice(0, start)));
      if (!cn) continue;
      hour = cn.hour;
      start += cn.skip;
    }
    let minute = 0;
    let bare = true;
    const rest = text.slice(end);
    for (const [form, value] of MINUTE_FORMS) {
      const mm = form.exec(rest);
      if (!mm) continue;
      minute = value(mm);
      end += mm[0].length;
      bare = false;
      break;
    }
    out.push({ start, end, hour, minute, bare, cnOne: m[4] === "一" });
  }
  return out.filter((c) => c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59);
}

/**
 * 一串中文数字里的钟点：紧跟在"周""星期""礼拜"后面的，开头的字是周几（周三八点、周一十点、每周一三五八点），
 * 去掉最少的几个字让剩下的是 0–23 的钟点；别处的整串就是钟点（二十三点），整串不是的同样从前面去字
 */
function chineseHour(run: string, afterWeek: boolean): { hour: number; skip: number } | undefined {
  const first = afterWeek && "一二三四五六".includes(run[0]!) ? 1 : 0;
  for (let skip = first; skip < run.length; skip++) {
    const hour = numberOf(run.slice(skip));
    if (hour >= 0 && hour <= 23) return { hour, skip };
  }
  return undefined;
}

/** 光一个"3点"时，紧挨在前面的这些字说明是在数条目（总结成3点、第2点、列出3点、有两点、以下两点、注意两点） */
const COUNTING_BEFORE = /[第几成出列分有提写讲说这那哪每多好前下意]\s*$/;
/** 光一个"3点"时，后面跟着这些说明是在数条目（3点建议） */
const COUNTING_AFTER = /^\s*(?:建议|意见|要求|内容|注意|要点|理由|原因|看法|想法|问题|说明|总结|结论|事项|改进|不足|区别|好处|坏处|疑问|心得|体会|感想|原则|规则|方面|特点|优点|缺点)/;

// ───────────────────────── 时段 ─────────────────────────

type PeriodKind = "dawn" | "morning" | "noon" | "afternoon" | "evening";

/** 时段：几点按哪种算；有的连着哪天（今晚、明早）、反复（每晚），昨晚是过去的 */
const PERIODS: Readonly<Record<string, { kind: PeriodKind; days?: number; daily?: true; past?: true }>> = {
  凌晨: { kind: "dawn" },
  早上: { kind: "morning" },
  早晨: { kind: "morning" },
  清晨: { kind: "morning" },
  上午: { kind: "morning" },
  中午: { kind: "noon" },
  午后: { kind: "afternoon" },
  下午: { kind: "afternoon" },
  傍晚: { kind: "afternoon" },
  晚上: { kind: "evening" },
  夜里: { kind: "evening" },
  夜间: { kind: "evening" },
  半夜: { kind: "evening" },
  今早: { kind: "morning", days: 0 },
  今晚: { kind: "evening", days: 0 },
  明早: { kind: "morning", days: 1 },
  明晚: { kind: "evening", days: 1 },
  每早: { kind: "morning", daily: true },
  每晚: { kind: "evening", daily: true },
  昨晚: { kind: "evening", past: true },
};
const PERIOD_AT_END = new RegExp(`(${Object.keys(PERIODS).join("|")})\\s*$`);

/**
 * 按时段算成 24 小时的钟点：下午的 1–11 点加 12，中午的 1–10 点加 12（中午 12 点还是 12 点），晚上的 5–11 点加 12；
 * 晚上 12 点是过了这一天的 0 点，晚上、夜里的 1–4 点也是过了这一天的半夜（nextDay）；凌晨 12 点是 0 点。13 点以后的照写的算。
 */
function hourIn(hour: number, period: PeriodKind | undefined): { hour: number; nextDay: boolean } {
  if (hour > 12) return { hour, nextDay: false };
  switch (period) {
    case "dawn":
      return { hour: hour === 12 ? 0 : hour, nextDay: false };
    case "noon":
      return { hour: hour >= 1 && hour <= 10 ? hour + 12 : hour, nextDay: false };
    case "afternoon":
      return { hour: hour >= 1 && hour <= 11 ? hour + 12 : hour, nextDay: false };
    case "evening":
      if (hour >= 5 && hour <= 11) return { hour: hour + 12, nextDay: false };
      return { hour: hour === 12 ? 0 : hour, nextDay: true };
    default:
      return { hour, nextDay: false };
  }
}

// ───────────────────────── 哪天、反复 ─────────────────────────

/** 哪天：某一天；从今天起最近的周几（今天就是、钟点还没过就是今天）；过去的 */
type Day = { kind: "date"; date: Date } | { kind: "nearest"; weekday: number } | { kind: "past" };
/** 反复：时间表的样子（钟点后填） */
type Repeat = { kind: "daily" } | { kind: "weekly"; weekdays: number[] } | { kind: "monthly"; days: number[] } | { kind: "workdays" };

const WEEK = "(?:周|星期|礼拜)";
const WD = "[一二三四五六日天]";
const WEEKDAY_OF: Readonly<Record<string, number>> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
/** 哪天和时段、钟点之间可以有空格、"的" */
const GAP = "[\\s的]*$";

/** 紧挨在前面的反复：[写法, 按写的拼出反复] */
const REPEAT_FORMS: ReadonlyArray<[RegExp, (m: RegExpExecArray) => Repeat | undefined]> = [
  [new RegExp(`每个?${WEEK}末${GAP}`), () => ({ kind: "weekly", weekdays: [0, 6] })],
  [new RegExp(`每个?${WEEK}(${WD}(?:\\s*(?:[、，,和及与跟到至~\\-－]|以及)?\\s*${WEEK}?${WD})*)${GAP}`), (m) => weekdaysIn(m[1]!)],
  [new RegExp(`(?:每个?)?工作日${GAP}`), () => ({ kind: "workdays" })],
  [new RegExp(`每个?月((?:${DAY_NUM})\\s*[号日]?(?:\\s*[、，,和及与跟]\\s*(?:${DAY_NUM})\\s*[号日]?)*)${GAP}`), (m) => monthDaysIn(m[1]!)],
  [new RegExp(`(?:每天|每日|天天|每一天)${GAP}`), () => ({ kind: "daily" })],
];

/** "一三五""一、三、五""一和周四""一到五"里的周几（到、至连起来是一段） */
function weekdaysIn(s: string): Repeat {
  const days = new Set<number>();
  let from: number | undefined;
  let range = false;
  for (const ch of s.replace(/周|星期|礼拜/g, "")) {
    const d = WEEKDAY_OF[ch];
    if (d === undefined) {
      if (/[到至~\-－]/.test(ch)) range = true;
      continue;
    }
    // 一到五：周一到周五；周日写在后面当 7
    if (range && from !== undefined) for (let x = from === 0 ? 7 : from; x <= (d === 0 ? 7 : d); x++) days.add(x % 7);
    days.add(d);
    from = d;
    range = false;
  }
  return { kind: "weekly", weekdays: [...days].toSorted((a, b) => a - b) };
}

/** "15号""1号和15号""1、15号"里的几号（最后要有号、日） */
function monthDaysIn(s: string): Repeat | undefined {
  if (!/[号日]\s*$/.test(s)) return undefined;
  const days = [...s.matchAll(new RegExp(DAY_NUM, "g"))].map((m) => numberOf(m[0]));
  if (days.length === 0 || days.some((d) => !(d >= 1 && d <= 31))) return undefined;
  return { kind: "monthly", days: [...new Set(days)].toSorted((a, b) => a - b) };
}

/** 紧挨在前面的哪天：[写法, 按写的算出哪天]；日子不存在（2 月 30 号）是 undefined */
const DAY_FORMS: ReadonlyArray<[RegExp, (m: RegExpExecArray, now: Date) => Day | undefined]> = [
  [new RegExp(`(?:(\\d{4})\\s*年\\s*)?(${DAY_NUM})\\s*月\\s*(${DAY_NUM})\\s*[号日]${GAP}`), (m, now) => monthDay(m[1], numberOf(m[2]!), numberOf(m[3]!), now)],
  [new RegExp(`(大后天|后天|明天|明日|明儿|今天|今日|今儿|昨天|昨日|前天)${GAP}`), (m, now) => relativeDay(m[1]!, now)],
  [new RegExp(`(下下|下|这|本|上)?个?${WEEK}(${WD})${GAP}`), (m, now) => weekdayDay(m[1], WEEKDAY_OF[m[2]!]!, now)],
  [new RegExp(`(?<![月\\d一二三四五六七八九十])(${DAY_NUM})\\s*[号日]${GAP}`), (m, now) => dayOfMonth(numberOf(m[1]!), now)],
];

const RELATIVE_DAYS: Readonly<Record<string, number>> = { 大后天: 3, 后天: 2, 明天: 1, 明日: 1, 明儿: 1, 今天: 0, 今日: 0, 今儿: 0, 昨天: -1, 昨日: -1, 前天: -2 };

/** 今天往后第几天的 0 点 */
const dayStart = (now: Date, plus: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + plus);

function relativeDay(word: string, now: Date): Day {
  const plus = RELATIVE_DAYS[word]!;
  return plus < 0 ? { kind: "past" } : { kind: "date", date: dayStart(now, plus) };
}

/** 某年（没写是今年；这个日子今年已经过了就是明年）某月某日 */
function monthDay(year: string | undefined, month: number, day: number, now: Date): Day | undefined {
  let y = year === undefined ? now.getFullYear() : Number(year);
  if (year === undefined && new Date(y, month - 1, day) < dayStart(now, 0)) y += 1;
  const date = new Date(y, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? { kind: "date", date } : undefined;
}

/** 几号：这个月的还没过就是这个月的，过了就是下个月的 */
function dayOfMonth(day: number, now: Date): Day | undefined {
  const date = new Date(now.getFullYear(), day >= now.getDate() ? now.getMonth() : now.getMonth() + 1, day);
  return date.getDate() === day ? { kind: "date", date } : undefined;
}

/** 周一开始数的周几：周一 0 … 周日 6 */
const mondayBased = (d: number) => (d + 6) % 7;

/** 周几：下周X 是下一个周一开始的那一周里的；这周X、本周X 是这一周（周一开始）里的；光写周X 是从今天起最近的那个；上周X 是过去的 */
function weekdayDay(which: string | undefined, weekday: number, now: Date): Day {
  const offset = mondayBased(weekday) - mondayBased(now.getDay());
  switch (which) {
    case "上":
      return { kind: "past" };
    case "这":
    case "本":
      return { kind: "date", date: dayStart(now, offset) };
    case "下":
      return { kind: "date", date: dayStart(now, 7 + offset) };
    case "下下":
      return { kind: "date", date: dayStart(now, 14 + offset) };
    default:
      return { kind: "nearest", weekday };
  }
}

// ───────────────────────── 拼起来 ─────────────────────────

/** 这个钟点连同前面的时段、哪天或反复，算出时间表；过去的、看着是在数条目的不认 */
function withContext(text: string, clock: Clock, now: Date): TextTime | undefined {
  let before = text.slice(0, clock.start);
  let quoteStart = clock.start;
  const periodMatch = PERIOD_AT_END.exec(before);
  const period = periodMatch ? PERIODS[periodMatch[1]!]! : undefined;
  if (periodMatch) {
    quoteStart = periodMatch.index;
    before = before.slice(0, periodMatch.index);
  }
  if (period?.past) return undefined;

  let repeat: Repeat | undefined = period?.daily ? { kind: "daily" } : undefined;
  let day: Day | undefined = period?.days === undefined ? undefined : { kind: "date", date: dayStart(now, period.days) };
  if (!repeat && !day) {
    const r = firstAtEnd(REPEAT_FORMS, before, now);
    if (r) {
      repeat = r.value;
      quoteStart = r.index;
    }
  }
  if (!repeat && !day) {
    const d = firstAtEnd(DAY_FORMS, before, now);
    if (d) {
      // 写了哪天但那天不存在（2月30号）
      if (!d.value) return undefined;
      day = d.value;
      quoteStart = d.index;
    }
  }
  if (day?.kind === "past") return undefined;
  // 前面像是写了哪天、但这里认不出（每月最后一天8点、周末早上9点）：宁可不认，也不当成只有钟点
  if (!repeat && !day && /[天日号周月年末节][\s的]*$/.test(before)) return undefined;

  // 光一个"3点"：看是不是在数条目
  if (clock.bare && !period && !repeat && !day) {
    if (clock.cnOne || COUNTING_BEFORE.test(text.slice(0, clock.start)) || COUNTING_AFTER.test(text.slice(clock.end))) return undefined;
  }

  const { hour, nextDay } = hourIn(clock.hour, period?.kind);
  const time = `${pad2(hour)}:${pad2(clock.minute)}`;
  const quote = text.slice(quoteStart, clock.end).trim();
  if (repeat) return { schedule: repeatAt(repeat, time, nextDay), mode: "repeat", quote };

  const at = day === undefined ? nextClockTime(time, now) : day.kind === "nearest" ? nearestWeekday(day.weekday, hour, clock.minute, nextDay, now) : atOn(day.date, nextDay, hour, clock.minute);
  // 说的是过去的时间（今天早上8点而现在已经晚上了）：那是在说之前的事
  if (at.getTime() <= now.getTime()) return undefined;
  return { schedule: { kind: "once", at: nowIso(at) }, mode: "at", quote };
}

/** 几种写法里第一个紧挨在末尾的：读出的值（可能是 undefined：写法对上了但值不对）和它在哪 */
function firstAtEnd<T>(forms: ReadonlyArray<[RegExp, (m: RegExpExecArray, now: Date) => T | undefined]>, before: string, now: Date): { value: T | undefined; index: number } | undefined {
  for (const [form, read] of forms) {
    const m = form.exec(before);
    if (m) return { value: read(m, now), index: m.index };
  }
  return undefined;
}

/** 某天（过了这一天的半夜挪到第二天）的几点几分 */
const atOn = (date: Date, nextDay: boolean, hour: number, minute: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + (nextDay ? 1 : 0), hour, minute);

/** 从今天起最近的周X 的那个钟点（今天就是、还没过就是今天，过了是下周的） */
function nearestWeekday(weekday: number, hour: number, minute: number, nextDay: boolean, now: Date): Date {
  for (let i = 0; i <= 7; i++) {
    const day = dayStart(now, i);
    const at = atOn(day, nextDay, hour, minute);
    if (day.getDay() === weekday && at.getTime() > now.getTime()) return at;
  }
  return atOn(dayStart(now, 7), nextDay, hour, minute);
}

/** 反复的时间表；晚上 12 点这种过了这一天的，每周几、每月几号往后挪一天 */
function repeatAt(repeat: Repeat, time: string, nextDay: boolean): ReminderSchedule {
  const shift = (values: number[], next: (v: number) => number) => (nextDay ? [...new Set(values.map(next))].toSorted((a, b) => a - b) : values);
  switch (repeat.kind) {
    case "daily":
      return { kind: "daily", time };
    case "workdays":
      return { kind: "workdays", time };
    case "weekly":
      return { kind: "weekly", time, weekdays: shift(repeat.weekdays, (d) => (d + 1) % 7) };
    case "monthly":
      return { kind: "monthly", time, days: shift(repeat.days, (d) => (d % 31) + 1) };
  }
}
