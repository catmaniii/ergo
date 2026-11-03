// 简单提醒的时间规则：协议里的 ReminderSchedule（schema 和类型），以及所有按规则种类（一次性、每天、每 N 天、每周几、每月几号、
// 每年某月某日、按我的工作日）分支的逻辑：下一次响的时间、钟点、只改钟点、按重复规则拼出时间表、中文写法。
// 守护进程（提醒模块、秘书的工具、内部作业）和 Web（提醒卡、看板）都用这一份，别处不再按 schedule.kind 分支。
// 定时作业的时间表也是它。时间都按本地时间算（守护进程所在机器、或浏览器的时区）。
//
// "每 N 天"：从起算日（anchor，本地日期 YYYY-MM-DD）那天起，每隔 N 天（2–365）在那个钟点响一次：落点是起算日往后
// 0、N、2N……个日历日，按本地日历的年月日加（不按毫秒加），跨月、闰年、夏令时切换都不漂。改起算日就整体平移。
// 起算日之前不响；秘书没给起算日时是今天（今天这个钟点已经过了，第一次就是 N 天后）。
//
// "按我的工作日"：只在个人工作日历（workday-calendar.ts）上的上班日的那个钟点响。工作日历由调用方经
// ScheduleContext 传给 nextOccurrence（必填：漏传在编译时就报错），每次按当时的工作日历算：工作日历改了（某天标成休息），
// 下一次跟着变，不用重建提醒。哪些时间表要跟着工作日历变，看 dependsOnWorkdayCalendar。
//
// "每年某月某日"：只认公历（农历的日子每年落在公历的不同天，先不做）。2 月 29 日的规矩：闰年在 2 月 29 日响，
// 平年在 2 月 28 日响（和"每月几号"没有这天的月份在月底一样）；拼时间表时只收日历上有的日子（2 月最多 29 日，4 月最多 30 日）。
// 档案里的生日、纪念日"提前几天提醒"先用 monthDayBefore 算出提醒的那天，再按每年拼时间表。
import { type Static, Type } from "typebox";
import { t, tTable } from "./i18n/runtime.ts";
import { daysInMonth, localDate, monthName, pad2, parseLocalDate, weekdayChar } from "./local-date.ts";
import { nowIso } from "./time.ts";
import { LOCAL_DATE_PATTERN, type WorkdayCalendar } from "./workday-calendar.ts";

/** 算下一次时要的东西：当前的个人工作日历（"按我的工作日"按它算；别的规则用不上，但调用方总要给） */
export interface ScheduleContext {
  calendar: WorkdayCalendar;
}

/** 重复规则的种类（一次性的不算重复） */
export const REPEAT_KINDS = ["daily", "everyNDays", "weekly", "monthly", "yearly", "workdays"] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const REPEAT_KIND_LABEL: Readonly<Record<RepeatKind, string>> = tTable({
  daily: "protocol.schedule.repeat.daily",
  everyNDays: "protocol.schedule.repeat.everyNDays",
  weekly: "protocol.schedule.repeat.weekly",
  monthly: "protocol.schedule.repeat.monthly",
  yearly: "protocol.schedule.repeat.yearly",
  workdays: "protocol.schedule.repeat.workdays",
});

/** 一天里的几点几分（24 小时制，本地时间） */
export const ClockTime = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" });

/** "每 N 天"的 N 最少、最多是几（每 1 天就是每天） */
export const EVERY_N_DAYS_MIN = 2;
export const EVERY_N_DAYS_MAX = 365;

