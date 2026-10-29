// 提醒插件（126 号票，ADR-0027 的第一个适配器）：简单提醒在守护进程这一侧的全部登记都在这里，组合根只在插件清单里列它。
// - 数据契约（停用也登记）：提醒卡（卡片的形状、文字；动作现取提醒的服务），发起对话框里的"只提醒我"（create_reminder 请求）。
//   插件没启用时卡上的按钮、这个请求回"提醒插件没启用"；彻底删除、卡片改写后的新版本照常。302 号票起登记了提醒事件的改写函数
//   （purge.ts：没有素材来源采提醒，平时彻底删除碰不到；个人档案彻底删除生日、纪念日时连它建的每年提醒一起改写——内容换成删除标记、
//   时间去掉，连带同一条提醒的别的版本、提醒卡每个版本、待我处理里它的通知），提醒卡也有了 purge。
// - 装配：提醒的服务（reminders，经插件宿主按名字取：日历、秘书的提醒工具）、派生视图 reminders（定义里声明）、
//   看板上的"简单提醒"那一种、事件发生时提醒的订阅方（交给事件来源的分发）、工作日历变了重算"按我的工作日"的提醒。
// - start：还没到点的提醒登记进调度器（守护进程重启后照常触发），再按现在的工作日历对一遍（启动时节假日数据可能变了）；stop：取消计时器。
// - agent 那一侧（128 号票，agent 贡献缝）：秘书的建、改、取消、归档（185 号票）简单提醒四个工具经 ctx.agent 给秘书（只给秘书，排在它的
//   两个附件工具之后）；删除是快速动作 delete_reminder（185 号票，经 ctx.quickActions 登记，总要用户在卡上确认）。
//   系统提示里讲提醒的部分在定义里声明（prompts，见 prompt.ts：条件"提醒"、工具名和快速动作的占位符、片段 reminders）。
//   插件停用时秘书没有这些工具和快速动作、提示里没有提醒；看板、日历照常（没有提醒那一类）。
// - 185 号票：看板菜单、提醒卡上的按钮、看板多选对提醒的取消、归档、删除交前端请求 reminder_action（数据契约，停用也登记，回"提醒插件没启用"）。
// 没有素材来源、内部作业要登记（现在的提醒没有）。
// 211 号票（设置 · 插件）：一句话和它带来了什么（四个给秘书的工具、提醒卡）；移除时"连数据删"删全部提醒事件、提醒卡的每个版本、
// 待我处理里提醒的通知（提醒视图随之重放成空的），删不掉的是秘书会话里提到过的和备份快照里的（用户 2026-10-20 定）。
// 提醒卡没有"关掉"这个动作，不会有关掉提醒卡采成的素材，素材库不受影响。
import { CHANNELS, EVENT_TYPES, t } from "@ergo/protocol";
import type { EventSubscriberKind } from "../event-sources/index.ts";
import type { EventStore } from "../events/event-store.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { REMINDERS } from "./api.ts";
import { reminderBoardKind } from "./board-kind.ts";
import { reminderCardType } from "./card.ts";
import { deleteReminderAction } from "./delete-action.ts";
import { remindersPrompts } from "./prompt.ts";
import { reminderPurge } from "./purge.ts";
import { createReminderService, type ReminderService } from "./reminders.ts";
import { reminderText } from "./texts.ts";
import { reminderTools } from "./tools.ts";
import { listReminders, remindersView } from "./views.ts";

/** 事件发生时提醒的订阅方：每条待触发、写着等什么事件的提醒是一个订阅（r-N）；事件来了发一条通知 */
function reminderSubscriber(reminders: ReminderService, store: EventStore): EventSubscriberKind {
  return {
    kind: "reminder",
    subscriptions: () => listReminders(store.reader, "pending").flatMap((r) => (r.event ? [{ id: r.id, kind: "reminder", trigger: r.event, active: true }] : [])),
    // 提醒一变（建、改成到点提醒、取消……）就重算
    watches: (event) => event.channel === CHANNELS.board && event.type === EVENT_TYPES.reminder,
    deliver: (sub, trigger, key) => reminders.fireOnEvent(sub.id, trigger, key),
  };
}

