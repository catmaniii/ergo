// 秘书建、改、取消、归档（185 号票）简单提醒的四个工具：只产生卡片（聊天里出现提醒卡），不拉起别的 agent。
// 删除不是工具：走快速动作 delete_reminder（delete-action.ts），总要用户在卡上确认。
// 秘书在同一轮里自己选用，不另加分类器（规格第 7 节）。
// 时间的写法：具体的本地日期时间（at），哪天几点（date），最近的周几几点（weekday），几天后几点（inDays），几分钟后（inMinutes），
// 或者几点加重复规则（repeat，取自共享协议包的 RepeatRule：每天、每周几、每月几号、每年某月某日（282 号票，公历）、按我的工作日）。
// 工具结果里写明落到了哪天、星期几、几点，让秘书复述给用户。
// 128 号票起由提醒插件经 agent 贡献缝给秘书（reminders/plugin.ts），插件停用时秘书没有这三个工具。调用时现取提醒的服务：
// 插件运行中停了、秘书还没按新的贡献重新装配的那一会儿取不到，回"提醒插件没启用"（isError），不崩、不产生提醒和卡片。
// @i18n-ignore-file model：工具的说明、参数说明和结果给秘书（模型）看（174 号票）；工具的名字走 t()
import { describeSchedule, describeTime, forModel, isRepeating, jobTriggerText, type Reminder, RepeatRule, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { ReminderService } from "./reminders.ts";
import { editedSchedule, resolveReminderTime } from "./schedule.ts";
import { reminderText } from "./texts.ts";
import { REMINDER_TOOL } from "./tool-names.ts";

/** 和时间有关的参数（建和改共用） */
const timeParams = {
  at: Type.Optional(
    Type.String({
      description: "具体的本地日期时间，YYYY-MM-DD HH:mm。知道今天的日期时优先用它（用户消息前标着当前的本地日期、星期和时间）；凌晨说的\"明早\"一般指今天早上",
    }),
  ),
  time: Type.Optional(Type.String({ description: "几点，HH:mm（24 小时制），比如 09:00；配合 date、weekday、inDays 或 repeat 用" })),
  date: Type.Optional(Type.String({ description: "哪天：YYYY-MM-DD，或只写 MM-DD（取最近的将来那天）" })),
  weekday: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 6, description: "最近的那个周几（0 是周日、1 是周一……6 是周六），配合 time；今天就是这天且钟点还没到就是今天。要隔一周的（\"下下周五\"）用 at 写具体日期" }),
  ),
  inDays: Type.Optional(Type.Integer({ minimum: 0, description: "几天后：0 是今天、1 是明天、2 是后天，配合 time" })),
  inMinutes: Type.Optional(Type.Integer({ minimum: 1, description: "多少分钟后，比如\"半小时后\"写 30；给了就不再给 time" })),
  repeat: Type.Optional(RepeatRule),
};

const CreateParams = Type.Object({ text: Type.String({ minLength: 1, maxLength: 500, description: "提醒什么，比如\"交报告\"" }), ...timeParams }, { additionalProperties: false });

const UpdateParams = Type.Object(
  {
    reminderId: Type.String({ description: "提醒的编号，比如 r-3（建提醒时工具结果里给过）" }),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "新的内容；不改就不给" })),
    ...timeParams,
  },
  { additionalProperties: false },
);

/** 给了时间参数没有 */
const timeGiven = (args: Partial<Record<keyof typeof timeParams, unknown>>) => Object.keys(timeParams).some((k) => args[k as keyof typeof timeParams] !== undefined);

const CancelParams = Type.Object({ reminderId: Type.String({ description: "提醒的编号，比如 r-3" }) }, { additionalProperties: false });

const ArchiveParams = Type.Object({ reminderId: Type.String({ description: "提醒的编号，比如 r-3（用 view_board 查，已触发、已取消的在\"最近结束\"）" }) }, { additionalProperties: false });

