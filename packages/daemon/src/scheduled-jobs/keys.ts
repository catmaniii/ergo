// 触发底座的事件的幂等键（19 号票的定时作业起；76 号票加了登记、迁移、合并、分段线、收尾提醒）：同一件事只做一次
// （重启后补登记、补跑、重复的动作都靠它），键的写法只在这里。
export const jobKeys = {
  /** 定时触发的任务登记好了（运营中）：登记它的触发（一个任务只登记一次） */
  registerTask: (taskId: string) => `job-register-task:${taskId}`,
  /** 76 号票之前的定时作业迁移成定时触发的普通任务（建出任务的 task 事件） */
  migrate: (jobId: string) => `job-migrate:${jobId}`,
  /** 同一事务里把触发登记指向迁移出来的任务（scheduled_job 的 migrated） */
  migrateLink: (jobId: string) => `job-migrate:${jobId}#job`,
  /**
   * 升级前交了、升级后才确认的长程任务计划里的第 i 个定时作业（76 号票之后确认时照迁移的办法建成定时触发的普通任务）：
   * 建出任务的 task 事件；登记的 scheduled_job 在后面加 #job
   */
  legacyPlanJob: (planId: string, index: number) => `job-legacy-plan:${planId}:${index}`,
  legacyPlanJobLink: (planId: string, index: number) => `job-legacy-plan:${planId}:${index}#job`,
  /** 一次到点（due 是时间表上的那一刻）：一次运行进队列（或并进排着的那一次），下一次往后算 */
  trigger: (jobId: string, due: string) => `job-trigger:${jobId}:${due}`,
  /**
   * 事件来源经 fire 推来的一次触发，调用方没给幂等键时：每个事件各自一个（eventId 每次新取），排队合并期间来的几次不会撞成一次
   */
  fire: (jobId: string, eventId: string) => `job-fire:${jobId}:${eventId}`,
  /** 排队合并时，属于项目的、工单还排着的：工单的内容换成合并后的这一批（key 是这次触发的幂等键） */
  mergedWorkOrder: (key: string) => `${key}#wo`,
  /** 一次运行开始 */
  runStart: (runId: string) => `job-run-start:${runId}`,
  /** 一次运行结束（成功、失败、中断，或者排着时被丢掉） */
  runEnd: (runId: string) => `job-run-end:${runId}`,
  /** 交给执行它的 agent 的那条通知 */
  runNotice: (runId: string) => `job-run:${runId}`,
  /** 会话里这次运行的分段线（任务详情按运行分段） */
  runDivider: (runId: string) => `job-run-divider:${runId}`,
  /** 定时触发的流程：这次运行收工前还有步骤没做，提醒一次 */
  runNudge: (runId: string) => `job-run-nudge:${runId}`,
  /** 某个时间做一次的任务到点了：从等时间进排队（一个任务只一次；停机错过的开机补的也是这一次） */
  onceDue: (taskId: string) => `task-once-due:${taskId}`,
  /** 停机错过了那个时间、开机补做时，会话里记的那一句 */
  onceMissedNote: (taskId: string) => `task-once-due:${taskId}#note`,
  /** 属于项目的：这次运行的工单 */
  runWorkOrder: (runId: string) => `job-run-wo:${runId}`,
} as const;
