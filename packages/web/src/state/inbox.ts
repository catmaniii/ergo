// 待我处理的视图（纯函数）：排序、按"待处理 / 已处理 / 已归档"分组、tab 上的提示。
// - 置顶的（到点的提醒）排在最前，然后按紧急度三档（卡住任务且有时限、卡住任务、不卡任务），同一档里新的在前；
// - 处理过了：用共享协议包的 isInboxItemProcessed（守护进程、原型的假连接用的是同一个）：卡片事项看卡片本身的状态
//   （在聊天里处理了，这里同步；本地还没收到这张卡时算没处理过），通知类事项点过某个动作；
// - tab 上：有未读亮小红点；看过还没处理的显示灰色数字（几件）。紧急度只在 Web 里体现（小红点和排序），不做手机推送。
import { type InboxItem, isInboxItemProcessed as processed, URGENCIES } from "./protocol.ts";
import type { CardState, UiState } from "./ui-state.ts";

export type InboxFilter = "open" | "done" | "archived";

export interface InboxEntry {
  item: InboxItem;
  /** 处理过了 */
  processed: boolean;
  /** 卡片事项的卡片（还没收到时没有） */
  card?: CardState;
}

/** 这条事项处理过了没有（卡片事项按本地收到的那张卡的状态） */
export function inboxItemProcessed(state: UiState, item: InboxItem): boolean {
  return processed(item, item.kind === "card" ? state.cards[item.cardId]?.card.status : undefined);
}

function filterOf(state: UiState, item: InboxItem): InboxFilter {
  if (item.archived) return "archived";
  return inboxItemProcessed(state, item) ? "done" : "open";
}

/** 某一组的事项，排好序 */
export function inboxEntries(state: UiState, filter: InboxFilter): InboxEntry[] {
  return Object.values(state.inbox)
    .filter((item) => filterOf(state, item) === filter)
    .toSorted(compareItems)
    .map((item) => {
      const card = item.cardId === undefined ? undefined : state.cards[item.cardId];
      return { item, processed: inboxItemProcessed(state, item), ...(card ? { card } : {}) };
    });
}

/** 每一组有几项 */
export function inboxCounts(state: UiState): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = { open: 0, done: 0, archived: 0 };
  for (const item of Object.values(state.inbox)) counts[filterOf(state, item)] += 1;
  return counts;
}

/** tab 上的提示：未读数（亮小红点）；看过还没处理的件数（灰色数字） */
export function inboxBadge(state: UiState): { unread: number; seenPending: number } {
  let unread = 0;
  let seenPending = 0;
  for (const item of Object.values(state.inbox)) {
    if (filterOf(state, item) !== "open") continue;
    if (item.read) seenPending += 1;
    else unread += 1;
  }
  return { unread, seenPending };
}

export function selectInboxItem(state: UiState, itemId: string): InboxItem | undefined {
  return state.inbox[itemId];
}

/** 置顶的在前，然后按紧急度三档，同一档里新的在前 */
function compareItems(a: InboxItem, b: InboxItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const u = URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency);
  if (u !== 0) return u;
  return b.createdAt.localeCompare(a.createdAt);
}
