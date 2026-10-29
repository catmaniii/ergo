// 任务的操作菜单和看板多选（纯函数，90 号票）。用户 2026-10-11：看板上长按 / 右键任务卡片要能操作这个任务，最好能批量管理；
// 任务详情顶部四排太占地方，并成一行、收进管理菜单。
// - "这个任务现在能做什么"只有一份（taskActionItems）：照共享协议包的 availableTaskActions（"谁能改"表推出，守护进程按同一份再判一次）
//   按种类和状态变；看板卡的长按 / 右键菜单（taskMenu 的 board：多了"打开""多选"）、任务详情标题栏的"⋯"、状态签浮层都用它。
//   定时、事件触发的任务运营中时，暂停、恢复、取消落到它的触发上（76 号票），菜单项照它的触发登记能做的；定时的多一项"改时间"
//   （98 号票：带着现在的时间表，点了弹出改时间的对话框）；100 号票：定时、事件触发的多一项"立即运行一次"，能开关的任务
//   多一项"跑完自动播报：开 / 关"（都在取消任务之前）；141 号票：项目在用时运营方案里的一条（operationsLock）只有暂停、恢复和立即运行一次，
//   取消、归档换成一行说明（operations_note，点了进项目维护者的会话）；
// - 标题栏的关键按钮（taskKeyItem）：只在等我、失败时出一个最要紧的——验收通过、追加预算继续 / 继续执行、重试；
// - "⋯"的上半（taskPanels）：计划、工单 N（有才有）、工具包、消耗、运行 N（定时触发的任务），宽屏在右边的详情栏打开、手机整页；
// - 状态签浮层要的原因说明（taskStatusNote）：守护进程写的原因（超预算的用量也照它写的，评审 2026-10-11：追加预算后工具调用重新计数，
//   前端自己从阶段算的数字和守护进程的判断对不上）；
// - 看板多选（canBatch、batchCounts、batchTargets、batchResult）：每个操作只对能做的生效，按钮上写个数；结果逐条回报。
import {
  archiveCancelsFirst,
  ASSISTANT_NAME_MARK,
  availableTaskActions,
  canSetVoiceAnnounce,
  ENDED_TASK_STATES,
  type ReminderSchedule,
  type RunJobNowResult,
  stageCodes,
  type ScheduledJobAction,
  type TaskAction,
  type TaskBatchAction,
  type TaskEndKind,
  type TaskKind,
  type TaskPauseReason,
  type TaskState,
  type TaskWaitReason,
  TASK_WAIT_REASON_LABEL,
  t,
  tTable,
} from "./protocol.ts";

/** 菜单、浮层要看的一个阶段：在等什么、开始过没有 */
export interface MenuStage {
  readonly stageId: string;
  readonly state: string;
  readonly waitReason?: TaskWaitReason | undefined;
  /** 开始过又放下了的阶段还留着开始的时间（协议包 stageStarted 的口径） */
  readonly startedAt?: string | undefined;
  /** 前置阶段（91 号票：按钮上的第几阶段按依赖图的编号写，并行的 4a、4b；原型的假条目没有，按计划里的第几个写） */
  readonly dependsOn?: readonly string[] | undefined;
  /** 计划里存的编号（93 号票）；之前的计划没有，按依赖图现算 */
  readonly code?: string | undefined;
}

/** 按钮上写的第几阶段：各阶段都给了前置就按依赖图的编号（stageCodes），否则是计划里的第几个 */
function stageNoOf(list: readonly MenuStage[]): (s: MenuStage) => string {
  if (!list.every((s) => s.dependsOn !== undefined)) return (s) => String(list.indexOf(s) + 1);
  const codes = stageCodes(list.map((s) => ({ id: s.stageId, after: s.dependsOn ?? [], code: s.code })));
  return (s) => codes.get(s.stageId) ?? String(list.indexOf(s) + 1);
}

