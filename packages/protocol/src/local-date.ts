// 本地日期和星期的小工具：日期写成 YYYY-MM-DD（不带时区，只关心是哪一天），星期 0 是周日（和 Date.getDay 一致）。
// 时间规则（reminder-schedule.ts）和工作日历（workday-calendar.ts）共用，守护进程校验节假日数据也用这里的 parseLocalDate。
// 不引用 TypeBox。
import { t, tTable } from "./i18n/runtime.ts";

/** 周几的名字（跟着当前语言：周日 / Sun） */
const WEEKDAY_NAMES: Readonly<Record<string, string>> = tTable({
  0: "protocol.date.weekday.0",
  1: "protocol.date.weekday.1",
  2: "protocol.date.weekday.2",
  3: "protocol.date.weekday.3",
  4: "protocol.date.weekday.4",
  5: "protocol.date.weekday.5",
  6: "protocol.date.weekday.6",
});

/** 周几的那一个字（"每周一、三、五"这种写法用；英文是 Mon 这种） */
const WEEKDAY_CHARS: Readonly<Record<string, string>> = tTable({
  0: "protocol.date.weekdayChar.0",
  1: "protocol.date.weekdayChar.1",
  2: "protocol.date.weekdayChar.2",
  3: "protocol.date.weekdayChar.3",
  4: "protocol.date.weekdayChar.4",
  5: "protocol.date.weekdayChar.5",
  6: "protocol.date.weekdayChar.6",
});

/** 月份的写法（日期里用："10 月" / "Oct"） */
const MONTH_NAMES: Readonly<Record<string, string>> = tTable({
  1: "protocol.date.month.1",
  2: "protocol.date.month.2",
  3: "protocol.date.month.3",
  4: "protocol.date.month.4",
  5: "protocol.date.month.5",
  6: "protocol.date.month.6",
  7: "protocol.date.month.7",
  8: "protocol.date.month.8",
  9: "protocol.date.month.9",
  10: "protocol.date.month.10",
  11: "protocol.date.month.11",
  12: "protocol.date.month.12",
});

/** 月份（1–12）的写法：10 → "10 月"（英文 Oct） */
export function monthName(month: number): string {
  return Object.hasOwn(MONTH_NAMES, String(month)) ? MONTH_NAMES[String(month)]! : String(month);
}

/** 周几的全称（额外上班规则的写法用：周六 / Saturday） */
const WEEKDAY_LONG: Readonly<Record<string, string>> = tTable({
  0: "protocol.date.weekdayLong.0",
  1: "protocol.date.weekdayLong.1",
  2: "protocol.date.weekdayLong.2",
  3: "protocol.date.weekdayLong.3",
  4: "protocol.date.weekdayLong.4",
  5: "protocol.date.weekdayLong.5",
  6: "protocol.date.weekdayLong.6",
});

/** 周几的全称：0 → 周日（英文 Sunday） */
export function weekdayLongName(day: number): string {
  return Object.hasOwn(WEEKDAY_LONG, String(day)) ? WEEKDAY_LONG[String(day)]! : "?";
}

/** 周几的名字：0 → 周日（英文 Sun） */
export function weekdayName(day: number): string {
  return Object.hasOwn(WEEKDAY_NAMES, String(day)) ? WEEKDAY_NAMES[String(day)]! : "?";
}

/** 周几的那一个字：0 → 日（"每周一、三、五"这种写法用；英文 Sun） */
export function weekdayChar(day: number): string {
  return Object.hasOwn(WEEKDAY_CHARS, String(day)) ? WEEKDAY_CHARS[String(day)]! : "?";
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 一个本地日期拆开：年、月（1–12）、日、周几 */
export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/** 拆开 YYYY-MM-DD；写法不对或者日期不存在（2026-02-30）抛错 */
export function parseLocalDate(date: string): LocalDateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (!m || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) throw new Error(t("protocol.date.badDate", { date }));
  return { year, month, day, weekday: utc.getUTCDay() };
}

/** 年、月（1–12）、日 → YYYY-MM-DD */
export function localDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** 某一时刻在本地是哪一天：YYYY-MM-DD */
export function localDate(d: Date): string {
  return localDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 某年某月（1–12）有几天 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
