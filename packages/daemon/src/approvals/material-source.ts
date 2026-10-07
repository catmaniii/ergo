// "审批决定"素材（规格第 15 节）：用户在审批卡上批准、拒绝（以后还有收窄）一次调用，从 guard 频道的 approval_decided 事件采集。
// 用户的选择是在 agent 先提出的这次调用上做的：算用户的选择（本人，注明 agent 先提出）；拒绝时写的说明是用户自己的话（本人）。
// "交给我做"事项上点"已完成"不是审批决定，不算。
import { EVENT_TYPES } from "@ergou/protocol";
import type { ApprovalDecidedPayload } from "../guard-runtime/events.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";

const DECISION_WORD: Readonly<Record<ApprovalDecidedPayload["decision"], string>> = { approved: "批准", denied: "拒绝", narrowed: "收窄" };

export const approvalDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "approval-decision",
  eventType: EVENT_TYPES.approvalDecided,
  capture(event) {
    const p = event.payload as ApprovalDecidedPayload;
    const what = `${p.toolTitle}「${p.argsSummary}」`;
    const narrowing = p.decision === "narrowed" && p.narrowing ? `（收窄成：${p.narrowing.summary}）` : "";
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        ...(p.origin.conversation === null ? {} : { conversation: p.origin.conversation }),
        ...(p.origin.taskId === null ? {} : { task: p.origin.taskId }),
        context: [`decision:${p.decision}`, `tool:${p.tool}`, ...p.categories.map((c) => `category:${c}`)],
        ref: { recordId: p.approvalId, cardId: p.cardId },
        accepted: { text: `${DECISION_WORD[p.decision]}：${what}${narrowing}`, field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};
