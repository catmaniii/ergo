// 触发底座的说法（19 号票的定时作业；76 号票起是定时触发的任务的每一次运行）：交给 agent 的一次运行的内容（触发的一批、要做的事、
// 前几次运行的结果）、系统提示和工具说明里的那几句、待我处理里的"定时触发的任务被自动暂停"、运行没做成的原因、拒绝用户动作的说法、
// 审批卡上的来源、迁移出来的任务的说明。工具名、次数一律插值；编排（jobs.ts）里不写文字。"做不了就报告失败"这句只在 failRunHint 里。
// 77 号票：事件触发的任务每次运行交给 agent 的内容里多一段这一批事件的结构化输入（JSON，键是事件字段的中文名，和流程步骤里的占位一样），
// 流程照的是代入了事件的值的步骤（一批里几个事件各走一遍）。
import {
  describeTime,
  eventRecord,
  jobTriggerKind,
  jobTriggerLine,
  grantText,
  isLegacyJob,
  type JobRun,
  JOB_RUN_STATE_LABEL,
  type Project,
  type ScheduledJob,
  SCHEDULED_JOB_STATE_LABEL,
  type Task,
  TASK_KIND_LABEL,
  taskKind,
  runEvents,
  temporalRuleText,
  type TurnEndEventPayload,
  type WorkflowPlan,
  type WorkflowStepView,
  TIME_TRIGGER_SOURCE,
} from "@ergou/protocol";
import { stepConditionLines, workflowPlanText } from "../tasks/workflow-plan.ts";
import { oneLine } from "../util/text.ts";
import { WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import { JOB_TOOL } from "./tool-names.ts";

/** 做不了时怎么办（交给 agent 的每次运行里、系统提示里都用这一句） */
export const failRunHint = (failureLimit: number) =>
  `做不了（缺数据、外部服务不通、做到一半出了错）就用 ${JOB_TOOL.failRun} 写明原因，这次记为失败；连续失败 ${failureLimit} 次会自动暂停，等用户处理。不要为了显得成功编造结果。`;

/** 这次运行是怎么触发的：一次就是那一句；排队合并了几次的列出这一批 */
function whenText(run: JobRun): string {
  const events = runEvents(run);
  if (events.length === 1) return events[0]!.summary;
  return [`这一批触发（上一次还没跑完时又来的，合成一批交给这一次运行，先后照来的顺序）：`, ...events.map((e) => `- ${e.summary}`)].join("\n");
}

/**
 * 事件触发的这一批事件的结构化输入（77 号票）：每个事件一项——来源、事件、时间，加上事件带的每个字段（键是字段的中文名，
 * 流程步骤参数里的 {{事件.字段名}} 就是它们）。时间到了的不算
 */
function eventsBlock(run: JobRun): string[] {
  const events = runEvents(run).filter((e) => e.source !== TIME_TRIGGER_SOURCE);
  if (events.length === 0) return [];
  return [`这一批事件的内容（结构化，${events.length} 个，先后照来的顺序）：`, "```json", JSON.stringify(events.map(eventRecord), null, 2), "```"];
}

/** 运行号里的第几次（j-3-r5 是第 5 次） */
export function runNumber(run: Pick<JobRun, "runId">): number | undefined {
  const m = /-r(\d+)$/.exec(run.runId);
  return m ? Number(m[1]) : undefined;
}

/** "第 5 次运行" */
export const runLabel = (run: Pick<JobRun, "runId">) => {
  const n = runNumber(run);
  return n === undefined ? `运行 ${run.runId}` : `第 ${n} 次运行`;
};

/** 一次运行最后说的话记多长（交给后面的运行时的"一两句"） */
export const RUN_SUMMARY_MAX = 200;

/**
 * 前几次运行的结果（后面的运行知道前几次的情况，76 号票）：结局、原因、最后说的那一两句。不属于项目的各次运行接着同一段会话，
 * 细节在会话的前面；属于项目的每次运行是一张新工单、新会话，前几次的情况只有这里写的
 */
function previousLines(previous: readonly JobRun[], sameSession: boolean): string[] {
  if (previous.length === 0) return ["这是第一次运行。"];
  return [
    sameSession ? "前几次运行的结果（做了什么在这一段会话的前面）：" : "前几次运行的结果（每次运行是一张新工单，前几次做了什么不在这一段会话里，只有下面这些）：",
    ...previous.map(previousLine),
  ];
}

/** 前几次里的一次："- 第 1 次运行（10 月 8 日（周四）09:00）：成功——最后说的：……"；失败的先写原因 */
function previousLine(r: JobRun): string {
  const said = r.summary ? `${r.reason ? "；" : "——"}最后说的：${oneLine(r.summary, RUN_SUMMARY_MAX)}` : "";
  return `- ${runLabel(r)}（${describeTime(new Date(r.dueAt))}）：${JOB_RUN_STATE_LABEL[r.state]}${r.reason ? `——${oneLine(r.reason, 200)}` : ""}${said}`;
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

/** 事件触发的流程：通用 bash 命令里的 ${ERGOU_EVENT_…} 是怎么回事（交给 agent 的那条通知里写） */
export const EVENT_SHELL_VARS_NOTE =
  "通用 bash 的命令里写的 ${ERGOU_EVENT_<第几个事件>_<字段>} 是这次事件的值，已经放进 bash 的环境变量：照步骤原样写命令（连同引号），不要换成值本身。";

/** 一批事件太多、分成几次运行（77 号票：一次运行最多照 maxRunSteps 步）：日志 */
export const batchSplitLog = (jobId: string, runId: string, perRun: number) => `${jobId} 排着的那一次已经有 ${perRun} 个事件（一次运行最多照这么多个），这次的事件另起一次（${runId}）排着`;

/** 一次运行要的上下文：哪份触发登记、哪一次、属于哪个任务、流程授权的那份计划、前几次的结果 */
export interface RunContext {
  job: ScheduledJob;
  run: JobRun;
  failureLimit: number;
  /** 属于哪个定时触发的任务（还没迁移的定时作业没有） */
  task?: Task | undefined;
  /** 定时触发的流程：用户授权的那份计划（每次运行照它的步骤做，守卫逐步核对） */
  workflow?: WorkflowPlan | undefined;
  /** 流程这次运行照的步骤（77 号票：事件触发的是一批里每个事件各一遍、代入了事件的值的；不给是授权的那份计划的步骤） */
  steps?: readonly WorkflowStepView[] | undefined;
  /** 这个任务前几次结束了的运行（先跑的在前，最多几次） */
  previous: readonly JobRun[];
}

/** 各次运行接着同一段会话吗：不属于项目的是（任务自己的 agent）；属于项目的每次运行是一张新工单、新会话 */
const sameSession = (job: ScheduledJob) => job.projectId === undefined;

/** 这个任务怎么称呼："定时触发的普通任务 t-5「每天早上出简报」"、"事件触发的流程 t-6「…」"；还没迁移的定时作业是"定时作业 j-1「…」" */
function ownerName(job: ScheduledJob, task: Task | undefined): string {
  if (!task) return `定时作业 ${job.id}「${job.title}」`;
  return `${jobTriggerKind(job)}的${TASK_KIND_LABEL[taskKind(task)]} ${task.id}「${task.title}」`;
}

/**
 * 一次运行的内容（属于项目的：工单的内容；不属于项目的：交给任务自己的 agent 的通知）。开头写这是第几次、怎么触发的（排队合并的列出这一批），
 * 然后是要做的事：迁移来的定时作业照作业的定义和授权；普通任务是建它时交代的那段话；流程是授权的那份计划的步骤。最后是前几次运行的结果
 */
export function runInstructions(ctx: RunContext): string {
  const { job, run, task } = ctx;
  const head = `${ownerName(job, task)}的${runLabel(run)}（${run.runId}；${jobTriggerLine(job)}）。触发：${whenText(run)}`;
  const steps = ctx.steps ?? ctx.workflow?.steps ?? [];
  const passes = job.event ? runEvents(run).filter((e) => e.source !== TIME_TRIGGER_SOURCE).length : 0;
  const body = ctx.workflow
    ? [
        `用户授权过计划 v${ctx.workflow.version}（授权一次，之后每次运行都照它）：这次从第一步做起按步骤做，守卫逐步核对，做过的步骤这次照样要做——`,
        ...(job.event
          ? [
              passes > 1
                ? `这一批有 ${passes} 个事件，每个事件各走一遍步骤（步骤编号后面的 .e1、.e2 是第几个事件），步骤里的参数已经代入了那个事件的值，照写的参数调用：`
                : "步骤里的参数已经代入了这次事件的值，照写的参数调用：",
              EVENT_SHELL_VARS_NOTE,
            ]
          : []),
        workflowPlanText({ steps }),
        ...workflowConditions({ steps }),
      ]
    : !task || isLegacyJob(job)
      ? [`每次要做的事：${job.each}`, ...authorizationLines(job)]
      : ["要做的事——", task.summary.trim()];
  const success = ctx.workflow
    ? `步骤都做完（或用 ${WORKFLOW_TOOL.reportStep} 说明跳过）这次运行才算成功，还有步骤没做就收工记为失败；最后用一两句话说这次做成了什么`
    : "做完这一轮就算这次运行成功（最后用一两句话说这次做成了什么）";
  return [head, ...eventsBlock(run), ...body, ...previousLines(ctx.previous, sameSession(job)), `${success}；${failRunHint(ctx.failureLimit)}`].join("\n");
}

/** 流程每一步要满足的条件（没有条件的步骤不列） */
function workflowConditions(plan: { steps: readonly Pick<WorkflowStepView, "id" | "conditions">[] }): string[] {
  const lines = plan.steps.flatMap((s) => stepConditionLines(s).map((c) => `- ${s.id}：${c}`));
  return lines.length === 0 ? [] : ["每一步要满足的条件（守卫照样检查）：", ...lines];
}

/** 定时触发的流程一轮要收工时还有步骤没做（照 59 号票的收尾提醒，每次运行只提醒一次）：交给 agent 的话 */
export function runPendingNudge(titles: readonly string[]): string {
  return `【计划检查】这次运行里，授权的计划还有 ${titles.join("、")} 既没有执行，也没有报告跳过。请接着按计划做完；确实不需要做的，用 ${WORKFLOW_TOOL.reportStep} 标记 skipped，并在 gist 里说明原因。还有步骤没做完、也没说明跳过就收工，这次运行记为失败。`;
}

/** 定时触发的流程这次运行收工时还有步骤既没做完也没说明跳过（照 59 号票的口径不算做完）：这次运行失败的原因 */
export function runStepsLeftReason(titles: readonly string[]): string {
  return `还有 ${titles.length} 步没做：${titles.join("、")}`;
}

/** 一次运行开始时会话里的分段线上写的："第 3 次运行 · 10-08 09:00 到点"（合并了几次的写"合并了 N 次触发"） */
export function runDividerTitle(run: JobRun): string {
  const events = runEvents(run);
  return `${runLabel(run)} · ${events.length === 1 ? events[0]!.summary : `合并了 ${events.length} 次触发`}`;
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

/** 排着的运行被丢掉：暂停、取消了 */
export const droppedReason = (job: Pick<ScheduledJob, "state">) => `${SCHEDULED_JOB_STATE_LABEL[job.state]}，排着的这次不再运行`;
/** 所属的项目删掉了 */
export const PROJECT_GONE_REASON = "所属的项目已经删除了";
/** 运行的工单没做完就结束了（退回、做不了，又没写原因） */
export const WORK_ORDER_NOT_DONE = "这次运行的工单没有完成";

/** 连续失败到了次数、自动暂停：待我处理里的"定时触发的任务被自动暂停" */
export function autoPausedNotice(job: ScheduledJob, failures: readonly JobRun[]): { title: string; body: string } {
  const lines = failures.map((r) => `- ${describeTime(new Date(r.dueAt))}：${r.reason ?? "失败"}`);
  return {
    title: `定时触发的任务「${job.title}」已自动暂停`,
    body: [`连续失败 ${failures.length} 次，到点不再运行，等你处理：`, ...lines, "查明原因后点“恢复”接着按时间表运行；也可以先保持暂停。"].join("\n"),
  };
}

/** 审批卡、"交给我做"事项、待我处理事项上的来源（事件触发的写"事件触发"） */
export const jobSource = (job: Pick<ScheduledJob, "title" | "projectName" | "event">) => {
  const how = jobTriggerKind(job);
  return job.projectName ? `项目「${job.projectName}」· ${how}「${job.title}」` : `${how}「${job.title}」`;
};

/** 用户的动作被拒的说法 */
export const refusal = {
  notFound: (jobId: string) => `没有这个定时触发的任务（${jobId}）`,
  noTrigger: (taskId: string) => `任务 ${taskId} 不是定时触发的任务（或者还没登记好）`,
  notNow: (job: ScheduledJob, action: string) => `定时触发的任务「${job.title}」现在${SCHEDULED_JOB_STATE_LABEL[job.state]}，不能${action}`,
  projectRetired: (job: ScheduledJob) => `项目「${job.projectName ?? job.projectId}」已停用：先在项目页上重新启用项目，它的定时触发的任务会一起恢复`,
  projectArchived: (job: ScheduledJob) => `项目「${job.projectName ?? job.projectId}」已归档：先取消归档，它的定时触发的任务会一起恢复`,
  noRun: "现在没有在运行的一次运行：只有在做定时触发的任务的一次运行时才能用",
  notWorkflowRun: "这次运行不是定时触发的流程的运行，没有步骤可报",
  noStep: (stepId: string) => `授权的计划里没有步骤 ${stepId}`,
  /** fire 收到同一个幂等键的又一次 */
  alreadyFired: "这次触发已经收过了",
  /** 暂停着、取消了的不运行 */
  notRunning: (job: ScheduledJob) => refusal.notNow(job, "运行"),
  /** 改时间（98 号票）：事件触发的没有时间表 */
  noSchedule: (job: ScheduledJob) => `「${job.title}」是事件触发的，没有时间表，改不了时间：要按时间做，取消了在发起任务里选"定时"另建`,
  /** 改成某个时间做一次（98 号票）：那个时间已经过了 */
  oncePassed: (at: string) => `定的时间 ${describeTime(new Date(at))} 已经过了：定一个将来的时间`,
  /** 改成某个时间做一次（98 号票）：时间写得认不出 */
  badTime: (at: string) => `时间写得不对：${at}`,
};

/** 定时触发的流程每次运行里不能改步骤（照 59 号票）：交回 agent 的话 */
export const RUN_NO_PLAN_CHANGE_TEXT = `每次运行都照用户授权的那份计划做，运行里不能改步骤。计划需要变化（新增操作、预期之外的情况）时，用 ${JOB_TOOL.failRun} 写明原因（这次记为失败，用户看得到），由用户决定要不要重新发起；先接着做计划里还能做的步骤。`;

/** 迁移出来的普通任务的说明（任务的 summary：每次要做的事，连同它从哪来） */
export const migratedSummary = (job: ScheduledJob) => `${job.each}\n（76 号票之前长程任务「${job.taskTitle}」的计划里定的定时作业 ${job.id}，迁移成定时触发的普通任务；每次运行的授权照旧）`;

/** 升级前交、升级后才确认的计划里的定时作业，确认时建成的普通任务的说明（每次要做的事，连同它从哪来） */
export const legacyPlanJobSummary = (job: ScheduledJob) =>
  `${job.each}\n（长程任务「${job.taskTitle}」在 76 号票之前交的计划里定的定时作业 ${job.id}，确认计划时改成定时触发的普通任务；每次运行的授权照计划卡上的）`;

/** 确认这样的计划时卡上的说明 */
export const legacyPlanJobsNote = (titles: readonly string[]) => `计划里的定时作业已改成定时任务${titles.map((t) => `「${t}」`).join("、")}`;

/** 某个时间做一次的任务：守护进程停着时错过了那个时间，开机补做一次（会话里给人看的那句） */
export const onceMissedNote = (at: string) => `原定 ${describeTime(new Date(at))} 做：那时守护进程没在运行，开机后补做一次`;

/** 项目停用、归档了：恢复被拒的说法（没有挡着的是 undefined） */
export function projectBlocksResume(job: ScheduledJob, project: Pick<Project, "state"> | undefined): string | undefined {
  if (project?.state === "retired") return refusal.projectRetired(job);
  if (project?.state === "archived") return refusal.projectArchived(job);
  return undefined;
}
