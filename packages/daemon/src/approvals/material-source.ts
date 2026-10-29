// "审批决定"素材（规格第 15 节）：用户在审批卡上批准、拒绝（以后还有收窄）一次调用，从 guard 频道的 approval_decided 事件采集。
// 用户的选择是在 agent 先提出的这次调用上做的：算用户的选择（本人，注明 agent 先提出）；拒绝时写的说明是用户自己的话（本人）。
// "交给我做"事项上点"已完成"不是审批决定，不算。
// 彻底删除（21 号票）时这条事件只把带原话的字段（参数摘要、用户的说明、收窄成什么）换成删除标记，
// 决定、审批 id、卡片、来源原样保留：改写后审批表重放出来仍是已批准或已拒绝。
import { EVENT_TYPES, PURGED_TEXT, t, tTable } from "@ergo/protocol";
import { purgedField, purgedStrings, type PurgeRewriter } from "../events/purge.ts";
import { type ApprovalDecidedPayload, type ApprovalRequestedPayload, GUARD_EVENTS, purgedOrigin } from "../guard-runtime/events.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";

const DECISION_WORD: Readonly<Record<ApprovalDecidedPayload["decision"], string>> = tTable({
  approved: "approvals.decision.approved",
  denied: "approvals.decision.denied",
  narrowed: "approvals.decision.narrowed",
});

export const approvalDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "approval-decision",
  eventType: EVENT_TYPES.approvalDecided,
  capture(event) {
    const p = event.payload as ApprovalDecidedPayload;
    const what = t("approvals.what", { tool: p.toolTitle, args: p.argsSummary });
    const narrowing = p.decision === "narrowed" && p.narrowing ? t("approvals.narrowedTo", { summary: p.narrowing.summary }) : "";
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        ...(p.origin.conversation === null ? {} : { conversation: p.origin.conversation }),
        ...(p.origin.taskId === null ? {} : { task: p.origin.taskId }),
        context: [`decision:${p.decision}`, `tool:${p.tool}`, ...p.categories.map((c) => `category:${c}`)],
        ref: { recordId: p.approvalId, cardId: p.cardId },
        accepted: { text: t("approvals.decided", { decision: DECISION_WORD[p.decision], what, narrowing }), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

export const approvalDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.approvalDecided,
  rewrite(event) {
    const p = event.payload as ApprovalDecidedPayload;
    return {
      ...p,
      origin: purgedOrigin(p.origin),
      argsSummary: PURGED_TEXT,
      ...purgedField(p, "note"),
      ...(p.narrowing === undefined ? {} : { narrowing: { summary: PURGED_TEXT } }),
    } satisfies ApprovalDecidedPayload;
  },
};

/**
 * 审批请求（删除项目时改写那个维护者的，15 号票）：模型给的参数（原样）里的文字、参数摘要和守卫的说明换成删除标记；
 * 审批 id、卡片、来源、工具、调用指纹、命中的类别、时间不变（审批表重放出来不变，一次性授权照样按指纹匹配）
 */
export const approvalRequestPurge: PurgeRewriter = {
  eventType: GUARD_EVENTS.approvalRequested,
  rewrite(event) {
    const { approval } = event.payload as ApprovalRequestedPayload;
    return { approval: { ...approval, origin: purgedOrigin(approval.origin), args: purgedStrings(approval.args), argsSummary: PURGED_TEXT, reason: PURGED_TEXT } } satisfies ApprovalRequestedPayload;
  },
};