/** 判断菜单项要看的任务的样子（真任务直接给 Task；原型的假条目按它的状态拼一个） */
export interface TaskMenuSubject {
  readonly state: TaskState;
  readonly waitReason?: TaskWaitReason | undefined;
  readonly endKind?: TaskEndKind | undefined;
  readonly kind?: TaskKind | undefined;
  readonly stages?: { readonly list?: readonly MenuStage[] | undefined } | undefined;
  /** 运营中的定时、事件触发的任务：它的触发登记现在能做的（76 号票：暂停、恢复、取消落到触发上） */
  readonly triggerActions?: readonly ScheduledJobAction[] | undefined;
  /** 运营中的定时触发的任务能改时间时（98 号票）：它的触发登记现在的时间表（"改时间"预填它）；事件触发的没有 */
  readonly reschedule?: ReminderSchedule | undefined;
  /** 运营中的定时、事件触发的任务能立即运行一次时（100 号票：触发登记没取消，暂停着的也能） */
  readonly runNow?: boolean | undefined;
  /** 能开关"跑完自动播报"时（100 号票，voiceAnnounceOf）：现在开没开；不能开关的（项目内部的、不会再做完的、原型的假条目）没有 */
  readonly announce?: boolean | undefined;
  /**
   * 项目在用时运营方案里的一条（141 号票，operations-lock.ts 的 taskOperationsLock）：只有暂停、恢复，取消、归档换成这行说明
   * （点了进项目维护者的会话）；不是的没有
   */
  readonly operationsLock?: { readonly projectId: string; readonly note: string } | undefined;
  /**
   * 不能删的说明（186 号票，board.ts 的 taskMenuSubject 照协议包的 taskDeleteRefusal 算：项目内部任务、转为项目了的、项目的维护者做的）；
   * 能删的没有。原型的假条目都能删
   */
  readonly deleteRefusal?: string | undefined;
}

/** 落到任务上的几个动作（不用指明阶段的；删除另有一项，186 号票） */
export type TaskMenuAct = Extract<TaskAction, "pause" | "resume" | "retry" | "cancel" | "archive">;

/**
 * 菜单里的一项：
 * - open 打开（看板上才有）、select 多选（看板上才有）；
 * - act 落到任务上的动作；accept 某个阶段验收通过；back 退回（点了弹出写原因的对话框）；
 * - rework 已完成的"返工…"、别的时候"从某阶段重做…"（长程任务，点了先选阶段）；
 * - trigger 运营中的定时、事件触发的任务落到触发上的暂停、恢复、取消；
 * - reschedule 运营中的定时触发的任务改时间（98 号票）：带着现在的时间表（预填）、触发是不是暂停着（对话框里说明改完照旧暂停）；
 * - run_now 运营中的定时、事件触发的任务立即运行一次（100 号票）；announce 跑完自动播报（on 是现在开没开，点了换成另一个）；
 * - operations_note 项目在用时运营方案里的一条（141 号票）：取消、归档换成的那行说明，点了进项目（projectId）维护者的会话；
 * - delete 删除（186 号票，先确认；cancelsFirst 是还没结束、会先停下再删）；delete_note 不能删的说明（字小、能折行，点了什么也不做）。
 * act 的归档 cancelsFirst（186 号票）：还没结束，会先取消再归档（先确认；trigger 是运营中的定时、事件触发的任务，连同触发一起取消）。
 * tone：primary 是最要紧的那个，danger 是取消这类收不回的
 */
export type TaskMenuItem =
  | { readonly kind: "open"; readonly label: string }
  | { readonly kind: "act"; readonly action: TaskMenuAct; readonly label: string; readonly tone?: "primary" | "danger"; readonly cancelsFirst?: "task" | "trigger" }
  | { readonly kind: "delete"; readonly label: string; readonly tone: "danger"; readonly cancelsFirst: boolean; readonly archived: boolean }
  | { readonly kind: "delete_note"; readonly label: string }
  | { readonly kind: "accept"; readonly stageId: string; readonly label: string; readonly tone: "primary" }
  | { readonly kind: "back"; readonly stageId: string; readonly label: string }
  | { readonly kind: "rework"; readonly label: string }
  | { readonly kind: "trigger"; readonly action: ScheduledJobAction; readonly label: string; readonly tone?: "danger" }
  | { readonly kind: "reschedule"; readonly label: string; readonly schedule: ReminderSchedule; readonly paused: boolean }
  | { readonly kind: "run_now"; readonly label: string }
  | { readonly kind: "announce"; readonly label: string; readonly on: boolean }
  | { readonly kind: "operations_note"; readonly label: string; readonly projectId: string }
  | { readonly kind: "select"; readonly label: string };