export const remindersPlugin: PluginDefinition = {
  name: "reminders",
  get title() {
    return t("reminders.plugin.title");
  },
  get summary() {
    return t("reminders.plugin.summary");
  },
  get brings() {
    return { tools: [t("reminders.tool.create"), t("reminders.tool.update"), t("reminders.tool.cancel"), t("reminders.tool.archive")], cards: [t("reminders.plugin.card")] };
  },
  needs: [KERNEL.config, KERNEL.store, KERNEL.clock, KERNEL.scheduler, KERNEL.cards, KERNEL.inbox, KERNEL.workdayCalendar, KERNEL.eventTriggers],
  provides: [REMINDERS],
  views: [remindersView],
  prompts: remindersPrompts,
  contracts(ctx) {
    ctx.cardTypes.register(reminderCardType(() => ctx.active(REMINDERS)));
    // 发起对话框里的"只提醒我"（76 号票）：用户建的简单提醒（不用 agent，到点只发通知），同一幂等键重发拿到同一条
    ctx.requests.register("createReminder", (params, idempotencyKey) => ctx.active(REMINDERS).createFromUser(params, idempotencyKey));
    // 看板菜单、提醒卡上的按钮、看板多选（185 号票）：取消、归档、删除一条或几条，各自成败、逐条回报
    ctx.requests.register("reminderAction", (params, idempotencyKey) => ctx.active(REMINDERS).act(params, idempotencyKey));
    // 彻底删除（302 号票）：个人档案彻底删除生日、纪念日时，由它建的每年提醒的内容和时间一起改写
    ctx.purge.register(reminderPurge);
    // 移除时连数据一起彻底删除（211 号票）
    ctx.removal.declare({
      get deletes() {
        return [t("reminders.plugin.purge.reminders"), t("reminders.plugin.purge.cards"), t("reminders.plugin.purge.notices")];
      },
      get keeps() {
        return [t("reminders.plugin.keep.secretary"), t("reminders.plugin.keep.backup")];
      },
      events: [{ channel: CHANNELS.board, type: EVENT_TYPES.reminder }],
      cardTypes: ["reminder"],
      notices: ["reminder_due", "missed_reminder"],
    });
  },
  setup(ctx) {
    const config = ctx.use(KERNEL.config);
    const store = ctx.use(KERNEL.store);
    const workdayCalendar = ctx.use(KERNEL.workdayCalendar);
    const eventTriggers = ctx.use(KERNEL.eventTriggers);
    // 消息前的时间标记按配置的 timeZone，简单提醒的时间（06）按本机时区算：两者不一致时秘书写的提醒时间会差开
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const configuredZone = Intl.DateTimeFormat("en-US", { timeZone: config.timeZone }).resolvedOptions().timeZone;
    if (configuredZone !== localZone) ctx.log(reminderText.zoneMismatch(configuredZone, localZone));
    const reminders = createReminderService({
      store,
      cards: ctx.use(KERNEL.cards),
      inbox: ctx.use(KERNEL.inbox),
      scheduler: ctx.use(KERNEL.scheduler),
      clock: ctx.use(KERNEL.clock),
      // "按我的工作日"的提醒按当时的工作日历算下一次
      scheduleContext: () => ({ calendar: workdayCalendar.current() }),
      lateLimitMinutes: config.reminders.lateLimitMinutes,
      // 事件发生时提醒的（77）：事件触发方式经事件来源的分发查
      checkEvent: (trigger) => eventTriggers.check(trigger),
      log: (line) => ctx.log(line),
    });
    ctx.provide(REMINDERS, reminders);
    // 秘书的建、改、取消简单提醒（06；128 号票起由插件经 agent 贡献缝给秘书）：插件停了以后还没重新装配的秘书再调用，回"提醒插件没启用"
    let running = true;
    ctx.effect(() => () => {
      running = false;
    });
    const tools = reminderTools(() => (running ? reminders : undefined), ctx.use(KERNEL.clock));
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => tools });
    // 删除简单提醒（185 号票）：快速动作，总要用户在卡上确认
    ctx.quickActions.register(deleteReminderAction(() => (running ? reminders : undefined)));
    ctx.boardKinds.register(reminderBoardKind);
    ctx.eventSubscribers.register(reminderSubscriber(reminders, store));
    // 工作日历变了（个人设置、节假日数据）："按我的工作日"的提醒按新的工作日历重算下一次
    ctx.effect(() => workdayCalendar.onChange(() => reminders.recalculate()));
    ctx.lifecycle({
      start() {
        // 还没到点的提醒登记进调度器（守护进程重启后照常触发）；启动时节假日数据可能变了（框架发版、导入过新的）：按现在的工作日历对一遍
        reminders.start();
        reminders.recalculate();
      },
      stop: () => reminders.stop(),
    });
  },
};
