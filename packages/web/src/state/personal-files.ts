// 个人档案在网页上怎么写（纯函数，档案页、核对卡用）：一份档案在列表上叫什么、"出处"那一行、
// 号码分组、删一样东西时有几句出处的原话可以一起彻底删除。档案经 HTTP 现取（不走事件），形状在协议包的 personal-files-schema.ts。
// 列表分四组（我、家人、重要的人、其他人），personalFileGroups。
// 449：生日、纪念日的选择器（公历 / 农历，年、月、日三个下拉，农历可勾闰月）的草稿：从现在的值预选、改一样以后日子往回收、拼成存的样子。
import { MEMORY_CONFIDENCE_LABEL, MEMORY_EPISTEMIC_LABEL, MEMORY_TIER_LABEL } from "./memory-graph.ts";
import {
  type AnnualCalendar,
  annualDayMax,
  ANNUAL_YEAR_MIN,
  formatAnnualDate,
  parseAnnualDate,
  type MemoryClaimTier,
  type MemoryConfidence,
  type MemoryEpistemic,
  type PersonalAnnualView,
  type PersonalFieldValue,
  type PersonalFileDeleteTarget,
  type PersonalFileSource,
  type PersonalFileSuggestItem,
  type PersonalFilesView,
  type PersonalFileSummary,
  type PersonalFileView,
  type PersonalLearnedClaim,
  guessPersonGroup,
  PERSON_GROUPS,
  type PersonGroup,
  t,
  tTable,
} from "./protocol.ts";

/** 协议时间 → 日期（守护进程那边的日子） */
export const personalDate = (iso: string | undefined): string => (iso ?? "").slice(0, 10);

/** 285：三组的名字（本人那份另成一组"我"） */
export const PERSON_GROUP_LABEL: Readonly<Record<PersonGroup, string>> = tTable({
  family: "pages.personalFiles.group.family",
  important: "pages.personalFiles.group.important",
  others: "pages.personalFiles.group.others",
});

/** 档案列表上的一组 */
export interface PersonalFilesGroup {
  id: "me" | PersonGroup;
  title: string;
  files: PersonalFileSummary[];
}

/** 一份档案归哪组：带了分组的照它，没带的（老的守护进程）按关系猜 */
const groupOf = (f: PersonalFileSummary): PersonGroup => f.group ?? guessPersonGroup(f.relation);

/** 285：档案列表分四组——我（本人那份）、家人、重要的人、其他人，组里照列表给的先后（建的先后）；空的组也列（页面上写"还没有"） */
export function personalFileGroups(view: PersonalFilesView): PersonalFilesGroup[] {
  return [
    { id: "me", title: t("pages.personalFiles.selfTitle"), files: view.files.filter((f) => f.kind === "self") },
    ...PERSON_GROUPS.map((g) => ({ id: g, title: PERSON_GROUP_LABEL[g], files: view.files.filter((f) => f.kind === "person" && groupOf(f) === g) })),
  ];
}

/** 列表上、标题里一份档案叫什么：本人写"我"（设了名字写"我 · 名字"），别人写称呼 */
export function personalFileName(file: Pick<PersonalFileSummary, "kind" | "name" | "id">): string {
  if (file.kind === "self") return file.name === undefined ? t("pages.personalFiles.me") : t("pages.personalFiles.meNamed", { name: file.name });
  return file.name ?? file.id;
}

/** 列表上的一句：和我的关系、填了几项、记了几件事 */
export function personalFileSub(file: PersonalFileSummary): string {
  const counts = t("pages.personalFiles.counts", { filled: file.filled, notes: file.notes });
  return file.relation === undefined ? counts : t("pages.personalFiles.relationCounts", { relation: file.relation, counts });
}

/** 怎么写进来的（不带原话）：你在档案页填的、你在聊天里说的、你在核对卡上确认的、管理员提议你确认的、二狗统一了写法（460） */
export function sourceVia(source: PersonalFileSource): string {
  if (source.via === "page") return t("pages.personalFiles.via.page");
  if (source.via === "tidy") return t("pages.personalFiles.via.tidy");
  if (source.via === "curator") return t(source.origin === "contacts" ? "pages.personalFiles.via.contacts" : source.origin === "vcard" ? "pages.personalFiles.via.vcard" : "pages.personalFiles.via.curator");
  return source.basis === "explicit" ? t("pages.personalFiles.via.explicit") : t("pages.personalFiles.via.confirmed");
}