/**
 * 菜单里的几项固定说法（170 号票起按当前语言现取）：改时间（98 号票）、立即运行一次（100 号票）、
 * 跑完自动播报（100 号票：菜单里写"跑完自动播报：开 / 关"，发起对话框里的勾选也叫它）
 */
export const TASK_MENU_LABEL = tTable({
  reschedule: "state.taskMenu.reschedule",
  runNow: "state.taskMenu.runNow",
  voiceAnnounce: "state.taskMenu.voiceAnnounce",
});

/** 菜单里跑完自动播报那一项的说法（写现在的样子） */
export const announceLabel = (on: boolean) => (on ? t("state.taskMenu.announceOn") : t("state.taskMenu.announceOff"));

/** 菜单要的"跑完自动播报"：能开关的给现在开没开（Task.voiceAnnounce，不写是关），不能开关的是 undefined（菜单里没有这一项） */
export function voiceAnnounceOf(task: { state: TaskState; kind?: TaskKind | undefined; internal?: unknown; voiceAnnounce?: boolean | undefined }): boolean | undefined {
  return canSetVoiceAnnounce(task) ? task.voiceAnnounce === true : undefined;
}

/** 立即运行一次之后的提示：开始了（不改时间表、跑完告诉你），或者排着等名额 */
export function runNowToast(result: Pick<RunJobNowResult, "runId" | "state">): string {
  const no = /-r(\d+)$/.exec(result.runId)?.[1];
  const which = no ? t("state.taskMenu.runNo", { no }) : result.runId;
  if (result.state === "queued") return t("state.taskMenu.runNowQueued", { which });
  return t("state.taskMenu.runNowStarted", { which });
}

/** 开关跑完自动播报之后的提示 */
export function announceToast(on: boolean): string {
  return on ? t("state.taskMenu.announceOnToast") : t("state.taskMenu.announceOffToast");
}

/** 触发上的三个动作在菜单里怎么写（取消触发时任务一起取消，所以写"取消任务"） */
const TRIGGER_ITEM_LABEL: Readonly<Record<ScheduledJobAction, string>> = tTable({
  pause: "state.taskMenu.trigger.pause",
  resume: "state.taskMenu.trigger.resume",
  cancel: "state.taskMenu.trigger.cancel",
});

/** 开始过的阶段（协议包 stageStarted 的口径：不是未开始，或者开始过又放下了） */
const started = (s: MenuStage) => s.state !== "pending" || s.startedAt !== undefined;

/**
 * 这个任务现在能做的（菜单的下半、状态签浮层的按钮），顺序照票面：验收（有在等你验收的阶段时，最要紧放最前）、暂停、
 * 继续 / 追加预算继续、重试、取消任务、从某阶段重做、归档
 */
export function taskActionItems(task: TaskMenuSubject): TaskMenuItem[] {
  // 141 号票：项目在用时运营方案里的一条只有暂停、恢复（用户 2026-10-18 定），外加立即运行一次（不改任务，用户同日定放回），
  // 后面一行说明要去掉请项目维护者改运营方案
  const lock = task.operationsLock;
  if (lock) {
    const keep = actionItems(task).filter((i) => i.kind === "run_now" || ((i.kind === "act" || i.kind === "trigger") && (i.action === "pause" || i.action === "resume")));
    return [...keep, { kind: "operations_note", label: lock.note, projectId: lock.projectId }];
  }
  return actionItems(task);
}

