// 定时作业的一次运行里维护者的工具名（系统提示、交给它的通知、固定上下文、测试里引用；工具定义在 tools.ts）
export const JOB_TOOL = {
  /** 这次运行做不了：说明原因，这次运行记为失败（不调用它、这一轮正常结束就算成功） */
  failRun: "fail_job_run",
} as const;
