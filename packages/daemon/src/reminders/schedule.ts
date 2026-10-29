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
  repeatRuleOf,
  repeatSchedule,
  type ScheduleContext,
  scheduleClockTime,
  withClockTime,
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { parseLocalDateTime } from "../util/local-date-time.ts";

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
    if (daySpecs > 0) throw new ReminderInputError(t("reminders.schedule.repeatNoDay"));
    const result = repeatSchedule(spec.repeat, clock(spec.time, t("reminders.schedule.repeatNeedTime")));
    if ("error" in result) throw new ReminderInputError(result.error);
    return result.schedule;
  }
  if (daySpecs > 1) throw new ReminderInputError(t("reminders.schedule.oneDaySpec"));
  let at: Date;
  if (spec.at !== undefined) {
    if (spec.time !== undefined) throw new ReminderInputError(t("reminders.schedule.atNoTime"));
    at = localDateTime(spec.at);
  } else if (spec.inMinutes !== undefined) {
    if (spec.time !== undefined) throw new ReminderInputError(t("reminders.schedule.inMinutesNoTime"));
    if (!Number.isInteger(spec.inMinutes) || spec.inMinutes <= 0) throw new ReminderInputError(t("reminders.schedule.badInMinutes", { value: String(spec.inMinutes) }));
    at = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE + spec.inMinutes * MINUTE);
  } else {
    const [hh, mm] = clock(spec.time, t("reminders.schedule.onceNeedTime")).split(":").map(Number) as [number, number];
    const onDay = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh, mm);
    if (spec.date !== undefined) {
      at = resolveDate(spec.date, hh, mm, now);
    } else if (spec.inDays !== undefined) {
      if (!Number.isInteger(spec.inDays) || spec.inDays < 0) throw new ReminderInputError(t("reminders.schedule.badInDays", { value: String(spec.inDays) }));
      at = onDay(spec.inDays);
    } else if (spec.weekday !== undefined) {
      const weekday = spec.weekday;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ReminderInputError(t("reminders.schedule.badWeekday", { value: String(weekday) }));
      // 最近的那个周几：今天就是、钟点还没到就是今天，否则往后数
      let offset = (weekday - now.getDay() + 7) % 7;
      if (onDay(offset).getTime() <= now.getTime()) offset += 7;
      at = onDay(offset);
    } else {
      // 只给钟点：今天还没到就是今天，过了就是明天
      at = onDay(0).getTime() > now.getTime() ? onDay(0) : onDay(1);
    }
  }
  if (at.getTime() <= now.getTime()) throw new ReminderInputError(t("reminders.schedule.passed", { at: describeTime(at, now), now: describeTime(now) }));
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
  if (time === undefined) throw new ReminderInputError(t("reminders.schedule.badTime", { value }));
  return time;
}

/** 具体的本地日期时间：YYYY-MM-DD HH:mm（也认 YYYY-MM-DDTHH:mm）；写法不对、日期不存在的抛 ReminderInputError */
const localDateTime = (value: string): Date => parseLocalDateTime(value, (message) => new ReminderInputError(message));

function resolveDate(value: string, hh: number, mm: number, now: Date): Date {
  const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!m) throw new ReminderInputError(t("reminders.schedule.badDate", { value }));
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const exists = (year: number) => {
    const d = new Date(year, month, day, hh, mm);
    return d.getMonth() === month && d.getDate() === day ? d : undefined;
  };
  if (m[1] !== undefined) {
    const d = exists(Number(m[1]));
    if (!d) throw new ReminderInputError(t("reminders.schedule.noSuchDate", { value }));
    return d;
  }
  // 只写月日：今年的还没过就是今年，过了就是明年
  const thisYear = exists(now.getFullYear());
  if (thisYear && thisYear.getTime() > now.getTime()) return thisYear;
  const nextYear = exists(now.getFullYear() + 1);
  if (!nextYear) throw new ReminderInputError(t("reminders.schedule.noSuchDate", { value }));
  return nextYear;
}

/**
 * 规则下一次响的时间（"按我的工作日"按 context 里的工作日历算）；没有下一次（一次性的时刻已经过了，或者写法不对）就说明错在哪。
 * 从网页来的时间表（提醒卡上改的、发起对话框里建的）只过了 schema：重复规则拼不出来的（每年 2 月 30 日，282 号票）在这里拦下
 */
export function nextAtOf(schedule: ReminderSchedule, now: Date, context: ScheduleContext): string {
  const rule = repeatRuleOf(schedule);
  const made = rule && repeatSchedule(rule, scheduleClockTime(schedule));
  if (made && "error" in made) throw new ReminderInputError(made.error);
  const next = nextOccurrence(schedule, now, context);
  if (!next) throw new ReminderInputError(t("reminders.schedule.passedSchedule", { schedule: describeSchedule(schedule, now), now: describeTime(now) }));
  return nowIso(next);
}