function actionItems(task: TaskMenuSubject): TaskMenuItem[] {
  // 跑完自动播报（100 号票）：能开关的都有，排在取消任务（没有的话归档）之前
  const announce: TaskMenuItem[] = task.announce === undefined ? [] : [{ kind: "announce", label: announceLabel(task.announce), on: task.announce }];
  if (task.state === "operating" && task.triggerActions) {
    const items = task.triggerActions.map((action): TaskMenuItem => ({ kind: "trigger", action, label: TRIGGER_ITEM_LABEL[action], ...(action === "cancel" ? { tone: "danger" as const } : {}) }));
    if (task.triggerActions.length === 0) return [...items, ...deleteItems(task)];
    // 暂停 / 恢复之后、取消任务之前：立即运行一次（100 号票）、改时间（98 号票）、跑完自动播报
    const extra: TaskMenuItem[] = [
      ...(task.runNow ? [{ kind: "run_now" as const, label: TASK_MENU_LABEL.runNow }] : []),
      ...(task.reschedule ? [{ kind: "reschedule" as const, label: TASK_MENU_LABEL.reschedule, schedule: task.reschedule, paused: task.triggerActions.includes("resume") }] : []),
      ...announce,
    ];
    // 186 号票：触发能取消的，也能先取消（连同触发）再归档
    const archive: TaskMenuItem[] = task.triggerActions.includes("cancel") ? [archiveItem("trigger")] : [];
    return [...beforeEnd(items, extra), ...archive, ...deleteItems(task)];
  }
  return [...beforeEnd(stateItems(task), announce), ...deleteItems(task)];
}

/** 归档（186 号票起没结束的也有：先取消再归档，点了先确认） */
const archiveItem = (cancelsFirst?: "task" | "trigger"): TaskMenuItem => ({ kind: "act", action: "archive", label: t("state.taskMenu.archive"), ...(cancelsFirst ? { cancelsFirst } : {}) });

/** 最后一项删除（186 号票）：能删的是"删除"（标红，先确认）；不能删的换成一行说明为什么（项目在用的运营任务另有那行说明，不到这里） */
function deleteItems(task: TaskMenuSubject): TaskMenuItem[] {
  if (task.deleteRefusal) return [{ kind: "delete_note", label: t("state.taskMenu.deleteBlocked", { why: task.deleteRefusal }) }];
  return [{ kind: "delete", label: t("state.taskMenu.delete"), tone: "danger", cancelsFirst: !ENDED_TASK_STATES.includes(task.state), archived: task.state === "archived" }];
}

/** 插在取消任务（没有的话归档）之前；都没有的放最后 */
function beforeEnd(items: readonly TaskMenuItem[], extra: readonly TaskMenuItem[]): TaskMenuItem[] {
  const end = (action: string) => items.findIndex((i) => (i.kind === "act" || i.kind === "trigger") && i.action === action);
  const cancel = end("cancel");
  const at = cancel >= 0 ? cancel : end("archive");
  return at < 0 ? [...items, ...extra] : [...items.slice(0, at), ...extra, ...items.slice(at)];
}

/** 照"谁能改"表落到任务上的那些（不是运营中的定时、事件触发的任务） */
function stateItems(task: TaskMenuSubject): TaskMenuItem[] {
  const can = new Set(availableTaskActions(task, "user"));
  const list = task.stages?.list ?? [];
  const no = stageNoOf(list);
  const out: TaskMenuItem[] = [];
  if (can.has("accept_stage")) {
    for (const s of list) {
      if (s.state !== "waiting" || s.waitReason !== "acceptance") continue;
      out.push({ kind: "accept", stageId: s.stageId, label: t("state.taskMenu.acceptStage", { no: no(s) }), tone: "primary" }, { kind: "back", stageId: s.stageId, label: t("state.taskMenu.sendBack") });
    }
  }
  if (can.has("pause")) out.push({ kind: "act", action: "pause", label: t("state.taskMenu.pause") });
  // 超预算的"继续"就是追加预算继续（这个阶段重新给一整份预算，14 号票）
  if (can.has("resume")) out.push({ kind: "act", action: "resume", label: task.state === "paused" ? t("state.taskMenu.resumePaused") : task.waitReason === "over_budget" ? t("state.taskMenu.resumeOverBudget") : t("state.taskMenu.resumeWaiting") });
  if (can.has("retry")) out.push({ kind: "act", action: "retry", label: t("state.taskMenu.retry") });
  if (can.has("cancel")) out.push({ kind: "act", action: "cancel", label: t("state.taskMenu.cancel"), tone: "danger" });
  // 从某个阶段重做（84 号票：开始过的阶段就能）；已完成的叫返工
  if (can.has("rework") && list.some(started)) out.push({ kind: "rework", label: task.state === "done" ? t("state.taskMenu.rework") : t("state.taskMenu.redoFrom") });
  if (can.has("archive")) out.push(archiveItem());
  // 186 号票：没结束、能取消的也能归档——先取消再归档
  else if (archiveCancelsFirst(task)) out.push(archiveItem("task"));
  return out;
}