/** 一年里的某月某日（公历）：每年的提醒用；档案里的生日、纪念日也是这个形状 */
export interface MonthDay {
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

/**
 * 简单提醒什么时候响：一次性的写具体时刻；重复的写规则（每天、每 N 天、每周几、每月几号、每年某月某日、按我的工作日，
 * 都在本地时间的某个钟点）。
 */
export const ReminderSchedule = Type.Union([
  /** 一次性：带时区偏移的 ISO 时间 */
  Type.Object({ kind: Type.Literal("once"), at: Type.String({ minLength: 16 }) }),
  Type.Object({ kind: Type.Literal("daily"), time: ClockTime }),
  /** 每 N 天：从起算日那天起，每隔 interval 天（按本地日历日数）在 time 响 */
  Type.Object({
    kind: Type.Literal("everyNDays"),
    time: ClockTime,
    // @i18n-ignore-start model：时间表的字段说明（负责人写运营方案时看）
    interval: Type.Integer({ minimum: EVERY_N_DAYS_MIN, maximum: EVERY_N_DAYS_MAX, description: "每几天一次（2–365）：隔一天（每两天一次）是 2" }),
    anchor: Type.String({ pattern: LOCAL_DATE_PATTERN, description: "起算日：本地日期 YYYY-MM-DD，这天响第一次，之后每 interval 天一次" }),
    // @i18n-ignore-end
  }),
  /** 每周几：0 是周日（和 Date.getDay 一致） */
  Type.Object({ kind: Type.Literal("weekly"), time: ClockTime, weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }) }),
  /** 每月几号：这个月没有这一天（比如 2 月的 30 号）就在这个月的最后一天响 */
  Type.Object({ kind: Type.Literal("monthly"), time: ClockTime, days: Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { minItems: 1, maxItems: 31 }) }),
  /** 每年某月某日（公历）：2 月 29 日在平年的 2 月 28 日响 */
  Type.Object({ kind: Type.Literal("yearly"), time: ClockTime, month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }) }),
  /** 按我的工作日：个人工作日历上的上班日（新加坡或国内的工作日、调休补班、额外规则、手动标记） */
  Type.Object({ kind: Type.Literal("workdays"), time: ClockTime }),
]);
export type ReminderSchedule = Static<typeof ReminderSchedule>;

/** 重复规则（秘书工具的参数、提醒卡编辑框里的选择）：种类，加上每 N 天的 N 和起算日、每周几、每月几号、每年的几月几日 */
export const RepeatRule = Type.Object(
  {
    // @i18n-ignore-start model：工具参数的说明
    kind: Type.Enum(REPEAT_KINDS, {
      description:
        "daily 每天；everyNDays 每 N 天（\"隔一天\"\"每两天\"是 2，\"每三天\"是 3：给 interval，从 anchor 那天起算）；weekly 每周几；monthly 每月几号；yearly 每年某月某日（公历；农历的日子每年落在公历的不同天，不能用它）；workdays 按我的工作日（用户的上班日，含调休补班，去掉休息日）",
    }),
    interval: Type.Optional(Type.Integer({ minimum: EVERY_N_DAYS_MIN, maximum: EVERY_N_DAYS_MAX, description: "everyNDays 时：每几天一次（2–365），隔一天就是 2" })),
    anchor: Type.Optional(
      Type.String({
        pattern: LOCAL_DATE_PATTERN,
        description: "everyNDays 时：从哪天起算（本地日期 YYYY-MM-DD，这天响第一次，之后每 interval 天一次）；不给就是今天（今天这个钟点已经过了，第一次就是 interval 天后）",
      }),
    ),
    weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { description: "weekly 时：周几，0 是周日、1 是周一……6 是周六" })),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { description: "monthly 时：几号（这个月没有这一天就在月底那天响）" })),
    month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "yearly 时：几月（1–12，公历）" })),
    day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: "yearly 时：几日（要是日历上有的日子；2 月 29 日在平年的 2 月 28 日响）" })),
    // @i18n-ignore-end
  },
  { description: "重复规则；不给就是一次性的" }, // @i18n-ignore model
);
export type RepeatRule = Static<typeof RepeatRule>;

/**
 * 按重复规则在某个钟点拼出时间表（周几、几号去重排好）；规则不全时说明缺什么。
 * 每 N 天没给起算日的从 today 那天起算（不给 today 就是此刻；守护进程传它自己的时钟）
 */
export function repeatSchedule(rule: RepeatRule, time: string, today: Date = new Date()): { schedule: ReminderSchedule } | { error: string } {
  switch (rule.kind) {
    case "daily":
      return { schedule: { kind: "daily", time } };
    case "everyNDays": {
      const { interval } = rule;
      if (interval === undefined || !Number.isInteger(interval) || interval < EVERY_N_DAYS_MIN || interval > EVERY_N_DAYS_MAX) return { error: t("protocol.schedule.needInterval", { min: EVERY_N_DAYS_MIN, max: EVERY_N_DAYS_MAX }) };
      const anchor = rule.anchor ?? localDate(today);
      if (!isLocalDate(anchor)) return { error: t("protocol.schedule.badAnchor", { date: anchor }) };
      return { schedule: { kind: "everyNDays", time, interval, anchor } };
    }
    case "weekly": {
      const weekdays = uniqueSorted(rule.weekdays ?? []);
      if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: t("protocol.schedule.needWeekdays") };
      return { schedule: { kind: "weekly", time, weekdays } };
    }
    case "monthly": {
      const days = uniqueSorted(rule.days ?? []);
      if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return { error: t("protocol.schedule.needDays") };
      return { schedule: { kind: "monthly", time, days } };
    }
    case "yearly": {
      const { month, day } = rule;
      if (month === undefined || day === undefined || !isMonthDay({ month, day })) return { error: t("protocol.schedule.needMonthDay") };
      return { schedule: { kind: "yearly", time, month, day } };
    }
    case "workdays":
      return { schedule: { kind: "workdays", time } };
  }
}

