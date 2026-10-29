// 废弃分支在状态层的样子（151 号票，⑂ 展开的预览、分支详情和遗留效果，
// 数据换成二狗的会话条目）：
// - ⑂ 展开的预览：这条分支自己那一段（branchOwnRanges：它的路径上、不在当前路径上的）
//   按主线同一套条目画（chatItems 给了分支）；"N 段"是缩小后的矩形数（工具调用组拆成每一块）；
// - 分支详情：分支摘要、遗留效果（守护进程取回的那份，ui-state.ts 的 branchViews），每件申请撤回了没有（取回时就有的，加上之后会话频道上
//   来的 effect_undo_requested，几台设备同步）；完整历史就是预览的那些条目；
// - 消息手里没有的（刷新之后、往上翻没翻到那里）由界面经 HTTP 取（store 的 loadBranch），取回来并进会话的消息里，这里照常推。
import { type ChatItem, chatItems } from "./chat-items.ts";
import type { BranchEffect, ConversationId } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { zoomRects } from "./zoom-decor.ts";

/** 废弃分支上的一件遗留效果：守护进程算的那件（本机还是对外、能不能申请撤回、原因），加上提交撤销请求的时间（没提交是 undefined） */
export interface BranchEffectView extends BranchEffect {
  readonly requested: string | undefined;
}

/** 一条废弃分支：预览、详情要的 */
export interface AbandonedBranchView {
  readonly branchId: string;
  /** 它自己那一段的条目（手里有的；loaded 之后是全的） */
  readonly items: readonly ChatItem[];
  /** 缩小后几块（"⑂ 另一条分支 · N 段"） */
  readonly segments: number;
  /** 守护进程那份取回来了（和现在的当前分支比的） */
  readonly loaded: boolean;
  /** 分支摘要：这条分支被回退离开时写的那份（只被切换离开过的、之后又多了消息的没有） */
  readonly summary: string | undefined;
  readonly effects: readonly BranchEffectView[];
}

export function abandonedBranch(state: UiState, conversation: ConversationId, branchId: string): AbandonedBranchView {
  const conv = state.conversations[conversation];
  const items = chatItems(state, conversation, branchId);
  const view = conv?.branchViews?.[branchId];
  const loaded = view !== undefined && view.against === conv?.branches?.current;
  return {
    branchId,
    items,
    segments: zoomRects(items).length,
    loaded,
    summary: loaded ? view.summary : undefined,
    effects: loaded ? view.effects.map((e) => ({ ...e, requested: e.undoRequested ?? conv?.undoRequests?.[e.callId] })) : [],
  };
}

/**
 * 会话树最近一次变化（回退、切换分支）从哪个序号起：切换之后进到当前路径上的那些条目序号都在它前面，它们不是新到的，
 * 不播到达动效（切换有自己的双向动画）。没回退过是 0
 */
export function branchEpochStart(state: UiState, conversation: ConversationId): number {
  return state.conversations[conversation]?.branches?.epochs.at(-1)?.from ?? 0;
}

/** 这个会话现在的当前分支（没回退过是 undefined）：切换分支的双向动画等它变成切过去的那条才量新布局 */
export function currentBranch(state: UiState, conversation: ConversationId): string | undefined {
  return state.conversations[conversation]?.branches?.current;
}

/** 切换分支之后各个会话手里缺的那一段（ui-state.ts 的 branchGap）：store 经 HTTP 取这条分支和 against 比的样子补进来 */
export function branchGaps(state: UiState): { conversation: ConversationId; branch: string; against: string }[] {
  return Object.entries(state.conversations).flatMap(([conversation, conv]) =>
    conv.branchGap ? [{ conversation: conversation as ConversationId, branch: conv.branchGap.branch, against: conv.branchGap.against }] : [],
  );
}
