// 关注类别设置的名字和纯函数（规格第 9 节，26 号票），守护进程和 Web 共用，不引用 TypeBox：
// - 场景（对话里、任务里）和设置页上的操作；
// - 内置类别只能往严里调：下拉只给不比默认更松的档（dispositionsNotLooserThan）；
// - 自定义类别的确定规则（匹配工具、路径、收件人、金额）写成一句话（categoryMatchText），设置页、计划卡、素材共用；
// - 规则里还没登记的工具（unregisteredTools）、仍按确认时的设置检查的进行中任务（heldByTasksText）在界面上怎么说。
// schema（设置的样子、设置页的请求、事件负载）在 watch-category-schema.ts。
import { DISPOSITIONS } from "./constants.ts";
import { t, tTable } from "./i18n/runtime.ts";
import type { Disposition } from "./schema.ts";
import type { WatchCategoryMatch, WatchToolChoice } from "./watch-category-schema.ts";

/** 每个类别分对话和任务两套处置 */
export const WATCH_SCENES = ["chat", "task"] as const;
export type WatchScene = (typeof WATCH_SCENES)[number];

export const WATCH_SCENE_LABEL: Readonly<Record<WatchScene, string>> = tTable({ chat: "protocol.watch.scene.chat", task: "protocol.watch.scene.task" });

/**
 * 设置页上的操作（update_watch_categories 请求的 op）：调严内置类别、新建 / 改 / 删自定义类别、修复坏了的设置文件、
 * 重新读设置文件（用户手改过文件之后）
 */
export const WATCH_CATEGORY_OPS = {
  setBuiltin: "set_builtin",
  createCustom: "create_custom",
  updateCustom: "update_custom",
  deleteCustom: "delete_custom",
  repair: "repair",
  reload: "reload",
} as const;
export type WatchCategoryOp = (typeof WATCH_CATEGORY_OPS)[keyof typeof WATCH_CATEGORY_OPS];

/** 设置事件里的变化：设置页上的一次操作，或者从设置文件读到的（file：启动时，或者文件被手改过、坏了） */
export const WATCH_CATEGORY_CHANGE_OPS = { ...WATCH_CATEGORY_OPS, file: "file" } as const;
export type WatchCategoryChangeOp = (typeof WATCH_CATEGORY_CHANGE_OPS)[keyof typeof WATCH_CATEGORY_CHANGE_OPS];

/**
 * 设置文件坏了时的修复：恢复成上一次有效的设置，或者恢复默认（内置类别回到默认处置、没有自定义类别）。
 * 坏掉的文件另存一份（WATCH_CATEGORIES_BROKEN_COPY），不丢
 */
export const WATCH_CATEGORY_REPAIRS = ["last_valid", "defaults"] as const;
export type WatchCategoryRepair = (typeof WATCH_CATEGORY_REPAIRS)[number];

export const WATCH_CATEGORY_REPAIR_LABEL: Readonly<Record<WatchCategoryRepair, string>> = tTable({
  last_valid: "protocol.watch.repair.lastValid",
  defaults: "protocol.watch.repair.defaults",
});

/** 修复时坏掉的设置文件另存成这个名字（和设置文件在同一个目录：数据目录的配置区） */
export const WATCH_CATEGORIES_BROKEN_COPY = "watch-categories.broken.json";

/** 自定义类别的名字最长多少字 */
export const WATCH_CATEGORY_TITLE_MAX = 60;

/** a 是不是比 base 松（一样的不算） */
export function isLooserDisposition(a: Disposition, base: Disposition): boolean {
  return DISPOSITIONS.indexOf(a) < DISPOSITIONS.indexOf(base);
}

/** 不比 base 更松的处置（由松到严）：内置类别的下拉只给这些 */
export function dispositionsNotLooserThan(base: Disposition): Disposition[] {
  return DISPOSITIONS.slice(DISPOSITIONS.indexOf(base));
}

function or(values: readonly string[]): string {
  return values.join(t("protocol.plan.scope.or"));
}

/** 确定规则写成一句话："工具是 write，并且路径在 D:\app\db 之内"（写了的条件都要满足） */
export function categoryMatchText(match: WatchCategoryMatch): string {
  const parts = [
    match.tools?.length ? t("protocol.watch.match.tools", { tools: or(match.tools) }) : "",
    match.paths?.length ? t("protocol.watch.match.paths", { paths: or(match.paths) }) : "",
    match.recipients?.length ? t("protocol.watch.match.recipients", { recipients: or(match.recipients) }) : "",
    match.amountOver === undefined ? "" : t("protocol.watch.match.amount", { amount: match.amountOver }),
  ].filter(Boolean);
  return parts.length === 0 ? t("protocol.watch.match.none") : parts.join(t("protocol.watch.match.and"));
}

/** 规则里写着、但现在没有登记的工具（可以先建类别，登记了才会命中） */
export function unregisteredTools(match: WatchCategoryMatch, tools: readonly WatchToolChoice[]): string[] {
  const known = new Set(tools.map((tool) => tool.name));
  return (match.tools ?? []).filter((name) => !known.has(name));
}

/** 规则里有没登记的工具时界面上的提示 */
export function unregisteredToolsText(names: readonly string[]): string {
  return t("protocol.watch.unregistered", { names: names.join(t("protocol.common.listSep")) });
}

/** 删除或调松一个自定义类别时，还有进行中的任务按确认时快照下来的设置检查它 */
export function heldByTasksText(count: number): string {
  return t("protocol.watch.heldByTasks", { n: count, count });
}
