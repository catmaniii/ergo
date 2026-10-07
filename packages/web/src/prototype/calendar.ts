// 工作日历页的原型计算（规格第 21 节）：
// 上班日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。
// 正式的计算和节假日数据在 29 号票；这里只放原型要显示的 2026 年 9–12 月，数据摘自 docs/research/13-holidays-sg-cn.md。

const SG_HOLIDAYS: Record<string, string> = {
  "2026-08-09": "新加坡国庆日",
  "2026-08-10": "新加坡国庆日补假",
  "2026-11-08": "屠妖节",
  "2026-11-09": "屠妖节补假",
  "2026-12-25": "圣诞节",
};

const CN_HOLIDAYS: Record<string, string> = {
  "2026-09-25": "中秋节",
  "2026-09-26": "中秋节",
  "2026-09-27": "中秋节",
  "2026-10-01": "国庆节",
  "2026-10-02": "国庆节",
  "2026-10-03": "国庆节",
  "2026-10-04": "国庆节",
  "2026-10-05": "国庆节",
  "2026-10-06": "国庆节",
  "2026-10-07": "国庆节",
};

const CN_MAKEUP_WORKDAYS = new Set(["2026-09-20", "2026-10-10"]);

/** 用户自定的额外上班规则 */
export interface ExtraRule {
  id: string;
  kind: "last_weekday" | "nth_weekday" | "every_weekday";
  weekday: number;
  /** nth_weekday 用：第几个 */
  n?: number;
}

export function ruleLabel(r: ExtraRule): string {
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][r.weekday];
  if (r.kind === "last_weekday") return `每月最后一个${wd}`;
  if (r.kind === "nth_weekday") return `每月第${["一", "二", "三", "四"][(r.n ?? 1) - 1]}个${wd}`;
  return `每${wd}`;
}

function matches(r: ExtraRule, date: Date): boolean {
  if (date.getUTCDay() !== r.weekday) return false;
  if (r.kind === "every_weekday") return true;
  const d = date.getUTCDate();
  if (r.kind === "nth_weekday") return Math.ceil(d / 7) === r.n;
  const next = new Date(date.getTime() + 7 * 86_400_000);
  return next.getUTCMonth() !== date.getUTCMonth();
}

export type ManualMark = "work" | "rest";

export interface DayInfo {
  date: string;
  day: number;
  work: boolean;
  /** 新加坡工作日、国内工作日、调休补班、额外规则、手动标记；休息时是周末、假期或手动标记 */
  reason: string;
  /** 补充说明（比如"国内放假：国庆节"） */
  note?: string;
  manual?: ManualMark;
}

export function dayInfo(date: string, rules: ExtraRule[], marks: Record<string, ManualMark>): DayInfo {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = d.getUTCDay();
  const weekdayWork = weekday >= 1 && weekday <= 5;
  const sgHoliday = SG_HOLIDAYS[date];
  const cnHoliday = CN_HOLIDAYS[date];
  const cnMakeup = CN_MAKEUP_WORKDAYS.has(date);
  const sgWork = weekdayWork && !sgHoliday;
  const cnWork = (weekdayWork && !cnHoliday) || cnMakeup;
  const rule = rules.find((r) => matches(r, d));
  const base = { date, day: d.getUTCDate() };
  const manual = marks[date];
  if (manual) return { ...base, work: manual === "work", reason: manual === "work" ? "手动标记上班" : "手动标记休息", manual };
  if (sgWork) return { ...base, work: true, reason: "新加坡工作日", note: cnWork ? undefined : `国内放假：${cnHoliday ?? "周末"}` };
  if (cnMakeup) return { ...base, work: true, reason: "调休补班" };
  if (cnWork) return { ...base, work: true, reason: "国内工作日", note: `新加坡放假：${sgHoliday}` };
  if (rule) return { ...base, work: true, reason: `额外规则：${ruleLabel(rule)}` };
  const holiday = [sgHoliday && `新加坡${sgHoliday.replace(/^新加坡/, "")}`, cnHoliday].filter(Boolean).join("、");
  return { ...base, work: false, reason: holiday || "周末" };
}

/** 某个月的每一天（year, month 从 1 开始） */
export function monthDays(year: number, month: number): string[] {
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
}

/** 这个月 1 号是星期几（0 = 周日） */
export function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}
