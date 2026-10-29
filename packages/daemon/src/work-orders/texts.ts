// 工单和会话分段上的说法（16 号票）：交给项目维护者的通知（工单开始、催写回、澄清的回答）、会话里给人看的说明、
// 待我处理里的"卡住求助"、时间线上的记录、工单退回和做不了的原因。工具名一律插值。
import {
  deletedIdLabel,
  isJobRunWorkOrder,
  type MaintainerSegment,
  namedIdLabel,
  type Project,
  t,
  type Task,
  type TaskKind,
  WORK_ORDER_SOURCE_LABEL,
  WRITE_BACK_GAP_LABEL,
  type WorkOrder,
  type WriteBackGap,
  forModel,
} from "@ergo/protocol";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import { WORK_ORDER_TOOL } from "./tool-names.ts";

// 173 号票：给用户看的（退回的原因、会话里的说明、"卡住求助"、时间线上的记录）走 t()，生成时按当时的语言；
// 交给维护者的通知、工具的拒绝原因（给模型看的）标 @i18n-ignore model

/** 发给已归档项目的工单：直接退回的原因 */
export const archivedReason = (project: Project) => t("workOrders.reason.archived", { name: project.name });

/** 发给已经删掉的项目的工单（17 号票：等阶段开始的工单派出时项目已经删了）：直接退回的原因 */
export const deletedProjectReason = (projectId: string) => t("workOrders.reason.projectDeleted", { id: projectId });

/** 任务取消了：工单退回的原因 */
export const taskCancelledReason = () => t("workOrders.reason.taskCancelled");
/** 任务结束了，还排着的工单退回的原因 */
export const taskEndedReason = () => t("workOrders.reason.taskEnded");

// @i18n-ignore-start model：工单的内容、交给维护者的通知
/** 执行工单的内容：计划、当前阶段和授权由重注入块给 */
export const executeInstructions = (task: Task) => `执行任务 ${task.id}「${task.title}」：计划已经确认。计划摘要、当前阶段、授权和边界见【运行时注入】那一段，以它为准。`;

/** 定时触发的一次运行（19 号票的定时作业；76 号票）的工单开始时交给维护者的通知（要做的事在固定上下文里的"这次的工单"） */
export const runStartText = (wo: WorkOrder) =>
  `开始工单 ${wo.id}「${wo.title}」（来自定时触发）：第几次运行、要做的事、前几次的结果、做不了时怎么办都在固定上下文里的“这次的工单”。做完就结束这一轮；` +
  `之后照常把进展写回 progress.md、用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。`;

/** 起草计划的工单开始时交给维护者的通知（流程的计划用 propose_plan 交：58 号票，64 号票起项目的维护者也起草流程） */
export const planStartText = (wo: WorkOrder, kind: TaskKind = "long_running") =>
  `开始工单 ${wo.id}「${wo.title}」（来自${forModel(() => WORK_ORDER_SOURCE_LABEL[wo.source])}）：工单的内容在固定上下文里的“这次的工单”。` +
  `起草计划这一段，工作目录和项目档案只读；起草好计划用 ${kind === "workflow" ? WORKFLOW_TOOL.proposePlan : SUBMIT_PLAN_TOOL} 提交，进展用 ${WORK_ORDER_TOOL.writeProgress} 写回，再用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。`;

// @i18n-ignore-end

/** 起草计划的工单段（工作目录和项目档案只读，进展经 write_progress 写回） */
export const isDraftingSegment = (segment: Pick<MaintainerSegment, "kind">, wo: WorkOrder | undefined) => segment.kind === "work_order" && wo?.kind === "plan";

/** 收尾时还缺什么 */
export function writeBackMissing(progressChanged: boolean, hasSummary: boolean): string[] {
  // 催写回的通知（给维护者）和"卡住求助"（给用户）都用：按当前语言（173 号票）
  return [progressChanged ? "" : t("workOrders.writeBack.progressUnchanged"), hasSummary ? "" : t("workOrders.writeBack.noSummary", { tool: WORK_ORDER_TOOL.writeSegmentSummary })].filter(Boolean);
}

/** 催写回的通知 */
// @i18n-ignore-start model：催写回的通知
export function nudgeText(segment: MaintainerSegment, missing: readonly string[], drafting: boolean): string {
  const what = segment.workOrderId ? `工单 ${segment.workOrderId} 这一段` : "这一段对话";
  const progress = drafting ? `用 ${WORK_ORDER_TOOL.writeProgress} 写回进展 progress.md（做到哪了、下一步做什么）` : "把新的理解写回项目档案（progress.md 一定要更新：做到哪了、下一步做什么）";
  return `${what}要结束了，但还没写回：${missing.join("；")}。${progress}，再用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。写好之后这一段才算完成${segment.workOrderId ? "、工单才结束" : ""}。`;
}
// @i18n-ignore-end

