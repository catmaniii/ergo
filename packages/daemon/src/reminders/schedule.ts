// 简单提醒的时间规则（纯函数，不看时钟：现在几点由调用方传入）。
// - resolveReminderTime：秘书在工具里给的时间（几点、哪天、几天后、几分钟后、重复规则）落成协议里的 ReminderSchedule；
//   秘书不一定知道今天几号，所以"明早 9 点"可以写成"1 天后 09:00"，日期由这里按现在的时间算出来。
// - nextOccurrence：规则下一次该在什么时候响（严格晚于给定时刻）。
// - describeSchedule / describeTime：给卡片的纯文本降级版本和工具结果用的中文写法。
// 都按本地时间（守护进程所在机器的时区）算。29 号票在这里加"按我的工作日"。
import { nowIso, type ReminderSchedule } from "@ergou/protocol";

/** 秘书给的时间（建提醒、改提醒的工具参数里和时间有关的部分）；照模型给的原样收，这里校验 */
export interface ReminderTimeSpec {
  /** 几点（HH:mm，24 小时制） */
  time?: string;
  /** 哪天：YYYY-MM-DD，或只写 MM-DD（取最近的将来那天） */
  date?: string;
  /** 几天后：0 是今天、1 是明天、2 是后天 */
  inDays?: number;
  /** 多少分钟后（"半小时后"）；给了就不再给钟点和日期 */
  inMinutes?: number;
  /** 重复规则；不给就是一次性的 */
  repeat?: { kind: string; weekdays?: number[]; days?: number[] };
}

/** 秘书给的时间不对：message 说明错在哪，作为工具结果交回秘书，让它改了再试 */
export class ReminderInputError extends Error {}

const MINUTE = 60_000;
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export function resolveReminderTime(spec: ReminderTimeSpec, now: Date): ReminderSchedule {
  const daySpecs = [spec.date, spec.inDays, spec.inMinutes].filter((v) => v !== undefined).length;
  if (spec.repeat !== undefined) {
    if (daySpecs > 0) throw new ReminderInputError("重复提醒不用给日期、几天后或几分钟后，只给几点（time）和重复规则（repeat）");
    const time = parseClock(spec.time, "重复提醒要给几点（time，HH:mm）");
    return resolveRepeat(spec.repeat, time);
  }
  if (spec.inMinutes !== undefined) {
    if (daySpecs > 1 || spec.time !== undefined) throw new ReminderInputError("date、inDays、inMinutes 只能给一种；给了 inMinutes 就不要再给 time");
    if (!Number.isInteger(spec.inMinutes) || spec.inMinutes <= 0) throw new ReminderInputError(`inMinutes 要是正整数（几分钟后），收到的是 ${String(spec.inMinutes)}`);
    const at = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE + spec.inMinutes * MINUTE);
    return { kind: "once", at: nowIso(at) };
  }
  if (daySpecs > 1) throw new ReminderInputError("date、inDays、inMinutes 只能给一种");
  const time = parseClock(spec.time, "一次性提醒要给几点（time，HH:mm），或者用 inMinutes 写几分钟后");
  const [hh, mm] = splitClock(time);
  let at: Date;
  if (spec.date !== undefined) {
    at = resolveDate(spec.date, hh, mm, now);
  } else if (spec.inDays !== undefined) {
    if (!Number.isInteger(spec.inDays) || spec.inDays < 0) throw new ReminderInputError(`inDays 要是不小于 0 的整数（0 是今天、1 是明天），收到的是 ${String(spec.inDays)}`);
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + spec.inDays, hh, mm);
  } else {
    // 只给钟点：今天还没到就是今天，过了就是明天
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
    if (at.getTime() <= now.getTime()) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hh, mm);
  }
  if (at.getTime() <= now.getTime()) throw new ReminderInputError(`这个时间已经过去了：${describeTime(at, now)}（现在是 ${describeTime(now, now)}）`);
  return { kind: "once", at: nowIso(at) };
}