/** "出处"那一行：从哪天起（以前的值写到哪天为止）、怎么写进来的；原话另外显示（sourceQuote）。本人的姓名来自"我的名字"，没有时间 */
export function valueSourceLine(value: PersonalFieldValue): string {
  if (!value.source) return t("pages.personalFiles.fromUserName");
  const when =
    value.until === undefined ? t("pages.personalFiles.since", { date: personalDate(value.since) }) : t("pages.personalFiles.between", { from: personalDate(value.since), to: personalDate(value.until) });
  return t("pages.personalFiles.sourceLine", { when, via: sourceVia(value.source) });
}

/** 原话：有就带引号，彻底删除了写明；页面里改的、二狗统一写法的没有 */
export function sourceQuote(source: PersonalFileSource | undefined): string | undefined {
  if (!source || source.via === "page" || source.via === "tidy") return undefined;
  if (source.messageGone) return t("pages.personalFiles.quoteGone");
  return source.quote === undefined ? undefined : t("pages.personalFiles.quote", { quote: source.quote });
}

/** 删这样东西时能一起彻底删除的出处（还在的那几句原话）有几句 */
export function deletableSources(file: PersonalFileView, target: PersonalFileDeleteTarget): number {
  const sources: Array<PersonalFileSource | undefined> = [];
  const fieldSources = (field: string) => {
    const view = file.fields.find((f) => f.field === field);
    if (!view) return;
    sources.push(view.current?.source, ...view.history.map((h) => h.source));
  };
  if (target.kind === "field") fieldSources(target.field);
  else if (target.kind === "note") sources.push(file.notes.find((n) => n.id === target.noteId)?.source);
  else {
    for (const field of file.fields) fieldSources(field.field);
    sources.push(...file.notes.map((n) => n.source));
  }
  const ids = new Set(sources.flatMap((s) => (s?.messageId !== undefined && !s.messageGone ? [s.messageId] : [])));
  return ids.size;
}

// ----------每年提醒、二狗了解到的、候选核对卡 ----------

/** 每年提醒能选提前几天（0 是当天） */
export const ANNUAL_REMINDER_DAY_CHOICES: readonly number[] = [0, 1, 2, 3, 5, 7, 14, 30];

/** "提前 3 天"、"当天" */
export function annualDaysLabel(days: number): string {
  return days === 0 ? t("pages.personalFiles.annual.sameDay") : t("pages.personalFiles.annual.daysBefore", { count: days });
}

/** 档案页上生日、纪念日字段能不能开每年提醒（有认得出的公历日子、提醒插件在） */
export function annualPickable(annual: PersonalAnnualView): boolean {
  return annual.monthDay !== undefined && annual.blocked === undefined;
}

/**
 * 档案页上每年提醒的那句小字：农历的暂时不能自动提醒、提醒插件没启用、下次哪天提醒（都没有是 undefined）。
 * 449：值认不出的（以前随手写的）不在这里说——值旁边已经提示了"格式认不出，点「改」重新选"
 */
export function annualNote(annual: PersonalAnnualView, value?: string): string | undefined {
  if (annual.blocked === "not_gregorian") return value !== undefined && parseAnnualDate(value) === undefined ? undefined : t("pages.personalFiles.annual.notGregorian");
  if (annual.blocked === "reminders_off") return annual.daysBefore === undefined ? t("pages.personalFiles.annual.remindersOff") : t("pages.personalFiles.annual.onButOff");
  return annual.nextAt === undefined || annual.daysBefore === undefined ? undefined : t("pages.personalFiles.annual.next", { date: personalDate(annual.nextAt) });
}

/** "二狗了解到的"里一条结论的小字：层 · 把握 · 谁说的 */
export function learnedClaimMeta(claim: PersonalLearnedClaim): string {
  const parts = [
    MEMORY_TIER_LABEL[claim.tier as MemoryClaimTier] ?? claim.tier,
    MEMORY_CONFIDENCE_LABEL[claim.confidence as MemoryConfidence] ?? claim.confidence,
    MEMORY_EPISTEMIC_LABEL[claim.epistemic as MemoryEpistemic] ?? claim.epistemic,
  ];
  return parts.join(" · ");
}

