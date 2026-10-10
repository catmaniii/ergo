// 秘书在工具里给的时间 → 协议里的时间表（ReminderSchedule）。纯函数，不看时钟：现在几点由调用方传入。
// 时间可以写成：具体的本地日期时间（at）、哪天几点（date + time）、最近的周几几点（weekday + time）、
// 几天后几点（inDays + time）、几分钟后（inMinutes）、只给几点（今天没到就是今天，过了就是明天），
// 或者几点 + 重复规则（repeat）。按规则种类分支的逻辑都在共享协议包的 reminder-schedule.ts，这里不再分支。
import {
  describeSchedule,
  describeTime,
  nextOccurrence,
  nowIso,
  parseClockTime,
  type ReminderSchedule,
  type RepeatRule,
  repeatSchedule,
  type ScheduleContext,
  scheduleClockTime,
  withClockTime,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";

/** 秘书给的时间（建提醒、改提醒的工具参数里和时间有关的部分）；照模型给的原样收，这里校验 */
export interface ReminderTimeSpec {
  /** 具体的本地日期时间：YYYY-MM-DD HH:mm */
  at?: string;
  /** 几点（HH:mm，24 小时制） */
  time?: string;
  /** 哪天：YYYY-MM-DD，或只写 MM-DD（取最近的将来那天） */
  date?: string;
  /** 最近的那个周几（0 是周日……6 是周六）：今天就是这天、钟点还没到，就是今天 */
  weekday?: number;
  /** 几天后：0 是今天、1 是明天、2 是后天 */
  inDays?: number;
  /** 多少分钟后（"半小时后"）；给了就不再给钟点和日期 */
  inMinutes?: number;
  /** 重复规则；不给就是一次性的 */
  repeat?: RepeatRule;
}

/** 提醒的时间或内容不对：message 说明错在哪（交回秘书让它改了再试；从卡片上来的就是给用户看的错误） */
export class ReminderInputError extends RequestRejected {
  constructor(message: string) {
    super("bad_params", message);
  }
}

const MINUTE = 60_000;

export function resolveReminderTime(spec: ReminderTimeSpec, now: Date): ReminderSchedule {
  const daySpecs = [spec.at, spec.date, spec.weekday, spec.inDays, spec.inMinutes].filter((v) => v !== undefined).length;
  if (spec.repeat !== undefined) {
    if (daySpecs > 0) throw new ReminderInputError("重复提醒不用给 at、date、weekday、inDays 或 inMinutes，只给几点（time）和重复规则（repeat）");
    const result = repeatSchedule(spec.repeat, clock(spec.time, "重复提醒要给几点（time，HH:mm）"));
    if ("error" in result) throw new ReminderInputError(result.error);
    return result.schedule;
  }
  if (daySpecs > 1) throw new ReminderInputError("at、date、weekday、inDays、inMinutes 只能给一种");
  let at: Date;
  if (spec.at !== undefined) {
    if (spec.time !== undefined) throw new ReminderInputError("给了 at（日期和时间一起）就不要再给 time");
    at = parseLocalDateTime(spec.at);
  } else if (spec.inMinutes !== undefined) {
    if (spec.time !== undefined) throw new ReminderInputError("给了 inMinutes 就不要再给 time");
    if (!Number.isInteger(spec.inMinutes) || spec.inMinutes <= 0) throw new ReminderInputError(`inMinutes 要是正整数（几分钟后），收到的是 ${String(spec.inMinutes)}`);
    at = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE + spec.inMinutes * MINUTE);
  } else {
    const [hh, mm] = clock(spec.time, "一次性提醒要给几点（time，HH:mm），或者用 at 写日期时间、用 inMinutes 写几分钟后").split(":").map(Number) as [number, number];
    const onDay = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh, mm);
    if (spec.date !== undefined) {
      at = resolveDate(spec.date, hh, mm, now);
    } else if (spec.inDays !== undefined) {
      if (!Number.isInteger(spec.inDays) || spec.inDays < 0) throw new ReminderInputError(`inDays 要是不小于 0 的整数（0 是今天、1 是明天），收到的是 ${String(spec.inDays)}`);
      at = onDay(spec.inDays);
    } else if (spec.weekday !== undefined) {
      const weekday = spec.weekday;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ReminderInputError(`weekday 要是 0–6（0 是周日），收到的是 ${String(weekday)}`);
      // 最近的那个周几：今天就是、钟点还没到就是今天，否则往后数
      let offset = (weekday - now.getDay() + 7) % 7;
      if (onDay(offset).getTime() <= now.getTime()) offset += 7;
      at = onDay(offset);
    } else {
      // 只给钟点：今天还没到就是今天，过了就是明天
      at = onDay(0).getTime() > now.getTime() ? onDay(0) : onDay(1);
    }
  }
  if (at.getTime() <= now.getTime()) throw new ReminderInputError(`这个时间已经过去了：${describeTime(at, now)}（现在是 ${describeTime(now)}）`);
  return { kind: "once", at: nowIso(at) };
}

