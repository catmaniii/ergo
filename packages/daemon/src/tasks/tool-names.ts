// 任务执行相关的工具名（维护者的系统提示、重注入块、交给维护者的通知、测试里引用；工具定义在 execution-tools.ts、review.ts、sub-agents/tools.ts）
/** 维护者执行任务时的工具（守护进程代为执行）：给模型看的文字一律插值它们 */
export const EXECUTION_TOOL = {
  startStage: "start_stage",
  completeStage: "complete_stage",
  reportProgress: "report_progress",
  waitForUser: "wait_for_user",
  failTask: "fail_task",
  /** 14 号票：提交计划变更（扩大授权、加能力、加项目、改目标或验收），出计划变更卡 */
  proposePlanChange: "propose_plan_change",
  /** 14 号票：自行调整计划（拆阶段、调顺序这类不扩大授权的），直接生效 */
  revisePlan: "revise_plan",
  /** 14 号票：把几个阶段标成做不了（计划变更被拒、在现有授权内也重排不了时） */
  markInfeasible: "mark_infeasible",
} as const;

/** 维护者执行任务时提议派子 agent 并行的工具（20 号票，定义在 sub-agents/tools.ts） */
export const PROPOSE_PARALLEL_TOOL = "propose_parallel";

/** 评审子 agent 交出结论的工具 */
export const SUBMIT_REVIEW_TOOL = "submit_review";

/**
 * 流程的维护者的工具（58 号票，照搬 AgentSense runtime.ts 的固定计划工具，定义在 workflow-tools.ts）：
 * 起草时提交（或重新提交）完整计划，执行时汇报某一步的状态
 */
export const WORKFLOW_TOOL = {
  proposePlan: "propose_plan",
  reportStep: "report_step",
} as const;

/**
 * 发起任务和澄清的工具（秘书的，58 号票；项目的维护者在自己项目里发起内部任务的同名，64 号票；定义在 secretary-tools.ts、
 * internal-tools.ts，发起的两个共用 launch-tools.ts）
 */
export const TASK_TOOL = {
  /** 58 号票：用户点明了要发起流程 */
  startWorkflow: "start_workflow",
  /** 用户点明了要发起长程任务（只说"发起任务"没说种类的也是它） */
  createTask: "create_task",
  suggestTask: "suggest_task",
  askQuestions: "ask_questions",
  writeTaskBrief: "write_task_brief",
  /** 75 号票：秘书自己把用户交代的一件事交给后台，建成普通任务（不必等用户点明） */
  delegateTask: "delegate_task",
} as const;
