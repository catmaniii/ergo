// 删除项目时它的内部任务一起删掉（64 号票，projects/deletion.ts）：内部任务的计划里定的定时作业（76 号票起是定时触发的内部任务的
// 触发登记），看板频道上它的每条事件里的文字
// 换成删除标记——作业名、每次做什么、建它的任务名、授权项和时序规则给人看的那句、运行失败的原因；编号、时间表、状态、归属、
// 授权的结构原样（作业的行留着：新作业的编号按行数接着往下排）。
import { type JobRun, PURGED_TEXT, type ScheduledJob, type ScheduledJobEventPayload } from "@ergou/protocol";

/**
 * 一次运行改写后的样子：原因；76 号票起还有最后说的那一两句、这一批触发里给人看的说明和事件里的值（77 号票的事件可能带着文件名之类）、
 * 定时触发的流程各步的标题和要点
 */
const purgedRun = (run: JobRun): JobRun => ({
  ...run,
  ...(run.reason === undefined ? {} : { reason: PURGED_TEXT }),
  ...(run.summary === undefined ? {} : { summary: PURGED_TEXT }),
  ...(run.events === undefined ? {} : { events: run.events.map(({ data: _d, ...e }) => ({ ...e, summary: PURGED_TEXT })) }),
  ...(run.steps === undefined ? {} : { steps: run.steps.map(({ gist, ...s }) => ({ ...s, title: PURGED_TEXT, ...(gist === undefined ? {} : { gist: PURGED_TEXT }) })) }),
});

function purgedJob(job: ScheduledJob): ScheduledJob {
  return {
    ...job,
    title: PURGED_TEXT,
    each: PURGED_TEXT,
    taskTitle: PURGED_TEXT,
    grants: job.grants.map((g) => ({ ...g, title: PURGED_TEXT })),
    temporalRules: job.temporalRules.map((r) => (r.title === undefined ? r : { ...r, title: PURGED_TEXT })),
    ...(job.lastRun ? { lastRun: purgedRun(job.lastRun) } : {}),
  };
}

/** 一条定时作业事件改写之后的负载 */
export function purgedJobPayload(payload: ScheduledJobEventPayload): ScheduledJobEventPayload {
  return { ...payload, job: purgedJob(payload.job), ...(payload.run ? { run: purgedRun(payload.run) } : {}) };
}
