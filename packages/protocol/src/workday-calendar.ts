// 个人工作日历（规格第 21 节，29 号票）：哪天上班、哪天休息，为什么。守护进程（"按我的工作日"的提醒和作业、
// 设置接口、快速动作、节假日数据的校验）和 Web（设置里的工作日历页）共用这一份。
//
// 我的工作日 = 新加坡工作日（周一到周五，去掉新加坡公众假期，含补假）
//           ∪ 国内工作日（周一到周五，去掉国内放假日期，加上调休补班的周末）
//           ∪ 额外上班规则（每周几、每月第 N 个周几、每月最后一个周几）∪ 手动标记的上班日
//           − 手动标记的休息日。
// 新加坡放假、国内上班的撞日因此算上班。同一天只有一个手动标记，它压过别的一切原因。
//
// - 节假日数据（HolidayYear）按地区和年份组织，框架自带的是公开数据（守护进程包的 holidays/），用户的更新任务导入的
//   放在数据目录的配置区，同一个格式；同一地区同一年有几份时以后面的为准（mergeHolidayYears，只在这里定）。
//   某一年缺哪边的数据，那边就按周一到周五算，结果里标明缺了。
// - 额外规则和手动标记（WorkdaySettings）是个人数据，放在数据目录的配置区，只由运行时改（applyWorkdayChange）。
// 日期一律是本地日期 YYYY-MM-DD（local-date.ts；不带时区：工作日历只关心是哪一天）。
import { type Static, Type } from "typebox";
import { followLocale, t, tTable } from "./i18n/runtime.ts";
import { daysInMonth, localDate, localDateKey, monthName, parseLocalDate, weekdayLongName, weekdayName } from "./local-date.ts";
import { schemaChecker } from "./validate.ts";

/** 节假日数据的两个地区：新加坡、国内（中国大陆） */
export const HOLIDAY_REGIONS = ["sg", "cn"] as const;
export type HolidayRegion = (typeof HOLIDAY_REGIONS)[number];
export const HOLIDAY_REGION_LABEL: Readonly<Record<HolidayRegion, string>> = tTable({ sg: "protocol.workday.region.sg", cn: "protocol.workday.region.cn" });

/**
 * 节假日数据里一天的种类：
 * - holiday：放假（新加坡的公众假期；国内官方公布的放假日期，含因调休放假的工作日）；
 * - observed：新加坡的补假（公众假期落在周日时次日补休，按官方公布的日期，不自己推算）；
 * - makeup_workday：国内调休补班（官方公布的上班日，多是周末）。
 */
export const HOLIDAY_DAY_KINDS = ["holiday", "observed", "makeup_workday"] as const;
export type HolidayDayKind = (typeof HOLIDAY_DAY_KINDS)[number];

/** 每种日子是放假还是上班（工作日历的判断和数据校验都看这张表） */
export const HOLIDAY_DAY_KIND_REST: Readonly<Record<HolidayDayKind, boolean>> = { holiday: true, observed: true, makeup_workday: false };

/** 每个地区的数据里能有哪几种日子：新加坡没有调休补班，国内没有补假（补偿已折算进放假区间和调休补班） */
export const HOLIDAY_KINDS_BY_REGION: Readonly<Record<HolidayRegion, readonly HolidayDayKind[]>> = {
  sg: ["holiday", "observed"],
  cn: ["holiday", "makeup_workday"],
};

/** 本地日期 YYYY-MM-DD 的 pattern（拼带别的说明的日期参数时也用它） */
export const LOCAL_DATE_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/** 本地日期 YYYY-MM-DD */
export const LocalDate = Type.String({ pattern: LOCAL_DATE_PATTERN, description: "日期，YYYY-MM-DD" }); // @i18n-ignore model

/** 节假日数据的官方来源 */
export const HolidaySource = Type.Object({
  title: Type.String({ minLength: 1 }),
  url: Type.String({ pattern: "^https://" }),
  /** 发布或最后更新的日期（YYYY-MM-DD，官方页面上标的） */
  published: Type.Optional(Type.String()),
  /** 访问日期 */
  accessed: Type.Optional(Type.String()),
});
export type HolidaySource = Static<typeof HolidaySource>;

