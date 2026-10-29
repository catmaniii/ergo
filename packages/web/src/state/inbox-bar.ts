// 会话里的"等你处理"栏（107 号票，纯函数）：项目整页、任务整页、秘书会话把还没处理、来源是这个会话的待办事项列在会话和输入框之间，
// 在那里直接处理（通知点它的动作，卡片在会话里定位到那张卡），和在待办里处理是同一个请求，两边一起变。
// - 哪些属于这个会话只用 105 号票的 inboxJump 认：去处是这个任务、这个项目、秘书会话的，不另起一套规则；项目的维护者会话也是
//   它的内部任务的会话（内部任务的维护者就是项目的维护者，卡出在这里），去处是这个项目内部任务的（事项带着 internal 标记）也列在项目这里；
// - 已处理的（卡片看卡的状态、通知看选过动作没有，同 inboxItemProcessed）、已归档的不进，处理了就从栏里消失；
// - 排序和待办的"待处理"一样（compareInboxItems：置顶、紧急度三档、同一档里新的在前）。
import { inboxItemProcessed } from "./inbox.ts";
import { type InboxJump, inboxJump } from "./inbox-jump.ts";
import { compareInboxItems, type InboxItem, isInternalTo } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 栏挂在哪个会话上：任务整页（负责它的 agent 的会话）、项目整页（维护者的会话）、秘书会话 */
export type InboxPlace = { kind: "task"; taskId: string } | { kind: "project"; projectId: string } | { kind: "secretary" };

export interface InboxBarEntry {
  item: InboxItem;
  /** 在会话里定位到哪（卡片 id；中断不确定、交给我做是那次调用）：栏里"看卡片""看那次调用"经它；没有就不出 */
  at?: string;
}

/** 这个会话的栏里列哪几项（排好序）；一项都没有时整条栏不显示 */
export function inboxBarEntries(state: UiState, place: InboxPlace): InboxBarEntry[] {
  const out: InboxBarEntry[] = [];
  for (const item of Object.values(state.inbox).toSorted(compareInboxItems)) {
    if (item.archived || inboxItemProcessed(state, item)) continue;
    const jump = inboxJump(state, item);
    if (!jump || !belongs(jump, item, place)) continue;
    const at = "at" in jump ? jump.at : undefined;
    out.push(at === undefined ? { item } : { item, at });
  }
  return out;
}

/** 去处是不是这个会话 */
function belongs(jump: InboxJump, item: InboxItem, place: InboxPlace): boolean {
  switch (place.kind) {
    case "task":
      return jump.kind === "task" && jump.taskId === place.taskId;
    case "project":
      return (jump.kind === "project" && jump.projectId === place.projectId) || (jump.kind === "task" && isInternalTo(item, place.projectId));
    case "secretary":
      return jump.kind === "secretary";
  }
}
