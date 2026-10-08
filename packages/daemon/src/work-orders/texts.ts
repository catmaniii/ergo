// 工单和会话分段上的说法（16 号票）：交给项目维护者的通知（工单开始、催写回、澄清的回答）、会话里给人看的说明、
// 待我处理里的"卡住求助"、时间线上的记录、工单退回和做不了的原因。工具名一律插值。
import { type MaintainerSegment, type Project, type Task, WORK_ORDER_SOURCE_LABEL, WRITE_BACK_GAP_LABEL, type WorkOrder, type WriteBackGap } from "@ergou/protocol";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { WORK_ORDER_TOOL } from "./tool-names.ts";

/** 发给已归档项目的工单：直接退回的原因 */
export const archivedReason = (project: Project) => `项目「${project.name}」已归档：维护者不接新的工单。要接着做，先在项目页上取消归档，再重新发起`;

/** 发给已经删掉的项目的工单（17 号票：等阶段开始的工单派出时项目已经删了）：直接退回的原因 */
export const deletedProjectReason = (projectId: string) => `项目 ${projectId} 已经删除了`;

/** 任务取消了：工单退回的原因 */
export const TASK_CANCELLED_REASON = "任务取消了";
/** 任务结束了，还排着的工单退回的原因 */
export const TASK_ENDED_REASON = "任务已经结束了";

/** 执行工单的内容：计划、当前阶段和授权由重注入块给 */
export const executeInstructions = (task: Task) => `执行任务 ${task.id}「${task.title}」：计划已经确认。计划摘要、当前阶段、授权和边界见【运行时注入】那一段，以它为准。`;

/** 起草计划的工单开始时交给维护者的通知 */
export const planStartText = (wo: WorkOrder) =>
  `开始工单 ${wo.id}「${wo.title}」（来自${WORK_ORDER_SOURCE_LABEL[wo.source]}）：工单的内容在固定上下文里的“这次的工单”。` +
  `起草计划这一段，工作目录和项目档案只读；起草好计划用 ${SUBMIT_PLAN_TOOL} 提交，进展用 ${WORK_ORDER_TOOL.writeProgress} 写回，再用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。`;

/** 起草计划的工单段（工作目录和项目档案只读，进展经 write_progress 写回） */
export const isDraftingSegment = (segment: Pick<MaintainerSegment, "kind">, wo: WorkOrder | undefined) => segment.kind === "work_order" && wo?.kind === "plan";

/** 收尾时还缺什么 */
export function writeBackMissing(progressChanged: boolean, hasSummary: boolean): string[] {
  return [progressChanged ? "" : "进展 progress.md 的内容没变", hasSummary ? "" : `还没用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要`].filter(Boolean);
}

/** 催写回的通知 */
export function nudgeText(segment: MaintainerSegment, missing: readonly string[], drafting: boolean): string {
  const what = segment.workOrderId ? `工单 ${segment.workOrderId} 这一段` : "这一段对话";
  const progress = drafting ? `用 ${WORK_ORDER_TOOL.writeProgress} 写回进展 progress.md（做到哪了、下一步做什么）` : "把新的理解写回项目档案（progress.md 一定要更新：做到哪了、下一步做什么）";
  return `${what}要结束了，但还没写回：${missing.join("；")}。${progress}，再用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。写好之后这一段才算完成${segment.workOrderId ? "、工单才结束" : ""}。`;
}

/** 催写回到了次数还没写回：会话里给人看的说明 */
export const escalatedNote = (segment: MaintainerSegment, nudges: number) =>
  `维护者催了 ${nudges} 次还没写回项目档案：这一段（${segment.segmentId}）没写回就结束了${segment.workOrderId ? `，工单 ${segment.workOrderId} 照常结束` : ""}，转给你拍板（待我处理里的"卡住求助"）。`;

/** 催写回到了次数还没写回：待我处理里的"卡住求助" */
export function writeBackHelp(project: Project, wo: WorkOrder | undefined, missing: readonly string[]): { title: string; body: string } {
  return {
    title: `卡住求助：项目「${project.name}」的维护者没写回档案`,
    body: [
      `项目「${project.name}」的维护者在${wo ? `工单 ${wo.id}「${wo.title}」` : "一段对话"}结束时，催了还没把新的理解写回项目档案（${missing.join("；")}）。`,
      `${wo ? "工单照常结束了，" : ""}项目的队列接着往下走；这一段的理解可能没留在档案里，下一段会话只能从档案和上一段的摘要重建。`,
      "可以在维护者会话里让它补写进展，或者在项目页上重置维护者。",
    ].join("\n"),
  };
}

/** 时间线上的记录：一段没写回项目档案就结束了 */
export function unwrittenRecord(segment: MaintainerSegment, gap: WriteBackGap): { summary: string; detail: string } {
  return {
    summary: WRITE_BACK_GAP_LABEL[gap],
    detail: `会话分段 ${segment.segmentId}${segment.workOrderId ? `（工单 ${segment.workOrderId}）` : "（对话段）"}结束时没写回项目档案${gap === "reset" ? "：写回中途重置了维护者，工单照常算完成" : "：催写回到了次数，转给用户拍板"}`,
  };
}

/** 时间线上的记录：重置维护者时这一段工单的工作还没做范围审视（18 号票，写法同"重置时这段没写回档案"） */
export function unreviewedRecord(segment: MaintainerSegment): { summary: string; detail: string } {
  return {
    summary: "重置时这段没做范围审视",
    detail: `会话分段 ${segment.segmentId}（工单 ${segment.workOrderId ?? ""}）没做范围审视就结束了：重置了维护者，这段工作（压缩会话时审视过的除外）没有对照立项书、计划和授权查过`,
  };
}

/** 用户关掉了工单的提问卡：交给维护者的通知 */
export const DISMISSED_TEXT = "用户关掉了你的提问卡，没有回答。按你的理解接着做，拿不准的写进项目档案、在进展里说明。";

/** 时间线上的记录：用户关掉了工单的提问卡，维护者按自己的理解接着做 */
export const ownJudgementRecord = (wo: WorkOrder) => ({ summary: `关掉了工单 ${wo.id} 的提问卡：维护者按自己的理解接着做`, detail: `任务 ${wo.taskId}「${wo.taskTitle}」` });

/** 用户回答了工单的提问卡：交回提问的维护者 */
export const answeredText = (workOrderId: string, taskId: string | undefined, lines: readonly string[], allRecommended: boolean) =>
  `用户回答了你在工单 ${workOrderId} 里的提问${taskId === undefined ? "" : `（任务 ${taskId}）`}${allRecommended ? "，全按推荐" : ""}：\n${lines.join("\n")}\n接着做。`;

/** 只有做工单时能向派单方提问 */
export const ASK_ONLY_IN_WORK_ORDER = "只有做工单时能向派单方提问；直接和用户对话时直接问就行";
