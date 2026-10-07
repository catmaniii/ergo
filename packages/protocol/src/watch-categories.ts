// 关注类别设置的名字和纯函数（规格第 9 节，26 号票），守护进程和 Web 共用，不引用 TypeBox：
// - 场景（对话里、任务里）和设置页上的操作；
// - 内置类别只能往严里调：下拉只给不比默认更松的档（dispositionsNotLooserThan）；
// - 自定义类别的确定规则（匹配工具、路径、收件人、金额）写成一句话（categoryMatchText），设置页、计划卡、素材共用。
// schema（设置的样子、设置页的请求、事件负载）在 watch-category-schema.ts。
import { DISPOSITIONS } from "./constants.ts";

type Disposition = (typeof DISPOSITIONS)[number];

/** 每个类别分对话和任务两套处置 */
export const WATCH_SCENES = ["chat", "task"] as const;
export type WatchScene = (typeof WATCH_SCENES)[number];

export const WATCH_SCENE_LABEL: Readonly<Record<WatchScene, string>> = { chat: "对话里", task: "任务里" };

/**
 * 设置页上的操作：调严内置类别（set_builtin）、新建 / 改 / 删自定义类别、修复坏了的设置文件（repair）、
 * 重新读设置文件（reload：用户手改过文件之后）
 */
export const WATCH_CATEGORY_OPS = ["set_builtin", "create_custom", "update_custom", "delete_custom", "repair", "reload"] as const;
export type WatchCategoryOp = (typeof WATCH_CATEGORY_OPS)[number];

/**
 * 设置文件坏了时的修复：恢复成上一次有效的设置，或者恢复默认（内置类别回到默认处置、没有自定义类别）。
 * 坏掉的文件另存一份（WATCH_CATEGORIES_BROKEN_COPY），不丢
 */
export const WATCH_CATEGORY_REPAIRS = ["last_valid", "defaults"] as const;
export type WatchCategoryRepair = (typeof WATCH_CATEGORY_REPAIRS)[number];

export const WATCH_CATEGORY_REPAIR_LABEL: Readonly<Record<WatchCategoryRepair, string>> = {
  last_valid: "恢复成上一次有效的设置",
  defaults: "恢复默认（内置类别回到默认处置，没有自定义类别）",
};

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

/** 确定规则（和 schema 里的 WatchCategoryMatch 同形） */
export interface CategoryMatchLike {
  tools?: readonly string[];
  paths?: readonly string[];
  recipients?: readonly string[];
  amountOver?: number;
}

/** 确定规则写成一句话："工具是 write，并且路径在 D:\app\db 之内"（写了的条件都要满足） */
export function categoryMatchText(match: CategoryMatchLike): string {
  const or = (values: readonly string[]) => values.join(" 或 ");
  const parts = [
    match.tools?.length ? `工具是 ${or(match.tools)}` : "",
    match.paths?.length ? `路径在 ${or(match.paths)} 之内` : "",
    match.recipients?.length ? `收件人是 ${or(match.recipients)}` : "",
    match.amountOver === undefined ? "" : `金额大于 ${match.amountOver}`,
  ].filter(Boolean);
  return parts.length === 0 ? "（没有规则）" : parts.join("，并且");
}