export const HolidayDay = Type.Object({ date: LocalDate, name: Type.String({ minLength: 1 }), kind: Type.Enum(HOLIDAY_DAY_KINDS) });
export type HolidayDay = Static<typeof HolidayDay>;

/** 一个地区一年的节假日数据（框架自带的和更新任务交付的都是这个格式，format 是格式的版本） */
export const HolidayYear = Type.Object({
  format: Type.Literal(1),
  region: Type.Enum(HOLIDAY_REGIONS),
  year: Type.Integer({ minimum: 2000, maximum: 2100 }),
  /** 官方来源，至少一条 */
  sources: Type.Array(HolidaySource, { minItems: 1 }),
  days: Type.Array(HolidayDay),
});
export type HolidayYear = Static<typeof HolidayYear>;

/** 一份节假日数据的键，也是它的文件名（去掉 .json）：sg-2027 */
export function holidayYearKey(year: Pick<HolidayYear, "region" | "year">): string {
  return `${year.region}-${year.year}`;
}

/** 一份节假日数据的文件名：sg-2027.json（框架自带的、导入的都这样命名） */
export function holidayFileName(year: Pick<HolidayYear, "region" | "year">): string {
  return `${holidayYearKey(year)}.json`;
}

/** 合在一起：同一地区同一年有几份时以后面的为准（框架自带的在前、导入的在后）；按地区、年份排好 */
export function mergeHolidayYears(...lists: readonly (readonly HolidayYear[])[]): HolidayYear[] {
  const merged = new Map<string, HolidayYear>();
  for (const list of lists) for (const year of list) merged.set(holidayYearKey(year), year);
  return [...merged.values()].toSorted((a, b) => a.region.localeCompare(b.region) || a.year - b.year);
}

/** 校验器第一次用到时才编译（Web 只用纯函数，不把 schema 编译器打进包里） */
let holidayYearChecker: ReturnType<typeof schemaChecker<typeof HolidayYear>> | undefined;

/**
 * 校验一份节假日数据（框架自带的、更新任务交付的都过这一遍）：格式（schema）之外，日期都在这一年里、真实存在、
 * 不重复；每种日子都是这个地区能有的（HOLIDAY_KINDS_BY_REGION）；至少一条官方来源（https）。
 */
export function checkHolidayYear(value: unknown): { ok: true; value: HolidayYear } | { ok: false; error: string } {
  holidayYearChecker ??= schemaChecker(HolidayYear);
  if (!holidayYearChecker.check(value)) return { ok: false, error: t("protocol.workday.holiday.badFormat", { error: holidayYearChecker.firstError(value) ?? "" }) };
  const seen = new Set<string>();
  for (const day of value.days) {
    let year: number;
    try {
      year = parseLocalDate(day.date).year;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (year !== value.year) return { ok: false, error: t("protocol.workday.holiday.wrongYear", { date: day.date, year: value.year }) };
    if (seen.has(day.date)) return { ok: false, error: t("protocol.workday.holiday.duplicate", { date: day.date }) };
    seen.add(day.date);
    if (!HOLIDAY_KINDS_BY_REGION[value.region].includes(day.kind)) return { ok: false, error: t("protocol.workday.holiday.wrongKind", { region: HOLIDAY_REGION_LABEL[value.region], kind: day.kind, date: day.date }) };
  }
  return { ok: true, value };
}

const Weekday = Type.Integer({ minimum: 0, maximum: 6, description: "周几：0 是周日、1 是周一……6 是周六" }); // @i18n-ignore model

/** 额外上班规则（确定的写法，不用模型理解）：每周几、每月第 N 个周几、每月最后一个周几 */
export const ExtraWorkdayRule = Type.Union([
  Type.Object({ kind: Type.Literal("weekly"), weekday: Weekday }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("nth_weekday"), n: Type.Integer({ minimum: 1, maximum: 5, description: "第几个（1–5）" }), weekday: Weekday }, { additionalProperties: false }), // @i18n-ignore model
  Type.Object({ kind: Type.Literal("last_weekday"), weekday: Weekday }, { additionalProperties: false }),
]);
export type ExtraWorkdayRule = Static<typeof ExtraWorkdayRule>;

