// 个人档案（281 号票）在网页上怎么写（纯函数，档案页、核对卡用）：一份档案在列表上叫什么、"出处"那一行、
// 号码分组、删一样东西时有几句出处的原话可以一起彻底删除。档案经 HTTP 现取（不走事件），形状在协议包的 personal-files-schema.ts。
// 285 号票：列表分四组（我、家人、重要的人、其他人），personalFileGroups。
import { MEMORY_CONFIDENCE_LABEL, MEMORY_EPISTEMIC_LABEL, MEMORY_TIER_LABEL } from "./memory-graph.ts";
import {
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

/** 怎么写进来的（不带原话）：你在档案页填的、你在聊天里说的、你在核对卡上确认的、管理员提议你确认的 */
export function sourceVia(source: PersonalFileSource): string {
  if (source.via === "page") return t("pages.personalFiles.via.page");
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

/** 原话：有就带引号，彻底删除了写明；页面里改的没有 */
export function sourceQuote(source: PersonalFileSource | undefined): string | undefined {
  if (!source || source.via === "page") return undefined;
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

// ---------- 283 号票：每年提醒、二狗了解到的、候选核对卡 ----------

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

/** 档案页上每年提醒的那句小字：认不出日子、提醒插件没启用、下次哪天提醒（都没有是 undefined） */
export function annualNote(annual: PersonalAnnualView): string | undefined {
  if (annual.blocked === "not_gregorian") return t("pages.personalFiles.annual.notGregorian");
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
