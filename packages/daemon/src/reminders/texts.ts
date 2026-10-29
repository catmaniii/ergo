// 简单提醒的说法（77 号票起事件发生时提醒的几句放在这里；编排里不写文字）。
import { describeTime, t } from "@ergo/protocol";

export const reminderText = {
  /** 时间表和事件只能写一样 */
  scheduleOrEvent: () => t("reminders.scheduleOrEvent"),
  /** 没接上事件来源（测试里不给 checkEvent 时） */
  noEventSources: () => t("reminders.noEventSources"),
  /** 事件写得不对 */
  badEvent: (problems: readonly string[]) => t("reminders.badEvent", { problems: problems.join(t("reminders.listSep")) }),
  /** 事件发生时提醒响了：待我处理那一条的正文（事件的一句话和时刻） */
  eventBody: (summary: string, at: string) => t("reminders.eventBody", { summary, at: describeTime(new Date(at)) }),
  /**
   * 提醒插件停了（126 号票）：128 号票起配置停用时秘书没有提醒工具；只有运行中停用（测试用）、秘书还没按新的贡献重新装配的那一会儿，
   * 调用时回这句
   */
  pluginOff: "提醒插件没启用：现在建不了、改不了、取消不了提醒（用户停用了提醒插件）。如实告诉用户，不要说已经建好。", // @i18n-ignore model：交给秘书的工具结果
  /** 提醒的时间（本机时区）和消息前的时间标记（配置的 timeZone）不一致时，守护进程启动时记一条 */
  zoneMismatch: (configured: string, local: string) =>
    `配置的 timeZone 是 ${configured}，本机时区是 ${local}：秘书看到的消息时间按前者，简单提醒的时间按本机时区算，两者会差开；不需要另设时区时把 timeZone 去掉`, // @i18n-ignore log：启动时的日志
};
