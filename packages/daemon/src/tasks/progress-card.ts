// 进度卡（规格第 5 节的卡片之一，13 号票登记）：任务时间线上的一张卡，出现在维护者的会话里（不进待我处理）。
// - 维护者"报告进展"：所属任务、第几阶段（93 号票起写编号"第 1a 阶段"，之前的卡是第 N/M 阶段）、进展说明；
// - 一个阶段的验收结论：每条标准的方式和结果，谁判的（评审方式的标"评审判定"）。
// 只是告诉用户，唯一的动作是"知道了"。纯文本降级版本给不认识它的前端。
// 84 号票：你退回时写的原因记在由你验收的那几条结论的备注里；彻底删除那条退回（用户对产出的反应）时连带改写这张卡，换成删除标记。
import { ACCEPTANCE_VERDICT_LABEL, ProgressCardPayload, PURGED_TEXT } from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";

export function progressCardText(p: ProgressCardPayload): string {
  // 93 号票起写编号（和界面上进度卡的标题一样）；之前的卡照旧写计划里的第几个 / 共几个
  const where = `任务「${p.taskTitle}」第 ${p.stageCode ?? `${p.stageIndex}/${p.stageTotal}`} 阶段「${p.stageTitle}」`;
  if (p.kind === "acceptance" && p.acceptance) {
    return `验收${p.acceptance.passed ? "通过" : "没通过"}（${ACCEPTANCE_VERDICT_LABEL[p.acceptance.judgedBy]}）：${where}。${p.text}`;
  }
  return `进展：${where}。${p.text}`;
}

export function progressCardType() {
  return defineCardType({
    type: "progress",
    version: 1,
    payload: ProgressCardPayload,
    actions: {
      ack: { input: undefined, run: () => ({ status: "handled" }) },
    },
    toText: progressCardText,
    purge: (payload) =>
      payload.acceptance
        ? { ...payload, acceptance: { ...payload.acceptance, results: payload.acceptance.results.map((r) => (r.method === "user" && r.note !== undefined ? { ...r, note: PURGED_TEXT } : r)) } }
        : payload,
  });
}
