// 任务里谁能做什么（规格第 8 节"谁能改"表）：只在这里定一次。守护进程按 TASK_TRANSITIONS 校验每次状态迁移
// （tasks/state-machine.ts），控制器（tasks/execution.ts）、维护者模块、Web 的任务详情都用 availableTaskActions
// 判断现在能做什么。只有常量和纯函数，不引用 TypeBox。
import {
  ENDED_TASK_STATES,
  isPlainTask,
  type TaskAction,
  type TaskActor,
  type TaskEndKind,
  type TaskKind,
  type TaskState,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskWaitReason,
  UNFINISHED_TASK_STATES,
  userDecidesWait,
} from "./tasks.ts";
import { t, tTable } from "./i18n/runtime.ts";
import type { ProjectInternal } from "./schema.ts";

/** 判断"现在能做什么"要看的任务的样子 */
export interface TaskActSubject {
  state: TaskState;
  waitReason?: TaskWaitReason | undefined;
  endKind?: TaskEndKind | undefined;
  /** 任务的种类（58 号票）：流程没有返工（执行中不能改步骤，要改就重新发起）；普通任务（75 号票）做完了还收用户的话 */
  kind?: TaskKind | undefined;
  /** 项目内部任务（64 号票）：判断能做什么时不看它（90 号票起结束了的全局任务、项目内部任务都能直接归档），留着给调用方原样传 */
  internal?: ProjectInternal | undefined;
  stages?: { list?: ReadonlyArray<{ state: string; waitReason?: TaskWaitReason | undefined }> | undefined } | undefined;
}

/**
 * 除了状态之外还要满足的：在等用户定夺（卡住求助、超预算、中断不确定，见 USER_DECIDES_WAIT_REASONS：用户点"继续"；
 * 会话里回话也算的只有卡住求助、中断不确定，见 RESUME_ON_REPLY_WAIT_REASONS；别的等我要先在待我处理里处理）、
 * 能返工、从某个阶段重做（长程任务、建好了阶段，不是转为项目结束的；流程也不行：58 号票，流程没有返工）、有在等用户验收的阶段、
 * 是普通任务（75 号票：做完了用户接着说话，它接着做）
 */
export type TaskActCondition = "user_decides" | "not_converted" | "stage_awaiting_user" | "plain";

/**
 * 跟着项目归档的任务状态（141 号票）：运营中（触发登记随之暂停）、等时间（计时器随之撤掉）和结束了的（已完成、失败、已取消）。
 * 进行中的（规划中、排队中、执行中、等我、已暂停……）不跟着走：项目还有在做、排队的工单时本来就不能归档，剩下的照旧留在原来的状态
 */
export const FOLLOWS_PROJECT_ARCHIVE_STATES = ["operating", "scheduled", "done", "failed", "cancelled"] as const satisfies readonly TaskState[];

/** 撤回维护者的会话能把任务带回规划中的状态（152 号票：排队中、执行中、等我、已暂停、待确认，以及已完成、失败） */
const ROLLBACK_PLANNING_FROM = ["awaiting_confirm", "queued", "running", "waiting_for_user", "paused", "done", "failed"] as const satisfies readonly TaskState[];

/** 撤回维护者的会话能把任务带回那时的结局（已完成、失败）的状态（152 号票：回到的那一处任务已经结束了） */
const ROLLBACK_ENDED_FROM = ["queued", "running", "waiting_for_user", "paused", "done", "failed"] as const satisfies readonly TaskState[];

/**
 * 撤回、切换维护者的会话能把任务带回排队中的状态（152 号票：回到计划确认之后、开始执行之前的那一处；151 号票切回执行时的那条分支，
 * 名额空出时接着执行）。等我、待确认、已完成、失败到排队中表里本来就有
 */
const ROLLBACK_QUEUED_FROM = ["planning", "running"] as const satisfies readonly TaskState[];