/** 看板卡的长按 / 右键菜单（board：前面"打开"、后面"多选"）、任务详情的"⋯"的下半（detail） */
export function taskMenu(task: TaskMenuSubject, where: "board" | "detail"): TaskMenuItem[] {
  const items = taskActionItems(task);
  return where === "board" ? [{ kind: "open", label: t("state.taskMenu.open") }, ...items, { kind: "select", label: t("state.taskMenu.select") }] : items;
}

/** 宽屏标题栏的关键按钮：只在等我、失败时出一个最要紧的（验收通过、追加预算继续 / 继续执行、重试）；手机上放进状态签浮层和"⋯" */
export function taskKeyItem(task: TaskMenuSubject): TaskMenuItem | undefined {
  if (task.state !== "waiting_for_user" && task.state !== "failed") return undefined;
  const items = taskActionItems(task);
  const act = (a: TaskMenuAct) => items.find((i) => i.kind === "act" && i.action === a);
  return items.find((i) => i.kind === "accept") ?? act("resume") ?? act("retry");
}

// ───────────────────────── "⋯"的上半：计划、工单、工具包、消耗、运行 ─────────────────────────

/** 原来任务详情的几个页签（90 号票：页签那一排去掉，收进"⋯"，会话占满） */
export type TaskPanel = "plan" | "orders" | "toolkit" | "usage" | "runs";

export const TASK_PANEL_LABEL: Readonly<Record<TaskPanel, string>> = tTable({
  plan: "state.taskMenu.panel.plan",
  orders: "state.taskMenu.panel.orders",
  toolkit: "state.taskMenu.panel.toolkit",
  usage: "state.taskMenu.panel.usage",
  runs: "state.taskMenu.panel.runs",
});

/**
 * "⋯"的上半有哪几项，顺序照票面：计划、工单 N（有工单的才有）、工具包、消耗（普通任务没有这四样：只有会话和工具调用详情，75 号票）、
 * 运行 N（定时、事件触发的任务，76 号票）
 */
export function taskPanels(p: { plain: boolean; timed: boolean; orders: number; runs: number }): Array<{ panel: TaskPanel; label: string }> {
  const out: Array<{ panel: TaskPanel; label: string }> = [];
  if (!p.plain) {
    out.push({ panel: "plan", label: TASK_PANEL_LABEL.plan });
    if (p.orders > 0) out.push({ panel: "orders", label: `${TASK_PANEL_LABEL.orders} ${p.orders}` });
    out.push({ panel: "toolkit", label: TASK_PANEL_LABEL.toolkit }, { panel: "usage", label: TASK_PANEL_LABEL.usage });
  }
  if (p.timed) out.push({ panel: "runs", label: `${TASK_PANEL_LABEL.runs} ${p.runs}` });
  return out;
}

// ───────────────────────── 状态签和它的浮层 ─────────────────────────

/**
 * 标题栏状态签上写什么：宽屏写全（"等我 · 超预算""已暂停 · 累计被拒"）；手机上一行里还有标题、阶段标签、"⋯"，只写短的——
 * 等我的写在等什么（"超预算"，颜色已经是等我的颜色），别的写状态（"执行中""已暂停""等时间"），全称在浮层第一行
 */
