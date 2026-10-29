// 项目规范（issue 19，258 号票）：每个项目默认继承的一套文档要求，模板放在框架里按版本分目录
// （packages/daemon/templates/project-standard/<版本>/<开发类 dev | 其他类 other>/<语言>/）。这里是守护进程和 Web 共用的名字和形状：
// 规范里有哪几份文档、哪几份必须有（会检查）、只读接口 GET /api/projects/<id>/standard 返回什么（ProjectStandardView）。
// 不引用 TypeBox。
// - 四份必须有、会检查：规格、架构图、进展、决策记录（ADR）；"其他"类不要架构图（只三份）。立项书、术语表、项目清单、范围记录照旧，算辅助
//   （issue 19 第 1、4 条）；
// - 开发类另有 tickets/（一票一文件，格式同二狗自己的票）和 ops.json（运营接口清单，MCP 格式，转运营前才要求有）（第 6、7 条）；
// - 检查清单：当前状态转到下一个状态之前要做到的（第 3 条）。258 号票先给结构和"进展已写回"一项，其余由 259 号票填；
// - 本项目的规范改写（第 5 条，261 号票）：维护者提、用户在"规范改写"卡上确认才生效（照立项要求变更那套）。一条改写管规范里的
//   某一份（这个项目不要它、换一种写法）或者多出来的一份（按档案里的位置）；规范里每一份在这个项目里算什么按改写算
//   （effectiveStandardDocs），检查清单里看某一份文档的项，这个项目不要那一份就不列（standardChecklistApplies）。模板出了新版不自动带旧项目，
//   只提示有新版（standardHasNewer），要跟也由维护者提、用户确认。
import { t, tTable } from "./i18n/runtime.ts";
import type { ProjectKind, ProjectState } from "./projects.ts";

/** 框架里最新的规范模板版本：新项目建档时用它，记在项目上（Project.standardVersion）。模板升级不自动带旧项目（第 5 条，261 号票提示） */
export const PROJECT_STANDARD_LATEST = "v1";

/** 规范里的文档 */
export const STANDARD_DOCS = ["spec", "architecture", "progress", "adr", "tickets", "ops", "charter", "glossary", "manifest", "scopeRecords"] as const;
export type StandardDocKey = (typeof STANDARD_DOCS)[number];

/**
 * 一份文档在规范里算什么：
 * - required：必须有、会检查（开发类四份，其他类三份）；
 * - before_in_use：转运营（建设中 → 使用中）之前要有（ops.json）；
 * - kind：这类项目的模板里有、不检查（开发类的 tickets/）；
 * - auxiliary：辅助的，照旧生成、不检查（立项书、术语表、项目清单、范围记录）
 */
export const STANDARD_DOC_ROLES = ["required", "before_in_use", "kind", "auxiliary"] as const;
export type StandardDocRole = (typeof STANDARD_DOC_ROLES)[number];

/** 每类项目必须有的几份（按这个先后显示） */
export const STANDARD_REQUIRED_DOCS: Readonly<Record<ProjectKind, readonly StandardDocKey[]>> = {
  dev: ["spec", "architecture", "progress", "adr"],
  other: ["spec", "progress", "adr"],
};

/** 每类项目另有的、不在"必须有"里的（开发类的 tickets/、ops.json） */
export const STANDARD_KIND_DOCS: Readonly<Record<ProjectKind, ReadonlyArray<{ key: StandardDocKey; role: "before_in_use" | "kind" }>>> = {
  dev: [
    { key: "tickets", role: "kind" },
    { key: "ops", role: "before_in_use" },
  ],
  other: [],
};

/** 辅助的几份：照旧生成，不检查 */
export const STANDARD_AUXILIARY_DOCS: readonly StandardDocKey[] = ["charter", "glossary", "manifest", "scopeRecords"];

/**
 * 一个项目的规范里有哪几份、各算什么（按显示的先后）。项目类型立项书确认之后才有：之前按其他类的三份算
 * （开发类多的那几份在立项书确认时补上）
 */