/**
 * 撤回流程的会话回到计划授权之前能把它带回待确认（重新等你授权）的状态（153 号票：那时在等你授权的那一版后来授权了，同样的计划
 * 作为新的一版重新放进待我处理）
 */
const ROLLBACK_REAUTHORIZE_FROM = ["queued", "running", "waiting_for_user", "paused", "done", "failed"] as const satisfies readonly TaskState[];

/** "谁能改"表里每一步叫什么（拒绝时说明用；跟着当前语言，172 号票） */
export const TASK_TRANSITION_ACTION_LABEL = tTable({
  submitPlan: "protocol.taskTransitions.submitPlan",
  confirmPlan: "protocol.taskTransitions.confirmPlan",
  rejectPlan: "protocol.taskTransitions.rejectPlan",
  authorizeScheduled: "protocol.taskTransitions.authorizeScheduled",
  authorizeOnce: "protocol.taskTransitions.authorizeOnce",
  due: "protocol.taskTransitions.due",
  doneOnceRun: "protocol.taskTransitions.doneOnceRun",
  start: "protocol.taskTransitions.start",
  toWaiting: "protocol.taskTransitions.toWaiting",
  carryOn: "protocol.taskTransitions.carryOn",
  requeue: "protocol.taskTransitions.requeue",
  pause: "protocol.taskTransitions.pause",
  resume: "protocol.taskTransitions.resume",
  resumeQueued: "protocol.taskTransitions.resumeQueued",
  done: "protocol.taskTransitions.done",
  doneAllAccepted: "protocol.taskTransitions.doneAllAccepted",
  fail: "protocol.taskTransitions.fail",
  retry: "protocol.taskTransitions.retry",
  retryQueued: "protocol.taskTransitions.retryQueued",
  redoStage: "protocol.taskTransitions.redoStage",
  redoStageQueued: "protocol.taskTransitions.redoStageQueued",
  cancelAfterFail: "protocol.taskTransitions.cancelAfterFail",
  rework: "protocol.taskTransitions.rework",
  reworkQueued: "protocol.taskTransitions.reworkQueued",
  rollbackToPlanning: "protocol.taskTransitions.rollbackToPlanning",
  rollbackToQueued: "protocol.taskTransitions.rollbackToQueued",
  rollbackReauthorize: "protocol.taskTransitions.rollbackReauthorize",
  rollbackToEnded: "protocol.taskTransitions.rollbackToEnded",
  archive: "protocol.taskTransitions.archive",
  archiveWithProject: "protocol.taskTransitions.archiveWithProject",
  unarchiveWithProject: "protocol.taskTransitions.unarchiveWithProject",
  cancel: "protocol.taskTransitions.cancel",
  convertToProject: "protocol.taskTransitions.convertToProject",
});
export type TaskTransitionAction = keyof typeof TASK_TRANSITION_ACTION_LABEL;

/** "谁能改"表的一行：从哪个状态到哪个状态、这一步叫什么、谁能做；act 是用户的哪个控制（task_action）走这一步 */
export interface TaskTransition {
  from: TaskState;
  to: TaskState;
  /** 这一步叫什么（拒绝时说明用，TASK_TRANSITION_ACTION_LABEL 取说法） */
  action: TaskTransitionAction;
  by: readonly TaskActor[];
  act?: TaskAction;
  /** act 能做还要满足的（只影响"现在能做什么"，迁移本身的校验只看状态和谁） */
  when?: TaskActCondition;
}

