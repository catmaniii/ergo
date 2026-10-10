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
import { isProjectInternal } from "./project-internal.ts";
import type { ProjectInternal } from "./schema.ts";

/** 判断"现在能做什么"要看的任务的样子 */
export interface TaskActSubject {
  state: TaskState;
  waitReason?: TaskWaitReason | undefined;
  endKind?: TaskEndKind | undefined;
  /** 任务的种类（58 号票）：流程没有返工（执行中不能改步骤，要改就重新发起）；普通任务（75 号票）做完了还收用户的话 */
  kind?: TaskKind | undefined;
  /** 项目内部任务（64 号票）：结束之后用户在项目页上归档（全局任务在每周的归档清单上归档） */
  internal?: ProjectInternal | undefined;
  stages?: { list?: ReadonlyArray<{ state: string; waitReason?: TaskWaitReason | undefined }> | undefined } | undefined;
}

/**
 * 除了状态之外还要满足的：在等用户定夺（卡住求助、超预算、中断不确定，见 USER_DECIDES_WAIT_REASONS：用户点"继续"；
 * 会话里回话也算的只有卡住求助、中断不确定，见 RESUME_ON_REPLY_WAIT_REASONS；别的等我要先在待我处理里处理）、
 * 不是转为项目结束的（流程也不行：58 号票，流程没有返工）、有在等用户验收的阶段、是项目内部任务（64 号票：在项目页上归档）、
 * 是普通任务（75 号票：做完了用户接着说话，它接着做）
 */
export type TaskActCondition = "user_decides" | "not_converted" | "stage_awaiting_user" | "project_internal" | "plain";

/** "谁能改"表的一行：从哪个状态到哪个状态、这一步叫什么、谁能做；act 是用户的哪个控制（task_action）走这一步 */
export interface TaskTransition {
  from: TaskState;
  to: TaskState;
  /** 这一步叫什么（拒绝时说明用） */
  action: string;
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
  { from: "planning", to: "awaiting_confirm", action: "提交计划", by: ["maintainer"] },
  { from: "awaiting_confirm", to: "queued", action: "确认计划", by: ["user"] },
  { from: "awaiting_confirm", to: "planning", action: "打回计划", by: ["user"] },
  // 76 号票：定时触发的流程在计划卡上授权一次，之后按时间表运行（运营中，每次运行按步骤核对），不进排队
  { from: "awaiting_confirm", to: "operating", action: "授权计划（定时触发，之后按时间表运行）", by: ["user"] },
  // 76 号票：某个时间做一次的流程授权后等到那个时间；到点了（守护进程停着时错过的，开机补一次）进排队，之后和现在做一次的一样
  { from: "awaiting_confirm", to: "scheduled", action: "授权计划（某个时间做一次，到点再做）", by: ["user"] },
  { from: "scheduled", to: "queued", action: "到点了", by: ["system"] },
  { from: "queued", to: "running", action: "开始执行", by: ["system", "maintainer"] },
  { from: "running", to: "waiting_for_user", action: "转为等我", by: ["maintainer", "system"] },
  // 等我 → 执行中：一支不用再等了（系统）、用户验收、点"继续执行"（只对卡住求助、超预算——14 号票、中断不确定的有效）、
  // 在会话里回话（只对卡住求助、中断不确定：RESUME_ON_REPLY_WAIT_REASONS；超预算要点"追加预算继续"）
  { from: "waiting_for_user", to: "running", action: "接着执行", by: ["user", "system"], act: "resume", when: "user_decides" },
  { from: "waiting_for_user", to: "queued", action: "回到排队（执行名额满了）", by: ["user", "system"], act: "resume", when: "user_decides" },
  { from: "running", to: "paused", action: "暂停", by: ["user", "system"], act: "pause" },
  { from: "waiting_for_user", to: "paused", action: "暂停", by: ["user", "system"], act: "pause" },
  // 累计被拒太多次（14 号票）：恢复执行时回到排队中的任务也可能被系统暂停
  { from: "queued", to: "paused", action: "暂停", by: ["user", "system"], act: "pause" },
  { from: "paused", to: "running", action: "继续", by: ["user"], act: "resume" },
  { from: "paused", to: "queued", action: "继续（执行名额满了）", by: ["user", "system"], act: "resume" },
  // 13 号票：全部阶段验收通过后由控制器（系统）自动完成；最后一个阶段由用户验收时，验收前任务可能正在等我
  { from: "running", to: "done", action: "完成", by: ["maintainer", "system"] },
  { from: "waiting_for_user", to: "done", action: "完成（全部阶段验收通过）", by: ["system"] },
  { from: "running", to: "failed", action: "失败", by: ["maintainer"] },
  { from: "failed", to: "running", action: "重试", by: ["user"], act: "retry" },
  { from: "failed", to: "queued", action: "重试（执行名额满了）", by: ["user", "system"], act: "retry" },
  // 失败后的抉择：不重试就取消（失败已经结束，所以单列一行）
  { from: "failed", to: "cancelled", action: "取消（失败后不再重试）", by: ["user"], act: "cancel" },
  { from: "done", to: "running", action: "返工", by: ["user"], act: "rework", when: "not_converted" },
  { from: "done", to: "queued", action: "返工（执行名额满了）", by: ["user", "system"], act: "rework", when: "not_converted" },
  // 归档：全局任务在每周的归档清单上选（19 号票），项目内部任务在项目页上点（64 号票，task_action 的 archive）；都只有用户能做
  ...ENDED_TASK_STATES.filter((s) => s !== "archived").map((from): TaskTransition => ({ from, to: "archived", action: "归档", by: ["user"], act: "archive", when: "project_internal" })),
  ...UNFINISHED_TASK_STATES.map((from): TaskTransition => ({ from, to: "cancelled", action: "取消", by: ["user", "secretary"], act: "cancel" })),
  // 转为项目（15 号票）：原任务的维护者接着做立项问答，任务以"已完成 · 已转为项目"结束（Task.endKind）
  ...UNFINISHED_TASK_STATES.map((from): TaskTransition => ({ from, to: "done", action: "转为项目", by: ["user"] })),
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
    case "project_internal":
      return isProjectInternal(task);
    case "plain":
      return isPlainTask(task);
  }
}