/** 时间表的重复规则；一次性的没有 */
export function repeatRuleOf(schedule: ReminderSchedule): RepeatRule | undefined {
  switch (schedule.kind) {
    case "once":
      return undefined;
    case "daily":
      return { kind: "daily" };
    case "everyNDays":
      return { kind: "everyNDays", interval: schedule.interval, anchor: schedule.anchor };
    case "weekly":
      return { kind: "weekly", weekdays: schedule.weekdays };
    case "monthly":
      return { kind: "monthly", days: schedule.days };
    case "yearly":
      return { kind: "yearly", month: schedule.month, day: schedule.day };
    case "workdays":
      return { kind: "workdays" };
  }
}

/** 下一次响的时间跟不跟着个人工作日历变（工作日历改了，提醒、作业要按新日历重算下一次的，只有这些） */
export function dependsOnWorkdayCalendar(schedule: ReminderSchedule): boolean {
  return schedule.kind === "workdays";
}

/** 是不是重复的（一次性的响过就结束；重复的一直待触发） */
export function isRepeating(schedule: ReminderSchedule): boolean {
  return repeatRuleOf(schedule) !== undefined;
}

/**
 * 交来的重复时间表（只过了 schema 的：网页上改的、负责人写进运营方案的）按规则拼不出来时，说明错在哪（每年 2 月 30 日、
 * 每 N 天的起算日 2026-02-30）；拼得出来的、一次性的是 undefined
 */
export function repeatScheduleError(schedule: ReminderSchedule): string | undefined {
  const rule = repeatRuleOf(schedule);
  const made = rule && repeatSchedule(rule, scheduleClockTime(schedule));
  return made && "error" in made ? made.error : undefined;
}

/** 时间表的钟点（HH:mm，本地时间） */
export function scheduleClockTime(schedule: ReminderSchedule): string {
  if (schedule.kind !== "once") return schedule.time;
  const at = new Date(schedule.at);
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** 只改钟点：重复的还按原来的规则，一次性的还在原来那天 */
export function withClockTime(schedule: ReminderSchedule, time: string): ReminderSchedule {
  if (schedule.kind !== "once") return { ...schedule, time };
  const day = new Date(schedule.at);
  const [hh, mm] = splitClock(time);
  return { kind: "once", at: nowIso(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm)) };
}

/**
 * 规则下一次该响的时刻：严格晚于 after；一次性的已经响过（或过了点）就没有下一次。
 * "按我的工作日"按 context 里当时的工作日历算。
 */
export function nextOccurrence(schedule: ReminderSchedule, after: Date, context: ScheduleContext): Date | undefined {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : undefined;
    }
    case "daily":
      return nextClockTime(schedule.time, after);
    case "everyNDays":
      return nextEveryNDays(schedule.anchor, schedule.interval, schedule.time, after);
    case "weekly":
      return firstDayFrom(after, schedule.time, 8, (day) => schedule.weekdays.includes(day.getDay()));
    case "monthly": {
      const [hh, mm] = splitClock(schedule.time);
      // 最多看到 13 个月以后：每个月里按几号排，这个月没有的号数落到月底
      for (let i = 0; i <= 13; i++) {
        const year = after.getFullYear();
        const month = after.getMonth() + i;
        const lastDay = new Date(year, month + 1, 0).getDate();
        for (const d of uniqueSorted(schedule.days.map((x) => Math.min(x, lastDay)))) {
          const at = new Date(year, month, d, hh, mm);
          if (at.getTime() > after.getTime()) return at;
        }
      }
      return undefined;
    }
    case "yearly": {
      const [hh, mm] = splitClock(schedule.time);
      // 今年的还没到就是今年，到了或过了就是明年；这一年的这个月没有这一天（平年的 2 月 29 日）就在这个月的最后一天
      for (const year of [after.getFullYear(), after.getFullYear() + 1]) {
        const at = new Date(year, schedule.month - 1, Math.min(schedule.day, daysInMonth(year, schedule.month)), hh, mm);
        if (at.getTime() > after.getTime()) return at;
      }
      return undefined;
    }
    case "workdays":
      // 往后最多看两年：手动标了一长串休息日也找得到下一个上班日
      return firstDayFrom(after, schedule.time, WORKDAY_SEARCH_DAYS, (day) => context.calendar.isWorkday(day));
  }
}

