// 任务（规格第 8 节）的名字：任务状态、谁改的、看板分组、计划里的枚举。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 task-schema.ts，计划的纯函数在 plan.ts，
// 活动状态在 activity.ts。"谁能改"表和"现在能对任务做什么"在 task-transitions.ts（守护进程的 tasks/state-machine.ts 按它校验迁移）。
import type { ReminderStatus } from "./schema.ts";

/**
 * 任务状态：规划中 → 待确认 → 排队中 → 执行中 → 已完成 →（用户手动）已归档；执行中 ⇄ 等我 / 已暂停；
 * 执行中 → 失败 →（重试）执行中；已完成 → 返工 → 执行中；任何未结束的状态 → 已取消。
 * 76 号票（ADR 0025）：定时（以后还有事件）触发的任务登记好了就是运营中——按触发一次次运行（每次一次运行），
 * 自己不进排队、执行中；暂停、恢复的是它的触发（触发登记上的运营中 / 已暂停，看板上照样在"运营中"一组），取消了才结束。
 * 普通任务建出就是运营中，流程在计划卡上授权之后是运营中。
 * 某个时间做一次（定时、时间表是一次性的，用户 2026-10-10 定）：等到那个时间是"等时间"（普通任务建出就是，流程在计划卡上授权之后是），
 * 到点了进排队，之后和现在做一次的任务一样（做完即完成）；看板上在"进行中"一组。
 */
