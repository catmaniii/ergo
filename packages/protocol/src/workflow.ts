// 流程（58 号票，ADR 0019）的名字和纯函数：不引用 TypeBox（Web 只用这些常量和类型）。schema 在 workflow-schema.ts。
// 固定计划：
// - 计划是一串步骤（每步一次工具调用：工具和参数，连同前置步骤），连同这份计划要满足的条件（时序规则）；
// - 计划先过审查修补（planguard 的 reviewer），审查结果的几种状态、修补动作的说法见计划审查面板；
// - 需要用户逐项明确同意的事项（confirmationItems）勾完才能授权；
// - 执行时步骤的状态由维护者用 report_step 自报（StepStatus）。
import { followLocale, t, tTable } from "./i18n/runtime.ts";
import type { WorkflowReview, WorkflowStepView } from "./workflow-schema.ts";

/** 审查结果的状态：通过、已修补、需你逐项确认、退回维护者重写、判定不可执行 */
export const WORKFLOW_REVIEW_STATUSES = ["pass", "patched", "needs_confirmation", "needs_replan", "blocked"] as const;
export type WorkflowReviewStatus = (typeof WORKFLOW_REVIEW_STATUSES)[number];

/** 审查结果的状态在卡上怎么写 */
export const WORKFLOW_REVIEW_STATUS_LABEL: Readonly<Record<WorkflowReviewStatus, { label: string; cls: "ok" | "warn" | "no" }>> = {
  pass: {
    get label() {
      return t("protocol.workflow.review.pass");
    },
    cls: "ok",
  },
  patched: {
    get label() {
      return t("protocol.workflow.review.patched");
    },
    cls: "warn",
  },
  needs_confirmation: {
    get label() {
      return t("protocol.workflow.review.needsConfirmation");
    },
    cls: "warn",
  },
  needs_replan: {
    get label() {
      return t("protocol.workflow.review.needsReplan");
    },
    cls: "warn",
  },
  blocked: {
    get label() {
      return t("protocol.workflow.review.blocked");
    },
    cls: "no",
  },
};

/**
 * 定时触发的流程（76 号票，ADR 0017：授权随计划卡确认）：卡上写明这次授权管多久——用户点授权时就知道它不按 7 天到期，
 * 之后每次运行都照它，直到暂停或取消
 */
export let TIMED_WORKFLOW_GRANT_TEXT = "";

/** 事件触发的流程（77 号票）：计划卡上写明授权管多久，和步骤里的事件占位怎么用（对话框、守护进程生成的卡片文字共用） */
export let EVENT_WORKFLOW_GRANT_TEXT = "";
export let EVENT_PLACEHOLDER_NOTE = "";

// 上面三句跟着当前语言（followLocale）
followLocale(() => {
  TIMED_WORKFLOW_GRANT_TEXT = t("protocol.workflow.timedGrant");
  EVENT_WORKFLOW_GRANT_TEXT = t("protocol.workflow.eventGrant");
  EVENT_PLACEHOLDER_NOTE = t("protocol.workflow.placeholderNote");
});

/** 修补动作的种类：插入步骤、改写参数、调整顺序、交给你确认、退回重写（planguard 的 REPAIR_KINDS） */
export const WORKFLOW_REPAIR_KINDS = ["insert", "rewrite", "move_after", "confirm", "replan"] as const;
export type WorkflowRepairKind = (typeof WORKFLOW_REPAIR_KINDS)[number];

/** 修补动作在卡上怎么写 */
export const WORKFLOW_REPAIR_LABEL: Readonly<Record<string, string>> = tTable({
  insert: "protocol.workflow.repair.insert",
  rewrite: "protocol.workflow.repair.rewrite",
  move_after: "protocol.workflow.repair.moveAfter",
  confirm: "protocol.workflow.repair.confirm",
  replan: "protocol.workflow.repair.replan",
});

/** 一步的条件在审查时查出的结果：满足、违反（修补之后仍违反，计划不会走到这里）、现在判不了（推迟到执行时再查） */
export const WORKFLOW_CONDITION_STATUSES = ["pass", "violated", "unknown"] as const;
export type WorkflowConditionStatus = (typeof WORKFLOW_CONDITION_STATUSES)[number];

