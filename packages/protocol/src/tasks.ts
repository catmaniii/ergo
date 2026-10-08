// 任务（规格第 8 节）的名字：任务状态、谁改的、看板分组、计划里的枚举。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 task-schema.ts，计划的纯函数在 plan.ts，
// 活动状态在 activity.ts。"谁能改"表和"现在能对任务做什么"在 task-transitions.ts（守护进程的 tasks/state-machine.ts 按它校验迁移）。
import type { ReminderStatus } from "./schema.ts";

/**
 * 任务状态：规划中 → 待确认 → 排队中 → 执行中 → 已完成 →（用户手动）已归档；执行中 ⇄ 等我 / 已暂停；
 * 执行中 → 失败 →（重试）执行中；已完成 → 返工 → 执行中；任何未结束的状态 → 已取消。
 */
export const TASK_STATES = ["planning", "awaiting_confirm", "queued", "running", "waiting_for_user", "paused", "done", "failed", "cancelled", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
  planning: "规划中",
  awaiting_confirm: "待确认",
  queued: "排队中",
  running: "执行中",
  waiting_for_user: "等我",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  archived: "已归档",
};

/** 结束了的状态（不再推进；"任何未结束的状态 → 已取消"里的"结束"） */
export const ENDED_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled", "archived"];

/** 未结束的状态：都能取消、转为项目 */
export const UNFINISHED_TASK_STATES: readonly TaskState[] = TASK_STATES.filter((s) => !ENDED_TASK_STATES.includes(s));

/** 已完成的任务是怎么结束的（不写是做完了）：转为项目（15 号票），显示成"已完成 · 已转为项目" */
export const TASK_END_KINDS = ["converted_to_project"] as const;

/** 任务怎么称呼："任务 t-3「整理发票」"（秘书看的看板、任务控制快速动作的说法共用） */
export function taskName(task: { id: string; title: string }): string {
  return `任务 ${task.id}「${task.title}」`;
}

/** 任务自己的维护者（建任务卡时产生，t-<n> 的是 tm-<n>）；属于项目的任务（首个建设任务）由项目的维护者执行 */
export function ownMaintainerId(taskId: string): string {
  return `tm-${taskId.replace(/^t-/, "")}`;
}

/** 任务由它自己的维护者执行（不是某个项目的任务）：这样的任务才能转为项目 */
export function hasOwnMaintainer(task: { id: string; maintainerId: string }): boolean {
  return task.maintainerId === ownMaintainerId(task.id);
}
export type TaskEndKind = (typeof TASK_END_KINDS)[number];

export const TASK_END_KIND_LABEL: Readonly<Record<TaskEndKind, string>> = { converted_to_project: "已转为项目" };

/** 谁改的（规格第 8 节"谁能改"表的四行） */
export const TASK_ACTORS = ["user", "secretary", "maintainer", "system"] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

export const TASK_ACTOR_LABEL: Readonly<Record<TaskActor, string>> = { user: "用户", secretary: "秘书", maintainer: "维护者", system: "系统" };

/**
 * 任务从哪条路发起：用户点"发起任务"按钮、用户点了秘书给的"建议发起任务"卡、用户在消息里要秘书去做（秘书直接建任务卡），
 * 以及项目开工（立项书卡上的"确认并开工"、项目页上的"开工"）时建出的首个建设任务（15 号票）。
 * 这几条路发起的任务都由用户发起（秘书只是按用户的要求建卡）
 */