export function standardDocsOf(kind: ProjectKind | undefined): Array<{ key: StandardDocKey; role: StandardDocRole }> {
  const k = kind ?? "other";
  return [
    ...STANDARD_REQUIRED_DOCS[k].map((key) => ({ key, role: "required" as const })),
    ...STANDARD_KIND_DOCS[k],
    ...STANDARD_AUXILIARY_DOCS.map((key) => ({ key, role: "auxiliary" as const })),
  ];
}

export const STANDARD_DOC_LABEL: Readonly<Record<StandardDocKey, string>> = tTable({
  spec: "protocol.projectStandard.doc.spec",
  architecture: "protocol.projectStandard.doc.architecture",
  progress: "protocol.projectStandard.doc.progress",
  adr: "protocol.projectStandard.doc.adr",
  tickets: "protocol.projectStandard.doc.tickets",
  ops: "protocol.projectStandard.doc.ops",
  charter: "protocol.projectStandard.doc.charter",
  glossary: "protocol.projectStandard.doc.glossary",
  manifest: "protocol.projectStandard.doc.manifest",
  scopeRecords: "protocol.projectStandard.doc.scopeRecords",
});

/** 规范改写里多出来的一份（261 号票）：不在默认规范里，名字和位置是改写里写的 */
export const STANDARD_CUSTOM_DOC = "custom";
export type StandardDocViewKey = StandardDocKey | typeof STANDARD_CUSTOM_DOC;

/** 一份文档现在的样子 */
export interface StandardDocView {
  /** 规范里的哪一份；改写里多出来的是 custom（名字在 title） */
  key: StandardDocViewKey;
  /** 改写里多出来的那份的名字（261 号票） */
  title?: string;
  /** 本项目的规范改写动了这一份（261 号票）：不要（drop，不再检查）、换一种写法（change）、多出来的（add） */
  override?: StandardOverrideKind;
  /** 在项目档案里的位置（相对项目档案，目录以 / 结尾）：spec.md、adr/ */
  path: string;
  role: StandardDocRole;
  /** 在不在（目录：目录在） */
  exists: boolean;
  /** 最近修改时间（目录取里面最新的那个文件；不在的没有） */
  modifiedAt?: string;
  /**
   * 还是模板原样、没写过（文件和某个版本的模板一字不差；目录里只有模板的说明文件）。从模板生成的几份才有，辅助的几份不给。
   * 在、但还是模板原样，就是"还没写"
   */
  untouched?: boolean;
}

/**
 * 检查清单里的项（258 号票只有"进展已写回"；259 号票加上转运营——建设中 → 使用中——的那几项，issue 19 第 3 条）：
 * - architecture：架构图写清服务和对外接口（architecture.md 写过、"用到的服务""对外接口"两张表都有行，没有就写一行"无"；
 *   运营方案里的服务架构图里都写着）；
 * - ops：运营接口清单验收通过（268 号票起照 112 号票的自动验收：格式对、每个操作一条能跑通的测试、只读的真不写；项目服务上的操作
 *   等服务上线后再测，别的都过了也算做到。259 号票时只查 ops.json 不是模板原样、是合法的 JSON、tools 是列表、每个接口有 name）；
 * - services：服务按模板在 LSM 登记——架构图里写的服务都写进了运营方案（means: service，133 号票的模板），确认转入使用时
 *   运行时照它交给 LSM 登记、启动；
 * - public_entry：要外网的开好 /apps/<项目>/——对外接口里走 /apps/…、公网的，运营方案里有对应的带网页（web）的服务，
 *   确认后经二狗转发（issue 20：共用隧道和配对认证）；
 * - progress_written：进展已写回（所有转换都要）。
 * 开发类的建设中 → 使用中五项都查；其他类只查进展，运营方案里真有服务的照开发类查（第 4 条"真有服务就按开发类来"）。
 * 别的转换（筹备中 → 建设中、使用中 → 已停用、已停用 → 使用中）只要进展写回（停用时的反向收回由运行时做，不在清单里）
 */
export const STANDARD_CHECKLIST_ITEMS = ["architecture", "ops", "services", "public_entry", "progress_written"] as const;
export type StandardChecklistItemId = (typeof STANDARD_CHECKLIST_ITEMS)[number];

