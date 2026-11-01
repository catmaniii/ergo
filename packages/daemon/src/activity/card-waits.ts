// 待处理的卡片里，哪些是某个 agent 在等用户（活动状态的"等你"）：
// - 审批卡：发起调用的 agent（审批表里的 origin.agentId）在等你批准。子进程里那次调用还在等时，agent 管家已经报了"等你"；
//   挂起、这一轮结束以后卡还没处理的，靠这里接着算"等你"；
// - 提问卡：没回答之前，提问的一方在等你回答。负责人为工单问的、转问用户的卡上记着是谁（askedBy），别的是秘书问的。
//   放久了（超过 materials.staleCardDays 没答）不再算在等，卡还在聊天历史里，照样能答（到点由 stale-questions.ts 叫重新算）。
// 说明带上要处理的那张卡（标题上点了跳到它），有几张在等时是最近的那张，并写一共几张。
// 全部由事件推出（卡片视图、审批表），守护进程重启后照样对。以后有新的"等用户"的卡（工单的等澄清……），往 CARD_WAITS 里加一行，
// 标题上照样点得到（运行时的提问卡不在这里：它只在这一轮里等，子进程那边报，见 conversation/runtime-questions.ts）。
import type { ActivityDetail, ApprovalCardPayload, Card, QuestionsCardPayload } from "@ergo/protocol";
import { getApproval } from "../approvals/views.ts";
import { listPendingCards } from "../cards/views.ts";
import { SECRETARY_AGENT_ID } from "../secretary/secretary.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

/** 一张待处理的卡是谁在等、等什么（不认得的卡返回 undefined） */
type CardWait = (card: Card, db: ReadonlyDatabase) => { agentId: string; detail: ActivityDetail } | undefined;

const CARD_WAITS: Readonly<Record<string, CardWait>> = {
  approval: (card, db) => {
    const p = card.payload as ApprovalCardPayload;
    const approval = getApproval(db, p.approvalId);
    return approval ? { agentId: approval.origin.agentId, detail: { kind: "approval", tool: p.toolTitle } } : undefined;
  },
  questions: (card) => ({ agentId: (card.payload as QuestionsCardPayload).askedBy?.maintainerId ?? SECRETARY_AGENT_ID, detail: { kind: "clarification" } }),
};

/** 会让某个 agent 等用户的卡片类型 */
export const CARD_WAIT_TYPES: readonly string[] = Object.keys(CARD_WAITS);

/**
 * 放久了就不算在等的卡：只有秘书在聊天里随口问的提问卡。
 * 审批卡一直算：不批，那次调用就做不了。为任务问的、负责人为工单问的也一直算：它们正卡着工作，放久了更不能没人提醒
 */
export function cardWaitGoesStale(card: Pick<Card, "type" | "payload">): boolean {
  if (card.type !== "questions") return false;
  const payload = card.payload as QuestionsCardPayload;
  return payload.askedBy === undefined && payload.taskId === undefined;
}

/** 一张卡从什么时候起算放久了（毫秒） */
export function cardWaitStaleAt(card: Pick<Card, "createdAt">, staleAfterMs: number): number {
  return Date.parse(card.createdAt) + staleAfterMs;
}

/** 一个 agent 在等你的那些卡：说明是最近一张的（带着它的编号，有几张时带着张数），cardIds 是全部 */
export interface AgentCardWaits {
  detail: ActivityDetail;
  cardIds: readonly string[];
}

/** 说明写上一共几张：两张及以上才写 */
export function withCardCount(detail: ActivityDetail, cardIds: ReadonlySet<string>): ActivityDetail {
  return cardIds.size > 1 ? { ...detail, cardCount: cardIds.size } : detail;
}

/** 每个 agent 在等你的待处理卡片（放久了的提问卡不算），按建卡先后（最近的算说明） */
export function pendingCardWaits(db: ReadonlyDatabase, at: { nowMs: number; staleAfterMs: number }): Map<string, AgentCardWaits> {
  const latest = new Map<string, { detail: ActivityDetail; cardIds: string[] }>();
  const cards = listPendingCards(db, CARD_WAIT_TYPES).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const card of cards) {
    if (cardWaitGoesStale(card) && at.nowMs >= cardWaitStaleAt(card, at.staleAfterMs)) continue;
    const wait = CARD_WAITS[card.type]?.(card, db);
    if (!wait) continue;
    latest.set(wait.agentId, { detail: { ...wait.detail, cardId: card.id }, cardIds: [...(latest.get(wait.agentId)?.cardIds ?? []), card.id] });
  }
  return new Map([...latest].map(([agentId, { detail, cardIds }]) => [agentId, { detail: withCardCount(detail, new Set(cardIds)), cardIds }]));
}
