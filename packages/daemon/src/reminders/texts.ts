// 简单提醒的说法（77 号票起事件发生时提醒的几句放在这里；编排里不写文字）。
import { describeTime } from "@ergou/protocol";

export const reminderText = {
  /** 时间表和事件只能写一样 */
  scheduleOrEvent: "提醒要么写什么时候（时间表），要么写事件发生时（event），二选一",
  /** 没接上事件来源（测试里不给 checkEvent 时） */
  noEventSources: "事件发生时提醒还没接上事件来源",
  /** 事件写得不对 */
  badEvent: (problems: readonly string[]) => `事件写得不对：${problems.join("；")}`,
  /** 事件发生时提醒响了：待我处理那一条的正文（事件的一句话和时刻） */
  eventBody: (summary: string, at: string) => `${summary}（${describeTime(new Date(at))}）`,
};