export const STANDARD_CHECKLIST_ITEM_LABEL: Readonly<Record<StandardChecklistItemId, string>> = tTable({
  architecture: "protocol.projectStandard.checklist.architecture",
  ops: "protocol.projectStandard.checklist.ops",
  services: "protocol.projectStandard.checklist.services",
  public_entry: "protocol.projectStandard.checklist.publicEntry",
  progress_written: "protocol.projectStandard.checklist.progressWritten",
});

/**
 * 检查清单里每一项看的是哪一份文档（261 号票）：这个项目不要那一份（规范改写），这一项就不列。架构图写清服务和对外接口看架构图、
 * 运营接口清单已交看 ops.json；服务登记、/apps/ 两项看运营方案，不挂在哪一份文档上（不要架构图时只按运营方案查）；进展不能不要
 */
export const STANDARD_CHECKLIST_ITEM_DOC: Readonly<Record<StandardChecklistItemId, StandardDocKey | undefined>> = {
  architecture: "architecture",
  ops: "ops",
  services: undefined,
  public_entry: undefined,
  progress_written: "progress",
};

/** 看 doc 这份文档的检查项在这个项目里列不列：这个项目不要它（规范改写）就不列 */
export function standardChecklistApplies(doc: StandardDocKey | undefined, overrides: readonly StandardOverride[]): boolean {
  return doc === undefined || !overrides.some((o) => o.kind === "drop" && o.doc === doc);
}

/** 检查清单里的一项 */
export interface StandardChecklistItem {
  id: StandardChecklistItemId;
  /** 说法（守护进程按当时的语言给） */
  label: string;
  done: boolean;
  /**
   * 没做到时差什么（"缺 ops.json"、"架构图里的服务「site」没写进运营方案"）；做到了的也可以有一句说明
   * （"没有服务，不用登记"、"确认后开 /apps/p-1-site/"）
   */
  detail?: string;
}

/** 清单里还没做到的几项 */
export function checklistMissing<I extends Pick<StandardChecklistItem, "done">>(items: readonly I[]): I[] {
  return items.filter((i) => !i.done);
}

/**
 * 每个状态的检查清单管哪一次转换：筹备中 → 建设中、建设中 → 使用中（重点，259 号票）、使用中 → 已停用（反向收回）、已停用 → 使用中；
 * 已归档没有（取消归档只是回到归档前的状态）
 */
export const STANDARD_CHECKLIST_TO: Readonly<Record<ProjectState, ProjectState | null>> = {
  preparing: "building",
  building: "in_use",
  in_use: "retired",
  retired: "in_use",
  archived: null,
};

/** 当前状态的检查清单 */
export interface StandardChecklistView {
  /** 现在的状态 */
  from: ProjectState;
  /** 这份清单管的转换要去的状态（已归档没有，项也是空的） */
  to: ProjectState | null;
  items: StandardChecklistItem[];
}

// ───────────────────────── 本项目的规范改写（261 号票） ─────────────────────────

/** 改写能动的几份：从模板生成的那几份（辅助的几份本来就不检查，不用改写） */
export const STANDARD_OVERRIDABLE_DOCS = ["spec", "architecture", "progress", "adr", "tickets", "ops"] as const satisfies readonly StandardDocKey[];
export type StandardOverridableDoc = (typeof STANDARD_OVERRIDABLE_DOCS)[number];

/** 不能不要的：进展（每段工作结束都要写回，运行时靠它判断写回了没有；检查清单的"进展已写回"） */
export const STANDARD_UNDROPPABLE_DOCS: readonly StandardOverridableDoc[] = ["progress"];

/** 一条改写是哪一种：这个项目不要规范里的某一份、某一份换一种写法、多一份 */
export const STANDARD_OVERRIDE_KINDS = ["drop", "change", "add"] as const;
export type StandardOverrideKind = (typeof STANDARD_OVERRIDE_KINDS)[number];

/**
 * 一条改写：
 * - drop：这个项目不要规范里的这一份（不再检查，守护进程也不从模板补回来）；
 * - change：这一份照样要，换一种写法（note：怎么写）；
 * - add：多一份（path：档案里的位置，目录以 / 结尾；title：名字；note：写什么），算必须有的
 */
