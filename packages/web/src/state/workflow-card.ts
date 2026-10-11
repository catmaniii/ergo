// 流程计划卡（58 号票，照搬 AgentSense 的 PlanCard / ReviewPanel / PlanSteps / AuthActions）的纯函数：
// 审查面板四步（扫描 → 识别 → 修复 → 结果）的数字、每一步的改写说法、敏感标注怎么写、授权前的摘要、执行中各步的进度。
import type { EventTrigger, ReminderSchedule, Task, TaskStep, WorkflowPlan, WorkflowStepMark, WorkflowStepView } from "./protocol.ts";
import { describeEventTrigger, describeSchedule, EVENT_PLACEHOLDER_NOTE, EVENT_WORKFLOW_GRANT_TEXT, TIMED_WORKFLOW_GRANT_TEXT, workflowConfirmationItems } from "./protocol.ts";

/** 定时触发的流程（76 号票）：卡上写明时间表，以及授权管多久——按时间表反复运行，一直有效，直到暂停或取消 */
export const timedWorkflowLine = (schedule: ReminderSchedule): string => `定时：${describeSchedule(schedule)}。${TIMED_WORKFLOW_GRANT_TEXT}。`;

/**
 * 事件触发的流程（77 号票）：卡上写明在等什么事件、授权管多久——每次事件发生时运行，一直有效，直到暂停或取消；
 * 步骤参数里的占位每次运行代入这次事件的值
 */
export const eventWorkflowLines = (trigger: EventTrigger): string[] => [`事件发生时：${describeEventTrigger(trigger)}。${EVENT_WORKFLOW_GRANT_TEXT}。`, `${EVENT_PLACEHOLDER_NOTE}。`];

/** 一步里写了事件的值（77 号票）：卡上标"代入事件的值：文件路径、文件名" */
export const stepEventValuesText = (step: Pick<WorkflowStepView, "eventValues">): string | undefined =>
  step.eventValues && step.eventValues.length > 0 ? `代入事件的值：${step.eventValues.join("、")}` : undefined;

/** 审查面板四步要的数字（AgentSense ReviewPanel 里算的那几个） */
export interface WorkflowReviewFigures {
  /** 修补动作里真正动了计划的（插入、改写、调顺序；交给你确认、退回重写不算） */
  repairs: WorkflowPlan["review"]["actions"];
  /** 违规里被修补动作盖掉的几处 */
  fixed: number;
  /** 修不掉的几处 */
  left: number;
  /** 要你逐条确认的事项 */
  asks: ReturnType<typeof workflowConfirmationItems>;
}

export function workflowReviewFigures(review: WorkflowPlan["review"], steps: WorkflowPlan["steps"] = []): WorkflowReviewFigures {
  const covered = new Set(review.actions.flatMap((a) => a.covers));
  const fixed = review.violations.filter((v) => v.key !== undefined && covered.has(v.key)).length;
  return {
    repairs: review.actions.filter((a) => a.kind !== "confirm" && a.kind !== "replan"),
    fixed,
    left: review.violations.length - fixed,
    asks: workflowConfirmationItems(review, steps),
  };
}

/**
 * 一步被审查改写成什么（AgentSense PlanSteps：引擎的 patches 是 "rewrite:s4:append.exclude=..." 这种内部写法；
 * 同一步的修补动作自带一句人话，有就用它）
 */
export function workflowStepPatches(plan: Pick<WorkflowPlan, "review">, step: Pick<WorkflowStepView, "id" | "patches">): string[] {
  const titled = plan.review.actions.filter((a) => a.stepId === step.id && a.kind !== "insert").map((a) => a.title);
  return titled.length > 0 ? titled : (step.patches ?? []);
}

export type MarkTone = "ok" | "op" | "high" | "no" | "quiet";

/**
 * 一步的敏感标注怎么写：计划授权了的（执行时不再问）、执行时仍会问的、交给你做的、永不的、会被直接拒绝的、
 * 只记录或做完告诉你的（不显眼）
 */
export function workflowMarkView(mark: WorkflowStepMark): { text: string; tone: MarkTone } {
  if (mark.category.startsWith("refusal:")) return { text: `⛔ ${mark.title}`, tone: "no" };
  if (mark.authorized) return { text: `✓ ${mark.title}：计划授权了`, tone: "ok" };
  switch (mark.disposition) {
    case "never":
      return { text: `⛔ ${mark.title}：永不`, tone: "no" };
    case "hand_to_me":
      return { text: `${mark.title}：交给你做`, tone: "high" };
    case "ask_first":
    case "planned_only":
      return { text: `⚠ ${mark.title}：执行时仍会问你`, tone: "op" };
    case "do_then_tell":
      return { text: `${mark.title}：做完告诉你`, tone: "quiet" };
    case "do":
      return { text: mark.title, tone: "quiet" };
  }
}

/** 授权前的一句摘要要的数字：涉及几项敏感操作（不算只记录的），其中执行时还会停下问你、交给你做的几处 */
export function workflowAuthFigures(plan: Pick<WorkflowPlan, "steps">): { sensitive: number; stops: number } {
  const marks = plan.steps.flatMap((s) => s.marks.map((m) => workflowMarkView(m)));
  const sensitive = marks.filter((m) => m.tone !== "quiet").length;
  const stops = marks.filter((m) => m.tone === "op" || m.tone === "high").length;
  return { sensitive, stops };
}

/**
 * 做完了几步：只算报了"做完"的，跳过的不算（AgentSense App.tsx、useAgent.ts 的 done：steps 里 status 是 done 的个数）。
 * 标题栏的进度条、看板卡、虚线框、"运行"一栏、缩小后的任务卡、项目页都用这一个（经 workflowProgress 或直接用）
 */
export function stepsDone(steps: readonly Pick<TaskStep, "state">[]): number {
  return steps.filter((s) => s.state === "done").length;
}

/**
 * 一份流程计划涉及几个关注类别（各步标注里不重复的类别）：计划台账、缩小后点开的任务卡（55 号票）都用这一个数
 */
export function workflowPlanCategoryCount(plan: Pick<WorkflowPlan, "steps">): number {
  return new Set(plan.steps.flatMap((s) => s.marks.map((m) => m.category))).size;
}

/** 执行中各步的状态（任务看板上的 Task.steps.list），按步骤 id */
export function workflowStepProgress(task: Pick<Task, "steps"> | undefined): Record<string, TaskStep> {
  return Object.fromEntries((task?.steps?.list ?? []).map((s) => [s.stepId, s]));
}
