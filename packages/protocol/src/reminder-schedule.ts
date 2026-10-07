// 简单提醒的时间规则：协议里的 ReminderSchedule（schema 和类型），以及所有按规则种类（一次性、每天、每周几、每月几号、
// 按我的工作日）分支的逻辑：下一次响的时间、钟点、只改钟点、按重复规则拼出时间表、中文写法。
// 守护进程（提醒模块、秘书的工具、内部作业）和 Web（提醒卡、看板）都用这一份，别处不再按 schedule.kind 分支。
// 定时作业（19 号票）的时间表也是它。时间都按本地时间算（守护进程所在机器、或浏览器的时区）。
//
// "按我的工作日"（29 号票）：只在个人工作日历（workday-calendar.ts）上的上班日的那个钟点响。工作日历由调用方经
// ScheduleContext 传给 nextOccurrence（必填：漏传在编译时就报错），每次按当时的工作日历算：工作日历改了（某天标成休息），
// 下一次跟着变，不用重建提醒。哪些时间表要跟着工作日历变，看 dependsOnWorkdayCalendar。
import { type Static, Type } from "typebox";
import { pad2, weekdayChar } from "./local-date.ts";
import { nowIso } from "./time.ts";
import type { WorkdayCalendar } from "./workday-calendar.ts";

/** 算下一次时要的东西：当前的个人工作日历（"按我的工作日"按它算；别的规则用不上，但调用方总要给） */
export interface ScheduleContext {
  calendar: WorkdayCalendar;
}

/** 重复规则的种类（一次性的不算重复） */
export const REPEAT_KINDS = ["daily", "weekly", "monthly", "workdays"] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const REPEAT_KIND_LABEL: Readonly<Record<RepeatKind, string>> = { daily: "每天", weekly: "每周几", monthly: "每月几号", workdays: "按我的工作日" };

/** 一天里的几点几分（24 小时制，本地时间） */
export const ClockTime = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" });

/**
 * 简单提醒什么时候响：一次性的写具体时刻；重复的写规则（每天、每周几、每月几号、按我的工作日，都在本地时间的某个钟点）。
 */
export const ReminderSchedule = Type.Union([
  /** 一次性：带时区偏移的 ISO 时间 */
  Type.Object({ kind: Type.Literal("once"), at: Type.String({ minLength: 16 }) }),
  Type.Object({ kind: Type.Literal("daily"), time: ClockTime }),
  /** 每周几：0 是周日（和 Date.getDay 一致） */
  Type.Object({ kind: Type.Literal("weekly"), time: ClockTime, weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }) }),
  /** 每月几号：这个月没有这一天（比如 2 月的 30 号）就在这个月的最后一天响 */
  Type.Object({ kind: Type.Literal("monthly"), time: ClockTime, days: Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { minItems: 1, maxItems: 31 }) }),
  /** 按我的工作日：个人工作日历上的上班日（新加坡或国内的工作日、调休补班、额外规则、手动标记） */
  Type.Object({ kind: Type.Literal("workdays"), time: ClockTime }),
]);
export type ReminderSchedule = Static<typeof ReminderSchedule>;

/** 重复规则（秘书工具的参数、提醒卡编辑框里的选择）：种类，加上每周几、每月几号 */
export const RepeatRule = Type.Object(
  {
    kind: Type.Enum(REPEAT_KINDS, { description: "daily 每天；weekly 每周几；monthly 每月几号；workdays 按我的工作日（用户的上班日，含调休补班，去掉休息日）" }),
    weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { description: "weekly 时：周几，0 是周日、1 是周一……6 是周六" })),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { description: "monthly 时：几号（这个月没有这一天就在月底那天响）" })),
  },
  { description: "重复规则；不给就是一次性的" },
);
export type RepeatRule = Static<typeof RepeatRule>;

/** 按重复规则在某个钟点拼出时间表（周几、几号去重排好）；规则不全时说明缺什么 */
export function repeatSchedule(rule: RepeatRule, time: string): { schedule: ReminderSchedule } | { error: string } {
  switch (rule.kind) {
    case "daily":
      return { schedule: { kind: "daily", time } };
    case "weekly": {
      const weekdays = uniqueSorted(rule.weekdays ?? []);
      if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: "每周提醒要给周几（weekdays，0 是周日、1 是周一……6 是周六）" };
      return { schedule: { kind: "weekly", time, weekdays } };
    }
    case "monthly": {
      const days = uniqueSorted(rule.days ?? []);
      if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return { error: "每月提醒要给几号（days，1–31）" };
      return { schedule: { kind: "monthly", time, days } };
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
    case "weekly":
      return { kind: "weekly", weekdays: schedule.weekdays };
    case "monthly":
      return { kind: "monthly", days: schedule.days };
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
    case "workdays":
      // 往后最多看两年：手动标了一长串休息日也找得到下一个上班日
      return firstDayFrom(after, schedule.time, WORKDAY_SEARCH_DAYS, (day) => context.calendar.isWorkday(day));
  }
}

/** 找下一个上班日最多往后看几天 */
const WORKDAY_SEARCH_DAYS = 732;

/** 这个钟点下一次出现的时刻（严格晚于 after：今天还没到就是今天，到了或过了就是明天） */
export function nextClockTime(time: string, after: Date): Date {
  return firstDayFrom(after, time, 2, () => true)!;
}

/** 一个时刻的中文写法：10 月 8 日（周四）09:00；和 reference 不在同一年时带上年份 */
export function describeTime(at: Date, reference: Date = at): string {
  const year = at.getFullYear() === reference.getFullYear() ? "" : `${at.getFullYear()} 年 `;
  return `${year}${at.getMonth() + 1} 月 ${at.getDate()} 日（周${weekdayChar(at.getDay())}）${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/**
 * 时间表的中文写法：10 月 8 日（周四）09:00 / 每天 09:00 / 每周一、三、五 19:00 /
 * 每月 1、31 号 09:00（没有这天的月份在月底）/ 按我的工作日 09:00
 */
export function describeSchedule(schedule: ReminderSchedule, reference?: Date): string {
  switch (schedule.kind) {
    case "once":
      return describeTime(new Date(schedule.at), reference);
    case "daily":
      return `每天 ${schedule.time}`;
    case "weekly":
      return `每周${schedule.weekdays.map(weekdayChar).join("、")} ${schedule.time}`;
    case "monthly": {
      const note = schedule.days.some((d) => d > 28) ? "（没有这天的月份在月底）" : "";
      return `每月 ${schedule.days.join("、")} 号 ${schedule.time}${note}`;
    }
    case "workdays":
      return `${REPEAT_KIND_LABEL.workdays} ${schedule.time}`;
  }
}

/** 几点的写法规范成 HH:mm（"9:00" → "09:00"）；不是合法的钟点返回 undefined */
export function parseClockTime(value: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? `${pad2(hh)}:${pad2(mm)}` : undefined;
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
