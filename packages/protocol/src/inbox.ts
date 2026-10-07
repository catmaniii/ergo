// 待我处理事项算不算处理过：只有这一份，守护进程（卡着任务的事项能不能归档、删除）、Web 状态层（待处理 / 已处理分组、
// tab 上的提示）、原型的假连接都用它。
import type { CardStatus, InboxItem } from "./schema.ts";

/**
 * 处理过了：
 * - 通知类事项：选过它的一个动作；
 * - 卡片事项：卡片不再是待处理（在哪里处理都算）。
 *
 * cardStatus 是事项那张卡的状态；不知道（前端还没收到这张卡、或者找不到）时传 undefined，算**没处理过**：
 * 卡着任务的事项宁可多留着、不让归档或删除，等卡片到了再说。
 */
export function isInboxItemProcessed(item: InboxItem, cardStatus: CardStatus | undefined): boolean {
  if (item.kind === "notice") return item.handled !== undefined;
  return cardStatus !== undefined && cardStatus !== "pending";
}
