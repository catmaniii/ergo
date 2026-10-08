// 计划变更卡（plan_change，规格第 5、8 节，14 号票）：维护者执行中要扩大授权、加能力、加项目、改目标或验收时出的卡，
// 进待我处理（卡着任务）。卡上只列相对当前计划新增或改动的部分（负载的 changes，说法由协议包 plan.ts 的 planChangeItemText 生成）。
// - 确认（confirm，输入和计划卡一样是 PlanConfirmInput：可以勾掉、收窄授权项，加本任务的关注类别）：计划和授权项随之更新，
//   受影响的阶段恢复；
// - 拒绝（reject，可附说明）：受影响的阶段交回维护者在现有授权内重排，做不到就标做不了。
// 两个动作都追加 plan_decided（带 change，"审批决定"素材的来源），逻辑在执行控制器（execution.ts）。
// 卡片清单里的"工具包变更"（规格第 21 节）在计划变更里是 toolkit 那一处改动；维护者不在任务里时的工具包变更卡归 27 号票。
import { PlanChangeCardPayload, PlanConfirmInput, planChangeItemText } from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";
import type { TaskExecution } from "./execution.ts";

export function planChangeCardType(execution: TaskExecution) {
  return defineCardType({
    type: "plan_change",
    version: 1,
    payload: PlanChangeCardPayload,
    actions: {
      confirm: { input: PlanConfirmInput, run: ({ payload, input, idempotencyKey }) => execution.confirmPlanChange(payload, input, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => execution.rejectPlanChange(payload, note, idempotencyKey) },
    },
    toText: (p) =>
      [
        `计划变更：${p.taskTitle}（${p.why}）`,
        ...p.changes.map((c) => `- ${planChangeItemText(c, p.grantInfo)}${c.expands ? "（要你确认）" : ""}`),
        ...(p.affectedStages.length > 0 ? [`停下等确认的阶段：${p.affectedStages.map((s) => `${s.stageId}「${s.title}」`).join("、")}`] : []),
      ].join("\n"),
  });
}