/**
 * "谁能改"表：
 * - 用户：发起任务、确认计划、暂停 / 继续、取消、批准、回答、验收、返工、归档、转为项目（以"已完成 · 已转为项目"结束）；
 * - 秘书：按用户的发起建任务卡（建卡不是迁移）、写任务书；用户要求时取消；
 * - 维护者：开始、报告进展、转为等我、完成、失败；起草计划的维护者提交计划；
 * - 系统：排队调度；卡住或超预算时转等我（14 号票：拉回超限、催促超限、验收第 3 次不过是卡住求助，预算超 2 倍是超预算），
 *   累计被拒太多次时暂停（pauseReason）；恢复执行而名额已满的回到排队中；全部阶段验收通过时自动完成（13 号票）。
 * 同一对状态之间可以有几行（执行中 → 已完成：维护者"完成"，用户"转为项目"），谁能做看全部这几行。
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  { from: "planning", to: "awaiting_confirm", action: "submitPlan", by: ["maintainer"] },
  { from: "awaiting_confirm", to: "queued", action: "confirmPlan", by: ["user"] },
  { from: "awaiting_confirm", to: "planning", action: "rejectPlan", by: ["user"] },
  // 76 号票：定时触发的流程在计划卡上授权一次，之后按时间表运行（运营中，每次运行按步骤核对），不进排队
  { from: "awaiting_confirm", to: "operating", action: "authorizeScheduled", by: ["user"] },
  // 76 号票：某个时间做一次的流程授权后等到那个时间；到点了（守护进程停着时错过的，开机补一次）进排队，之后和现在做一次的一样
  { from: "awaiting_confirm", to: "scheduled", action: "authorizeOnce", by: ["user"] },
  { from: "scheduled", to: "queued", action: "due", by: ["system"] },
  // 98 号票：运营中的定时任务改成了某个时间做一次，那一次运行做成了（没有下一次）——照"到点做一次、做完即完成"，系统把它算完成
  { from: "operating", to: "done", action: "doneOnceRun", by: ["system"] },
  { from: "queued", to: "running", action: "start", by: ["system", "maintainer"] },
  { from: "running", to: "waiting_for_user", action: "toWaiting", by: ["maintainer", "system"] },
  // 等我 → 执行中：一支不用再等了（系统）、用户验收、点"继续执行"（只对卡住求助、超预算——14 号票、中断不确定的有效）、
  // 在会话里回话（只对卡住求助、中断不确定：RESUME_ON_REPLY_WAIT_REASONS；超预算要点"追加预算继续"）
  { from: "waiting_for_user", to: "running", action: "carryOn", by: ["user", "system"], act: "resume", when: "user_decides" },
  { from: "waiting_for_user", to: "queued", action: "requeue", by: ["user", "system"], act: "resume", when: "user_decides" },
  { from: "running", to: "paused", action: "pause", by: ["user", "system"], act: "pause" },
  { from: "waiting_for_user", to: "paused", action: "pause", by: ["user", "system"], act: "pause" },
  // 累计被拒太多次（14 号票）：恢复执行时回到排队中的任务也可能被系统暂停
  { from: "queued", to: "paused", action: "pause", by: ["user", "system"], act: "pause" },
  { from: "paused", to: "running", action: "resume", by: ["user"], act: "resume" },
  { from: "paused", to: "queued", action: "resumeQueued", by: ["user", "system"], act: "resume" },
  // 13 号票：全部阶段验收通过后由控制器（系统）自动完成；最后一个阶段由用户验收时，验收前任务可能正在等我
  { from: "running", to: "done", action: "done", by: ["maintainer", "system"] },
  { from: "waiting_for_user", to: "done", action: "doneAllAccepted", by: ["system"] },
  { from: "running", to: "failed", action: "fail", by: ["maintainer"] },
  { from: "failed", to: "running", action: "retry", by: ["user"], act: "retry" },
  { from: "failed", to: "queued", action: "retryQueued", by: ["user", "system"], act: "retry" },
  // 84 号票（用户 2026-10-11 定：阶段开始过就能重开）：失败的从某个开始过的阶段重做，重新排队（有名额就接着执行）
  { from: "failed", to: "running", action: "redoStage", by: ["user"], act: "rework", when: "not_converted" },
  { from: "failed", to: "queued", action: "redoStageQueued", by: ["user", "system"], act: "rework", when: "not_converted" },
  // 失败后的抉择：不重试就取消（失败已经结束，所以单列一行）
  { from: "failed", to: "cancelled", action: "cancelAfterFail", by: ["user"], act: "cancel" },
  { from: "done", to: "running", action: "rework", by: ["user"], act: "rework", when: "not_converted" },
  { from: "done", to: "queued", action: "reworkQueued", by: ["user", "system"], act: "rework", when: "not_converted" },
  // 84 号票（阶段开始过就能重开）：等我的长程任务也能从某个开始过的阶段重做——这一阶段和下游回到未开始，
  // 卡着的审批、计划变更随之作废，有能推进的就接着执行（名额满了排队）；执行中、已暂停、排队中的不改状态，见 TASK_STAY_ACTS
  { from: "waiting_for_user", to: "running", action: "redoStage", by: ["user"], act: "rework", when: "not_converted" },
  { from: "waiting_for_user", to: "queued", action: "redoStageQueued", by: ["user", "system"], act: "rework", when: "not_converted" },
  // 152 号票：用户撤回了维护者的会话（会话回退），任务状态按保留的分支推导——回到计划确认之前的回到规划中（要重新确认计划）；
  // 回到任务结束（完成、失败）之后的那一处的，回到那时的结局；执行中、等我、已暂停、排队中之间照 84 号票的重做（resume、settle）走上面那几行
  ...ROLLBACK_PLANNING_FROM.map((from): TaskTransition => ({ from, to: "planning", action: "rollbackToPlanning", by: ["user"] })),
  ...ROLLBACK_QUEUED_FROM.map((from): TaskTransition => ({ from, to: "queued", action: "rollbackToQueued", by: ["user"] })),
  // 153 号票：流程回到计划授权之前（那时在等你授权的那一版后来授权了）：回到待确认，同样的计划重新等你授权
  ...ROLLBACK_REAUTHORIZE_FROM.map((from): TaskTransition => ({ from, to: "awaiting_confirm", action: "rollbackReauthorize", by: ["user"] })),
  ...ROLLBACK_ENDED_FROM.flatMap((from) => (["done", "failed"] as const).filter((to) => to !== from).map((to): TaskTransition => ({ from, to, action: "rollbackToEnded", by: ["user"] }))),
  // 归档：只有用户能做。结束了的（已完成、失败、已取消）随时能直接归档（90 号票：看板卡的菜单、多选、任务详情的"⋯"，项目内部任务
  // 在项目页上，64 号票），全局任务、项目内部任务都行；每周的归档清单（19 号票）照旧。没结束的要先取消
  ...ENDED_TASK_STATES.filter((s) => s !== "archived").map((from): TaskTransition => ({ from, to: "archived", action: "archive", by: ["user"], act: "archive" })),
  // 141 号票：运营方案建的内部任务跟着项目归档（系统做的，记下原来的状态 archivedFrom）、取消归档时回到原来的状态；
  // 只有运营中、等时间的和结束了的跟着走（进行中的没有这一步，见 FOLLOWS_PROJECT_ARCHIVE_STATES）
  ...FOLLOWS_PROJECT_ARCHIVE_STATES.map((from): TaskTransition => ({ from, to: "archived", action: "archiveWithProject", by: ["system"] })),
  ...FOLLOWS_PROJECT_ARCHIVE_STATES.map((to): TaskTransition => ({ from: "archived", to, action: "unarchiveWithProject", by: ["system"] })),
  ...UNFINISHED_TASK_STATES.map((from): TaskTransition => ({ from, to: "cancelled", action: "cancel", by: ["user", "secretary"], act: "cancel" })),
  // 转为项目（15 号票）：原任务的维护者接着做立项问答，任务以"已完成 · 已转为项目"结束（Task.endKind）
  ...UNFINISHED_TASK_STATES.map((from): TaskTransition => ({ from, to: "done", action: "convertToProject", by: ["user"] })),
];

/** 不改任务状态的事：用户在维护者会话里说话（message）、维护者处理会话里的输入（work） */
export const TASK_CONVERSATION_ACTS = ["message", "work"] as const;
export type TaskConversationAct = (typeof TASK_CONVERSATION_ACTS)[number];

