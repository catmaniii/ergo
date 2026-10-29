// 问题里的时间说法（规则版的查询规划，任务书第 7 节"Temporal：找当前 / 过去状态、事件顺序"）：只看问题本身。
// - 问"那时的状态"（那会儿、那阵、那时候、还……吗）：给有效期的时间点 at（那一段的中间：月中、旬中、年中），
//   查那时成立的事实；原话不按它过滤（"去年九月吃香菜吗"要找到今年三月那句"其实一直不吃"）；
// - 问"那时的事"（去年去的、五一去的）：给发生时间的范围 eventRange；
// - 现在、最近、目前：at = 问的时间；
// - 认不出的（"这一年"这种说得很松的、"这周六"这种以后的）什么都不给，不硬猜。
// 检索接口（search）不自己调它：调用的人（评测、以后的秘书）先规划，再把 at、eventRange 交给检索。
import { addDays, monthStart, startOfMonth, startOfWeek, startOfYear, toMs, yearMonthOf } from "../domain/time.ts";

export interface QueryPlan {
  /** 有效期的时间点：查那时成立的事实 */
  at?: string;
  /** 发生时间 [起, 止) */
  eventRange?: [string, string];
  /** 起作用的说法（演示、评测看得见为什么这么规划） */
  signals: string[];
}

const CN: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function monthNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (/^十[一二]$/.test(s)) return 10 + CN[s[1]!]!;
  return CN[s];
}

const MONTH_EXPR = /(去年|今年|前年)?\s*(\d{1,2}|十[一二]|[一二三四五六七八九十])\s*月份?\s*(上旬|中旬|下旬|初|底|末)?/;
const HOLIDAY_EXPR = /(去年|今年|前年)?\s*(五一|国庆)/;
const YEAR_EXPR = /去年|今年|前年/;
const MONTH_REL_EXPR = /上个?月|这个?月|本月/;
const WEEK_EXPR = /上周|上个?星期|上个?礼拜/;
const STATE_EXPR = /那会儿?|那阵子?|那时候?|那段时间|还[^，,。？?！!]{0,8}[吗么]/;
const NOW_EXPR = /现在|最近|目前|如今|这阵子|眼下/;

const YEAR_DELTA: Readonly<Record<string, number>> = { 前年: -2, 去年: -1, 今年: 0 };

/** 某年某月某日中午（时区取 now 的） */
function noon(now: string, year: number, month: number, day: number): string {
  return addDays(monthStart(now, year, month), day - 1).replace("T00:00:00", "T12:00:00");
}

interface Period {
  from: string;
  to: string;
  /** 问"那时的状态"时取的时间点 */
  point: string;
  text: string;
}

function monthPeriod(now: string, m: RegExpExecArray): Period | undefined {
  const month = monthNumber(m[2]!);
  if (month === undefined || month < 1 || month > 12) return undefined;
  const { year: thisYear, month: thisMonth } = yearMonthOf(now);
  const year = m[1] ? thisYear + YEAR_DELTA[m[1]]! : month > thisMonth ? thisYear - 1 : thisYear;
  const start = monthStart(now, year, month);
  const end = monthStart(now, year, month + 1);
  const part = m[3];
  const [fromDay, toDay, pointDay] = part === "上旬" || part === "初" ? [1, 11, 5] : part === "中旬" ? [11, 21, 15] : part === "下旬" || part === "底" || part === "末" ? [21, 0, 25] : [1, 0, 15];
  return {
    from: addDays(start, fromDay - 1),
    to: toDay === 0 ? end : addDays(start, toDay - 1),
    point: noon(now, year, month, pointDay),
    text: m[0].trim(),
  };
}

function holidayPeriod(now: string, m: RegExpExecArray): Period {
  const [month, days] = m[2] === "五一" ? [5, 5] : [10, 7];
  const { year: thisYear } = yearMonthOf(now);
  let year = m[1] ? thisYear + YEAR_DELTA[m[1]]! : thisYear;
  if (!m[1] && toMs(monthStart(now, year, month)) > toMs(now)) year -= 1;
  const from = monthStart(now, year, month);
  return { from, to: addDays(from, days), point: noon(now, year, month, Math.ceil(days / 2)), text: m[0].trim() };
}

function findPeriod(question: string, now: string): Period | undefined {
  const month = MONTH_EXPR.exec(question);
  if (month) {
    const p = monthPeriod(now, month);
    if (p) return p;
  }
  const holiday = HOLIDAY_EXPR.exec(question);
  if (holiday) return holidayPeriod(now, holiday);
  const year = YEAR_EXPR.exec(question);
  if (year) {
    const delta = YEAR_DELTA[year[0]]!;
    const { year: y } = yearMonthOf(now);
    return { from: startOfYear(now, delta), to: startOfYear(now, delta + 1), point: noon(now, y + delta, 7, 1), text: year[0] };
  }
  const rel = MONTH_REL_EXPR.exec(question);
  if (rel) {
    const delta = rel[0].startsWith("上") ? -1 : 0;
    const from = startOfMonth(now, delta);
    const { year: y, month: mo } = yearMonthOf(from);
    return { from, to: startOfMonth(now, delta + 1), point: noon(now, y, mo, 15), text: rel[0] };
  }
  const week = WEEK_EXPR.exec(question);
  if (week) {
    const from = startOfWeek(now, -1);
    return { from, to: startOfWeek(now, 0), point: addDays(from, 3).replace("T00:00:00", "T12:00:00"), text: week[0] };
  }
  return undefined;
}

/** 规划问题里的时间（见文件开头）；now 是问的时间 */
export function planQuery(question: string, now: string): QueryPlan {
  const period = findPeriod(question, now);
  if (period) {
    const state = STATE_EXPR.exec(question);
    if (state) return { at: period.point, signals: [period.text, state[0]] };
    return { eventRange: [period.from, period.to], signals: [period.text] };
  }
  const current = NOW_EXPR.exec(question);
  if (current) return { at: now, signals: [current[0]] };
  return { signals: [] };
}