export type StandardOverride =
  | { kind: "drop"; doc: StandardOverridableDoc }
  | { kind: "change"; doc: StandardOverridableDoc; note: string }
  | { kind: "add"; path: string; title: string; note: string };

/** 现在生效的一条改写：第几次改写里用户确认的、什么时候 */
export type StandardOverrideEntry = StandardOverride & { revision: number; confirmedAt: string };

/** 一次改写里的一处变化：同一份的改写前后（没有就是照默认规范）。只有 after 是新加的，只有 before 是恢复照默认 */
export interface StandardChangeItem {
  before?: StandardOverride;
  after?: StandardOverride;
}

/**
 * 跟新版规范：项目记着的版本换成框架里最新的（缺的文档从新版模板补上，已有的不动）。
 * 272 号票：规范上线之前建的项目（没有版本）也走这条路补齐规范文档——没有 from，missing 是提的时候算的缺的几份；
 * 确认后照 262 号票的补齐做（改用规范、从模板放进缺的几份，再建一个任务交给维护者照项目现状写好）
 */
export interface StandardUpgrade {
  from?: string;
  to: string;
  missing?: StandardBackfillDoc[];
}

/** 一条改写管的是哪一份：规范里的按名字，多出来的按位置（同一份只能有一条） */
export function standardOverrideTarget(o: StandardOverride): string {
  return o.kind === "add" ? `path:${o.path}` : `doc:${o.doc}`;
}

/** 去掉第几次、什么时候确认（比内容、存进卡里用） */
export function bareStandardOverride(o: StandardOverride): StandardOverride {
  if (o.kind === "drop") return { kind: "drop", doc: o.doc };
  if (o.kind === "change") return { kind: "change", doc: o.doc, note: o.note };
  return { kind: "add", path: o.path, title: o.title, note: o.note };
}

/** 两条改写内容一样（不看第几次、什么时候） */
export function sameStandardOverride(a: StandardOverride | undefined, b: StandardOverride | undefined): boolean {
  return JSON.stringify(a && bareStandardOverride(a)) === JSON.stringify(b && bareStandardOverride(b));
}

/** 用户确认了的一次改写合进现在生效的：改同一份的原地换掉，恢复照默认的拿掉，新加的接在后面 */
export function applyStandardChange(
  entries: readonly StandardOverrideEntry[],
  items: readonly StandardChangeItem[],
  stamp: { revision: number; confirmedAt: string },
): StandardOverrideEntry[] {
  let next: Array<StandardOverrideEntry | undefined> = [...entries];
  for (const item of items) {
    const subject = item.after ?? item.before;
    if (!subject) continue;
    const target = standardOverrideTarget(subject);
    const at = next.findIndex((e) => e !== undefined && standardOverrideTarget(e) === target);
    const entry: StandardOverrideEntry | undefined = item.after ? { ...bareStandardOverride(item.after), ...stamp } : undefined;
    if (at >= 0) next[at] = entry;
    else if (entry) next = [...next, entry];
  }
  return next.filter((e): e is StandardOverrideEntry => e !== undefined);
}

/** 一条改写管的那一份叫什么：规范里的取名字，多出来的写"「名字」（位置）" */
function overrideSubject(o: StandardOverride): string {
  return o.kind === "add" ? t("protocol.projectStandard.override.custom", { title: o.title, path: o.path }) : STANDARD_DOC_LABEL[o.doc];
}

/** 一条改写写成一句："不要架构图""进展换一种写法：按周写""多一份「运维手册」（runbook.md）：写什么" */
export function standardOverrideText(o: StandardOverride): string {
  if (o.kind === "drop") return t("protocol.projectStandard.override.drop", { doc: STANDARD_DOC_LABEL[o.doc] });
  if (o.kind === "change") return t("protocol.projectStandard.override.change", { doc: STANDARD_DOC_LABEL[o.doc], note: o.note });
  return t("protocol.projectStandard.override.add", { doc: overrideSubject(o), note: o.note });
}

