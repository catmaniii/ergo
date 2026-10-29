// 定时触发的任务改时间（98 号票，纯函数）：任务操作菜单里的"改时间"打开的对话框，和发起任务对话框同一套时间表编辑
// （按时间表反复做 / 某个时间做一次，TIMED_MODES；重复的含"按我的工作日"）。从触发登记现在的时间表起草；某个时间做一次的时间已过、
// 没改的不能存；保存后按守护进程回的（reschedule_job 的结果：状态、新的时间表、下一次）提示一句。
// 只换时间表：任务、会话、运行记录都不变，下一次按新的算；暂停着的改完照旧暂停。
import { describeSchedule, describeTime, isRepeating, nextClockTime, nowIso, type ReminderSchedule, type RescheduleJobResult, scheduleClockTime, t } from "./protocol.ts";
import type { TimedMode } from "./triggers.ts";

/** 对话框里正在改的：选的是哪一种，两种各自的时间表（切来切去不丢） */
export interface RescheduleDraft {
  mode: TimedMode;
  /** 按时间表反复做：重复的时间表 */
  repeat: ReminderSchedule;
  /** 某个时间做一次：一次性的时间表 */
  at: ReminderSchedule;
}

/**
 * 从现在的时间表起草：反复的选中"按时间表反复做"、预填它，另一种是这个钟点的下一次（今天没到是今天，过了是明天）；
 * 某个时间做一次的选中它、预填那个时间，另一种是每天这个钟点
 */
export function rescheduleDraft(current: ReminderSchedule, now: Date): RescheduleDraft {
  const time = scheduleClockTime(current);
  if (isRepeating(current)) return { mode: "repeat", repeat: current, at: { kind: "once", at: nowIso(nextClockTime(time, now)) } };
  return { mode: "at", repeat: { kind: "daily", time }, at: current };
}

/** 对话框里选定的时间表 */
export const draftSchedule = (draft: RescheduleDraft): ReminderSchedule => (draft.mode === "repeat" ? draft.repeat : draft.at);

/** 两份时间表是不是同一份（周几、几号由编辑框排好了，按写法比） */
const sameSchedule = (a: ReminderSchedule, b: ReminderSchedule): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 不能存的原因（保存按钮灰掉，下面写这句）：某个时间做一次的时间已经过了、和现在的一样；能存是 undefined。nowMs 是此刻 */
export function rescheduleBlocked(draft: RescheduleDraft, current: ReminderSchedule, nowMs: number): string | undefined {
  const schedule = draftSchedule(draft);
  if (schedule.kind === "once" && !(Date.parse(schedule.at) > nowMs)) return t("state.reschedule.past");
  if (sameSchedule(schedule, current)) return t("state.reschedule.same");
  return undefined;
}

/** 对话框里的说明：只换时间表；暂停着的改完照旧暂停；某个时间做一次的运行一次、做成了任务就算完成 */
export function rescheduleHint(mode: TimedMode, paused: boolean): string {
  const base = t("state.reschedule.hint.base");
  const once = mode === "at" ? t("state.reschedule.hint.once") : "";
  return `${base}${once}${paused ? t("state.reschedule.hint.paused") : ""}`.trimEnd();
}

/** 保存后的提示："已改成每天 08:00，下次 10 月 13 日（周二）08:00"；暂停着的说恢复后按新的；某个时间做一次的说运行一次 */
export function rescheduledToast(result: Pick<RescheduleJobResult, "state" | "schedule" | "nextAt">): string {
  const { schedule } = result;
  if (schedule.kind === "once") return t(result.state === "paused" ? "state.reschedule.toast.oncePaused" : "state.reschedule.toast.once", { time: describeTime(new Date(schedule.at)) });
  const described = describeSchedule(schedule);
  if (result.state === "paused") return t("state.reschedule.toast.repeatPaused", { schedule: described });
  return result.nextAt ? t("state.reschedule.toast.repeatNext", { schedule: described, next: describeTime(new Date(result.nextAt)) }) : t("state.reschedule.toast.repeat", { schedule: described });
}