/** 能对任务做的事：用户的控制（task_action），加上会话里的两件 */
export type TaskAct = TaskAction | TaskConversationAct;

/** 不改任务状态的事，在哪些状态下谁能做 */
export const TASK_STAY_ACTS: ReadonlyArray<{ act: TaskAct; in: readonly TaskState[]; by: readonly TaskActor[]; when?: TaskActCondition }> = [
  // 用户在任务详情里对维护者说话：已完成、已取消、已归档的不再收（要返工用"返工"），失败的还收（重试时维护者看得到）
  { act: "message", in: [...UNFINISHED_TASK_STATES, "failed"], by: ["user"] },
  // 普通任务（75 号票）做完了还收：用户接着说，任务回到执行中接着做（已完成 → 执行中走"返工"那一行的迁移，记成 continued）
  { act: "message", in: ["done"], by: ["user"], when: "plain" },
  // 84 号票：执行中、已暂停、排队中的长程任务从某个开始过的阶段重做，状态不变——执行中的先停稳维护者手头这一轮，这一阶段和下游
  // 回到未开始，维护者接着做；暂停的仍暂停、排队的仍排队，继续、轮到时维护者照重做后的样子做
  { act: "rework", in: ["running", "paused", "queued"], by: ["user"], when: "not_converted" },
  // 维护者处理会话里的输入：排队中、已暂停、结束了的输入留在队里；定时触发的任务运营中时处理（每次运行的通知、用户在详情里说的，76 号票）
  { act: "work", in: ["planning", "awaiting_confirm", "running", "waiting_for_user", "operating"], by: ["maintainer"] },
  // 由我验收的阶段：验收通过、退回（等我的任务验收通过后可能接着执行，那一步走"接着执行"那行）
  { act: "accept_stage", in: ["running", "waiting_for_user"], by: ["user"], when: "stage_awaiting_user" },
  { act: "return_stage", in: ["running", "waiting_for_user"], by: ["user"], when: "stage_awaiting_user" },
];