/** 一处变化写成一句（卡的纯文本降级、交给维护者的通知、档案里的变更记录） */
export function standardChangeItemText(item: StandardChangeItem): string {
  if (item.before && item.after) return t("protocol.projectStandard.change.replace", { before: standardOverrideText(item.before), after: standardOverrideText(item.after) });
  if (item.before) return t("protocol.projectStandard.change.restore", { doc: overrideSubject(item.before), before: standardOverrideText(item.before) });
  return item.after ? standardOverrideText(item.after) : "";
}

/** 跟新版规范写成一句；没有版本的项目（272 号票）写成补齐规范文档，缺的几份跟在后面 */
export function standardUpgradeText(u: StandardUpgrade): string {
  if (u.from !== undefined) return t("protocol.projectStandard.change.upgrade", { from: u.from, to: u.to });
  const missing = u.missing ?? [];
  if (missing.length === 0) return t("protocol.projectStandard.change.adopt", { to: u.to });
  return t("protocol.projectStandard.change.adoptMissing", { to: u.to, docs: missing.map(standardBackfillDocText).join(t("protocol.common.listSep")) });
}

/** 规范里的一份在这个项目里算什么（按改写） */
export interface EffectiveStandardDoc {
  key: StandardDocViewKey;
  role: StandardDocRole;
  override?: StandardOverrideKind;
  /** 多出来的那份：档案里的位置、名字 */
  path?: string;
  title?: string;
}

/**
 * 一个项目的规范里有哪几份、各算什么（按改写，按显示的先后）：默认规范的每一份（standardDocsOf），这个项目不要的标 drop、换写法的标 change；
 * 多出来的几份算必须有的，接在默认必须有的后面
 */
export function effectiveStandardDocs(kind: ProjectKind | undefined, overrides: readonly StandardOverride[]): EffectiveStandardDoc[] {
  const docs: EffectiveStandardDoc[] = standardDocsOf(kind).map(({ key, role }) => {
    const o = overrides.find((x) => x.kind !== "add" && x.doc === key);
    return { key, role, ...(o ? { override: o.kind } : {}) };
  });
  const added = overrides.flatMap((o): EffectiveStandardDoc[] => (o.kind === "add" ? [{ key: STANDARD_CUSTOM_DOC, role: "required", override: "add", path: o.path, title: o.title }] : []));
  const lastRequired = docs.findLastIndex((d) => d.role === "required");
  return [...docs.slice(0, lastRequired + 1), ...added, ...docs.slice(lastRequired + 1)];
}

/** 本项目的规范改写里现在生效的一条（只读接口里给网页看：和默认规范哪里不同） */
export type StandardOverrideView = StandardOverrideEntry & {
  /** 在项目档案里的位置（不要的、换写法的是规范里那一份的位置；目录以 / 结尾） */
  path: string;
  /** 一句话（守护进程按当时的语言给）："不要架构图" */
  summary: string;
  /** 维护者提这次改写时说的为什么 */
  why: string;
};

/** 只读接口 GET /api/projects/<id>/standard 的返回 */
export interface ProjectStandardView {
  projectId: string;
  /** 建档时用的模板版本；规范上线之前建的项目没有（null：262 号票出"补齐文档"的任务） */
  version: string | null;
  /** 框架里最新的模板版本（261 号票：项目用的旧了，提示有新版——standardHasNewer；不自动跟） */
  latest: string;
  /** 项目类型（立项书确认之后才有；之前按其他类的三份算） */
  kind: ProjectKind | null;
  /** 规范里的每一份（按本项目的规范改写）：必须有的在前（改写里多出来的接在后面），然后是这类项目另有的、辅助的 */
  docs: StandardDocView[];
  /** 当前状态的检查清单（按改写：这个项目不要的那份，看它的项不列） */
  checklist: StandardChecklistView;
  /** 本项目的规范改写：现在生效的每一条（按确认的先后），没有改写是空的 */
  overrides: StandardOverrideView[];
}

/** 模板出了新版：项目记着的版本不是框架里最新的（规范上线之前建的没有版本，归 262 号票补齐，不算） */
export function standardHasNewer(view: Pick<ProjectStandardView, "version" | "latest">): boolean {
  return view.version !== null && view.version !== view.latest;
}