export function statusChipText(full: string, wide: boolean): string {
  if (wide) return full;
  // 等我的前缀照 board.ts 的 taskStatusText 那一句（"等我 · "，英文"Needs you · "）
  const waiting = t("state.board.status.waiting", { reason: "" });
  if (full.startsWith(waiting)) return full.slice(waiting.length);
  // 170 号票：英文的括号是半角、前面空一格
  return full.split(/ · |（| \(/)[0] ?? full; // @i18n-ignore data：认状态那句里的分隔（中文的全角括号、英文的半角括号）
}

/**
 * 状态签浮层里的原因说明（原来任务详情第 3 排）：等我写的原因（卡住求助、超预算用了多少预算多少……都是守护进程写的那句；
 * 中断不确定的说明自己就写着"中断：不确定……"，23 号票）、
 * 失败的原因；系统暂停的原因已经在状态签上（"已暂停 · 累计被拒"）
 */
export function taskStatusNote(task: { state: TaskState; waitReason?: TaskWaitReason | undefined; waitNote?: string | undefined; failReason?: string | undefined; pauseReason?: TaskPauseReason | undefined }): string | undefined {
  if (task.waitNote)
    return task.waitReason === "interrupted"
      ? task.waitNote
      : t("state.taskMenu.waitNote", { reason: task.waitReason ? TASK_WAIT_REASON_LABEL[task.waitReason] : t("state.taskMenu.stuck"), note: task.waitNote });
  if (task.failReason) return t("state.taskMenu.failReason", { reason: task.failReason });
  return undefined;
}

// ───────────────────────── 看板多选 ─────────────────────────

/** 操作栏上的按钮：暂停、继续、取消、归档、删除（185 号票加了删除，先只对简单提醒；186 号票起任务也能删） */
type BatchButton = TaskBatchAction;

/** 操作栏上的几个按钮（票面："已选 N 个 · 暂停 · 继续 · 取消 · 归档 · 完成"；185 号票起看板多了只对提醒的"删除"） */
export const BATCH_ACTION_LABEL: Readonly<Record<BatchButton, string>> = tTable({
  pause: "state.taskMenu.batch.pause",
  resume: "state.taskMenu.batch.resume",
  cancel: "state.taskMenu.batch.cancel",
  archive: "state.taskMenu.batch.archive",
  delete: "state.taskMenu.batch.delete",
});
/** 句子里的动作（"现在不能暂停"；英文小写） */
const BATCH_ACTION_VERB: Readonly<Record<BatchButton, string>> = tTable({
  pause: "state.taskMenu.batchVerb.pause",
  resume: "state.taskMenu.batchVerb.resume",
  cancel: "state.taskMenu.batchVerb.cancel",
  archive: "state.taskMenu.batchVerb.archive",
  delete: "state.taskMenu.batchVerb.delete",
});
/** 做完的那一句（"已暂停 N 个"） */
const BATCH_DONE_KEY: Readonly<Record<BatchButton, string>> = {
  pause: "state.taskMenu.batchDone.pause",
  resume: "state.taskMenu.batchDone.resume",
  cancel: "state.taskMenu.batchDone.cancel",
  archive: "state.taskMenu.batchDone.archive",
  delete: "state.taskMenu.batchDone.delete",
};

/**
 * 这个任务能不能一起做这件事：运营中的定时、事件触发的任务看它的触发登记（归档要先取消）；别的照"谁能改"表；
 * 项目在用时运营方案里的一条只能暂停、恢复（141 号票）
 */
export function canBatch(task: TaskMenuSubject, action: TaskBatchAction): boolean {
  // 141 号票：项目在用时运营方案里的一条不能取消、归档、删除
  if (task.operationsLock && (action === "cancel" || action === "archive" || action === "delete")) return false;
  // 186 号票：删除看能不能删（没结束的先停下再删）
  if (action === "delete") return task.deleteRefusal === undefined;
  // 186 号票：没结束的归档先取消（运营中的定时任务连同触发一起取消），能取消的都算
  if (task.state === "operating" && task.triggerActions) return task.triggerActions.includes(action === "archive" ? "cancel" : action);
  if (action === "archive") return availableTaskActions(task, "user").includes("archive") || archiveCancelsFirst(task);
  return availableTaskActions(task, "user").includes(action);
}

/** 这个任务还没结束：归档会先取消、删除会先停下（186 号票，确认框里写明几个） */
export const notEnded = (task: Pick<TaskMenuSubject, "state">): boolean => !ENDED_TASK_STATES.includes(task.state);

/** 多选里的一个任务 */
export interface BatchEntry {
  readonly id: string;
  readonly title: string;
  readonly subject: TaskMenuSubject;
}

/** 每个按钮能做几个（按钮上写"取消（3）"，一个都不能做时灰掉） */
export function batchCounts(entries: readonly BatchEntry[]): Record<TaskBatchAction, number> {
  const count = (a: TaskBatchAction) => entries.filter((e) => canBatch(e.subject, a)).length;
  return { pause: count("pause"), resume: count("resume"), cancel: count("cancel"), archive: count("archive"), delete: count("delete") };
}

/** 点了一个按钮：交给守护进程的（能做的）和跳过的（现在不能做的） */
export function batchTargets(entries: readonly BatchEntry[], action: TaskBatchAction): { ids: string[]; skipped: number } {
  const ids = entries.filter((e) => canBatch(e.subject, action)).map((e) => e.id);
  return { ids, skipped: entries.length - ids.length };
}

/** 取消先确认一次：写清几个会取消、几个跳过 */
export function batchCancelConfirm(n: number, skipped: number): { title: string; body: string } {
  return {
    title: t("state.taskMenu.cancelTitle", { count: n, n }),
    body: skipped > 0 ? t("state.taskMenu.cancelBodySkipped", { count: n, n, skipped }) : t("state.taskMenu.cancelBody", { count: n, n }),
  };
}

/** 单个任务删除先确认一次（186 号票）：写清会删掉什么、本人的话留着、收不回；还没结束的写明会先停下；没归档的提一句可以归档 */
export function taskDeleteConfirm(task: { title: string; cancelsFirst: boolean; archived: boolean }): { title: string; body: string } {
  const parts = [t("state.taskMenu.deleteConfirm.body", { name: ASSISTANT_NAME_MARK })];
  if (task.cancelsFirst) parts.unshift(t("state.taskMenu.deleteConfirm.running"));
  if (!task.archived) parts.push(t("state.taskMenu.deleteConfirm.archiveHint"));
  return { title: t("state.taskMenu.deleteConfirm.title", { title: task.title }), body: parts.join("") };
}

/** 没结束的任务归档先确认一次（186 号票）：会先取消再归档；运营中的定时、事件触发的连同触发一起取消 */
export function taskArchiveConfirm(task: { title: string; cancelsFirst: "task" | "trigger" }): { title: string; body: string } {
  return {
    title: t("state.taskMenu.archiveConfirm.title", { title: task.title }),
    body: task.cancelsFirst === "trigger" ? t("state.taskMenu.archiveConfirm.trigger") : t("state.taskMenu.archiveConfirm.body"),
  };
}

/** 守护进程逐条回报的一条（协议的 TaskBatchItemResult，加上原型的假条目在页面上做的） */
export type BatchItemResult = { readonly taskId: string; readonly ok: true } | { readonly taskId: string; readonly ok: false; readonly message: string };

/**
 * 做完提示结果：成功几个；跳过几个（点的时候就不能做的，没交给守护进程）；失败几个、每个为什么（"「标题」：原因"）。
 * 全成功时只有一句（页面底部的短提示），有没成的时候列出来
 */
export function batchResult(action: BatchButton, results: readonly BatchItemResult[], skipped: number, titleOf: (taskId: string) => string): { summary: string; failures: string[] } {
  const done = results.filter((r) => r.ok).length;
  const failed = results.filter((r): r is Extract<BatchItemResult, { ok: false }> => !r.ok);
  const parts = [t(BATCH_DONE_KEY[action], { n: done })];
  if (skipped > 0) parts.push(t("state.taskMenu.batchSkipped", { n: skipped, action: BATCH_ACTION_VERB[action] }));
  if (failed.length > 0) parts.push(t("state.taskMenu.batchFailed", { n: failed.length }));
  return { summary: parts.join(t("state.taskMenu.batchSep")), failures: failed.map((r) => t("state.taskMenu.batchFailure", { title: titleOf(r.taskId), message: r.message })) };
}

/** 勾上 / 去掉一个 */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 一组的"全选"：这一组都勾上了就全去掉（"取消全选"），否则全勾上；all 是点之前是不是都勾上了 */
export function groupSelection(selected: ReadonlySet<string>, ids: readonly string[]): { all: boolean; next: Set<string> } {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return { all, next };
}
