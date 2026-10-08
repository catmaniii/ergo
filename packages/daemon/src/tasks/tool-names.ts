// 任务执行相关的工具名（维护者的系统提示、重注入块、交给维护者的通知、测试里引用；工具定义在 execution-tools.ts、review.ts、sub-agents/tools.ts）
/** 维护者执行任务时的工具（守护进程代为执行）：给模型看的文字一律插值它们 */
export const EXECUTION_TOOL = {
  startStage: "start_stage",
  completeStage: "complete_stage",
  reportProgress: "report_progress",
  waitForUser: "wait_for_user",
  failTask: "fail_task",
} as const;

/** 维护者执行任务时提议派子 agent 并行的工具（20 号票，定义在 sub-agents/tools.ts） */
export const PROPOSE_PARALLEL_TOOL = "propose_parallel";

/** 评审子 agent 交出结论的工具 */
export const SUBMIT_REVIEW_TOOL = "submit_review";