function holds(condition: TaskActCondition | undefined, task: TaskActSubject): boolean {
  switch (condition) {
    case undefined:
      return true;
    case "user_decides":
      return userDecidesWait(task);
    case "not_converted":
      return task.endKind === undefined && task.kind !== "workflow" && (task.stages?.list?.length ?? 0) > 0;
    case "stage_awaiting_user":
      return (task.stages?.list ?? []).some((s) => s.state === "waiting" && s.waitReason === "acceptance");
    case "plain":
      return isPlainTask(task);
  }
}

/** 这个人现在能对任务做的事（按"谁能改"表和上面那几件不改状态的事推出） */
export function availableTaskActions(task: TaskActSubject, actor: TaskActor): TaskAct[] {
  const out = new Set<TaskAct>();
  for (const row of TASK_TRANSITIONS) if (row.act && row.from === task.state && row.by.includes(actor) && holds(row.when, task)) out.add(row.act);
  for (const s of TASK_STAY_ACTS) if (s.in.includes(task.state) && s.by.includes(actor) && holds(s.when, task)) out.add(s.act);
  return [...out];
}

/** 现在不能做时说明为什么（用户的控制、往维护者会话里发话；给人看，待我处理在界面上叫"待办"，43 号票） */
export function taskActRefusal(task: TaskActSubject & { title?: string }, act: TaskAct): string {
  const state = TASK_STATE_LABEL[task.state];
  switch (act) {
    case "pause":
      return t("protocol.taskTransitions.refusal.pause", { state });
    case "resume":
      return task.state === "waiting_for_user"
        ? t("protocol.taskTransitions.refusal.resumeWaiting", { reason: TASK_WAIT_REASON_LABEL[task.waitReason ?? "approval"] })
        : t("protocol.taskTransitions.refusal.resume", { state });
    case "cancel":
      return t("protocol.taskTransitions.refusal.cancel", { state });
    case "retry":
      return t("protocol.taskTransitions.refusal.retry", { state });
    case "rework":
      if (task.kind === "workflow") return t("protocol.taskTransitions.refusal.reworkWorkflow");
      if (isPlainTask(task)) return t("protocol.taskTransitions.refusal.reworkPlain");
      if (task.endKind) return t("protocol.taskTransitions.refusal.reworkConverted", { state });
      if ((task.stages?.list?.length ?? 0) === 0) return t("protocol.taskTransitions.refusal.reworkNotStarted");
      return t("protocol.taskTransitions.refusal.rework", { state });
    case "accept_stage":
    case "return_stage":
      return t("protocol.taskTransitions.refusal.noAcceptance");
    case "archive":
      return task.state === "archived" ? t("protocol.taskTransitions.refusal.archived") : t("protocol.taskTransitions.refusal.archive", { state });
    // 删除不是状态迁移（186 号票）：能不能删看 taskDeleteRefusal，这里只是兜底的一句
    case "delete":
      return t("protocol.taskTransitions.refusal.delete");
    case "message": {
      const who = task.title ? t("protocol.taskTransitions.refusal.messageTask", { title: task.title }) : t("protocol.taskTransitions.refusal.messageTaskUntitled");
      return t(task.state === "done" ? "protocol.taskTransitions.refusal.messageDone" : "protocol.taskTransitions.refusal.message", { who, state });
    }
    case "work":
      return t("protocol.taskTransitions.refusal.work", { state });
  }
}

