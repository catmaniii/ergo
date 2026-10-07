// 待我处理的排序、处理状态和 tab 上的提示。
import { URGENCY_RANK } from "../model/labels.ts";
import type { InboxItem } from "../model/types.ts";
import { selectCard, type UiState } from "../state/index.ts";

/** 处理过了：卡片不再是待处理（在哪里处理都算），通知类点过某个动作 */
export function isProcessed(item: InboxItem, ui: UiState): boolean {
  if (item.kind === "card") {
    const status = selectCard(ui, item.cardId)?.card.status;
    return status !== undefined && status !== "pending";
  }
  return item.handled !== undefined;
}

/** 列表里显示的（没删、没归档）事项：到点的简单提醒置顶，其余按紧急度三档，再按时间新的在前 */
export function sortInbox(items: InboxItem[]): InboxItem[] {
  return items.toSorted((a, b) => {
    const pa = a.kind === "notice" && a.pinned ? 0 : 1;
    const pb = b.kind === "notice" && b.pinned ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (u !== 0) return u;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** tab 上的提示：有未读亮小红点；看过还没处理的显示灰色数字 */
export function inboxBadge(items: InboxItem[], ui: UiState): { unread: number; seenPending: number } {
  let unread = 0;
  let seenPending = 0;
  for (const it of items) {
    if (it.deleted || it.archived || isProcessed(it, ui)) continue;
    if (it.read) seenPending += 1;
    else unread += 1;
  }
  return { unread, seenPending };
}