/** 给用户看的工单（159 号票，163 号票写成 t-3「标题」）："wo-3「加一个导出说明」"；取不到的（删掉了）"wo-3（已删除）" */
const shownOrder = (workOrderId: string, wo: Pick<WorkOrder, "id" | "title"> | undefined) => (wo?.id === workOrderId ? namedIdLabel(wo.id, wo.title) : deletedIdLabel(workOrderId));

/** 催写回到了次数还没写回：会话里给人看的说明（待我处理在界面上叫"待办"，43 号票）；wo 是这一段的工单 */
export const escalatedNote = (segment: MaintainerSegment, nudges: number, wo: Pick<WorkOrder, "id" | "title"> | undefined) =>
  segment.workOrderId
    ? t("workOrders.writeBack.escalatedOrder", { count: nudges, nudges, segment: segment.segmentId, order: shownOrder(segment.workOrderId, wo) })
    : t("workOrders.writeBack.escalated", { count: nudges, nudges, segment: segment.segmentId });

/** 催写回到了次数还没写回：待我处理里的"卡住求助" */
export function writeBackHelp(project: Project, wo: WorkOrder | undefined, missing: readonly string[]): { title: string; body: string } {
  return {
    title: t("workOrders.writeBack.helpTitle", { name: project.name }),
    body: [
      t("workOrders.writeBack.helpWhat", {
        name: project.name,
        what: wo ? t("workOrders.writeBack.helpOrder", { id: wo.id, title: wo.title }) : t("workOrders.writeBack.helpChat"),
        missing: missing.join(t("workOrders.sep")),
      }),
      t(wo ? "workOrders.writeBack.helpQueueOrder" : "workOrders.writeBack.helpQueue"),
      t("workOrders.writeBack.helpFix"),
    ].join("\n"),
  };
}

/** 时间线上的记录：一段没写回项目档案就结束了（wo 是这一段的工单） */
export function unwrittenRecord(segment: MaintainerSegment, gap: WriteBackGap, wo: Pick<WorkOrder, "id" | "title"> | undefined): { summary: string; detail: string } {
  return {
    summary: WRITE_BACK_GAP_LABEL[gap],
    detail: t(gap === "reset" ? "workOrders.writeBack.unwrittenReset" : "workOrders.writeBack.unwrittenNudged", {
      segment: segment.segmentId,
      which: segment.workOrderId ? t("workOrders.writeBack.whichOrder", { order: shownOrder(segment.workOrderId, wo) }) : t("workOrders.writeBack.whichChat"),
    }),
  };
}

/** 时间线上的记录：重置维护者时这一段工单的工作还没做范围审视（18 号票，写法同"重置时这段没写回档案"；wo 是这一段的工单） */
export function unreviewedRecord(segment: MaintainerSegment, wo: Pick<WorkOrder, "id" | "title"> | undefined): { summary: string; detail: string } {
  return {
    summary: t("workOrders.unreviewed.summary"),
    detail: t("workOrders.unreviewed.detail", { segment: segment.segmentId, order: segment.workOrderId === undefined ? "" : shownOrder(segment.workOrderId, wo) }),
  };
}

/** 用户关掉了工单的提问卡：交给维护者的通知 */
export const DISMISSED_TEXT = "用户关掉了你的提问卡，没有回答。按你的理解接着做，拿不准的写进项目档案、在进展里说明。"; // @i18n-ignore model

/** 时间线上的记录：用户关掉了工单的提问卡，维护者按自己的理解接着做 */
export const ownJudgementRecord = (wo: WorkOrder) => ({
  summary: t("workOrders.ownJudgement.summary", { order: namedIdLabel(wo.id, wo.title) }),
  detail: isJobRunWorkOrder(wo) ? t("workOrders.ownJudgement.order", { title: wo.title }) : t("workOrders.taskRef", { id: wo.taskId, title: wo.taskTitle }),
});

/** 用户回答了工单的提问卡：交回提问的维护者 */
// @i18n-ignore-start model：交给维护者的通知、工具的拒绝原因
export const answeredText = (workOrderId: string, taskId: string | undefined, lines: readonly string[], allRecommended: boolean) =>
  `用户回答了你在工单 ${workOrderId} 里的提问${taskId === undefined ? "" : `（任务 ${taskId}）`}${allRecommended ? "，全按推荐" : ""}：\n${lines.join("\n")}\n接着做。`;

/** 只有做工单时能向派单方提问 */
export const ASK_ONLY_IN_WORK_ORDER = "只有做工单时能向派单方提问；直接和用户对话时直接问就行";

/** 定时作业的一次运行（19 号票）没人等着回答 */
export const ASK_NOT_IN_JOB_RUN = "定时触发的运行没人等着回答：自己拿主意接着做；做不了照“这次的工单”里写的报告这次运行失败";
// @i18n-ignore-end
