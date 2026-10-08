// 项目维护者在工单和会话分段上的工具名（系统提示、固定上下文、催写回的通知、测试里引用；工具定义在 tools.ts）
export const WORK_ORDER_TOOL = {
  /** 写（或改）这一段的摘要：下一段固定上下文里的"上一段摘要" */
  writeSegmentSummary: "write_segment_summary",
  /** 起草计划的工单段里写回进展（这一段工作目录和项目档案只读，进展文档只能经它写回） */
  writeProgress: "write_progress",
  /** 干活中遇到要问派单方的：工单转等澄清，问题以提问卡进待我处理 */
  askClarification: "ask_clarification",
} as const;
