// 记忆 · 素材的浏览（167 号票，用户 2026-10-19 要的"素材管理加按时间范围浏览，不然以后会太多"）：纯函数，页面在 pages/more/MaterialsBrowse.tsx。
// - 时间范围：快捷选项今天、近 7 天（默认）、近 30 天，自定义起止日期；往前一段、往后一段按这一段的天数翻（最晚到今天）；
//   搜的时候能一键换成全部时间。范围是一段本地日期（两头都算），交给守护进程时落成头一天零点到最后一天最后一刻（带时区的 ISO）；
// - 列表按日期分组：今天、昨天，别的写"10 月 17 日 周六"，不是今年的带年份；新的在前（守护进程已经按素材的时间排好）；
// - 搜：命中的字标出来（highlightParts：几个词都标，不分大小写，叠着的合成一段）；
// - 筛：种类（MATERIAL_FACETS，守护进程认）、会话（秘书主线排第一，别的按条数多的在前）。
import { monthWord } from "./date-words.ts";
import { CHANNELS, formatDate, localDate, localDateKey, type MaterialFacet, type MaterialListFilter, nowIso, parseLocalDate, t, tTable } from "./protocol.ts";

export const MATERIAL_RANGE_PRESETS = ["today", "7d", "30d"] as const;
export type MaterialRangePreset = (typeof MATERIAL_RANGE_PRESETS)[number];

export const MATERIAL_RANGE_PRESET_LABEL: Readonly<Record<MaterialRangePreset, string>> = tTable({
  today: "state.materialBrowse.preset.today",
  "7d": "state.materialBrowse.preset.days7",
  "30d": "state.materialBrowse.preset.days30",
});

/** 打开素材页默认看哪一段 */
export const DEFAULT_MATERIAL_RANGE_PRESET: MaterialRangePreset = "7d";

/**
 * 浏览的时间范围：全部时间，或者一段本地日期（YYYY-MM-DD，两头都算）。kind 记着是哪个快捷选项落的（往前往后翻时长度不变）、
 * 还是自定义的
 */
export type MaterialRange = { readonly kind: "all" } | { readonly kind: MaterialRangePreset | "custom"; readonly from: string; readonly to: string };

const PRESET_DAYS: Readonly<Record<MaterialRangePreset, number>> = { today: 1, "7d": 7, "30d": 30 };

/** 某一天往前（负）往后（正）挪几天 */
function addDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return localDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 两头都算的天数 */
function spanDays(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000) + 1;
}

const validDate = (s: string): boolean => {
  try {
    parseLocalDate(s);
    return true;
  } catch {
    return false;
  }
};

/** 快捷选项落成的范围（截到今天，含今天） */
export function presetMaterialRange(preset: MaterialRangePreset, now: Date): MaterialRange {
  const to = localDate(now);
  return { kind: preset, from: addDays(to, 1 - PRESET_DAYS[preset]), to };
}

/** 自定义的起止日期；写法不对、起点晚于终点的是 undefined */
export function customMaterialRange(from: string, to: string): MaterialRange | undefined {
  if (!validDate(from) || !validDate(to) || from > to) return undefined;
  return { kind: "custom", from, to };
}

/** 往前一段（-1）、往后一段（1）：按这一段的天数翻；全部时间不动 */
export function shiftMaterialRange(range: MaterialRange, dir: -1 | 1): MaterialRange {
  if (range.kind === "all") return range;
  const days = spanDays(range.from, range.to) * dir;
  return { kind: range.kind, from: addDays(range.from, days), to: addDays(range.to, days) };
}

/** 能不能往后一段：最晚翻到今天 */
export function canShiftMaterialRangeLater(range: MaterialRange, now: Date): boolean {
  return range.kind !== "all" && range.to < localDate(now);
}

/** 哪个快捷选项亮着：是截到今天的那一段才亮（翻过的不亮），自定义一直亮；全部时间都不亮 */
export function materialRangePreset(range: MaterialRange, now: Date): MaterialRangePreset | "custom" | undefined {
  if (range.kind === "all") return undefined;
  if (range.kind === "custom") return "custom";
  const current = presetMaterialRange(range.kind, now);
  return current.kind !== "all" && current.from === range.from && current.to === range.to ? range.kind : undefined;
}

/** 月份的写法（170 号票，date-words.ts）：中文是数字（"10 月 17 日"），英文是简写（"Oct 17"）；日期的几种写法是整句的模板 */
const monthName = monthWord;

/** 一天写成"10 月 17 日"，不是今年的带年份 */
function dateText(date: string, now: Date): string {
  const { year, month, day } = parseLocalDate(date);
  return year === now.getFullYear()
    ? t("state.materialBrowse.date.monthDay", { month: monthName(month), day })
    : t("state.materialBrowse.date.yearMonthDay", { year, month: monthName(month), day });
}

