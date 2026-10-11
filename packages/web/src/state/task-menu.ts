// 任务的操作菜单和看板多选（纯函数，90 号票）。用户 2026-10-11：看板上长按 / 右键任务卡片要能操作这个任务，最好能批量管理；
// 任务详情顶部四排太占地方，并成一行、收进管理菜单。
// - "这个任务现在能做什么"只有一份（taskActionItems）：照共享协议包的 availableTaskActions（"谁能改"表推出，守护进程按同一份再判一次）
//   按种类和状态变；看板卡的长按 / 右键菜单（taskMenu 的 board：多了"打开""多选"）、任务详情标题栏的"⋯"、状态签浮层都用它。
//   定时、事件触发的任务运营中时，暂停、恢复、取消落到它的触发上（76 号票），菜单项照它的触发登记能做的；
// - 标题栏的关键按钮（taskKeyItem）：只在等我、失败时出一个最要紧的——验收通过、追加预算继续 / 继续执行、重试；
// - "⋯"的上半（taskPanels）：计划、工单 N（有才有）、工具包、消耗、运行 N（定时触发的任务），宽屏在右边的详情栏打开、手机整页；
// - 状态签浮层要的原因说明（taskStatusNote）：守护进程写的原因（超预算的用量也照它写的，评审 2026-10-11：追加预算后工具调用重新计数，
//   前端自己从阶段算的数字和守护进程的判断对不上）；
// - 看板多选（canBatch、batchCounts、batchTargets、batchResult）：每个操作只对能做的生效，按钮上写个数；结果逐条回报。
import {
  availableTaskActions,
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
}

/** 按钮上写的第几阶段：各阶段都给了前置就按依赖图的编号（stageCodes），否则是计划里的第几个 */
function stageNoOf(list: readonly MenuStage[]): (s: MenuStage) => string {
  if (!list.every((s) => s.dependsOn !== undefined)) return (s) => String(list.indexOf(s) + 1);
  const codes = stageCodes(list.map((s) => ({ id: s.stageId, after: s.dependsOn ?? [] })));
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
}

/** 落到任务上的几个动作（不用指明阶段的） */
export type TaskMenuAct = Extract<TaskAction, "pause" | "resume" | "retry" | "cancel" | "archive">;

/**
 * 菜单里的一项：
 * - open 打开（看板上才有）、select 多选（看板上才有）；
 * - act 落到任务上的动作；accept 某个阶段验收通过；back 退回（点了弹出写原因的对话框）；
 * - rework 已完成的"返工…"、别的时候"从某阶段重做…"（长程任务，点了先选阶段）；
 * - trigger 运营中的定时、事件触发的任务落到触发上的暂停、恢复、取消。
 * tone：primary 是最要紧的那个，danger 是取消这类收不回的
 */
export type TaskMenuItem =
  | { readonly kind: "open"; readonly label: string }
  | { readonly kind: "act"; readonly action: TaskMenuAct; readonly label: string; readonly tone?: "primary" | "danger" }
  | { readonly kind: "accept"; readonly stageId: string; readonly label: string; readonly tone: "primary" }
  | { readonly kind: "back"; readonly stageId: string; readonly label: string }
  | { readonly kind: "rework"; readonly label: string }
  | { readonly kind: "trigger"; readonly action: ScheduledJobAction; readonly label: string; readonly tone?: "danger" }
  | { readonly kind: "select"; readonly label: string };

/** 触发上的三个动作在菜单里怎么写（取消触发时任务一起取消，所以写"取消任务"） */
const TRIGGER_ITEM_LABEL: Readonly<Record<ScheduledJobAction, string>> = { pause: "暂停", resume: "恢复", cancel: "取消任务" };

/** 开始过的阶段（协议包 stageStarted 的口径：不是未开始，或者开始过又放下了） */
const started = (s: MenuStage) => s.state !== "pending" || s.startedAt !== undefined;

/**
 * 这个任务现在能做的（菜单的下半、状态签浮层的按钮），顺序照票面：验收（有在等你验收的阶段时，最要紧放最前）、暂停、
 * 继续 / 追加预算继续、重试、取消任务、从某阶段重做、归档
 */
