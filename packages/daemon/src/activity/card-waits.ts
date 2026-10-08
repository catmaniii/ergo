// 待处理的卡片里，哪些是某个 agent 在等用户（规格术语"活动状态"的"等你"，25 号票）：
// - 审批卡：发起调用的 agent（审批表里的 origin.agentId）在等你批准。子进程里那次调用还在等时，agent 管家已经报了"等你"；
//   挂起、这一轮结束以后卡还没处理的，靠这里接着算"等你"；
// - 提问卡：秘书提问澄清，没回答之前秘书在等你回答（提问卡现在只有秘书出）。
// 全部由事件推出（卡片视图、审批表），守护进程重启后照样对。后面的票有新的"等用户"的卡（别的 agent 出的提问卡、工单的等澄清……），
// 往 CARD_WAITS 里加一行。
import type { ActivityDetail, ApprovalCardPayload, Card } from "@ergou/protocol";
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
  questions: () => ({ agentId: SECRETARY_AGENT_ID, detail: { kind: "clarification" } }),
};

/** 会让某个 agent 等用户的卡片类型 */
export const CARD_WAIT_TYPES: readonly string[] = Object.keys(CARD_WAITS);

/** 每个 agent 在等你的那些待处理卡片的说明，按建卡先后（最近的在最后） */
export function pendingCardWaits(db: ReadonlyDatabase): Map<string, ActivityDetail[]> {
  const waits = new Map<string, ActivityDetail[]>();
  const cards = listPendingCards(db, CARD_WAIT_TYPES).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const card of cards) {
    const wait = CARD_WAITS[card.type]?.(card, db);
    if (!wait) continue;
    waits.set(wait.agentId, [...(waits.get(wait.agentId) ?? []), wait.detail]);
  }
  return waits;
}
