// 工单卡（work_order，规格第 5、12 节，17 号票）：涉及多个项目的任务的维护者执行中派出计划外的工单，命中"计划外工单"类别
// （任务里默认先问我），工单待你确认，待我处理出现这张卡。"确认派出"之后工单才进入项目维护者的队列，"拒绝"则不派
// （记"没派出"）；两个都是"审批决定"素材（material-source.ts）。逻辑在 multi-project.ts 的 decide，说法在 multi-project-texts.ts。
import { WorkOrderCardPayload } from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";
import type { MultiProject } from "./multi-project.ts";
import { workOrderCardText } from "./multi-project-texts.ts";

export function workOrderCardType(multiProject: () => Pick<MultiProject, "decide">) {
  return defineCardType({
    type: "work_order",
    version: 1,
    payload: WorkOrderCardPayload,
    actions: {
      dispatch: { input: undefined, run: ({ card, payload, note }) => multiProject().decide({ id: card.id, payload }, "dispatch", note) },
      deny: { input: undefined, run: ({ card, payload, note }) => multiProject().decide({ id: card.id, payload }, "deny", note) },
    },
    toText: workOrderCardText,
  });
}