export function taskActionItems(task: TaskMenuSubject): TaskMenuItem[] {
  if (task.state === "operating" && task.triggerActions) {
    return task.triggerActions.map((action): TaskMenuItem => ({ kind: "trigger", action, label: TRIGGER_ITEM_LABEL[action], ...(action === "cancel" ? { tone: "danger" as const } : {}) }));
  }
  const can = new Set(availableTaskActions(task, "user"));
  const list = task.stages?.list ?? [];
  const no = stageNoOf(list);
  const out: TaskMenuItem[] = [];
  if (can.has("accept_stage")) {
    for (const s of list) {
      if (s.state !== "waiting" || s.waitReason !== "acceptance") continue;
      out.push({ kind: "accept", stageId: s.stageId, label: `第 ${no(s)} 阶段验收通过`, tone: "primary" }, { kind: "back", stageId: s.stageId, label: "退回…" });
    }
  }
  if (can.has("pause")) out.push({ kind: "act", action: "pause", label: "暂停" });
  // 超预算的"继续"就是追加预算继续（这个阶段重新给一整份预算，14 号票）
  if (can.has("resume")) out.push({ kind: "act", action: "resume", label: task.state === "paused" ? "继续" : task.waitReason === "over_budget" ? "追加预算继续" : "继续执行" });
  if (can.has("retry")) out.push({ kind: "act", action: "retry", label: "重试" });
  if (can.has("cancel")) out.push({ kind: "act", action: "cancel", label: "取消任务", tone: "danger" });
  // 从某个阶段重做（84 号票，照 AgentSense：开始过的阶段就能）；已完成的叫返工
  if (can.has("rework") && list.some(started)) out.push({ kind: "rework", label: task.state === "done" ? "返工…" : "从某阶段重做…" });
  if (can.has("archive")) out.push({ kind: "act", action: "archive", label: "归档" });
  return out;
}

