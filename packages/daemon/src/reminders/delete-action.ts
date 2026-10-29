// 快速动作"删除简单提醒"（185 号票，用户 2026-10-20："打个电话这种简单提醒没办法归档和删除和取消"）：用户对秘书说
// "把打个电话那条提醒删了"，秘书用"提议快速动作"提出 delete_reminder，参数是提醒的编号。
// - 删除照现有删除类的做法先在聊天里出确认（记忆删除、授权文件夹）：confirm: "always"，不管用户原话点没点名，都出一张待确认的卡
//   （卡上写删哪一条），同时进待我处理，用户点"执行"才删；秘书的归档（archive_reminder）、取消（cancel_reminder）照旧是直接做的工具；
// - 规范化时就核对：编号对不上的、删过的不出卡，原因（连同现在有哪些提醒）回给秘书；执行时再核对一遍（确认之前可能在看板上删过了），
//   不让做的抛 RequestRejected，卡片保持待处理；
// - 执行就是提醒服务的删除（by 用户：用户在卡上确认的），和卡片更新、操作记录同一事务：提醒变成已删除、时间表停掉，提醒卡写已删除，
//   待我处理里它的事项删掉；
// - 不落入任何内置类别（用户的自定义类别照样能按 quick_action:delete_reminder 匹配它）。
// 由提醒插件经 ctx.quickActions 登记（plugin.ts），插件停用时没有这个动作。
import { t, Type } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { defineQuickAction, type QuickActionExecutor } from "../quick-actions/index.ts";
import type { ReminderService } from "./reminders.ts";
import { reminderText } from "./texts.ts";
import { DELETE_REMINDER_ACTION } from "./tool-names.ts";

const Params = Type.Object(
  { reminderId: Type.String({ minLength: 1, description: "提醒的编号，比如 r-3（用 view_board 查，或者照抄建提醒时工具结果里给的）" }) }, // @i18n-ignore model：参数说明
  { additionalProperties: false },
);

/** 快速动作"删除简单提醒"；service 每次现取（提醒插件没启用时是 undefined） */
export function deleteReminderAction(service: () => ReminderService | undefined): QuickActionExecutor {
  const reminders = (): ReminderService => {
    const current = service();
    if (!current) throw new RequestRejected("not_allowed", reminderText.pluginOff);
    return current;
  };
  return defineQuickAction({
    type: DELETE_REMINDER_ACTION,
    get title() {
      return t("reminders.deleteAction.title");
    },
    // @i18n-ignore-next model：给秘书的用法
    usage: "用户要删掉一条简单提醒（“把打个电话那条提醒删了”）：任何状态的都能删，还没响的先停掉；删了看板、日历、待办里都不再有它，聊天里那张提醒卡写“已删除”。总会出一张卡请用户确认后才删（只是不想它再响的用 cancel_reminder，响过、取消了想收起来的用 archive_reminder）",
    params: Params,
    watch: { categories: [] },
    confirm: "always",
    normalize({ reminderId }) {
      // 只为核对（编号对不上、删过的抛出，原因连同现在有哪些提醒写明）：事件不追加
      const { reminder } = reminders().buildRemove(reminderId, "user");
      return { params: { reminderId: reminder.id }, title: t("reminders.deleteAction.actionTitle", { id: reminder.id, text: reminder.text }) };
    },
    execute(params) {
      // 用户在卡上确认的：提醒的事件和卡片更新、操作记录同一事务
      const { reminder, events } = reminders().buildRemove((params as { reminderId: string }).reminderId, "user");
      return { events, summary: t("reminders.deleteAction.done", { id: reminder.id, text: reminder.text }) };
    },
  });
}
