// 流程计划卡（58 号票，照搬 AgentSense 的 PlanCard / ReviewPanel / PlanSteps / AuthActions）的纯函数：
// 审查面板四步（扫描 → 识别 → 修复 → 结果）的数字、每一步的改写说法、敏感标注怎么写、授权前的摘要、执行中各步的进度。
import type { Task, TaskStep, WorkflowPlan, WorkflowStepMark, WorkflowStepView } from "./protocol.ts";
import { workflowConfirmationItems } from "./protocol.ts";

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

/** 执行中各步的状态（任务看板上的 Task.steps.list），按步骤 id */
export function workflowStepProgress(task: Pick<Task, "steps"> | undefined): Record<string, TaskStep> {
  return Object.fromEntries((task?.steps?.list ?? []).map((s) => [s.stepId, s]));
}