/** 看板卡的长按 / 右键菜单（board：前面"打开"、后面"多选"）、任务详情的"⋯"的下半（detail） */
export function taskMenu(task: TaskMenuSubject, where: "board" | "detail"): TaskMenuItem[] {
  const items = taskActionItems(task);
  return where === "board" ? [{ kind: "open", label: "打开" }, ...items, { kind: "select", label: "多选" }] : items;
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

export const TASK_PANEL_LABEL: Readonly<Record<TaskPanel, string>> = { plan: "计划", orders: "工单", toolkit: "工具包", usage: "消耗", runs: "运行" };

/**
 * "⋯"的上半有哪几项，顺序照票面：计划、工单 N（有工单的才有）、工具包、消耗（普通任务没有这四样：只有会话和工具调用详情，75 号票）、
 * 运行 N（定时、事件触发的任务，76 号票）
 */
export function taskPanels(t: { plain: boolean; timed: boolean; orders: number; runs: number }): Array<{ panel: TaskPanel; label: string }> {
  const out: Array<{ panel: TaskPanel; label: string }> = [];
  if (!t.plain) {
    out.push({ panel: "plan", label: TASK_PANEL_LABEL.plan });
    if (t.orders > 0) out.push({ panel: "orders", label: `${TASK_PANEL_LABEL.orders} ${t.orders}` });
    out.push({ panel: "toolkit", label: TASK_PANEL_LABEL.toolkit }, { panel: "usage", label: TASK_PANEL_LABEL.usage });
  }
  if (t.timed) out.push({ panel: "runs", label: `${TASK_PANEL_LABEL.runs} ${t.runs}` });
  return out;
}

// ───────────────────────── 状态签和它的浮层 ─────────────────────────

/**
 * 标题栏状态签上写什么：宽屏写全（"等我 · 超预算""已暂停 · 累计被拒"）；手机上一行里还有标题、阶段标签、"⋯"，只写短的——
 * 等我的写在等什么（"超预算"，颜色已经是等我的颜色），别的写状态（"执行中""已暂停""等时间"），全称在浮层第一行
 */
export function statusChipText(full: string, wide: boolean): string {
  if (wide) return full;
  if (full.startsWith("等我 · ")) return full.slice("等我 · ".length);
  return full.split(/ · |（/)[0] ?? full;
}

/**
 * 状态签浮层里的原因说明（原来任务详情第 3 排）：等我写的原因（卡住求助、超预算用了多少预算多少……都是守护进程写的那句；
 * 中断不确定的说明自己就写着"中断：不确定……"，23 号票）、
 * 失败的原因；系统暂停的原因已经在状态签上（"已暂停 · 累计被拒"）
 */
export function taskStatusNote(task: { state: TaskState; waitReason?: TaskWaitReason | undefined; waitNote?: string | undefined; failReason?: string | undefined; pauseReason?: TaskPauseReason | undefined }): string | undefined {
  if (task.waitNote) return task.waitReason === "interrupted" ? task.waitNote : `${task.waitReason ? TASK_WAIT_REASON_LABEL[task.waitReason] : "卡住了"}：${task.waitNote}`;
  if (task.failReason) return `失败的原因：${task.failReason}`;
  return undefined;
}

// ───────────────────────── 看板多选 ─────────────────────────

/** 操作栏上的几个按钮（票面："已选 N 个 · 暂停 · 继续 · 取消 · 归档 · 完成"） */
export const BATCH_ACTION_LABEL: Readonly<Record<TaskBatchAction, string>> = { pause: "暂停", resume: "继续", cancel: "取消", archive: "归档" };
const BATCH_DONE_LABEL: Readonly<Record<TaskBatchAction, string>> = { pause: "已暂停", resume: "已继续", cancel: "已取消", archive: "已归档" };

/** 这个任务能不能一起做这件事：运营中的定时、事件触发的任务看它的触发登记（归档要先取消）；别的照"谁能改"表 */
export function canBatch(task: TaskMenuSubject, action: TaskBatchAction): boolean {
  if (task.state === "operating" && task.triggerActions) return action !== "archive" && task.triggerActions.includes(action);
  return availableTaskActions(task, "user").includes(action);
}

/** 多选里的一个任务 */
export interface BatchEntry {
  readonly id: string;
  readonly title: string;
  readonly subject: TaskMenuSubject;
}

/** 每个按钮能做几个（按钮上写"取消（3）"，一个都不能做时灰掉） */
export function batchCounts(entries: readonly BatchEntry[]): Record<TaskBatchAction, number> {
  const count = (a: TaskBatchAction) => entries.filter((e) => canBatch(e.subject, a)).length;
  return { pause: count("pause"), resume: count("resume"), cancel: count("cancel"), archive: count("archive") };
}

/** 点了一个按钮：交给守护进程的（能做的）和跳过的（现在不能做的） */
export function batchTargets(entries: readonly BatchEntry[], action: TaskBatchAction): { ids: string[]; skipped: number } {
  const ids = entries.filter((e) => canBatch(e.subject, action)).map((e) => e.id);
  return { ids, skipped: entries.length - ids.length };
}

/** 取消先确认一次：写清几个会取消、几个跳过 */
export function batchCancelConfirm(n: number, skipped: number): { title: string; body: string } {
  return {
    title: `取消 ${n} 个任务？`,
    body: `${n} 个会取消${skipped > 0 ? `，${skipped} 个跳过（已经结束了，或者现在不能取消）` : ""}。取消了的不再执行，会话和记录都留着；定时触发的连同触发一起取消。想先停一停可以用"暂停"。`,
  };
}

/** 守护进程逐条回报的一条（协议的 TaskBatchItemResult，加上原型的假条目在页面上做的） */
export type BatchItemResult = { readonly taskId: string; readonly ok: true } | { readonly taskId: string; readonly ok: false; readonly message: string };

/**
 * 做完提示结果：成功几个；跳过几个（点的时候就不能做的，没交给守护进程）；失败几个、每个为什么（"「标题」：原因"）。
 * 全成功时只有一句（页面底部的短提示），有没成的时候列出来
 */
export function batchResult(action: TaskBatchAction, results: readonly BatchItemResult[], skipped: number, titleOf: (taskId: string) => string): { summary: string; failures: string[] } {
  const done = results.filter((r) => r.ok).length;
  const failed = results.filter((r): r is Extract<BatchItemResult, { ok: false }> => !r.ok);
  const parts = [`${BATCH_DONE_LABEL[action]} ${done} 个`];
  if (skipped > 0) parts.push(`跳过 ${skipped} 个（现在不能${BATCH_ACTION_LABEL[action]}）`);
  if (failed.length > 0) parts.push(`${failed.length} 个没成`);
  return { summary: parts.join("，"), failures: failed.map((r) => `「${titleOf(r.taskId)}」：${r.message}`) };
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