/** 一份文档在项目页上怎么说：写了、只有模板（在，但还是模板原样）、缺（不在）、本项目不要（规范改写，261 号票） */
export const STANDARD_DOC_STATES = ["written", "template", "missing", "dropped"] as const;
export type StandardDocState = (typeof STANDARD_DOC_STATES)[number];

export const STANDARD_DOC_STATE_LABEL: Readonly<Record<StandardDocState, string>> = tTable({
  written: "protocol.projectStandard.state.written",
  template: "protocol.projectStandard.state.template",
  missing: "protocol.projectStandard.state.missing",
  dropped: "protocol.projectStandard.state.dropped",
});

export function standardDocState(doc: Pick<StandardDocView, "exists" | "untouched" | "override">): StandardDocState {
  if (doc.override === "drop") return "dropped";
  if (!doc.exists) return "missing";
  return doc.untouched === true ? "template" : "written";
}

// ───────────────────────── 现有项目补齐规范文档（262 号票） ─────────────────────────
// issue 19 第 10 条（用户原话："可以给个任务，但是不一定要补，我确认后再补"）：规范上线之前建的项目（没有版本）出一张"补齐规范文档"卡，
// 写明按它的类型和本项目的规范改写缺哪几份；用户选"补齐"才改用现在的规范、建任务交给维护者补，选"不补"就不补；一个项目只出一次。

/** 补齐时算进来的几种：必须有的、这类另有的（开发类的票、转运营之前要有的运营接口清单）；辅助的照旧不算 */
const BACKFILL_ROLES: readonly StandardDocRole[] = ["required", "kind", "before_in_use"];

/** 缺的一份：缺（不在），还是只有说明（目录在、里面只有模板的 README.md，比如一条决策记录都没记） */
export const STANDARD_BACKFILL_DOC_STATES = ["missing", "template"] as const;
export type StandardBackfillDocState = (typeof STANDARD_BACKFILL_DOC_STATES)[number];

/** 规范上线之前建的项目缺的一份：规范里的哪一份（改写里多出来的是 custom，名字在 title）、在项目档案里的位置 */
export interface StandardBackfillDoc {
  key: StandardDocViewKey;
  path: string;
  title?: string;
  state: StandardBackfillDocState;
}

/**
 * 一个项目缺的几份（只读接口的返回里算）：按项目类型和本项目的规范改写（docs 已经按改写算过），必须有的、这类另有的不在或者只有说明的；
 * 写了的、本项目不要的、辅助的不算。都齐了是空的
 */
export function standardBackfillDocs(view: Pick<ProjectStandardView, "docs">): StandardBackfillDoc[] {
  return view.docs.flatMap((d): StandardBackfillDoc[] => {
    if (!BACKFILL_ROLES.includes(d.role)) return [];
    const state = standardDocState(d);
    if (state !== "missing" && state !== "template") return [];
    return [{ key: d.key, path: d.path, ...(d.title === undefined ? {} : { title: d.title }), state }];
  });
}

/** 缺的一份写成一句："架构图（architecture.md）"、"决策记录（adr/，只有说明）"、改写里多出来的写它的名字 */
export function standardBackfillDocText(doc: StandardBackfillDoc): string {
  const label = doc.key === STANDARD_CUSTOM_DOC ? (doc.title ?? doc.path) : STANDARD_DOC_LABEL[doc.key];
  return t(doc.state === "template" ? "protocol.projectStandard.backfill.docTemplate" : "protocol.projectStandard.backfill.doc", { label, path: doc.path });
}

/** "补齐规范文档"卡上的两个选择：补齐（改用现在的规范、建任务交给维护者补）、不补 */
export const STANDARD_BACKFILL_CHOICES = ["backfill", "skip"] as const;
export type StandardBackfillChoice = (typeof STANDARD_BACKFILL_CHOICES)[number];

export const STANDARD_BACKFILL_CHOICE_LABEL: Readonly<Record<StandardBackfillChoice, string>> = tTable({
  backfill: "protocol.projectStandard.backfill.choice.backfill",
  skip: "protocol.projectStandard.backfill.choice.skip",
});