export const WORKFLOW_CONDITION_STATUS_LABEL: Readonly<Record<WorkflowConditionStatus, string>> = tTable({
  pass: "protocol.workflow.condition.pass",
  violated: "protocol.workflow.condition.violated",
  unknown: "protocol.workflow.condition.unknown",
});

/** 一步的条件从哪里来：框架自带的 v1 规则模板、维护者写进计划的规则 */
export const WORKFLOW_CONDITION_SOURCES = ["template", "plan"] as const;
export type WorkflowConditionSource = (typeof WORKFLOW_CONDITION_SOURCES)[number];

export const WORKFLOW_CONDITION_SOURCE_LABEL: Readonly<Record<WorkflowConditionSource, string>> = tTable({ template: "protocol.workflow.source.template", plan: "protocol.workflow.source.plan" });

/** 执行时一步的状态：没做、在做、做完、失败、跳过 */
export const WORKFLOW_STEP_STATES = ["pending", "in_progress", "done", "failed", "skipped"] as const;
export type WorkflowStepState = (typeof WORKFLOW_STEP_STATES)[number];

export const WORKFLOW_STEP_STATE_LABEL: Readonly<Record<WorkflowStepState, string>> = tTable({
  pending: "protocol.workflow.step.pending",
  in_progress: "protocol.workflow.step.inProgress",
  done: "protocol.workflow.step.done",
  failed: "protocol.workflow.step.failed",
  skipped: "protocol.workflow.step.skipped",
});

/** 步骤状态的图标 */
export const WORKFLOW_STEP_ICON: Readonly<Record<WorkflowStepState, string>> = { pending: "○", in_progress: "◐", done: "●", failed: "✕", skipped: "–" };

/** 维护者用 report_step 能报的状态（"没做"不用报） */
export const REPORTED_STEP_STATES = ["in_progress", "done", "failed", "skipped"] as const satisfies readonly WorkflowStepState[];
export type ReportedStepState = (typeof REPORTED_STEP_STATES)[number];

/** 算"结束了"的步骤：做完、跳过（失败的不算，维护者要接着处理或判任务失败） */
export const SETTLED_STEP_STATES: readonly WorkflowStepState[] = ["done", "skipped"];

/** 流程执行时的那个阶段（执行控制器按一个阶段管名额、暂停、审批挂起……；界面上不显示阶段，显示步骤） */
export const WORKFLOW_STAGE_ID = "flow";

/** 需要用户逐项点头的一项：key 用来对上卡上的勾选 */
export interface WorkflowConfirmationItem {
  key: string;
  text: string;
}

/**
 * 审查结果里必须由用户逐项点头的事项：审查明说要问的、本身就带人工介入代价的修补
 * （例如"先备份再删"）。事前授权过一次不等于默认同意这些，所以单独列出来，勾完才能授权。
 * 没有"目标打架时被放弃的那个"：二狗的流程没有审查目标（goals）。
 * 交给你确认（confirm）的动作本身也带人工介入代价，只列一次（confirmations 里那条），不在"同意这项改动"里再列
 */
export function workflowConfirmationItems(
  review: Pick<WorkflowReview, "confirmations" | "actions" | "status">,
  steps: ReadonlyArray<Pick<WorkflowStepView, "id" | "title" | "outside">> = [],
): WorkflowConfirmationItem[] {
  const items = [
    ...review.confirmations.map((item) => ({ key: `c:${item}`, text: item })),
    ...review.actions
      .filter((a) => a.kind !== "confirm" && (a.costs?.interaction ?? 0) > 0)
      .map((a) => ({ key: `a:${a.kind}${a.title}`, text: t("protocol.workflow.confirm.action", { title: a.title }) })),
  ];
  // 审查说要问，却说不出问什么：不能因此默认放行，给一条兜底的
  if (items.length === 0 && review.status === "needs_confirmation") items.push({ key: "fallback", text: t("protocol.workflow.confirm.fallback") });
  // 58 号票：真实路径在工作目录之外的步骤（写的是 sub，sub 实际指到别处），授权前逐条勾
  for (const step of steps) {
    for (const o of step.outside ?? []) {
      items.push({ key: `o:${step.id}:${o.arg}:${o.path}`, text: t("protocol.workflow.confirm.outside", { step: step.id, title: step.title, arg: o.arg, path: o.path, real: o.realPath }) });
    }
  }
  return items;
}
