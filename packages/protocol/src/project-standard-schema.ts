// @i18n-ignore-file model：这里的中文都是 schema 里的说明
// 本项目的规范改写（261 号票，issue 19 第 5 条）的 schema，用 TypeBox 定义：
// - 一条改写（StandardOverrideSchema，形状同 project-standard.ts 的 StandardOverride）：不要规范里的某一份、某一份换一种写法、多一份；
// - "规范改写"卡（standard_change）的负载：维护者用 propose_standard_change 提的几处变化（同一份改写前后）和跟新版规范，
//   附它引用、运行时核实过的用户原话。卡上逐条对照，进待办，也出在用户说话的那个会话里；用户确认了才生效（记进项目档案的
//   standard-overrides.md，跟新版规范的项目上记着的版本换成新的、缺的文档从新版模板补上），拒绝的不变。
// - "补齐规范文档"卡（standard_backfill，262 号票）的负载：规范上线之前建的项目缺的几份，见文件末尾。
import { type Static, Type } from "typebox";
import { STANDARD_BACKFILL_CHOICES, STANDARD_BACKFILL_DOC_STATES, STANDARD_CUSTOM_DOC, STANDARD_DOCS, STANDARD_OVERRIDABLE_DOCS } from "./project-standard.ts";
import { PROJECT_KINDS } from "./projects.ts";
import { USER_WORDS_MAX, VerifiedUserWords } from "./user-words.ts";

const OverridableDoc = Type.Enum(STANDARD_OVERRIDABLE_DOCS);

/** 一条改写（StandardOverride） */
export const StandardOverrideSchema = Type.Union([
  Type.Object({ kind: Type.Literal("drop"), doc: OverridableDoc }),
  Type.Object({ kind: Type.Literal("change"), doc: OverridableDoc, note: Type.String() }),
  Type.Object({ kind: Type.Literal("add"), path: Type.String(), title: Type.String(), note: Type.String() }),
]);

/** 一处变化（StandardChangeItem）：同一份的改写前后，没有就是照默认规范 */
export const StandardChangeItemSchema = Type.Object({
  before: Type.Optional(StandardOverrideSchema),
  after: Type.Optional(StandardOverrideSchema),
});

/** 缺的一份（StandardBackfillDoc） */
export const StandardBackfillDocSchema = Type.Object({
  key: Type.Enum([...STANDARD_DOCS, STANDARD_CUSTOM_DOC]),
  path: Type.String(),
  /** 改写里多出来的那份的名字 */
  title: Type.Optional(Type.String()),
  state: Type.Enum(STANDARD_BACKFILL_DOC_STATES),
});

/** "规范改写"卡（standard_change，261 号票） */
export const StandardChangeCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 这个项目的第几次规范改写（提出的就算，被拒的也占号） */
  revision: Type.Integer({ minimum: 1 }),
  /** 维护者为什么要改（它的说法） */
  why: Type.String(),
  /** 逐处对照（只有跟新版规范时是空的） */
  items: Type.Array(StandardChangeItemSchema),
  /**
   * 跟新版规范：从哪一版到哪一版。272 号票：规范上线之前建的项目（没有版本）补齐规范文档时没有 from，missing 是缺的几份
   */
  upgrade: Type.Optional(Type.Object({ from: Type.Optional(Type.String()), to: Type.String(), missing: Type.Optional(Type.Array(StandardBackfillDocSchema)) })),
  /** 维护者引用、运行时核实过的用户原话（卡上单独一栏，标明"运行时核实"） */
  userWords: Type.Optional(Type.Array(VerifiedUserWords, { maxItems: USER_WORDS_MAX })),
  /** 处理之后：确认了没有、什么时候 */
  decided: Type.Optional(Type.Object({ confirmed: Type.Boolean(), at: Type.String() })),
});
export type StandardChangeCardPayload = Static<typeof StandardChangeCardPayload>;

// ───────────────────────── "补齐规范文档"卡（262 号票） ─────────────────────────
// 规范上线之前建的项目（没有版本）一个出一张：按项目类型和本项目的规范改写缺哪几份。选"补齐"：项目改用现在的规范（记下版本，有模板的几份
// 从模板放进档案），建一个项目内部的普通任务交给维护者照项目现状补；选"不补"：什么都不动。选了哪个都不会再出。

/** "补齐规范文档"卡（standard_backfill，262 号票） */
export const StandardBackfillCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 项目类型（立项书确认了才出卡） */
  kind: Type.Enum(PROJECT_KINDS),
  /** 补齐之后改用的规范版本（框架里最新的） */
  version: Type.String(),
  /** 缺的几份（出卡时算的） */
  missing: Type.Array(StandardBackfillDocSchema, { minItems: 1 }),
  /** 处理之后：选了哪个、什么时候；补齐时建的任务（确认时都齐了就没建） */
  decided: Type.Optional(Type.Object({ choice: Type.Enum(STANDARD_BACKFILL_CHOICES), at: Type.String(), taskId: Type.Optional(Type.String()) })),
});
export type StandardBackfillCardPayload = Static<typeof StandardBackfillCardPayload>;
