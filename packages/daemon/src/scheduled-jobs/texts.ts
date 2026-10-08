// 定时作业的说法（19 号票）：交给维护者的一次运行的内容、作业维护者的系统提示和工具说明里的那几句、待我处理里的
// "定时作业被自动暂停"、运行没做成的原因、拒绝用户动作的说法、计划检查的问题、审批卡上的来源。
// 工具名、次数一律插值；编排（jobs.ts）里不写文字。"做不了就报告失败"这句只在 failRunHint 里。
import {
  describeSchedule,
  describeTime,
  grantText,
  type JobRun,
  type Project,
  type ScheduledJob,
  SCHEDULED_JOB_STATE_LABEL,
  temporalRuleText,
  type TurnEndEventPayload,
} from "@ergou/protocol";
import { JOB_TOOL } from "./tool-names.ts";

/** 做不了时怎么办（交给维护者的每次运行里、作业维护者的系统提示里都用这一句） */
export const failRunHint = (failureLimit: number) =>
  `做不了（缺数据、外部服务不通、做到一半出了错）就用 ${JOB_TOOL.failRun} 写明原因，这次记为失败；连续失败 ${failureLimit} 次作业自动暂停，等用户处理。不要为了显得成功编造结果。`;

/** 这次运行是什么时候的、怎么触发的 */
function whenText(run: JobRun): string {
  const due = describeTime(new Date(run.dueAt));
  if (run.trigger !== "catch_up") return `${due} 到点`;
  return `守护进程停机期间错过了${run.missed !== undefined && run.missed > 1 ? ` ${run.missed} 次（最近一次 ${due}）` : ` ${due} 那次`}，开机补跑一次`;
}

/** 这次运行能做什么：作业的授权项（作业在就一直有效）和时序规则；超出的照常先问用户 */
function authorizationLines(job: ScheduledJob): string[] {
  const grants = job.grants.map((g) => `- ${g.title}：${grantText(g, job.grantInfo[g.id], "job")}`);
  const rules = job.temporalRules.map((r) => `- ${temporalRuleText(r)}`);
  return [
    grants.length > 0 ? `这次运行预先授权的操作（超出的照常先问用户）：\n${grants.join("\n")}` : "这个作业没有预先授权的操作：要做落在关注类别里的事都会先问用户。",
    ...(rules.length > 0 ? [`每次运行都要守的规则：\n${rules.join("\n")}`] : []),
  ];
}

/** 一次运行的内容（属于项目的作业：工单的内容；作业自己的维护者：交给它的通知） */
export function runInstructions(job: ScheduledJob, run: JobRun, failureLimit: number): string {
  return [
    `定时作业 ${job.id}「${job.title}」的一次运行（${run.runId}，${whenText(run)}；时间表：${describeSchedule(job.schedule)}）。`,
    `每次要做的事：${job.each}`,
    ...authorizationLines(job),
    `做完这一轮就算这次运行成功；${failRunHint(failureLimit)}`,
  ].join("\n");
}

/** 这一轮怎么结束的 → 没做成的原因（成功、被打断的是 undefined：被打断另记中断） */
export function turnFailure(turn: Pick<TurnEndEventPayload, "outcome" | "error">): string | undefined {
  switch (turn.outcome) {
    case "completed":
    case "interrupted":
      return undefined;
    case "error":
      return `维护者这一轮出错了：${turn.error ?? "没有说明"}`;
    case "aborted":
      return "这一轮被中止了";
  }
}

/** 停机打断的那次：记为中断，不重做、不算进连续失败 */
export const INTERRUPTED_REASON = "这次运行做到一半被打断了（守护进程重启，或维护者的子进程意外退出），不重做";

/** 这一轮里有一步没做成（运行没做成，记失败） */
export const blockedReason = {
  /** 先问用户的调用等不到批准，被拦下（审批卡还在待我处理里） */
  approval: (toolTitle: string, argsSummary: string) => `「${toolTitle}」（${argsSummary}）要用户批准，等不到被拦下了，这次没做成`,
  /** 守卫判定"交给我做"：这一步要用户亲手做 */
  handOver: (toolTitle: string) => `「${toolTitle}」要用户亲手做（交给我做），这次没做成`,
};

/** 排着的运行被丢掉：作业暂停、取消了 */
export const droppedReason = (job: Pick<ScheduledJob, "state">) => `作业${SCHEDULED_JOB_STATE_LABEL[job.state]}，排着的这次不再运行`;
/** 作业所属的项目删掉了 */
export const PROJECT_GONE_REASON = "作业所属的项目已经删除了";
/** 运行的工单没做完就结束了（退回、做不了，又没写原因） */
export const WORK_ORDER_NOT_DONE = "这次运行的工单没有完成";

/** 连续失败到了次数、自动暂停：待我处理里的"定时作业被自动暂停" */
export function autoPausedNotice(job: ScheduledJob, failures: readonly JobRun[]): { title: string; body: string } {
  const lines = failures.map((r) => `- ${describeTime(new Date(r.dueAt))}：${r.reason ?? "失败"}`);
  return {
    title: `定时作业「${job.title}」已自动暂停`,
    body: [`连续失败 ${failures.length} 次，到点不再运行，等你处理：`, ...lines, "查明原因后点“恢复”接着按时间表运行；也可以先保持暂停。"].join("\n"),
  };
}

/** 作业的来源（审批卡、"交给我做"事项、待我处理事项上） */
export const jobSource = (job: Pick<ScheduledJob, "title" | "projectName">) => (job.projectName ? `项目「${job.projectName}」· 定时作业「${job.title}」` : `定时作业「${job.title}」`);

/** 用户的动作被拒的说法 */
export const refusal = {
  notFound: (jobId: string) => `没有定时作业 ${jobId}`,
  notNow: (job: ScheduledJob, action: string) => `定时作业「${job.title}」现在${SCHEDULED_JOB_STATE_LABEL[job.state]}，不能${action}`,
  projectRetired: (job: ScheduledJob) => `项目「${job.projectName ?? job.projectId}」已停用：先在项目页上重新启用项目，它的定时作业会一起恢复`,
  projectArchived: (job: ScheduledJob) => `项目「${job.projectName ?? job.projectId}」已归档：先取消归档，它的定时作业会一起恢复`,
  noRun: "现在没有在运行的定时作业：只有在做定时作业的一次运行时才能报告失败",
};

/** 项目停用、归档了：恢复被拒的说法（没有挡着的是 undefined） */
export function projectBlocksResume(job: ScheduledJob, project: Pick<Project, "state"> | undefined): string | undefined {
  if (project?.state === "retired") return refusal.projectRetired(job);
  if (project?.state === "archived") return refusal.projectArchived(job);
  return undefined;
}

/** 计划里的作业定义没通过检查的问题 */
export const planJobProblems = {
  notRepeating: (title: string) => `定时作业「${title}」的时间表要是重复的（每天、每周几、每月几号、按我的工作日）：一次性的事用简单提醒`,
  wrongProject: (title: string, named: string, own: string | undefined) =>
    own === undefined
      ? `定时作业「${title}」写了属于项目「${named}」：属于项目的作业要对那个项目单独发起任务来建（只涉及这一个项目的任务），这个任务不是，它的作业不属于项目（把 project 去掉）`
      : `定时作业「${title}」写了属于项目「${named}」：这是项目「${own}」的任务，它的作业都属于「${own}」（project 写「${own}」或不写）`,
};
