// 原型看板上的假任务（proto.board 里的 TaskSummary，还没接真数据的那些）怎么菜单、怎么做（90 号票）：
// - 菜单项和真任务同一份规则（state/task-menu.ts 照"谁能改"表算），假条目按它的状态拼一个 TaskMenuSubject——阶段取假详情里的
//   （taskDetailOf），没有的按"第 N/M 阶段"排出 M 个：前面的验收了、第 N 个是它现在的样子、后面的没开始；
// - 做了之后状态怎么变：没有执行，照原来假任务详情里演的那套（暂停、继续——执行名额没满直接回到执行中、满了先排队、取消、归档、
//   重试、验收通过算做完、退回 / 返工回到执行中），写一句提示。
import type { ActivityState, TaskStatus, TaskSummary } from "../model/types.ts";
import type { MenuStage, TaskAction, TaskMenuSubject } from "../state/index.ts";
import { FAKE_RUN_SLOTS, taskDetailOf } from "./fake-data.ts";

/** 假任务的阶段：假详情里有就用，没有按"第 N/M 阶段"排出来 */
function protoStages(t: TaskSummary): MenuStage[] {
  const detail = taskDetailOf(t.id).stages;
  if (detail.length > 0) return detail.map((s) => ({ stageId: s.id, state: s.status, ...(s.waitReason ? { waitReason: s.waitReason } : {}) }));
  if (!t.stage) return [];
  const { current, total } = t.stage;
  const now = (): MenuStage["state"] => (t.status === "waiting_for_user" ? "waiting" : t.status === "done" || t.status === "archived" ? "accepted" : t.status === "failed" ? "failed" : "running");
  return Array.from({ length: total }, (_, i) => ({
    stageId: `s${i + 1}`,
    state: i < current - 1 ? "accepted" : i === current - 1 ? now() : "pending",
    ...(i === current - 1 && t.status === "waiting_for_user" && t.waitReason ? { waitReason: t.waitReason } : {}),
  }));
}

/** 假任务按菜单规则看的样子 */
export function protoSubject(t: TaskSummary): TaskMenuSubject {
  return {
    state: t.status,
    ...(t.waitReason ? { waitReason: t.waitReason } : {}),
    kind: t.taskKind ?? "long_running",
    ...(t.endNote ? { endKind: "converted_to_project" as const } : {}),
    stages: { list: protoStages(t) },
    ...(t.status === "operating" && t.trigger ? { triggerActions: t.trigger.actions } : {}),
  };
}

/** 假任务做了一件事之后：新的状态、活动状态（没变的不写）、提示；running 是别的在执行中的假任务有几个（执行名额） */
export function protoAfter(action: TaskAction, running: number): { status: TaskStatus; activity?: ActivityState; toast: string } {
  const resume = (what: string) =>
    running < FAKE_RUN_SLOTS
      ? { status: "running" as const, activity: "working" as const, toast: `${what}：执行名额没满，直接回到执行中` }
      : { status: "queued" as const, activity: "queued" as const, toast: `${what}：执行名额满了（${running}/${FAKE_RUN_SLOTS}），先排队` };
  switch (action) {
    case "pause":
      return { status: "paused", activity: "sleeping", toast: "已暂停" };
    case "resume":
      return resume("已继续");
    case "cancel":
      return { status: "cancelled", activity: "sleeping", toast: "已取消" };
    case "archive":
      return { status: "archived", toast: "已归档" };
    case "retry":
      return resume("已重试");
    case "accept_stage":
      return { status: "done", activity: "sleeping", toast: "验收通过，任务完成" };
    case "return_stage":
      return resume("已退回，原因交给了维护者");
    case "rework":
      return resume("已从这里重做，重开这个阶段和它的下游");
  }
}
