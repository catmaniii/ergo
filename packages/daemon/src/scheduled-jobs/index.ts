// 触发底座（ADR 0025；原来叫定时作业，目录名照旧）：对外的唯一入口，别处只从这里取东西。
// 日历要的查询：ScheduledJobs.calendar（时间表展开、这段时间的运行记录、登记的状态和暂停原因），视图的 runsOfJob；
// 时间表展开本身是协议包的 occurrencesBetween（和简单提醒同一套时间规则）。
// - jobs.ts：登记、迁移、触发（fire：时间到了也是一种事件，事件来源接在同一个口子上）、排队合并、名额、运行和结局、
//   失败和自动暂停、用户的动作、项目停用归档、启动时补跑、每次运行的授权（createScheduledJobs）；
// - maintainers.ts：作业自己的负责人（以前登记的、不属于项目的定时作业，jm-<n>；迁移成普通任务后照旧由它做）的会话；
// - tools.ts：执行它的 agent 报告这次运行失败的工具；system-prompt.ts：作业负责人的系统提示；
// - views.ts：派生视图 scheduled_jobs、job_runs；texts.ts：说法；keys.ts：幂等键；thresholds.ts：默认值；
// - purge.ts：删项目、删任务时属于它的定时作业（触发登记）换掉文字（"删除参与方"登记表）。
// 每周的归档清单是任务模块的内部作业，在 tasks/archive-list.ts。
export { createScheduledJobs, type FireOutcome, isJobMaintainerId, type JobCalendarEntry, jobMaintainerId, runPlanId, type ScheduledJobs } from "./jobs.ts";
export { createJobMaintainers, type JobMaintainers } from "./maintainers.ts";
export { registerJobDeletion } from "./purge.ts";
export { jobMaintainerSystemPrompt } from "./system-prompt.ts";
export { DEFAULT_SCHEDULED_JOB_THRESHOLDS, type ScheduledJobThresholds } from "./thresholds.ts";
export { countRunningOwnRuns, getJob, jobOfTask, listJobs, runsIn, runsOfJob, scheduledJobsView } from "./views.ts";
export { runLabel, runNumber } from "./texts.ts";