/** 一天的说法：今天、昨天，别的"10 月 17 日 周六"（不是今年的带年份；周几按语言格式化，中文是"周六"） */
export function materialDayLabel(date: string, now: Date): string {
  const today = localDate(now);
  if (date === today) return t("state.materialBrowse.today");
  if (date === addDays(today, -1)) return t("state.materialBrowse.yesterday");
  const { year, month, day } = parseLocalDate(date);
  return t("state.materialBrowse.dayWithWeekday", { date: dateText(date, now), weekday: formatDate(new Date(year, month - 1, day), { weekday: "short" }) });
}

/**
 * 范围写成什么字：全部时间；一天的写那一天（今天、昨天……）；一段写起止日期——同一个月的后一头只写日，不是今年的带年份，
 * 跨年的两头都带年份。快捷选项亮着时不再写"近 7 天"（分段切换上已经亮着），手机上一行放得下
 */
export function materialRangeLabel(range: MaterialRange, now: Date): string {
  if (range.kind === "all") return t("state.materialBrowse.allTime");
  if (range.from === range.to) return materialDayLabel(range.from, now);
  const a = parseLocalDate(range.from);
  const b = parseLocalDate(range.to);
  const from = { fromMonth: monthName(a.month), fromDay: a.day };
  if (a.year !== b.year) return t("state.materialBrowse.range.crossYear", { ...from, fromYear: a.year, toYear: b.year, toMonth: monthName(b.month), toDay: b.day });
  const thisYear = a.year === now.getFullYear();
  if (a.month === b.month) return thisYear ? t("state.materialBrowse.range.sameMonth", { ...from, toDay: b.day }) : t("state.materialBrowse.range.sameMonthYear", { ...from, toDay: b.day, year: a.year });
  const to = { toMonth: monthName(b.month), toDay: b.day };
  return thisYear ? t("state.materialBrowse.range.sameYear", { ...from, ...to }) : t("state.materialBrowse.range.sameYearOther", { ...from, ...to, year: a.year });
}

/** 交给守护进程的起止时间：头一天零点到最后一天的最后一刻（本地时间，带时区）；全部时间不给 */
export function materialRangeBounds(range: MaterialRange): { from?: string; to?: string } {
  if (range.kind === "all") return {};
  const start = parseLocalDate(range.from);
  const end = parseLocalDate(range.to);
  return {
    from: nowIso(new Date(start.year, start.month - 1, start.day)),
    to: nowIso(new Date(new Date(end.year, end.month - 1, end.day + 1).getTime() - 1)),
  };
}

export interface MaterialDayGroup<T> {
  /** YYYY-MM-DD（本地日期） */
  readonly date: string;
  readonly label: string;
  readonly items: T[];
}

/** 按日期分组（本地日期）：列表已经新的在前，同一天的连着排成一组 */
export function materialDayGroups<T extends { readonly time: string }>(items: readonly T[], now: Date): Array<MaterialDayGroup<T>> {
  const groups: Array<MaterialDayGroup<T>> = [];
  for (const item of items) {
    const date = localDate(new Date(item.time));
    const last = groups.at(-1);
    if (last?.date === date) last.items.push(item);
    else groups.push({ date, label: materialDayLabel(date, now), items: [item] });
  }
  return groups;
}

/** 列表一行的时刻（按日期分了组，只写几点几分；本地时间，和分组同一个口径） */
export function materialClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 文字的一段：hit 是命中了关键词的字 */
export interface HighlightPart {
  readonly text: string;
  readonly hit: boolean;
}

/** 标出命中的字：关键词按空白拆开，几个词都标，不分大小写；挨着的、叠着的合成一段 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  if (text === "") return [];
  const lower = text.toLowerCase();
  const terms = query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) marks.push([at, at + term.length]);
  }
  if (marks.length === 0) return [{ text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of marks) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const parts: HighlightPart[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) parts.push({ text: text.slice(pos, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
  return parts;
}

/** 页面上选的这些拼成接口的筛选（没选的不带） */
export function materialListFilter(input: { range: MaterialRange; query: string; facets: readonly MaterialFacet[]; conversation?: string | undefined }): MaterialListFilter {
  const query = input.query.trim();
  return {
    ...materialRangeBounds(input.range),
    ...(query ? { query } : {}),
    ...(input.facets.length > 0 ? { facets: [...input.facets] } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
  };
}

/** 会话下拉框列哪些：秘书主线排第一（没有素材也列，写 0 条），别的按条数多的在前 */
export function materialConversationChoices(conversations: ReadonlyArray<{ conversation: string; count: number }>): Array<{ conversation: string; count: number }> {
  const secretary = conversations.find((c) => c.conversation === CHANNELS.secretary) ?? { conversation: CHANNELS.secretary, count: 0 };
  const rest = conversations.filter((c) => c.conversation !== CHANNELS.secretary).toSorted((a, b) => b.count - a.count);
  return [{ ...secretary }, ...rest.map((c) => ({ ...c }))];
}
