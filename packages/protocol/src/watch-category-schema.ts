// @i18n-ignore-file model：这里的中文都是 schema 里给模型看的参数说明
// 关注类别设置的 schema（规格第 9 节，26 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型：
// - 确定规则（WatchCategoryMatch）：全局设置里的自定义类别、计划里本任务新加的类别同一种写法；
// - 设置的样子（WatchCategoriesState）：关注类别频道上 watch_category_settings 事件里的，设置页照它画；
// - 设置页的请求（update_watch_categories）：调严内置类别、新建 / 改 / 删自定义类别、修复、重新读文件。
// 处置一律用前端协议的写法（do、do_then_tell、planned_only……）；设置文件里是守卫的写法，守护进程负责换。
import { type Static, Type } from "typebox";
import { DISPOSITIONS } from "./constants.ts";
import { WATCH_CATEGORY_CHANGE_OPS, WATCH_CATEGORY_OPS, WATCH_CATEGORY_REPAIRS, WATCH_CATEGORY_TITLE_MAX, WATCH_SCENES } from "./watch-categories.ts";

const Disposition = Type.Enum(DISPOSITIONS);
const NonEmpty = (description: string) => Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 50, description });

/**
 * 确定规则：写了的条件都要满足（列表里任一即可）。作用在工具注册表登记的参数种类上：
 * 工具或伪工具名（bash 拆出的伪工具、快速动作 quick_action:<类型> 都算）、路径类参数落在目录之内、收件人类参数、金额类参数
 */
export const WatchCategoryMatch = Type.Object(
  {
    tools: Type.Optional(NonEmpty("工具或伪工具名")),
    paths: Type.Optional(NonEmpty("路径类参数落在这些目录之内（写完整的 Windows 路径）")),
    recipients: Type.Optional(NonEmpty("收件人类参数等于其中之一（不分大小写）")),
    amountOver: Type.Optional(Type.Number({ minimum: 0, description: "金额类参数大于它" })),
  },
  { additionalProperties: false },
);
export type WatchCategoryMatch = Static<typeof WatchCategoryMatch>;

/** 一个内置类别：名字、默认处置（对话里不适用时为 null，比如"计划外工单"）、现在的处置（只会比默认严） */
export const BuiltinWatchCategoryView = Type.Object({
  id: Type.String(),
  title: Type.String(),
  defaults: Type.Object({ chat: Type.Union([Disposition, Type.Null()]), task: Disposition }),
  chat: Type.Union([Disposition, Type.Null()]),
  task: Disposition,
});
export type BuiltinWatchCategoryView = Static<typeof BuiltinWatchCategoryView>;

/** 一条底线：固定的处置，只显示、不能改 */
export const BottomLineView = Type.Object({ id: Type.String(), title: Type.String(), disposition: Disposition });
export type BottomLineView = Static<typeof BottomLineView>;

/** 用户自定义的一个类别：确定规则和两套处置（六档里的任何一档） */
export const CustomWatchCategoryView = Type.Object({
  id: Type.String(),
  title: Type.String(),
  match: WatchCategoryMatch,
  chat: Disposition,
  task: Disposition,
});
export type CustomWatchCategoryView = Static<typeof CustomWatchCategoryView>;

/** 自定义类别能匹配的一个工具（设置页的候选）：工具名和中文名 */
export const WatchToolChoice = Type.Object({ name: Type.String(), title: Type.String() });
export type WatchToolChoice = Static<typeof WatchToolChoice>;

/**
 * 关注类别设置的样子（设置页照它画）。problems 不空表示数据目录里的设置文件坏了：守卫判定一律出错（拦下），
 * 这时 builtin、custom 是上一次有效的设置，设置页提示并给出修复
 */
export const WatchCategoriesState = Type.Object({
  builtin: Type.Array(BuiltinWatchCategoryView),
  bottomLines: Type.Array(BottomLineView),
  custom: Type.Array(CustomWatchCategoryView),
  tools: Type.Array(WatchToolChoice),
  problems: Type.Array(Type.String()),
});
export type WatchCategoriesState = Static<typeof WatchCategoriesState>;

/** 新建或改一个自定义类别：名字、确定规则、两套处置 */
export const WatchCategoryDraft = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: WATCH_CATEGORY_TITLE_MAX }),
    match: WatchCategoryMatch,
    chat: Disposition,
    task: Disposition,
  },
  { additionalProperties: false },
);
export type WatchCategoryDraft = Static<typeof WatchCategoryDraft>;

const CategoryId = Type.String({ minLength: 1, maxLength: 80 });

/** 设置页的一次修改（update_watch_categories 请求的参数） */
export const UpdateWatchCategoriesParams = Type.Union([
  /** 调一个内置类别某个场景的处置：只能不比默认松（和默认一样就是回到默认） */
  Type.Object(
    { op: Type.Literal(WATCH_CATEGORY_OPS.setBuiltin), categoryId: CategoryId, scene: Type.Enum(WATCH_SCENES), disposition: Disposition },
    { additionalProperties: false },
  ),
  Type.Object({ op: Type.Literal(WATCH_CATEGORY_OPS.createCustom), category: WatchCategoryDraft }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal(WATCH_CATEGORY_OPS.updateCustom), categoryId: CategoryId, category: WatchCategoryDraft }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal(WATCH_CATEGORY_OPS.deleteCustom), categoryId: CategoryId }, { additionalProperties: false }),
  /** 设置文件坏了时修复（坏掉的文件另存一份） */
  Type.Object({ op: Type.Literal(WATCH_CATEGORY_OPS.repair), to: Type.Enum(WATCH_CATEGORY_REPAIRS) }, { additionalProperties: false }),
  /** 重新读设置文件（用户手改过之后）：和上次记下的不一样就记一条事件 */
  Type.Object({ op: Type.Literal(WATCH_CATEGORY_OPS.reload) }, { additionalProperties: false }),
]);
export type UpdateWatchCategoriesParams = Static<typeof UpdateWatchCategoriesParams>;

/** 结果：新建的自定义类别的 id（别的操作没有）。设置本身随后在关注类别频道推送 */
export const UpdateWatchCategoriesResult = Type.Object({ categoryId: Type.Optional(Type.String()) });
export type UpdateWatchCategoriesResult = Static<typeof UpdateWatchCategoriesResult>;

/** 这次是什么变化：设置页上的一次操作，或者从设置文件读到的（file：启动时，或者文件被手改过、坏了） */
export const WatchCategoryChange = Type.Object({
  op: Type.Enum(WATCH_CATEGORY_CHANGE_OPS),
  categoryId: Type.Optional(Type.String()),
  scene: Type.Optional(Type.Enum(WATCH_SCENES)),
  disposition: Type.Optional(Disposition),
  to: Type.Optional(Type.Enum(WATCH_CATEGORY_REPAIRS)),
  /**
   * 删除或调松一个自定义类别时，还有几个进行中的任务确认时快照了它（这些任务仍按确认时的设置检查它，heldByTasksText）。
   * 没有就不写
   */
  heldByTasks: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type WatchCategoryChange = Static<typeof WatchCategoryChange>;

/** `watch_category_settings` 事件（关注类别频道）：设置的最新样子、这次的变化、谁改的（用户在设置页，或系统从文件读到） */
export const WatchCategorySettingsEventPayload = Type.Object({
  state: WatchCategoriesState,
  change: WatchCategoryChange,
  by: Type.Union([Type.Literal("user"), Type.Literal("system")]),
  time: Type.String(),
});
export type WatchCategorySettingsEventPayload = Static<typeof WatchCategorySettingsEventPayload>;