function resolveRepeat(repeat: NonNullable<ReminderTimeSpec["repeat"]>, time: string): ReminderSchedule {
  switch (repeat.kind) {
    case "daily":
      return { kind: "daily", time };
    case "weekly": {
      const weekdays = uniqueSorted(repeat.weekdays ?? []);
      if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new ReminderInputError("每周提醒要给周几（weekdays，0 是周日、1 是周一……6 是周六）");
      }
      return { kind: "weekly", time, weekdays };
    }
    case "monthly": {
      const days = uniqueSorted(repeat.days ?? []);
      if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) throw new ReminderInputError("每月提醒要给几号（days，1–31）");
      return { kind: "monthly", time, days };
    }
    default:
      throw new ReminderInputError(`不认识的重复规则：${repeat.kind}（支持 daily、weekly、monthly）`);
  }
}

/** 规则下一次该响的时刻：严格晚于 after；一次性的已经响过（或过了点）就没有下一次 */
export function nextOccurrence(schedule: ReminderSchedule, after: Date): Date | undefined {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : undefined;
    }
    case "daily":
      return firstDayFrom(after, schedule.time, 2, () => true);
    case "weekly":
      return firstDayFrom(after, schedule.time, 8, (day) => schedule.weekdays.includes(day.getDay()));
    case "monthly": {
      const [hh, mm] = splitClock(schedule.time);
      // 最多看到 13 个月以后：每个月里按几号排，这个月没有的号数落到月底
      for (let i = 0; i <= 13; i++) {
        const year = after.getFullYear();
        const month = after.getMonth() + i;
        const lastDay = new Date(year, month + 1, 0).getDate();
        const candidates = uniqueSorted(schedule.days.map((d) => Math.min(d, lastDay)));
        for (const d of candidates) {
          const at = new Date(year, month, d, hh, mm);
          if (at.getTime() > after.getTime()) return at;
        }
      }
      return undefined;
    }
  }
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

/** 一个时刻的中文写法：10 月 8 日（周四）09:00；和 reference 不在同一年时带上年份 */
export function describeTime(at: Date, reference: Date = at): string {
  const year = at.getFullYear() === reference.getFullYear() ? "" : `${at.getFullYear()} 年 `;
  return `${year}${at.getMonth() + 1} 月 ${at.getDate()} 日（周${WEEKDAY_NAMES[at.getDay()]}）${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** 规则的中文写法：10 月 8 日（周四）09:00 / 每天 09:00 / 每周一、三、五 19:00 / 每月 1、15 号 09:00 */
export function describeSchedule(schedule: ReminderSchedule, reference?: Date): string {
  switch (schedule.kind) {
    case "once":
      return describeTime(new Date(schedule.at), reference);
    case "daily":
      return `每天 ${schedule.time}`;
    case "weekly":
      return `每周${schedule.weekdays.map((d) => WEEKDAY_NAMES[d]).join("、")} ${schedule.time}`;
    case "monthly":
      return `每月 ${schedule.days.join("、")} 号 ${schedule.time}`;
  }
}

function parseClock(value: string | undefined, missing: string): string {
  if (value === undefined) throw new ReminderInputError(missing);
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) throw new ReminderInputError(`几点的写法不对：${value}（写 HH:mm，24 小时制）`);
  return `${pad2(hh)}:${pad2(mm)}`;
}

function splitClock(time: string): [number, number] {
  const [hh, mm] = time.split(":").map(Number);
  return [hh ?? 0, mm ?? 0];
}

function resolveDate(value: string, hh: number, mm: number, now: Date): Date {
  const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!m) throw new ReminderInputError(`日期写法不对：${value}（写 YYYY-MM-DD，或者只写 MM-DD）`);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const exists = (year: number) => {
    const d = new Date(year, month, day, hh, mm);
    return d.getMonth() === month && d.getDate() === day ? d : undefined;
  };
  if (m[1] !== undefined) {
    const d = exists(Number(m[1]));
    if (!d) throw new ReminderInputError(`日期不存在：${value}`);
    return d;
  }
  // 只写月日：今年的还没过就是今年，过了就是明年
  const thisYear = exists(now.getFullYear());
  if (thisYear && thisYear.getTime() > now.getTime()) return thisYear;
  const nextYear = exists(now.getFullYear() + 1);
  if (!nextYear) throw new ReminderInputError(`日期不存在：${value}`);
  return nextYear;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
