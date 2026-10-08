// 定时作业（19 号票）：对外的唯一入口，别处只从这里取东西。
// 日历（35 号票）要的查询：ScheduledJobs.calendar（时间表展开、这段时间的运行记录、作业的状态和暂停原因），视图的 runsOfJob；
// 时间表展开本身是协议包的 occurrencesBetween（和简单提醒同一套时间规则）。
// - jobs.ts：登记、到点、名额、运行和结局、失败和自动暂停、用户的动作、项目停用归档、启动时补跑、作业的授权（createScheduledJobs）；
// - maintainers.ts：作业自己的维护者（不属于项目的作业，jm-<n>）的会话；
// - tools.ts：维护者报告这次运行失败的工具；plan.ts：提交计划时检查作业定义；system-prompt.ts：作业维护者的系统提示；
// - views.ts：派生视图 scheduled_jobs、job_runs；texts.ts：说法；keys.ts：幂等键；thresholds.ts：默认值。
// 每周的归档清单是任务模块的内部作业，在 tasks/archive-list.ts。
export { createScheduledJobs, type JobCalendarEntry, jobMaintainerId, type ScheduledJobs } from "./jobs.ts";
export { createJobMaintainers, type JobMaintainers } from "./maintainers.ts";
export { checkPlanJobs, jobProjectOf } from "./plan.ts";
export { jobMaintainerSystemPrompt, PROJECT_JOB_RUN_GUIDE } from "./system-prompt.ts";
export { DEFAULT_SCHEDULED_JOB_THRESHOLDS, type ScheduledJobThresholds } from "./thresholds.ts";
export { countRunningOwnRuns, getJob, listJobs, runsIn, runsOfJob, scheduledJobsView } from "./views.ts";