/**
 * 时间表在 [from, to) 之间的每次触发时刻，先到的在前（日历上展开定时作业、提醒用）；"按我的工作日"按 context 里
 * 当时的工作日历算。最多 limit 个（防御：每分钟一次的规则展开很长的区间时截断）
 */
export function occurrencesBetween(schedule: ReminderSchedule, from: Date, to: Date, context: ScheduleContext, limit = 1000): Date[] {
  const out: Date[] = [];
  // nextOccurrence 严格晚于给的时刻：往前挪 1 毫秒，正好在 from 的那一次也算
  let at = nextOccurrence(schedule, new Date(from.getTime() - 1), context);
  while (at && at.getTime() < to.getTime() && out.length < limit) {
    out.push(at);
    at = nextOccurrence(schedule, at, context);
  }
  return out;
}

/**
 * 守护进程停着期间错过的触发：从 first（错过的第一次）往后数，最后一个不晚于 now 的时刻，
 * 连同一共错过了几次。重复的简单提醒错过多次只按最近一次处理；定时作业错过几次都只补跑一次（运行记录写明错过了几次）
 */
export function latestOccurrence(schedule: ReminderSchedule, first: Date, now: Date, context: ScheduleContext): { due: Date; count: number } {
  let due = first;
  let count = 1;
  // 上限只是防御：每分钟一次也够看几十天
  for (let i = 0; i < 100_000; i++) {
    const next = nextOccurrence(schedule, due, context);
    if (!next || next.getTime() > now.getTime()) break;
    due = next;
    count += 1;
  }
  return { due, count };
}

/** 找下一个上班日最多往后看几天 */
const WORKDAY_SEARCH_DAYS = 732;

/** 这个钟点下一次出现的时刻（严格晚于 after：今天还没到就是今天，到了或过了就是明天） */
export function nextClockTime(time: string, after: Date): Date {
  return firstDayFrom(after, time, 2, () => true)!;
}

/** 一个时刻的中文写法：10 月 8 日（周四）09:00；和 reference 不在同一年时带上年份 */
export function describeTime(at: Date, reference: Date = at): string {
  const params = {
    year: at.getFullYear(),
    month: monthName(at.getMonth() + 1),
    day: at.getDate(),
    weekday: weekdayChar(at.getDay()),
    time: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
  };
  return at.getFullYear() === reference.getFullYear() ? t("protocol.schedule.time", params) : t("protocol.schedule.timeWithYear", params);
}

/**
 * 时间表的中文写法：10 月 8 日（周四）09:00 / 每天 09:00 / 每 2 天 20:00，从 11 月 3 日起 / 每周一、三、五 19:00 /
 * 每月 1、31 号 09:00（没有这天的月份在月底）/ 每年 3 月 2 日 09:00 / 每年 2 月 29 日 09:00（平年在 2 月 28 日）/ 按我的工作日 09:00。
 * 给了 reference：一次性的时刻、每 N 天的起算日和它不在同一年时带上年份
 */
export function describeSchedule(schedule: ReminderSchedule, reference?: Date): string {
  switch (schedule.kind) {
    case "once":
      return describeTime(new Date(schedule.at), reference);
    case "daily":
      return t("protocol.schedule.daily", { time: schedule.time });
    case "everyNDays":
      return t("protocol.schedule.everyNDays", { n: schedule.interval, time: schedule.time, from: anchorText(schedule.anchor, reference) });
    case "weekly":
      return t("protocol.schedule.weekly", { days: schedule.weekdays.map(weekdayChar).join(t("protocol.common.listSep")), time: schedule.time });
    case "monthly": {
      const note = schedule.days.some((d) => d > 28) ? t("protocol.schedule.monthEndNote") : "";
      return t("protocol.schedule.monthly", { days: schedule.days.join(t("protocol.common.listSep")), time: schedule.time, note });
    }
    case "yearly": {
      const note = schedule.month === 2 && schedule.day === 29 ? t("protocol.schedule.leapDayNote") : "";
      return t("protocol.schedule.yearly", { month: monthName(schedule.month), day: schedule.day, time: schedule.time, note });
    }
    case "workdays":
      return t("protocol.schedule.workdays", { label: REPEAT_KIND_LABEL.workdays, time: schedule.time });
  }
}

/**
 * 秘书给的重复规则写成一句（聊天里看它调了什么工具用）；拼不出来的是 undefined。
 * 每 N 天没给起算日的不写从哪天起：起算日是调用那天，事后再看时已经不是"今天"了
 */
export function describeRepeatRule(rule: RepeatRule, time: string): string | undefined {
  const made = repeatSchedule(rule, time);
  if ("error" in made) return undefined;
  if (made.schedule.kind === "everyNDays" && rule.anchor === undefined) return t("protocol.schedule.everyNDaysOpen", { n: made.schedule.interval, time });
  return describeSchedule(made.schedule);
}