export const DAY_MARKS = ["work", "rest"] as const;
export type DayMarkKind = (typeof DAY_MARKS)[number];

/** 手动标记：把某天标成上班或休息 */
export const DayMark = Type.Object({ date: LocalDate, mark: Type.Enum(DAY_MARKS) });
export type DayMark = Static<typeof DayMark>;

/** 用户的个人设置：额外上班规则和手动标记（同一天最多一个标记，按日期排好） */
export const WorkdaySettings = Type.Object({ rules: Type.Array(ExtraWorkdayRule), marks: Type.Array(DayMark) });
export type WorkdaySettings = Static<typeof WorkdaySettings>;

/** 个人设置在数据目录配置区里的文件（config/workday-calendar.json）：个人设置加上格式的版本 */
export const WorkdaySettingsFile = Type.Object({ format: Type.Literal(1), rules: WorkdaySettings.properties.rules, marks: WorkdaySettings.properties.marks });
export type WorkdaySettingsFile = Static<typeof WorkdaySettingsFile>;

export const EMPTY_WORKDAY_SETTINGS: WorkdaySettings = { rules: [], marks: [] };

/** 一次改动：加、删一条额外规则（规则按写法认，同一条只有一份），把某天标成上班或休息，清掉某天的标记 */
export const WorkdayChange = Type.Union([
  Type.Object({ kind: Type.Literal("add_rule"), rule: ExtraWorkdayRule }),
  Type.Object({ kind: Type.Literal("remove_rule"), rule: ExtraWorkdayRule }),
  Type.Object({ kind: Type.Literal("mark"), date: LocalDate, mark: Type.Enum(DAY_MARKS) }),
  Type.Object({ kind: Type.Literal("clear_mark"), date: LocalDate }),
]);
export type WorkdayChange = Static<typeof WorkdayChange>;

/**
 * 个人设置改动的来源：设置里的工作日历页、快速动作（秘书提议、用户确认），以及启动时发现配置文件和上一条事件不一样
 * （停着时手改过、从备份恢复了配置区）——配置文件是真相，以它为准
 */
export const WORKDAY_CHANGE_SOURCES = ["settings", "quick_action", "config_file"] as const;
export type WorkdayChangeSource = (typeof WORKDAY_CHANGE_SOURCES)[number];

/** 工作日历频道上的 workday_settings 事件：个人设置的最新样子，和这次的改动 */
export const WorkdaySettingsEventPayload = Type.Object({
  settings: WorkdaySettings,
  source: Type.Enum(WORKDAY_CHANGE_SOURCES),
  change: Type.Optional(WorkdayChange),
});
export type WorkdaySettingsEventPayload = Static<typeof WorkdaySettingsEventPayload>;

/** 工作日历频道上的 holiday_data 事件：工作日历用的节假日数据（框架自带的加上导入的，同一地区同一年以导入的为准） */
export const HolidayDataEventPayload = Type.Object({
  years: Type.Array(HolidayYear),
  /** 这次是导入了哪一份（更新任务交付的）；启动时的同步没有 */
  imported: Type.Optional(Type.Object({ region: Type.Enum(HOLIDAY_REGIONS), year: Type.Integer() })),
});
export type HolidayDataEventPayload = Static<typeof HolidayDataEventPayload>;

/** 某天上班或休息的一条原因 */
export const DayReason = Type.Union([
  Type.Object({ kind: Type.Literal("sg_workday") }),
  Type.Object({ kind: Type.Literal("cn_workday") }),
  Type.Object({ kind: Type.Literal("cn_makeup"), name: Type.String() }),
  Type.Object({ kind: Type.Literal("extra_rule"), rule: ExtraWorkdayRule }),
  Type.Object({ kind: Type.Literal("manual_work") }),
  Type.Object({ kind: Type.Literal("weekend") }),
  Type.Object({ kind: Type.Literal("sg_holiday"), name: Type.String() }),
  Type.Object({ kind: Type.Literal("cn_holiday"), name: Type.String() }),
  Type.Object({ kind: Type.Literal("manual_rest") }),
]);
export type DayReason = Static<typeof DayReason>;