/** 候选核对卡上的条目按人分组（卡上一个人一块：建档那一条在最前） */
export interface SuggestGroup {
  key: string;
  person: PersonalFileSuggestItem["person"];
  create?: PersonalFileSuggestItem;
  items: PersonalFileSuggestItem[];
}

export function suggestGroups(items: readonly PersonalFileSuggestItem[]): SuggestGroup[] {
  const groups: SuggestGroup[] = [];
  for (const item of items) {
    const key = item.person.id ?? `new:${item.person.name}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, person: item.person, items: [] };
      groups.push(group);
    }
    if (item.kind === "create") group.create = item;
    else group.items.push(item);
  }
  return groups;
}

/** 候选从哪几天的话里听到的："据你 10-25 说的"（日期去掉年份） */
export function suggestHeard(item: PersonalFileSuggestItem): string | undefined {
  if (item.heard.length === 0) return undefined;
  return t("pages.personalFiles.suggest.heard", { dates: item.heard.map((d) => d.slice(5)).join(t("pages.personalFiles.suggest.dateSep")) });
}

// ----------生日、纪念日的选择器（449） ----------

/** 选择器的草稿：公历 / 农历，年（没有是"不记得哪年"）、月、日（没选的没有），农历的闰月 */
export interface AnnualDraft {
  calendar: AnnualCalendar;
  year?: number;
  month?: number;
  day?: number;
  leap: boolean;
}

/** 打开时按现在的值预选（认得出的话）；没有值、认不出的从公历、不记得哪年、月日没选起 */
export function annualDraftOf(value: string | undefined): AnnualDraft {
  const date = value === undefined ? undefined : parseAnnualDate(value);
  if (!date) return { calendar: "solar", leap: false };
  return { calendar: date.calendar, ...(date.year === undefined ? {} : { year: date.year }), month: date.month, day: date.day, leap: date.leap === true };
}

/** 选的月份最多几号（月份还没选的按最长的算：公历 31、农历 30） */
const dayMaxOf = (draft: AnnualDraft) => annualDayMax(draft.calendar, draft.year, draft.month ?? 1);

/**
 * 改一样：换公历 / 农历（换成公历不再有闰月）、换年（null 是不记得哪年）、换月、换日、勾闰月。日子超过这个月最多几号的往回收
 * （2 月 29 日换成平年变 28 日，农历三十换成公历 2 月变 29 日）
 */
export function changeAnnualDraft(draft: AnnualDraft, change: { calendar?: AnnualCalendar; year?: number | null; month?: number; day?: number; leap?: boolean }): AnnualDraft {
  const { year: _year, ...base } = draft;
  const year = change.year === undefined ? draft.year : change.year === null ? undefined : change.year;
  const calendar = change.calendar ?? draft.calendar;
  const next: AnnualDraft = {
    ...base,
    ...(year === undefined ? {} : { year }),
    calendar,
    ...(change.month === undefined ? {} : { month: change.month }),
    ...(change.day === undefined ? {} : { day: change.day }),
    leap: calendar === "lunar" && (change.leap ?? draft.leap),
  };
  if (next.day !== undefined) next.day = Math.min(next.day, dayMaxOf(next));
  return next;
}

/** 选好了（月、日都选了）拼成存的样子（"--03-02""lunar:1990-L04-15"）；没选好是 undefined */
export function annualDraftValue(draft: AnnualDraft): string | undefined {
  if (draft.month === undefined || draft.day === undefined) return undefined;
  return formatAnnualDate({ calendar: draft.calendar, ...(draft.year === undefined ? {} : { year: draft.year }), month: draft.month, day: draft.day, ...(draft.leap ? { leap: true } : {}) });
}

/** 年份的选项：今年到 1900 年（新的在前）；现在的值是更早或者以后的年份时也列上 */
export function annualYearChoices(thisYear: number, current?: number): number[] {
  const years = Array.from({ length: thisYear - ANNUAL_YEAR_MIN + 1 }, (_, i) => thisYear - i);
  if (current !== undefined && !years.includes(current)) years.push(current);
  return years.toSorted((a, b) => b - a);
}

/** 日子的选项：1 到这个月最多几号（公历按年月，农历到三十） */
export function annualDayChoices(draft: AnnualDraft): number[] {
  return Array.from({ length: dayMaxOf(draft) }, (_, i) => i + 1);
}
