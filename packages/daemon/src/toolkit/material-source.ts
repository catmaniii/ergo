// 工具包的审批决定（27 号票）产生的素材（规格第 15 节）：用户批准或拒绝"工具包变更"卡、在项目页或任务详情里直接扩大或减少
// 工具包（toolkit_decided），都记成"审批决定"（本人的选择）；用户在卡上写的话是本人打的字。
// 在 daemon.ts 里、materials.start() 之前登记；彻底删除时只换掉用户写的话（改写函数登记进记忆模块的改写函数表）。
import { EVENT_TYPES, t, type ToolkitDecidedPayload, toolkitChangeText } from "@ergo/protocol";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";

/** 决定写成一句话 */
function decisionText(p: ToolkitDecidedPayload): string {
  const whose = p.target.kind === "project" ? t("toolkit.decision.project", { title: p.targetTitle }) : t("toolkit.decision.task", { title: p.targetTitle });
  const change = toolkitChangeText(p.before, p.after);
  if (p.decision === "approved") return t("toolkit.decision.approved", { whose, change });
  if (p.decision === "denied") return t("toolkit.decision.denied", { whose, change });
  return t("toolkit.decision.direct", { whose, change });
}

export const toolkitDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "toolkit-decision",
  eventType: EVENT_TYPES.toolkitDecided,
  capture(event) {
    const p = event.payload as ToolkitDecidedPayload;
    const text = { text: decisionText(p), field: "decision" };
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        ...(p.target.kind === "project" ? { project: p.target.projectId } : { task: p.target.taskId }),
        context: [`decision:${p.decision}`, p.cardId ? "card:toolkit_change" : "toolkit:edited"],
        ref: { recordId: `${p.target.kind === "project" ? p.target.projectId : p.target.taskId}@${p.time}`, ...(p.cardId ? { cardId: p.cardId } : {}) },
        // 批准、拒绝的是维护者先提出的申请；直接改的是用户在界面上选的（开关、名单），都按"选择"记
        accepted: text,
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 彻底删除：工具包的决定只换掉用户写的话，决定本身不变 */
export const toolkitDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.toolkitDecided,
  rewrite: (event) => {
    const p = event.payload as ToolkitDecidedPayload;
    return { ...p, ...purgedField(p, "note") } satisfies ToolkitDecidedPayload;
  },
};