/** 某一天的结果 */
export const DayVerdict = Type.Object({
  date: LocalDate,
  /** 周几：0 是周日 */
  weekday: Type.Integer({ minimum: 0, maximum: 6 }),
  workday: Type.Boolean(),
  /** 决定结果的原因：上班时是上班的理由（按 调休补班、新加坡、国内、额外规则 的顺序），休息时是休息的理由；手动标记只有它一条 */
  reasons: Type.Array(DayReason),
  /** 当天两边的节假日（不论是否决定结果），界面显示用 */
  holidays: Type.Array(Type.Object({ region: Type.Enum(HOLIDAY_REGIONS), name: Type.String(), kind: Type.Enum(HOLIDAY_DAY_KINDS) })),
  /** 这一年缺哪边的节假日数据（缺的那边按周一到周五算） */
  missing: Type.Array(Type.Enum(HOLIDAY_REGIONS)),
});
export type DayVerdict = Static<typeof DayVerdict>;

/** 工作日历：节假日数据加个人设置。调度器（"按我的工作日"）只用 isWorkday */
export interface WorkdayCalendar {
  /** 某天（本地日期）上不上班 */
  isWorkday(day: Date): boolean;
  day(date: string): DayVerdict;
  /** 某个月每一天的结果（month 从 1 起） */
  month(year: number, month: number): DayVerdict[];
  /** 某一年缺哪边的节假日数据 */
  missing(year: number): HolidayRegion[];
}

/** 由节假日数据和个人设置建一个工作日历（同一地区同一年有多份时以后面的为准） */
export function workdayCalendar(holidays: readonly HolidayYear[], settings: WorkdaySettings): WorkdayCalendar {
  const years = mergeHolidayYears(holidays);
  const present = new Set(years.map(holidayYearKey));
  const byDate = new Map<string, Map<HolidayRegion, HolidayDay>>();
  for (const year of years) {
    for (const day of year.days) {
      const regions = byDate.get(day.date) ?? new Map<HolidayRegion, HolidayDay>();
      regions.set(year.region, day);
      byDate.set(day.date, regions);
    }
  }
  const marks = new Map(settings.marks.map((m) => [m.date, m.mark]));
  const missing = (year: number) => HOLIDAY_REGIONS.filter((region) => !present.has(holidayYearKey({ region, year })));

  const day = (date: string): DayVerdict => {
    const { year, month, day: dayOfMonth, weekday } = parseLocalDate(date);
    const weekend = weekday === 0 || weekday === 6;
    const entries = byDate.get(date);
    const sg = entries?.get("sg");
    const cn = entries?.get("cn");
    const onThisDay = HOLIDAY_REGIONS.flatMap((region) => {
      const d = entries?.get(region);
      return d ? [{ region, name: d.name, kind: d.kind }] : [];
    });
    const base = { date, weekday, holidays: onThisDay, missing: missing(year) };
    const mark = marks.get(date);
    if (mark) return { ...base, workday: mark === "work", reasons: [{ kind: mark === "work" ? "manual_work" : "manual_rest" }] };

    const sgOff = sg !== undefined && HOLIDAY_DAY_KIND_REST[sg.kind];
    const cnOff = cn !== undefined && HOLIDAY_DAY_KIND_REST[cn.kind];
    const cnMakeup = cn !== undefined && !HOLIDAY_DAY_KIND_REST[cn.kind];
    const work: DayReason[] = [];
    if (cnMakeup) work.push({ kind: "cn_makeup", name: cn.name });
    if (!weekend && !sgOff) work.push({ kind: "sg_workday" });
    if (!weekend && !cnOff && !cnMakeup) work.push({ kind: "cn_workday" });
    for (const rule of settings.rules) if (ruleMatches(rule, year, month, dayOfMonth, weekday)) work.push({ kind: "extra_rule", rule });
    if (work.length > 0) return { ...base, workday: true, reasons: work };

    const rest: DayReason[] = [];
    if (sgOff) rest.push({ kind: "sg_holiday", name: sg.name });
    if (cnOff) rest.push({ kind: "cn_holiday", name: cn.name });
    if (weekend) rest.push({ kind: "weekend" });
    return { ...base, workday: false, reasons: rest };
  };

  return {
    isWorkday: (d) => day(localDate(d)).workday,
    day,
    month(year, month) {
      return Array.from({ length: daysInMonth(year, month) }, (_, i) => day(localDateKey(year, month, i + 1)));
    },
    missing,
  };
}