/** 这个人现在能对任务做的事（按"谁能改"表和上面那几件不改状态的事推出） */
export function availableTaskActions(task: TaskActSubject, actor: TaskActor): TaskAct[] {
  const out = new Set<TaskAct>();
  for (const t of TASK_TRANSITIONS) if (t.act && t.from === task.state && t.by.includes(actor) && holds(t.when, task)) out.add(t.act);
  for (const s of TASK_STAY_ACTS) if (s.in.includes(task.state) && s.by.includes(actor) && holds(s.when, task)) out.add(s.act);
  return [...out];
}

/** 现在不能做时说明为什么（用户的控制、往维护者会话里发话；给人看，待我处理在界面上叫"待办"，43 号票） */
export function taskActRefusal(task: TaskActSubject & { title?: string }, act: TaskAct): string {
  const label = `任务现在是${TASK_STATE_LABEL[task.state]}`;
  switch (act) {
    case "pause":
      return `${label}，不能暂停`;
    case "resume":
      return task.state === "waiting_for_user" ? `任务在等你处理：${TASK_WAIT_REASON_LABEL[task.waitReason ?? "approval"]}。先在待办里处理它` : `${label}，不能继续`;
    case "cancel":
      return `${label}，不能取消`;
    case "retry":
      return `${label}，只有失败的任务能重试`;
    case "rework":
      if (task.kind === "workflow") return "流程没有返工：要重做就重新发起";
      if (isPlainTask(task)) return "普通任务没有返工：在任务详情里接着说，它就接着做";
      return `${label}${task.endKind ? "（已转为项目）" : ""}，只有已完成的任务能返工`;
    case "accept_stage":
    case "return_stage":
      return "没有在等你验收的阶段";
    case "archive":
      return isProjectInternal(task) ? `${label}，只有结束了的任务能归档` : "这个任务在每周的归档清单上归档";
    case "message":
      return `${task.title ? `任务「${task.title}」` : "任务"}${TASK_STATE_LABEL[task.state]}，不再收消息${task.state === "done" ? "；要返工请用任务详情里的“返工”" : ""}`;
    case "work":
      return `${label}，维护者不处理输入`;
  }
}