// ───────────────────────── 删除、先取消再归档（186 号票） ─────────────────────────

/**
 * 没结束的任务点"归档"（186 号票，用户 2026-10-20 定）：用户现在能取消的（"谁能改"表推出的，含运营中的定时、事件触发的任务）先照现有的
 * 取消走（运营中的落到触发上），取消成了再归档；取消不了的不归档。结束了的照旧直接归档，项目在用的运营任务照旧不行（operationsItemLock）
 */
export function archiveCancelsFirst(task: TaskActSubject): boolean {
  return !ENDED_TASK_STATES.includes(task.state) && availableTaskActions(task, "user").includes("cancel");
}

/** 判断能不能删要看的任务的样子 */
export interface TaskDeleteSubject {
  maintainerId: string;
  internal?: ProjectInternal | undefined;
  endKind?: TaskEndKind | undefined;
}

/**
 * 任务能不能删（186 号票，用户 2026-10-20 定"任务能删除，连会话和工作目录一起删"）；不能删的给出说明，能删的是 undefined。
 * 照项目的规矩：项目还在时属于项目的东西由项目管——
 * - 项目内部任务（64 号票，含运营方案建的；项目在用的那几条另有 operationsItemLockText 那句，调用方先查）：随项目删；
 * - 执行它的维护者是一个还在的项目的维护者：任务转为项目了的（会话、工作目录跟着项目），64 号票之前由项目的维护者做的单项目任务
 *   （会话在项目的维护者会话里）。项目删掉了的不再拦（会话已经随项目删了，只剩任务本身）。
 * projectOf 给出还在（没删掉）的项目里由这个维护者维护的那一个
 */
export function taskDeleteRefusal(task: TaskDeleteSubject, projectOf: (maintainerId: string) => { name: string } | undefined): string | undefined {
  if (task.internal) return t("protocol.taskTransitions.deleteRefusal.internal", { project: task.internal.projectName });
  const project = projectOf(task.maintainerId);
  if (!project) return undefined;
  return task.endKind === "converted_to_project"
    ? t("protocol.taskTransitions.deleteRefusal.converted", { project: project.name })
    : t("protocol.taskTransitions.deleteRefusal.projectMaintainer", { project: project.name });
}