export const TASK_STATES = ["planning", "awaiting_confirm", "scheduled", "queued", "running", "waiting_for_user", "paused", "operating", "done", "failed", "cancelled", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
  planning: "规划中",
  awaiting_confirm: "待确认",
  scheduled: "等时间",
  queued: "排队中",
  running: "执行中",
  waiting_for_user: "等我",
  paused: "已暂停",
  operating: "运营中",
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

/**
 * 任务的做法（ADR 0019，58 号票；ADR 0025，75 号票加了普通任务）：建卡时定下，之后不能换。顺序就是发起对话框里的顺序
 * （普通任务排最前、默认选中）。
 * - 普通任务（plain，75 号票）：有任务卡、有自己的 agent，在后台像普通 agent 一样一轮轮直接做——不规划、不授权、不检查
 *   （守卫按普通对话那一套判，受 guard.conversationApprovals 管；受保护区域、密钥的硬拒绝照旧）。agent 这一轮做完就自动算完成；
 *   用户接着说话它就接着做。助理可以自己决定把一件事交出去建成它（delegate_task），不必等用户点明；
 * - 流程（workflow）：照搬 AgentSense 的固定计划——维护者把要做的事排成一串步骤（每步一次工具调用，连同它要满足的条件），
 *   审查修补后用户一次授权，执行时按步骤做；
 * - 长程任务（long_running）：原来的任务，计划由阶段组成，逐阶段验收、可以计划变更。
 * 流程和长程任务分开之前建的任务没有记种类，都算长程任务（taskKind 补默认值，不迁移数据）
 */
export const TASK_KINDS = ["plain", "workflow", "long_running"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** 有计划的两种做法（流程、长程任务）：要用户点明才发起，规划、一次授权、执行时检查（ADR 0019）；普通任务不在里面 */
export const PLANNED_TASK_KINDS = ["workflow", "long_running"] as const satisfies readonly TaskKind[];
export type PlannedTaskKind = (typeof PLANNED_TASK_KINDS)[number];

export const TASK_KIND_LABEL: Readonly<Record<TaskKind, string>> = { plain: "普通任务", workflow: "流程", long_running: "长程任务" };

/** 发起对话框里各个页签的副标题（照 AgentSense 的 ScenarioPicker）：说清几种的区别 */
export const TASK_KIND_HINT: Readonly<Record<TaskKind, string>> = {
  plain: "交给一个 agent 在后台直接做，像跟助理对话一样一轮轮干，不规划、不授权、不检查；做完自动算完成，在任务详情里接着说它就接着做",
  workflow: "每一步先排好（每步一次工具调用，连同它要满足的条件），审查修补后一次授权；执行时按步骤做，不逐步验收，执行中不能改步骤",
  long_running: "只定几个阶段：交什么、怎么验收、允许做什么；中间怎么走交给维护者，逐阶段验收，执行中可以提计划变更",
};

/** 任务的种类：没记的（流程和长程任务分开之前建的）是长程任务 */
export function taskKind(task: { kind?: TaskKind | undefined }): TaskKind {
  return task.kind ?? "long_running";
}

/** 是不是普通任务（75 号票）：没有计划、阶段、步骤，agent 这一轮做完就算完成 */
export function isPlainTask(task: { kind?: TaskKind | undefined }): boolean {
  return taskKind(task) === "plain";
}

// ───────────────────────── 触发方式（76 号票，ADR 0025） ─────────────────────────

/**
 * 任务什么时候做（ADR 0025 的第二个维度）：一次性（现在做一次，不写就是它）、定时（按时间表，含工作日历）、事件（某个事件推送过来时，
 * 77 号票接上事件来源登记表：event-sources.ts）。定时、事件触发的任务每被触发一次是一次运行；时间到了也看作一种事件，两者共用一个触发底座（守护进程 scheduled-jobs/）。
 * 定时的时间表是一次性的（某个时间做一次，用户 2026-10-10 定）不算反复运行：等到那个时间做一次，做完即完成（onceAt）
 */
export const TASK_TRIGGER_KINDS = ["once", "schedule", "event"] as const;
export type TaskTriggerKind = (typeof TASK_TRIGGER_KINDS)[number];

export const TASK_TRIGGER_LABEL: Readonly<Record<TaskTriggerKind, string>> = { once: "现在做一次", schedule: "定时", event: "事件发生时" };

/** 任务的触发方式：没写的（76 号票之前建的、一次性的）是一次性 */
export function taskTriggerKind(task: { trigger?: { kind: TaskTriggerKind } | undefined }): TaskTriggerKind {
  return task.trigger?.kind ?? "once";
}

/** 任务的触发方式里要看的那几样（不引用 schema：时间表只看是不是一次性的、一次性的那个时间） */
interface TriggerShape {
  trigger?: { kind: TaskTriggerKind; schedule?: { kind: string; at?: string } } | undefined;
}

/** 是不是定时、事件触发的任务（反复运行，登记好了是运营中）；某个时间做一次的不是 */
export function isTriggered(task: TriggerShape): boolean {
  const { trigger } = task;
  if (!trigger || trigger.kind === "once") return false;
  return trigger.kind === "event" || trigger.schedule?.kind !== "once";
}

/** 事件触发的任务（77 号票）：它的事件触发方式；不是的 undefined */
export function eventTriggerOf<T extends { kind: string }>(task: { trigger?: T | undefined }): Extract<T, { kind: "event" }> | undefined {
  return task.trigger?.kind === "event" ? (task.trigger as Extract<T, { kind: "event" }>) : undefined;
}

/** 某个时间做一次（定时、时间表是一次性的）：那个时间（协议时间）；不是的 undefined */
export function onceAt(task: TriggerShape): string | undefined {
  const { trigger } = task;
  return trigger?.kind === "schedule" && trigger.schedule?.kind === "once" ? trigger.schedule.at : undefined;
}

/** 一种做法能用哪些触发（ADR 0025）：普通任务、流程三种都能用；长程任务只做一次性（逐阶段验收的工作不适合反复跑） */
export function triggerKindsOf(kind: TaskKind): readonly TaskTriggerKind[] {
  return kind === "long_running" ? ["once"] : TASK_TRIGGER_KINDS;
}

/** 长程任务选了定时、事件时的说法（对话框、守护进程共用） */
export const LONG_RUNNING_TRIGGER_REFUSAL = "长程任务只能现在做一次：逐阶段验收的工作不适合反复跑。要定时做、事件发生时做的事，选普通任务或流程";

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

/**
 * 任务涉及几个项目（规格第 8 节"执行者"，17 号票评审后定）：不涉及项目、单项目（由这个项目的维护者执行）、多项目（任务自己的维护者，
 * 工具包固定为读项目档案、派工单、汇总回执）。建卡时定下（建卡时没写项目的，第一版任务书定下），之后不随计划改动重新判断：
 * 单项目任务的计划不能写进别的项目，不涉及项目的任务的计划不能写项目行；多项目任务删到只剩一个项目也还是多项目任务
 */
export const TASK_PROJECT_SCOPES = ["none", "single", "multi"] as const;
export type TaskProjectScope = (typeof TASK_PROJECT_SCOPES)[number];

export const TASK_PROJECT_SCOPE_LABEL: Readonly<Record<TaskProjectScope, string>> = { none: "不涉及项目", single: "单项目", multi: "多项目" };

/**
 * 任务涉及几个项目：任务上记着的；17 号票之前建的任务没有记，由项目的维护者执行的是单项目，
 * 任务自己的维护者执行、涉及两个以上项目的是多项目，其余不涉及项目
 */
export function taskProjectScope(task: { id: string; maintainerId: string; projects: readonly string[]; projectScope?: TaskProjectScope | undefined }): TaskProjectScope {
  if (task.projectScope !== undefined) return task.projectScope;
  if (!hasOwnMaintainer(task)) return "single";
  return task.projects.length >= 2 ? "multi" : "none";
}

export const TASK_END_KIND_LABEL: Readonly<Record<TaskEndKind, string>> = { converted_to_project: "已转为项目" };

/** 谁改的（规格第 8 节"谁能改"表的四行） */
export const TASK_ACTORS = ["user", "secretary", "maintainer", "system"] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

export const TASK_ACTOR_LABEL: Readonly<Record<TaskActor, string>> = { user: "用户", secretary: "秘书", maintainer: "维护者", system: "系统" };

/**
 * 任务从哪条路发起：用户点"发起任务"按钮、用户点了秘书给的"建议发起任务"卡、用户在消息里要秘书去做（秘书直接建任务卡），
 * 以及项目开工（立项书卡上的"确认并开工"、项目页上的"开工"）时建出的首个建设任务（15 号票）。
 * 这几条路发起的任务都由用户发起（秘书只是按用户的要求建卡）。
 * 75 号票：delegated——助理自己决定把用户交代的一件事交给后台去做（delegate_task），建成普通任务，不必等用户点明（ADR 0025）。
 * 76 号票：migrated——ADR 0025 之前长程任务的计划里登记的定时作业，迁移成定时触发的普通任务（新事件建出，不改写原来的事件）
 */
export const TASK_ORIGINS = ["button", "suggestion", "request", "project_build", "delegated", "migrated"] as const;
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
 * 17 号票：projects_settled：建卡时没写项目、第一版任务书涉及多个项目，任务定为多项目任务（执行的还是任务自己的维护者）。
 * 14 号票：偏离、阈值和计划变更——
 * - pulled_back：维护者被拉回（按规则退回）一次，阶段上的拉回次数加 1；nudged：无进展时运行时催了一次，阶段上的催促次数加 1；
 *   progressed：催过之后有了成功的工具调用或阶段推进，催促次数清零；rejection_counted：用户拒绝了一次（审批、计划变更），
 *   任务上的累计被拒次数加 1（满了就 paused，pauseReason 写明）；
 * - plan_change_proposed：维护者提交了计划变更，受影响的阶段停下等确认；plan_changed：用户确认了计划变更，计划和阶段随之更新；
 *   plan_change_rejected：用户拒绝了计划变更，受影响的阶段交回维护者在现有授权内重排；plan_revised：维护者自行调整了计划
 *   （拆阶段、调顺序这类不扩大授权的）。
 * 19 号票：archived：用户在归档清单上选了"归档"（已完成、失败、已取消 → 已归档）。
 * 往后的票加新的变化时往这里加
 */
export const TASK_CHANGES = [
  "created",
  "plan_submitted",
  "plan_confirmed",
  "plan_rejected",
  "converted_to_project",
  "handed_to_project",
  "projects_settled",
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
  "pulled_back",
  "nudged",
  "progressed",
  "rejection_counted",
  "plan_change_proposed",
  "plan_changed",
  "plan_change_rejected",
  "plan_revised",
  // 27 号票：用户在任务详情里直接改了工具包、维护者增减了 skill（现在生效的计划换了一版，只改了工具包）
  "toolkit_changed",
  "archived",
  // 58 号票：流程的维护者用 report_step 报了一步的状态
  "step_reported",
  // 59 号票：流程的维护者一轮收工时，运行时推断出步骤做完了（报着"在做"的、执行过却没报的）
  "steps_inferred",
  // 75 号票：普通任务做完之后用户在任务详情里接着说了（或者运行时交给它一条通知），任务回到执行中接着做
  "continued",
  // 76 号票：某个时间做一次的任务到点了（停机错过的开机补一次），从等时间进排队
  "time_due",
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
 * 任务（或它的一支）在等用户的原因：审批（挂起的审批）、交给我做、由我验收、卡住求助（维护者"转为等我"；14 号票起还有
 * 拉回超限、催促超限、验收第 3 次不过、标了做不了）、超预算（预算超出 2 倍，14）、计划变更（等用户确认计划变更卡，14）；
 * 工单的等澄清（17）、中断不确定（23）由各自的票用
 */
export const TASK_WAIT_REASONS = ["approval", "hand_over", "acceptance", "stuck", "clarification", "over_budget", "interrupted", "plan_change"] as const;
export type TaskWaitReason = (typeof TASK_WAIT_REASONS)[number];

export const TASK_WAIT_REASON_LABEL: Readonly<Record<TaskWaitReason, string>> = {
  approval: "审批",
  hand_over: "交给我做",
  acceptance: "由我验收",
  stuck: "卡住求助",
  clarification: "澄清",
  over_budget: "超预算",
  interrupted: "中断不确定",
  plan_change: "计划变更",
};

/**
 * 由用户直接定夺的等我原因：卡住求助（维护者"转为等我"，14 号票起还有阈值超了、标了做不了）、超预算（14 号票：用量超过预算的 2 倍）、
 * 中断不确定（23 号票：被杀时一次有副作用的调用说不清做没做完）。用户点"继续"（任务详情里的"继续执行"，或待我处理里那条事项上的
 * "继续执行""追加预算继续"）就接着执行，停下的那一支计数清零、超预算的阶段重新给一整份预算；在会话里回话能不能接着执行另见
 * RESUME_ON_REPLY_WAIT_REASONS（超预算不行）。维护者自己说的等我、中断不确定，别的分支有了结论也不会让任务自己恢复；
 * 别的等我（审批、交给我做、由我验收、计划变更……）要先在待我处理里处理掉那件事
 */
export const USER_DECIDES_WAIT_REASONS = ["stuck", "over_budget", "interrupted"] as const satisfies readonly TaskWaitReason[];

/** 任务（或它的一支）是不是在等用户定夺（见 USER_DECIDES_WAIT_REASONS） */
export function userDecidesWait(task: { waitReason?: TaskWaitReason | undefined }): boolean {
  return (USER_DECIDES_WAIT_REASONS as readonly string[]).includes(task.waitReason ?? "");
}

/**
 * 等用户定夺的里面，用户在任务的会话里回话就算定夺了、接着执行的：卡住求助、中断不确定（他的话就是交给维护者的输入）。
 * 超预算不在里面（2026-10-08 用户定的）：只有点"追加预算继续"（或任务详情里的"继续执行"）才接着执行、重新给一整份预算；
 * 会话里的话交给维护者回答，任务仍停在等我
 */
export const RESUME_ON_REPLY_WAIT_REASONS = ["stuck", "interrupted"] as const satisfies readonly (typeof USER_DECIDES_WAIT_REASONS)[number][];

/** 任务（或它的一支）在等的是不是用户回话就接着执行的（见 RESUME_ON_REPLY_WAIT_REASONS） */
export function resumesOnReply(task: { waitReason?: TaskWaitReason | undefined }): boolean {
  return (RESUME_ON_REPLY_WAIT_REASONS as readonly string[]).includes(task.waitReason ?? "");
}

/** 任务为什么被系统暂停（14 号票）：同一任务累计被用户拒绝太多次（默认 5 次） */
export const TASK_PAUSE_REASONS = ["too_many_rejections"] as const;
export type TaskPauseReason = (typeof TASK_PAUSE_REASONS)[number];

export const TASK_PAUSE_REASON_LABEL: Readonly<Record<TaskPauseReason, string>> = { too_many_rejections: "累计被拒" };

/**
 * 用户对任务的控制（task_action 请求）：暂停、继续、取消、失败后重试、对已完成的任务要求返工（重开指定阶段和它的下游）、
 * 由我验收的阶段验收通过或退回；结束了的任务归档（项目内部任务在项目页上，64 号票；90 号票起全局任务也能直接归档，每周的归档清单照旧）
 */
export const TASK_ACTIONS = ["pause", "resume", "cancel", "retry", "rework", "accept_stage", "return_stage", "archive"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * 一次对多个任务做的控制（task_batch_action，90 号票：看板多选的操作栏）：暂停、继续、取消、归档。每个任务各自按"谁能改"表判断、
 * 各自成败（和单个的 task_action 走同一个处理，定时触发的任务运营中时的暂停、恢复、取消照旧落到它的触发上）；
 * 要指明阶段、要写原因的（返工、验收、退回）和重试不在里面，一个一个做
 */
export const TASK_BATCH_ACTIONS = ["pause", "resume", "cancel", "archive"] as const satisfies readonly TaskAction[];
export type TaskBatchAction = (typeof TASK_BATCH_ACTIONS)[number];

/** 一次最多对几个任务做（看板上的任务没有这么多；挡住写错了的请求） */
export const TASK_BATCH_MAX = 200;

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
/** "超预算"事项（over_budget，14 号票）的动作：再给这个阶段一份预算，接着执行 */
export const OVER_BUDGET_ACTIONS = { resume: "追加预算继续" } as const;
/** "授权到期续期"事项（grant_renewal，14 号票）的动作：续期（有效期再延一期）、不续（到期后执行到那一步再问你） */
export const GRANT_RENEWAL_ACTIONS = { renew: "续期", skip: "不续" } as const;

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
  active: { title: "进行中", sub: "规划中、等时间、排队中、执行中、已暂停" },
  ops: { title: "运营中", sub: "简单提醒、定时和事件触发的任务" },
  ended: { title: "最近结束", sub: "已完成、失败、已取消" },
  archived: { title: "已归档", sub: "" },
};

/** 任务状态 → 看板分组（守护进程和 Web 只用这一份） */
export const BOARD_GROUP_OF_TASK_STATE: Readonly<Record<TaskState, BoardGroup>> = {
  waiting_for_user: "waiting",
  awaiting_confirm: "waiting",
  planning: "active",
  // 某个时间做一次、还没到点的（76 号票）：和排队中的一样在进行中
  scheduled: "active",
  queued: "active",
  running: "active",
  paused: "active",
  // 定时触发的任务（76 号票）：触发暂停着也在这一组（卡上写已暂停）
  operating: "ops",
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
