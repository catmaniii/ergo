// 本地日期和星期的小工具：日期写成 YYYY-MM-DD（不带时区，只关心是哪一天），星期 0 是周日（和 Date.getDay 一致）。
// 时间规则（reminder-schedule.ts）和工作日历（workday-calendar.ts）共用，守护进程校验节假日数据也用这里的 parseLocalDate。
// 不引用 TypeBox。

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** 周几的中文名：0 → 周日 */
export function weekdayName(day: number): string {
  return `周${WEEKDAY_NAMES[day] ?? "?"}`;
}

/** 周几的那一个字：0 → 日（"每周一、三、五"这种写法用） */
export function weekdayChar(day: number): string {
  return WEEKDAY_NAMES[day] ?? "?";
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
  if (!m || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) throw new Error(`日期不存在：${date}（写 YYYY-MM-DD）`);
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