/**
 * 改提醒时新的时间表；没给和时间有关的参数就是不改（undefined）。
 * - 给了 repeat：换成新的重复规则（没给几点就沿用原来的钟点）；
 * - 给了 at、date、weekday、inDays 或 inMinutes：换成一次性的（没给几点就沿用原来的钟点），比如"改到周五"；
 * - 只给了几点：重复的还按原来的规则，一次性的还在原来那天。
 */
export function editedSchedule(current: ReminderSchedule, spec: ReminderTimeSpec, now: Date): ReminderSchedule | undefined {
  const hasDay = [spec.at, spec.date, spec.weekday, spec.inDays, spec.inMinutes].some((v) => v !== undefined);
  if (spec.repeat === undefined && !hasDay && spec.time === undefined) return undefined;
  const time = spec.time ?? scheduleClockTime(current);
  if (spec.repeat !== undefined) return resolveReminderTime({ time, repeat: spec.repeat }, now);
  if (hasDay) return resolveReminderTime(spec.at !== undefined || spec.inMinutes !== undefined ? spec : { ...spec, time }, now);
  return withClockTime(current, clock(spec.time, ""));
}

/** 几点；没给时用 missing 说明 */
function clock(value: string | undefined, missing: string): string {
  if (value === undefined) throw new ReminderInputError(missing);
  const time = parseClockTime(value);
  if (time === undefined) throw new ReminderInputError(`几点的写法不对：${value}（写 HH:mm，24 小时制）`);
  return time;
}

/** 具体的本地日期时间：YYYY-MM-DD HH:mm（也认 YYYY-MM-DDTHH:mm） */
/** "YYYY-MM-DD HH:mm"（本地时间）：写法不对、日期不存在的抛 ReminderInputError（秘书交给后台、某个时间做一次的也用它） */
export function parseLocalDateTime(value: string): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}:\d{2})$/.exec(value.trim());
  const time = m ? parseClockTime(m[4]!) : undefined;
  if (!m || time === undefined) throw new ReminderInputError(`at 的写法不对：${value}（写 YYYY-MM-DD HH:mm，本地时间）`);
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(year, month, day, hh, mm);
  if (at.getMonth() !== month || at.getDate() !== day) throw new ReminderInputError(`日期不存在：${value}`);
  return at;
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

/** 规则下一次响的时间（"按我的工作日"按 context 里的工作日历算）；没有下一次（一次性的时刻已经过了，或者写法不对）就说明错在哪 */
export function nextAtOf(schedule: ReminderSchedule, now: Date, context: ScheduleContext): string {
  const next = nextOccurrence(schedule, now, context);
  if (!next) throw new ReminderInputError(`这个时间已经过去了（或者写法不对）：${describeSchedule(schedule, now)}（现在是 ${describeTime(now)}）`);
  return nowIso(next);
}
