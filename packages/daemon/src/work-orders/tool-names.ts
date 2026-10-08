// 项目维护者在工单和会话分段上的工具名（系统提示、固定上下文、催写回的通知、测试里引用；工具定义在 tools.ts）
export const WORK_ORDER_TOOL = {
  /** 写（或改）这一段的摘要：下一段固定上下文里的"上一段摘要" */
  writeSegmentSummary: "write_segment_summary",
  /** 起草计划的工单段里写回进展（这一段工作目录和项目档案只读，进展文档只能经它写回） */
  writeProgress: "write_progress",
  /**
   * 干活中遇到要问派单方的：工单转等澄清。用户发起的单项目任务，问题以提问卡进待我处理（16 号票）；
   * 任务维护者派的工单，问题交给任务维护者（17 号票）
   */
  askClarification: "ask_clarification",
  /** 项目维护者做完（或退回、做不了）任务维护者派来的工单：交回执（17 号票，退回、做不了必须写理由） */
  submitReceipt: "submit_receipt",
} as const;

/**
 * 涉及多个项目的任务的维护者的工具（17 号票，工具定义在 multi-project-tools.ts）。固定工具包（规格第 11 节）是读项目档案
 * （用秘书那个工具的名字，projects/tool-names.ts）、派工单、汇总回执三样；回答项目维护者的提问算"派工单"那一样的工单往来；
 * 答不了转问用户是运行时控制（和 16 号票里维护者问用户同一条路），不进工具包
 */
export const MULTI_PROJECT_TOOL = {
  /** 派工单：执行中给某个项目派一张工单（计划里这个阶段有这个项目的一行的直接派出，没有的是计划外的，要用户确认） */
  dispatchWorkOrder: "dispatch_work_order",
  /** 汇总回执：这个任务的工单（按阶段）现在怎样、各自的回执 */
  summarizeReceipts: "summarize_receipts",
  /** 回答项目维护者在工单里问的（工单回到进行中） */
  answerWorkOrder: "answer_work_order",
  /** 项目维护者在工单里问的答不了：指明工单转问用户（提问卡进待我处理，用户回答后交回任务维护者） */
  forwardToUser: "forward_to_user",
} as const;