/** 一条原因的中文写法 */
export function dayReasonLabel(reason: DayReason): string {
  switch (reason.kind) {
    case "sg_workday":
      return t("protocol.workday.reason.sgWorkday");
    case "cn_workday":
      return t("protocol.workday.reason.cnWorkday");
    case "cn_makeup":
      return t("protocol.workday.reason.cnMakeup");
    case "extra_rule":
      return t("protocol.workday.reason.extraRule", { rule: describeExtraRule(reason.rule) });
    case "manual_work":
      return t("protocol.workday.reason.manualWork");
    case "weekend":
      return t("protocol.workday.reason.weekend");
    case "sg_holiday":
      return t("protocol.workday.reason.sgHoliday", { name: reason.name });
    case "cn_holiday":
      return t("protocol.workday.reason.cnHoliday", { name: reason.name });
    case "manual_rest":
      return t("protocol.workday.reason.manualRest");
  }
}

/** 这条原因是不是手动标记（上班或休息） */
export function isManualReason(reason: DayReason): boolean {
  return reason.kind === "manual_work" || reason.kind === "manual_rest";
}

/** 这天是手动标记的 */
export function isManualDay(verdict: DayVerdict): boolean {
  return verdict.reasons.some(isManualReason);
}

/**
 * 工作日历页格子里的一个短词：手动；补班（调休补班）；工作日（两边都上班）、新加坡、国内（只有一边上班）；规则（额外规则）；
 * 休息时是假期的名字（太长截断）或周末
 */
export function dayShortLabel(verdict: DayVerdict): string {
  const [first] = verdict.reasons;
  if (!first) return "";
  if (isManualReason(first)) return t("protocol.workday.short.manual");
  switch (first.kind) {
    case "cn_makeup":
      return t("protocol.workday.short.makeup");
    case "sg_workday":
      return verdict.reasons.some((r) => r.kind === "cn_workday") ? t("protocol.workday.short.workday") : t("protocol.workday.short.sg");
    case "cn_workday":
      return t("protocol.workday.short.cn");
    case "extra_rule":
      return t("protocol.workday.short.rule");
    case "sg_holiday":
    case "cn_holiday":
      return first.name.length > 4 ? `${first.name.slice(0, 4)}…` : first.name;
    default:
      return t("protocol.workday.short.weekend");
  }
}

/** 格子短词的图例（跟着当前语言，followLocale） */
export let DAY_SHORT_LABEL_LEGEND = "";
followLocale(() => {
  DAY_SHORT_LABEL_LEGEND = t("protocol.workday.shortLegend");
});

/** 缺数据的说法：缺 2027 年国内节假日数据 */
export function missingHolidayDataText(year: number, regions: readonly HolidayRegion[]): string {
  return t("protocol.workday.missingData", { year, regions: regions.map((r) => HOLIDAY_REGION_LABEL[r]).join(t("protocol.common.listSep")) });
}

/** 额外规则的写法：每周六 / 每月第一个周六 / 每月最后一个周六（英文 Every Saturday / The first Saturday of every month……） */
export function describeExtraRule(rule: ExtraWorkdayRule): string {
  switch (rule.kind) {
    case "weekly":
      return t("protocol.workday.rule.weekly", { weekday: weekdayLongName(rule.weekday) });
    case "nth_weekday":
      return t("protocol.workday.rule.nth", {
        nth: rule.n >= 1 && rule.n <= 5 ? t(`protocol.workday.nth.${rule.n}`) : rule.n,
        weekday: weekdayLongName(rule.weekday),
      });
    case "last_weekday":
      return t("protocol.workday.rule.last", { weekday: weekdayLongName(rule.weekday) });
  }
}

