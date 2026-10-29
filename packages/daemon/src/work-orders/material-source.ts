// 工单卡上的决定（17 号票）产生的素材（规格第 15 节）：用户确认派出或拒绝计划外的工单（work_order_decided）记成"审批决定"。
// 确认、拒绝都是用户在 agent 先提出的提议上做的选择（本人，注明 agent 先提出）；用户写的话是本人打的字。
// 在 daemon.ts 里、materials.start() 之前登记；彻底删除时只换掉用户写的话（改写函数登记进记忆模块的改写函数表）。
import { EVENT_TYPES } from "@ergo/protocol";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import type { WorkOrderDecidedPayload } from "./multi-project.ts";
import { decisionText } from "./multi-project-texts.ts";

export const workOrderDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "work-order-decision",
  eventType: EVENT_TYPES.workOrderDecided,
  capture(event) {
    const p = event.payload as WorkOrderDecidedPayload;
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        task: p.taskId,
        project: p.projectId,
        context: [`decision:${p.decision}`, "card:work_order"],
        ref: { recordId: p.workOrderId, cardId: p.cardId },
        accepted: { text: decisionText(p), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 彻底删除：工单卡上的决定只换掉用户写的话，决定本身不变 */
export const workOrderDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.workOrderDecided,
  rewrite: (event) => {
    const p = event.payload as WorkOrderDecidedPayload;
    return { ...p, ...purgedField(p, "note") } satisfies WorkOrderDecidedPayload;
  },
};