/** 时间不对、编号不对之类：把原因交回秘书，让它改了再试 */
function guarded(f: () => HostToolOutput): HostToolOutput {
  try {
    return f();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

/** service：提醒的服务，每次调用时现取（提醒插件没启用时是 undefined） */
export function reminderTools(service: () => ReminderService | undefined, clock: Clock): HostTool[] {
  /** 现取提醒的服务；插件没启用时抛出，guarded 把它交回秘书 */
  const reminders = (): ReminderService => {
    const current = service();
    if (!current) throw new RequestRejected("not_allowed", reminderText.pluginOff);
    return current;
  };
  const now = () => new Date(clock.now());
  /** 落到了哪天、星期几、几点（重复的再写下一次） */
  const when = (r: Reminder): string => {
    if (!r.schedule) return jobTriggerText(r);
    return isRepeating(r.schedule) ? `${describeSchedule(r.schedule)}，下一次是 ${r.nextAt ? describeTime(new Date(r.nextAt), now()) : "（无）"}` : describeSchedule(r.schedule, now());
  };

  return [
    defineHostTool({
      name: REMINDER_TOOL.create,
      title: t("reminders.tool.create"),
      description:
        "建一条简单提醒：到点给用户发一条通知（不需要别人干活）。一次性的给具体日期时间（at），或者哪天 / 周几 / 几天后加几点，或者几分钟后；重复的给几点和 repeat（每天、每周几、每月几号、每年某月某日（公历，生日、纪念日这种；2 月 29 日在平年的 2 月 28 日响）、按我的工作日：用户个人工作日历上的上班日，含调休补班、不含休息日）。建好后聊天里会出现一张提醒卡，用户可以在卡上改或取消。",
      parameters: CreateParams,
      // 每调用一次多一条提醒
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { reminder, cardId } = reminders().create({ text: args.text, schedule: resolveReminderTime(args, now()) }, "agent");
          return { text: forModel(() => `已建好提醒 ${reminder.id}「${reminder.text}」：${when(reminder)}（现在是 ${describeTime(now())}）。`), cardIds: [cardId] };
        }),
    }),
    defineHostTool({
      name: REMINDER_TOOL.update,
      title: t("reminders.tool.update"),
      description: "改一条还没响的简单提醒：改时间、重复规则或内容。只给要改的；只给几点时，日期和重复规则不变；\"改到周五\"给 weekday（钟点不变）。",
      parameters: UpdateParams,
      // 改原有的提醒
      nature: "modify",
      // 重做一次结果相同，但卡片会多一个版本、提醒的修改记录多一条：从严算不是
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const current = reminders().get(args.reminderId);
          // 事件发生时提醒的（77 号票）没有时间表：给了时间就改成到点提醒
          const schedule = current?.schedule ? editedSchedule(current.schedule, args, now()) : current && timeGiven(args) ? resolveReminderTime(args, now()) : undefined;
          const { reminder, cardId } = reminders().update(args.reminderId, { ...(args.text === undefined ? {} : { text: args.text }), ...(schedule ? { schedule } : {}) }, "agent");
          return { text: forModel(() => `已改好提醒 ${reminder.id}「${reminder.text}」：${when(reminder)}（现在是 ${describeTime(now())}）。`), cardIds: [cardId] };
        }),
    }),
    defineHostTool({
      name: REMINDER_TOOL.cancel,
      title: t("reminders.tool.cancel"),
      description: "取消一条还没响的简单提醒。",
      parameters: CancelParams,
      // 去掉原有的提醒
      nature: "modify",
      // 已经取消的再取消会报错：从严算不是
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { reminder, cardId } = reminders().cancel(args.reminderId, "agent");
          return { text: `已取消提醒 ${reminder.id}「${reminder.text}」。`, cardIds: [cardId] };
        }),
    }),
    defineHostTool({
      name: REMINDER_TOOL.archive,
      title: t("reminders.tool.archive"),
      description: "归档一条已经结束的简单提醒（响过的一次性提醒、已取消的）：看板上从\"最近结束\"挪进\"已归档\"。还没响的不能归档（要先取消）；归档了不能取消归档。",
      parameters: ArchiveParams,
      // 改原有的提醒（挪个分组，不删东西）
      nature: "modify",
      // 已经归档的再归档会报错：从严算不是
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { reminder, cardId } = reminders().archive(args.reminderId, "agent");
          return { text: `已归档提醒 ${reminder.id}「${reminder.text}」：看板上挪进了“已归档”。`, cardIds: [cardId] };
        }),
    }),
  ];
}