export const TASK_ORIGINS = ["button", "suggestion", "request", "project_build"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/**
 * 任务看板事件里"这次是什么变化"。12 号票：建出、维护者提交计划、用户确认计划、用户打回计划，以及转为项目（15 号票用）；
 * 13 号票：执行和阶段——
 * - started：排队中 → 执行中（名额空出，系统开始执行）；requeued：要恢复执行而名额满了，回到排队中；
 * - stage_started：开始一个阶段；stage_submitted：维护者宣布阶段完成，开始验收；stage_accepted：这个阶段验收通过；
 *   stage_returned：验收没通过（脚本、评审或用户退回），交回维护者；stage_waiting：这一支停下等用户（审批、交给我做、由我验收）；
 *   stage_unblocked：这一支不用再等了（批准或拒绝了、交给我做的事做完了）；
 * - waiting：转等我（所有能推进的分支都在等用户，或维护者卡住求助）；resumed：接着执行（等我、已暂停之后）；paused：暂停；
 * - completed：全部阶段验收通过，自动完成；failed：维护者判失败；retried：失败后重试；rework：用户要求返工；cancelled：取消。
 * 16 号票：handed_to_project：秘书写的任务书只涉及一个项目（建卡时没写），任务交给这个项目的维护者起草并执行。
 * 往后的票加新的变化时往这里加
 */
export const TASK_CHANGES = [
  "created",
  "plan_submitted",
  "plan_confirmed",
  "plan_rejected",
  "converted_to_project",
  "handed_to_project",
  "started",
  "requeued",
  "stage_started",
  "stage_submitted",
  "stage_accepted",
  "stage_returned",
  "stage_waiting",
  "stage_unblocked",
  "waiting",
  "resumed",
  "paused",
  "completed",
  "failed",
  "retried",
  "rework",
  "cancelled",
] as const;
export type TaskChange = (typeof TASK_CHANGES)[number];

// ───────────────────────── 执行和阶段（13 号票） ─────────────────────────

/**
 * 阶段的状态：未开始、进行中（维护者在做，同一时刻最多一个）、验收中（宣布完成后跑脚本、评审）、
 * 等我（这一支在等用户：审批挂起、交给我做、由我验收）、已验收
 */
export const STAGE_STATES = ["pending", "running", "accepting", "waiting", "accepted"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const STAGE_STATE_LABEL: Readonly<Record<StageState, string>> = { pending: "未开始", running: "进行中", accepting: "验收中", waiting: "等我", accepted: "已验收" };

/**
 * 任务（或它的一支）在等用户的原因：审批（挂起的审批）、交给我做、由我验收、卡住求助（维护者"转为等我"）；
 * 工单的等澄清（17）、超预算（14）、中断不确定（23）由各自的票用
 */
export const TASK_WAIT_REASONS = ["approval", "hand_over", "acceptance", "stuck", "clarification", "over_budget", "interrupted"] as const;
export type TaskWaitReason = (typeof TASK_WAIT_REASONS)[number];

export const TASK_WAIT_REASON_LABEL: Readonly<Record<TaskWaitReason, string>> = {
  approval: "审批",
  hand_over: "交给我做",
  acceptance: "由我验收",
  stuck: "卡住求助",
  clarification: "澄清",
  over_budget: "超预算",
  interrupted: "中断不确定",
};

/**
 * 由用户直接定夺的等我原因：卡住求助（维护者"转为等我"）、中断不确定（23 号票：被杀时一次有副作用的调用说不清做没做完）。
 * 这两种用户在任务详情里回话、点"继续"就接着执行，别的分支有了结论也不会让任务自己恢复；
 * 别的等我（审批、交给我做、由我验收……）要先在待我处理里处理掉那件事
 */
export const USER_DECIDES_WAIT_REASONS = ["stuck", "interrupted"] as const satisfies readonly TaskWaitReason[];

/** 任务（或它的一支）是不是在等用户定夺（见 USER_DECIDES_WAIT_REASONS） */
export function userDecidesWait(task: { waitReason?: TaskWaitReason | undefined }): boolean {
  return (USER_DECIDES_WAIT_REASONS as readonly string[]).includes(task.waitReason ?? "");
}

/**
 * 用户对任务的控制（task_action 请求）：暂停、继续、取消、失败后重试、对已完成的任务要求返工（重开指定阶段和它的下游）、
 * 由我验收的阶段验收通过或退回
 */
export const TASK_ACTIONS = ["pause", "resume", "cancel", "retry", "rework", "accept_stage", "return_stage"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** "由我验收"事项（待我处理里的通知 stage_acceptance）的两个动作 */
export const STAGE_ACCEPTANCE_ACTIONS = { pass: "验收通过", return: "退回" } as const;
/** "失败后的抉择"事项（failure_choice）的两个动作 */
export const FAILURE_CHOICE_ACTIONS = { retry: "重试", cancel: "取消任务" } as const;
/** "卡住求助"事项（stuck_help）的动作：用户回过话、做完了维护者要的事之后点它 */
export const STUCK_HELP_ACTIONS = { resume: "继续执行" } as const;
/**
 * "中断不确定"事项（interrupted，23 号票）在任务里的两个动作：守护进程被杀时一次有副作用的调用正在执行、说不清做没做完，
 * 任务转等我；用户查过之后告诉维护者做了没有，任务接着执行（也可以在任务详情里回话、点"继续"）
 */
export const INTERRUPTED_ACTIONS = { executed: "已经执行了，继续", notExecuted: "没执行，重做这一步" } as const;
/** 不属于任务的"中断不确定"事项（秘书会话里的，不卡任务）只是告诉用户，动作是"知道了" */
export const INTERRUPTED_ACK = "知道了";

/** "中断不确定"事项（待我处理里的通知 interrupted）的结构化数据：哪次调用、哪个 agent 的、属于哪个任务（不属于任务的为 null） */
export interface InterruptedNoticeData {
  toolCallId: string;
  agentId: string;
  taskId: string | null;
}

/** 待我处理事项是"中断不确定"时取它的数据；不是、或者数据不全时是 undefined */
export function interruptedNoticeData(item: object): InterruptedNoticeData | undefined {
  if (!("kind" in item) || item.kind !== "notice" || !("notice" in item) || item.notice !== "interrupted") return undefined;
  const data: unknown = "data" in item ? item.data : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { toolCallId, agentId, taskId } = data as Record<string, unknown>;
  if (typeof toolCallId !== "string" || typeof agentId !== "string" || (taskId !== null && typeof taskId !== "string")) return undefined;
  return { toolCallId, agentId, taskId };
}

/** 阶段验收的结论由谁判的（卡上标"评审判定"……） */
export const ACCEPTANCE_VERDICT_LABEL: Readonly<Record<AcceptanceMethod, string>> = { script: "脚本检查", review: "评审判定", user: "用户验收" };

/** 进度卡（progress）是哪一种：维护者报告进展，或者一个阶段的验收结论 */
export const PROGRESS_CARD_KINDS = ["progress", "acceptance"] as const;

// ───────────────────────── 看板分组 ─────────────────────────

/** 看板的五组（规格第 8 节）：等我、进行中、运营中、最近结束、已归档 */
export const BOARD_GROUPS = ["waiting", "active", "ops", "ended", "archived"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

export const BOARD_GROUP_LABEL: Readonly<Record<BoardGroup, { title: string; sub: string }>> = {
  waiting: { title: "等我", sub: "等我、待确认" },
  active: { title: "进行中", sub: "规划中、排队中、执行中、已暂停" },
  ops: { title: "运营中", sub: "简单提醒、定时作业" },
  ended: { title: "最近结束", sub: "已完成、失败、已取消" },
  archived: { title: "已归档", sub: "" },
};

/** 任务状态 → 看板分组（守护进程和 Web 只用这一份） */
export const BOARD_GROUP_OF_TASK_STATE: Readonly<Record<TaskState, BoardGroup>> = {
  waiting_for_user: "waiting",
  awaiting_confirm: "waiting",
  planning: "active",
  queued: "active",
  running: "active",
  paused: "active",
  done: "ended",
  failed: "ended",
  cancelled: "ended",
  archived: "archived",
};

/**
 * 简单提醒在看板上的分组：待触发的在"运营中"（显示"运营中 · 待触发"），已触发的一次性提醒在"最近结束"；
 * 已取消的不上看板（undefined）
 */
export function boardGroupOfReminder(status: ReminderStatus): BoardGroup | undefined {
  if (status === "pending") return "ops";
  if (status === "fired") return "ended";
  return undefined;
}

// ───────────────────────── 计划 ─────────────────────────

/** 验收方式：系统检查（脚本）、独立评审（评审子 agent）、由用户验收 */
export const ACCEPTANCE_METHODS = ["script", "review", "user"] as const;
export type AcceptanceMethod = (typeof ACCEPTANCE_METHODS)[number];

export const ACCEPTANCE_METHOD_LABEL: Readonly<Record<AcceptanceMethod, string>> = { script: "脚本", review: "评审", user: "用户" };

/** 阶段的模式：定步（附步骤）、开放 */
export const STAGE_MODES = ["steps", "open"] as const;
export type StageMode = (typeof STAGE_MODES)[number];

/** 阶段、阶段组、授权项、提问的 id 的写法：字母数字开头，字母数字、点、下划线、连字符 */
export const PLAN_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
