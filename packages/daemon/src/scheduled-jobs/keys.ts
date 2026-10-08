// 定时作业的事件的幂等键（19 号票）：同一件事只做一次（重启后补登记、补跑、重复的动作都靠它），键的写法只在这里。
export const jobKeys = {
  /** 计划确认后把第 index 个作业定义登记成作业 */
  register: (planId: string, index: number) => `job-register:${planId}:${index}`,
  /** 一次到点（due 是时间表上的那一刻）：一次运行进队列，下一次往后算 */
  trigger: (jobId: string, due: string) => `job-trigger:${jobId}:${due}`,
  /** 一次运行开始 */
  runStart: (runId: string) => `job-run-start:${runId}`,
  /** 一次运行结束（成功、失败、中断，或者排着时被丢掉） */
  runEnd: (runId: string) => `job-run-end:${runId}`,
  /** 交给作业自己的维护者的那条通知 */
  runNotice: (runId: string) => `job-run:${runId}`,
  /** 属于项目的作业：这次运行的工单 */
  runWorkOrder: (runId: string) => `job-run-wo:${runId}`,
} as const;
