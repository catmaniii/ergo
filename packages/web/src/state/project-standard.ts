// 项目页上的"规范"一块（258 号票，纯函数）：项目用的哪一版规范、必须有的几份文档在不在（写了、只有模板、缺）。
// 数据是只读接口 GET /api/projects/<id>/standard 的返回（ProjectStandardView），每次打开项目页现取；详细的界面（检查清单）留给 issue 21。
// 261 号票：本项目的规范改写——不要的那份说"本项目不要"、换写法的标出来、改写里多出来的接在后面（名字是改写里写的），列出和默认规范
// 哪里不同（每条第几次改写、哪天确认）；模板出了新版提示"有新版"（不自动跟）；"规范改写"卡逐处对照（standardChangeRows），
// "规范"一块下列这个项目的几张卡（projectStandardCards）。
// 262 号票："补齐规范文档"卡上缺的每一份一行（standardBackfillRows：名字、位置、缺还是只有说明），"规范"一块下也列它（projectStandardCards）。
import {
  STANDARD_CUSTOM_DOC,
  STANDARD_DOC_LABEL,
  STANDARD_DOC_STATE_LABEL,
  type ProjectStandardView,
  type StandardBackfillCardPayload,
  type StandardBackfillDoc,
  type StandardChangeCardPayload,
  type StandardDocState,
  standardDocState,
  standardHasNewer,
  type StandardOverride,
  type StandardOverrideKind,
  standardOverrideTarget,
  t,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** "规范"一块里的一份文档 */
export interface StandardDocRow {
  /** 规范里的那份是它的名字（spec……），改写里多出来的是 custom:<位置> */
  key: string;
  label: string;
  /** 在项目档案里的位置（悬停时看） */
  path: string;
  state: StandardDocState;
  stateLabel: string;
  /** 本项目的规范改写动了它（261 号票）：不要、换写法、多出来的 */
  override?: StandardOverrideKind;
}

/** 和默认规范不同的一条（261 号票） */
export interface StandardOverrideRow {
  key: string;
  /** 一句话："不要架构图" */
  summary: string;
  /** 第几次改写、哪天确认 */
  meta: string;
}

/** "规范"一块要显示的 */
export interface StandardBlock {
  /** 用的哪一版规范；规范上线之前建的项目没有 */
  version: string | null;
  /** 模板出了新版（项目用的旧了）：新版的版本，不自动跟（261 号票）；没有是 null */
  newer: string | null;
  /** 项目类型还没定（立项书确认之前）：先按其他类的三份，开发类确认后多一份架构图 */
  kindPending: boolean;
  /** 必须有的几份（开发类四份，其他类三份；改写里多出来的接在后面） */
  docs: StandardDocRow[];
  /** 本项目的规范改写：和默认规范哪里不同（没有改写是空的） */
  overrides: StandardOverrideRow[];
}

export function projectStandardBlock(view: ProjectStandardView): StandardBlock {
  return {
    version: view.version,
    newer: standardHasNewer(view) ? view.latest : null,
    kindPending: view.kind === null,
    docs: view.docs
      .filter((d) => d.role === "required")
      .map((d) => {
        const state = standardDocState(d);
        const custom = d.key === "custom";
        return {
          key: custom ? `custom:${d.path}` : d.key,
          label: d.key === "custom" ? (d.title ?? d.path) : STANDARD_DOC_LABEL[d.key],
          path: d.path,
          state,
          stateLabel: STANDARD_DOC_STATE_LABEL[state],
          ...(d.override ? { override: d.override } : {}),
        };
      }),
    overrides: view.overrides.map((o) => ({
      key: standardOverrideTarget(o),
      summary: o.summary,
      meta: t("state.projectStandard.overrideMeta", { revision: o.revision, date: o.confirmedAt.slice(0, 10) }),
    })),
  };
}

// ───────────────────────── "规范改写"卡（261 号票） ─────────────────────────

/** 卡上的一处：哪一份、改前、改后（没有改写的一边写"照默认规范"）；跟新版规范写版本 */
export interface StandardChangeRow {
  key: string;
  label: string;
  before: string;
  after: string;
}

/** 一条改写在卡上怎么说（不带是哪一份：那在左边一栏） */
function ruleText(o: StandardOverride | undefined): string {
  if (!o) return t("state.standardChange.default");
  if (o.kind === "drop") return t("state.standardChange.drop");
  if (o.kind === "change") return t("state.standardChange.change", { note: o.note });
  return t("state.standardChange.add", { note: o.note });
}

/** 一条改写管的是哪一份：规范里的写名字，多出来的写"「名字」（位置）" */
function subjectOf(o: StandardOverride): string {
  return o.kind === "add" ? t("protocol.projectStandard.override.custom", { title: o.title, path: o.path }) : STANDARD_DOC_LABEL[o.doc];
}

export function standardChangeRows(p: Pick<StandardChangeCardPayload, "items" | "upgrade">): StandardChangeRow[] {
  return [
    // 272 号票：规范上线之前建的项目补齐规范文档时没有"从哪一版"
    ...(p.upgrade ? [{ key: "upgrade", label: t("state.standardChange.version"), before: p.upgrade.from ?? t("state.standardChange.noVersion"), after: p.upgrade.to }] : []),
    ...p.items.flatMap((item) => {
      const subject = item.after ?? item.before;
      return subject ? [{ key: standardOverrideTarget(subject), label: subjectOf(subject), before: ruleText(item.before), after: ruleText(item.after) }] : [];
    }),
  ];
}

// ───────────────────────── "补齐规范文档"卡（262 号票） ─────────────────────────

/** 卡上缺的一份：名字（改写里多出来的写它的名字）、位置、缺还是只有说明 */
export interface StandardBackfillRow {
  key: string;
  label: string;
  path: string;
  state: StandardBackfillDoc["state"];
  stateLabel: string;
}

export function standardBackfillRows(p: Pick<StandardBackfillCardPayload, "missing">): StandardBackfillRow[] {
  return p.missing.map((d) => ({
    ...(d.key === STANDARD_CUSTOM_DOC ? { key: `custom:${d.path}`, label: d.title ?? d.path } : { key: d.key, label: STANDARD_DOC_LABEL[d.key] }),
    path: d.path,
    state: d.state,
    stateLabel: t(d.state === "template" ? "state.standardBackfill.template" : "state.standardBackfill.missing"),
  }));
}

/** 项目页"规范"一块下面列的卡：这个项目的"规范改写"卡（261 号票）、"补齐规范文档"卡（262 号票），按出来的先后 */
const STANDARD_CARD_TYPES: ReadonlySet<string> = new Set(["standard_change", "standard_backfill"]);

/** 这个项目的规范卡（项目页"规范"一块下面列着：规范改写卡、补齐规范文档卡），先出来的在前 */
export function projectStandardCards(state: UiState, projectId: string): string[] {
  return Object.values(state.cards)
    .map((s) => s.card)
    .filter((c) => STANDARD_CARD_TYPES.has(c.type) && (c.payload as Partial<StandardChangeCardPayload | StandardBackfillCardPayload>).projectId === projectId)
    .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((c) => c.id);
}