/** 本地日期（YYYY-MM-DD）的写法：11 月 3 日；给了 reference、不在同一年时带上年份。写法不对的原样返回 */
function anchorText(date: string, reference?: Date): string {
  if (!isLocalDate(date)) return date;
  const { year, month, day } = parseLocalDate(date);
  const params = { year, month: monthName(month), day };
  return reference === undefined || reference.getFullYear() === year ? t("protocol.schedule.date", params) : t("protocol.schedule.dateWithYear", params);
}

/** 是不是日历上有的本地日期 YYYY-MM-DD（2026-02-30 不是） */
function isLocalDate(date: string): boolean {
  try {
    parseLocalDate(date);
    return true;
  } catch {
    return false;
  }
}

/** 几点的写法规范成 HH:mm（"9:00" → "09:00"）；不是合法的钟点返回 undefined */
export function parseClockTime(value: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? `${pad2(hh)}:${pad2(mm)}` : undefined;
}

/** 某月（1–12）最多几日：每年的提醒能定到几日（2 月算 29 日，闰年有） */
export function maxDayOfMonth(month: number): number {
  return daysInMonth(LEAP_YEAR, month);
}

/** 是不是日历上有的某月某日（2 月 29 日算有：闰年有） */
export function isMonthDay(value: MonthDay): boolean {
  const { month, day } = value;
  return Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= maxDayOfMonth(month);
}

/**
 * 某月某日往前数几天是哪一天（生日、纪念日"提前 3 天提醒"）：3 月 2 日提前 3 天是 2 月 27 日，1 月 1 日提前 3 天是
 * 12 月 29 日。按平年数：只有 2 月 28 日之后 n 天以内的日子（提前 3 天时是 3 月 1–3 日）在闰年会多提前 1 天（3 月 2 日提前 3 天
 * 在闰年也是 2 月 27 日），别的日子不受影响；2 月 29 日往前数和闰年一样（提前 3 天是 2 月 26 日）；提前 0 天就是原来那天。
 * 结果拿去按每年拼时间表（repeatSchedule）
 */
export function monthDayBefore(date: MonthDay, days: number): MonthDay {
  if (days <= 0) return { month: date.month, day: date.day };
  // 平年里 2 月 29 日落在 3 月 1 日：往前数 n 天正好和闰年里从 2 月 29 日往前数一样
  const at = new Date(Date.UTC(COMMON_YEAR, date.month - 1, date.day - days));
  return { month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** 判断某月最多几号用的闰年、往前数几天用的平年（只看月日，哪一年都行） */
const LEAP_YEAR = 2000;
const COMMON_YEAR = 2001;

const DAY_MS = 86_400_000;

/**
 * 每 N 天的下一次（严格晚于 after）：起算日往后 k·N 个日历日（k ≥ 0）在 time 钟点，取第一个晚于 after 的。
 * 日子按本地日历的年月日数（new Date(年, 月, 日 + k·N, 时, 分) 由本地日历进位），所以夏令时切换那天也不漂；
 * 两个本地日期隔几天按 UTC 的零点相减（UTC 没有夏令时，正好整天数）。起算日写法不对的没有下一次
 */
function nextEveryNDays(anchor: string, interval: number, time: string, after: Date): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
  if (!m || !(interval >= 1)) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const [hh, mm] = splitClock(time);
  const elapsed = Math.round((Date.UTC(after.getFullYear(), after.getMonth(), after.getDate()) - Date.UTC(year, month, day)) / DAY_MS);
  // 不晚于 after 那天的最后一个落点；那天的钟点已经过了就是再往后一个（多看一个只是防御）
  for (let k = Math.max(0, Math.floor(elapsed / interval)), end = k + 2; k <= end; k++) {
    const at = new Date(year, month, day + k * interval, hh, mm);
    if (at.getTime() > after.getTime()) return at;
  }
  return undefined;
}

/** 从 after 那天起往后 span 天里，第一个符合条件的日子在 time 钟点的时刻（严格晚于 after） */
function firstDayFrom(after: Date, time: string, span: number, ok: (day: Date) => boolean): Date | undefined {
  const [hh, mm] = splitClock(time);
  for (let i = 0; i <= span; i++) {
    const at = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, hh, mm);
    if (at.getTime() > after.getTime() && ok(at)) return at;
  }
  return undefined;
}

function splitClock(time: string): [number, number] {
  const [hh, mm] = time.split(":").map(Number);
  return [hh ?? 0, mm ?? 0];
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b);
}
