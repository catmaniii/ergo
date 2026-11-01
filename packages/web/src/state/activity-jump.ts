// 标题上的"等你……"点了去哪（369 号票，纯函数）：去要处理的那张卡，定位到它、闪一下。去处和待办里这一项的"去看看 ›"是同一个（inboxJump），
// 所以卡在别的会话、别的页面的也跳得过去（负责人会话里的卡是某个内部任务的，去那个任务）。
// - 活动状态的说明里带着卡片编号（守护进程的 card-waits.ts、审批和提问的等待）；有几张在等时是最近的那张；
// - 这一项在待办里没有、或者没记来源的：卡就在这个 agent 自己的会话里，按会话去（conversationAtJump）；
// - 这之前记下的事件没有编号，认不出去处的：退回待办；
// - 不是在等某张卡的（运行时插件没启用、会话交还了、在官方 App 里）：没有卡可去，不能点。
import { conversationAtJump, type InboxJump, inboxJump } from "./inbox-jump.ts";
import { type ActivityDetailKind, CHANNELS, maintainerChannel } from "./protocol.ts";
import { agentActivity, type UiState } from "./ui-state.ts";

export type ActivityJump = InboxJump | { kind: "inbox" };

/** 等的不是卡 */
const NOT_A_CARD: readonly ActivityDetailKind[] = ["runtime_off", "handed_back", "in_remote"];

/** 这个 agent 标题上的状态点了去哪；不在等你、没有卡可去的是 undefined（不能点） */
export function activityJump(state: UiState, agentId: string): ActivityJump | undefined {
  const { state: now, detail } = agentActivity(state, agentId);
  if (now !== "waiting_for_user" || (detail && NOT_A_CARD.includes(detail.kind))) return undefined;
  const cardId = detail?.cardId;
  if (cardId === undefined) return { kind: "inbox" };
  const item = Object.values(state.inbox).find((i) => i.kind === "card" && i.cardId === cardId && !i.deleted);
  const conversation = agentId === CHANNELS.secretary ? CHANNELS.secretary : maintainerChannel(agentId);
  return (item && inboxJump(state, item)) ?? conversationAtJump(state, conversation, {}, cardId) ?? { kind: "inbox" };
}
