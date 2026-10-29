// 简单提醒卡的长按 / 右键菜单（纯函数，156 号票）。用户 2026-10-18：简单提醒的卡片要能右键管理、能多选选中。
// - 菜单项照提醒现在能做的：待触发、到点提醒的"改时间"（带着现在的时间表，点了弹出改时间的对话框，存了落在提醒卡的 save 上）；
//   待触发的"取消提醒"（收不回，标红）；185 号票起已经结束的（一次性的已触发、已取消）"归档"（进看板的"已归档"；没有取消归档，照任务），
//   任何提醒"删除提醒"（先确认，标红）；后面"多选"（和任务卡一样进多选并勾上这一张）。
//   事件发生时提醒的没有时间表，不能改时间（提醒卡上同样不能改：要按时间提醒就取消了另建）。
// - 多选时提醒能一起做的：取消（待触发的）、归档（已经结束、没归档的）、删除（都能删）（canBatchReminder）；和任务混选的规则在 board-batch.ts。
// - 改时间的对话框（ui/reschedule-dialog.tsx 的 ReminderRescheduleDialog）：用提醒卡上同一个时间表编辑（一次性 / 每天、每周几、每月几号、
//   按我的工作日），没改的、一次性的时间已过的不能存（reminderRescheduleBlocked）；存了提示改成了什么（reminderRescheduledToast）。
import { describeSchedule, describeTime, type ReminderSchedule, t, type TaskBatchAction, tTable } from "./protocol.ts";

/**
 * 菜单、多选要看的提醒的样子：一次性的待触发 → 已触发，重复的、事件发生时提醒的一直待触发；任何时候能取消（185 号票起已取消的也在看板上）；
 * 已经结束的能归档（archived）。到点提醒的有时间表。删了的不上看板，不会走到这里
 */
export interface ReminderMenuSubject {
  readonly status: "pending" | "fired" | "cancelled";
  readonly schedule?: ReminderSchedule | undefined;
  readonly archived?: boolean | undefined;
}

/**
 * 提醒卡菜单里的一项：reschedule 改时间（带着现在的时间表，对话框预填它）、cancel 取消提醒（danger：收不回）、
 * archive 归档、delete 删除提醒（danger：先确认，收不回）、select 多选
 */
export type ReminderMenuItem =
  | { readonly kind: "reschedule"; readonly label: string; readonly schedule: ReminderSchedule }
  | { readonly kind: "cancel"; readonly label: string; readonly tone: "danger" }
  | { readonly kind: "archive"; readonly label: string }
  | { readonly kind: "delete"; readonly label: string; readonly tone: "danger" }
  | { readonly kind: "select"; readonly label: string };

/**
 * 菜单项的说法（170 号票起按当前语言现取）：改时间（和任务菜单里定时任务的"改时间"同一个说法，98 号票）、取消提醒（和提醒卡上的按钮
 * 同一个说法）、归档（和任务的同一个说法）、删除提醒、多选
 */
export const REMINDER_MENU_LABEL: Readonly<Record<ReminderMenuItem["kind"], string>> = tTable({
  reschedule: "state.reminderMenu.reschedule",
  cancel: "state.reminderMenu.cancel",
  archive: "state.reminderMenu.archive",
  delete: "state.reminderMenu.delete",
  select: "state.reminderMenu.select",
});

/** 已经结束了（一次性的已触发、已取消）、还没归档：能归档 */
const archivable = (r: ReminderMenuSubject) => r.status !== "pending" && !r.archived;

/** 提醒卡的长按 / 右键菜单：改时间（待触发、到点提醒的）、取消提醒（待触发的）、归档（结束了、没归档的）、删除提醒、多选 */
export function reminderMenu(r: ReminderMenuSubject): ReminderMenuItem[] {
  const out: ReminderMenuItem[] = [];
  if (r.status === "pending" && r.schedule) out.push({ kind: "reschedule", label: REMINDER_MENU_LABEL.reschedule, schedule: r.schedule });
  if (r.status === "pending") out.push({ kind: "cancel", label: REMINDER_MENU_LABEL.cancel, tone: "danger" });
  if (archivable(r)) out.push({ kind: "archive", label: REMINDER_MENU_LABEL.archive });
  out.push({ kind: "delete", label: REMINDER_MENU_LABEL.delete, tone: "danger" });
  out.push({ kind: "select", label: REMINDER_MENU_LABEL.select });
  return out;
}

/** 看板多选里，提醒能不能一起做这件事：取消（待触发的）、归档（已经结束、没归档的）、删除（都能删）；暂停、继续不能 */
export function canBatchReminder(r: ReminderMenuSubject, action: TaskBatchAction | "delete"): boolean {
  if (action === "cancel") return r.status === "pending";
  if (action === "archive") return archivable(r);
  return action === "delete";
}

/**
 * 删一条提醒之前确认一次（185 号票）：删了以后什么样、收不回；还没响的提一句只想不再提醒可以取消，结束了没归档的提一句可以归档
 */
export function reminderDeleteConfirm(title: string, r: ReminderMenuSubject): { title: string; body: string } {
  const key = r.status === "pending" ? "state.reminderMenu.deleteBody.pending" : archivable(r) ? "state.reminderMenu.deleteBody.ended" : "state.reminderMenu.deleteBody.archived";
  return { title: t("state.reminderMenu.deleteTitle", { title }), body: t(key) };
}

/** 改时间的对话框里的说明（170 号票起按当前语言现取，原来是常量 REMINDER_RESCHEDULE_HINT） */
export function reminderRescheduleHint(): string {
  return t("state.reminderMenu.hint");
}

/** 不能存的原因（保存按钮灰掉，按钮上悬停看得到）：和现在的一样、一次性的时间已经过了；能存是 undefined。nowMs 是此刻 */
export function reminderRescheduleBlocked(schedule: ReminderSchedule, current: ReminderSchedule, nowMs: number): string | undefined {
  if (JSON.stringify(schedule) === JSON.stringify(current)) return t("state.reminderMenu.same");
  if (schedule.kind === "once" && !(Date.parse(schedule.at) > nowMs)) return t("state.reminderMenu.past");
  return undefined;
}

/** 存了之后的提示："已改成每天 08:00"；一次性的"已改成 10 月 13 日（周二）08:00 提醒一次" */
export function reminderRescheduledToast(schedule: ReminderSchedule): string {
  if (schedule.kind === "once") return t("state.reminderMenu.toastOnce", { time: describeTime(new Date(schedule.at)) });
  return t("state.reminderMenu.toastRepeat", { schedule: describeSchedule(schedule) });
}