/** 一个日期的写法：2026 年 10 月 12 日（周一）（英文 Oct 12, 2026 (Mon)） */
export function describeLocalDate(date: string): string {
  const { year, month, day, weekday } = parseLocalDate(date);
  return t("protocol.workday.date", { year, month: monthName(month), day, weekday: weekdayName(weekday) });
}

/** 一次改动的写法（快速动作卡上给用户核对） */
export function describeWorkdayChange(change: WorkdayChange): string {
  switch (change.kind) {
    case "add_rule":
      return t("protocol.workday.change.addRule", { rule: describeExtraRule(change.rule) });
    case "remove_rule":
      return t("protocol.workday.change.removeRule", { rule: describeExtraRule(change.rule) });
    case "mark":
      return t(change.mark === "work" ? "protocol.workday.change.markWork" : "protocol.workday.change.markRest", { date: describeLocalDate(change.date) });
    case "clear_mark":
      return t("protocol.workday.change.clearMark", { date: describeLocalDate(change.date) });
  }
}

/**
 * 改个人设置：新的设置，和有没有变化（同一条规则再加、删不存在的规则、同样的标记再标、清掉没有的标记都没有变化）。
 * 日期不存在（2026-02-30）时抛错。
 */
export function applyWorkdayChange(settings: WorkdaySettings, change: WorkdayChange): { settings: WorkdaySettings; changed: boolean } {
  switch (change.kind) {
    case "add_rule": {
      if (settings.rules.some((r) => sameRule(r, change.rule))) return { settings, changed: false };
      return { settings: { ...settings, rules: [...settings.rules, normalizeRule(change.rule)] }, changed: true };
    }
    case "remove_rule": {
      const rules = settings.rules.filter((r) => !sameRule(r, change.rule));
      return rules.length === settings.rules.length ? { settings, changed: false } : { settings: { ...settings, rules }, changed: true };
    }
    case "mark": {
      parseLocalDate(change.date);
      if (settings.marks.some((m) => m.date === change.date && m.mark === change.mark)) return { settings, changed: false };
      const marks = [...settings.marks.filter((m) => m.date !== change.date), { date: change.date, mark: change.mark }].toSorted((a, b) => a.date.localeCompare(b.date));
      return { settings: { ...settings, marks }, changed: true };
    }
    case "clear_mark": {
      parseLocalDate(change.date);
      const marks = settings.marks.filter((m) => m.date !== change.date);
      return marks.length === settings.marks.length ? { settings, changed: false } : { settings: { ...settings, marks }, changed: true };
    }
  }
}

/** 规范成存进配置的样子：规则只留自己的字段、同一条只留一份；标记按日期排好、同一天只留最后一个。日期不存在时抛错 */
export function normalizeWorkdaySettings(settings: WorkdaySettings): WorkdaySettings {
  let next: WorkdaySettings = EMPTY_WORKDAY_SETTINGS;
  for (const rule of settings.rules) next = applyWorkdayChange(next, { kind: "add_rule", rule }).settings;
  for (const m of settings.marks) next = applyWorkdayChange(next, { kind: "mark", date: m.date, mark: m.mark }).settings;
  return next;
}

/** 两条规则是不是同一条（按写法） */
export function sameRule(a: ExtraWorkdayRule, b: ExtraWorkdayRule): boolean {
  return a.kind === b.kind && a.weekday === b.weekday && (a.kind !== "nth_weekday" || b.kind !== "nth_weekday" || a.n === b.n);
}

/** 规则只留它自己的字段（存进配置的样子） */
function normalizeRule(rule: ExtraWorkdayRule): ExtraWorkdayRule {
  return rule.kind === "nth_weekday" ? { kind: rule.kind, n: rule.n, weekday: rule.weekday } : { kind: rule.kind, weekday: rule.weekday };
}

function ruleMatches(rule: ExtraWorkdayRule, year: number, month: number, dayOfMonth: number, weekday: number): boolean {
  if (weekday !== rule.weekday) return false;
  switch (rule.kind) {
    case "weekly":
      return true;
    case "nth_weekday":
      return Math.ceil(dayOfMonth / 7) === rule.n;
    case "last_weekday":
      return dayOfMonth + 7 > daysInMonth(year, month);
  }
}
