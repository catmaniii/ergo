// 秘书建、改、取消简单提醒的三个工具：只产生卡片（聊天里出现提醒卡），不拉起别的 agent。
// 秘书在同一轮里自己选用，不另加分类器（规格第 7 节）。
// 秘书不一定知道今天几号：时间可以写成"几天后的几点"或"几分钟后"，日期由守护进程按现在的时间算，
// 工具结果里写明落到了哪天几点，让秘书复述给用户。29 号票往 repeat 里加"按我的工作日"。
import { nowIso, type ReminderSchedule, Type } from "@ergou/protocol";
import type { Clock } from "../scheduler/clock.ts";
import { defineSecretaryTool, type SecretaryTool, type SecretaryToolResult } from "../secretary/tools.ts";
import type { ReminderService } from "./reminders.ts";
import { describeSchedule, describeTime, ReminderInputError, type ReminderTimeSpec, resolveReminderTime } from "./schedule.ts";

const Repeat = Type.Object(
  {
    kind: Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], { description: "daily 每天；weekly 每周几；monthly 每月几号" }),
    weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { description: "weekly 时：周几，0 是周日、1 是周一……6 是周六" })),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { description: "monthly 时：几号（这个月没有这一天就在月底那天响）" })),
  },
  { description: "重复规则；不给就是一次性的" },
);

/** 和时间有关的参数（建和改共用） */
const timeParams = {
  time: Type.Optional(Type.String({ description: "几点，HH:mm（24 小时制），比如 09:00" })),
  date: Type.Optional(Type.String({ description: "哪天：YYYY-MM-DD，或只写 MM-DD（取最近的将来那天）" })),
  inDays: Type.Optional(Type.Integer({ minimum: 0, description: "几天后：0 是今天、1 是明天、2 是后天。不知道今天几号时用它，比如\"明早 9 点\"写 inDays 1、time 09:00" })),
  inMinutes: Type.Optional(Type.Integer({ minimum: 1, description: "多少分钟后，比如\"半小时后\"写 30；给了就不再给 time、date、inDays" })),
  repeat: Type.Optional(Repeat),
};

const CreateParams = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 500, description: "提醒什么，比如\"交报告\"" }), ...timeParams },
  { additionalProperties: false },
);

const UpdateParams = Type.Object(
  {
    reminderId: Type.String({ description: "提醒的编号，比如 r-3（建提醒时工具结果里给过）" }),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "新的内容；不改就不给" })),
    ...timeParams,
  },
  { additionalProperties: false },
);

const CancelParams = Type.Object({ reminderId: Type.String({ description: "提醒的编号，比如 r-3" }) }, { additionalProperties: false });

/** 时间不对之类：把原因交回秘书，让它改了再试 */
function guarded(f: () => SecretaryToolResult): SecretaryToolResult {
  try {
    return f();
  } catch (err) {
    if (err instanceof ReminderInputError) return { text: err.message, isError: true };
    throw err;
  }
}

export function reminderTools(reminders: ReminderService, clock: Clock): SecretaryTool[] {
  const now = () => new Date(clock.now());
  const when = (schedule: ReminderSchedule, nextAt: string | undefined): string =>
    schedule.kind === "once" ? describeTime(new Date(schedule.at), now()) : `${describeSchedule(schedule)}，下一次是 ${nextAt ? describeTime(new Date(nextAt), now()) : "（无）"}`;

  return [
    defineSecretaryTool({
      name: "create_reminder",
      description:
        "建一条简单提醒：到点给用户发一条通知（不需要别人干活）。一次性的给几点和哪天（或几天后、几分钟后）；重复的给几点和 repeat（每天、每周几、每月几号）。建好后聊天里会出现一张提醒卡，用户可以在卡上改或取消。",
      parameters: CreateParams,
      run: (args) =>
        guarded(() => {
          const schedule = resolveReminderTime(args, now());
          const { reminder, card } = reminders.create({ text: args.text, schedule }, "agent");
          return { text: `已建好提醒 ${reminder.id}「${reminder.text}」：${when(reminder.schedule, reminder.nextAt)}（现在是 ${describeTime(now())}）。`, cardIds: [card.id] };
        }),
    }),
    defineSecretaryTool({
      name: "update_reminder",
      description: "改一条还没响的简单提醒：改时间、重复规则或内容。只给要改的；只给几点时，日期和重复规则不变。",
      parameters: UpdateParams,
      run: (args) =>
        guarded(() => {
          const current = reminders.get(args.reminderId);
          const schedule = current ? updatedSchedule(current.schedule, args, now()) : undefined;
          const { reminder, card } = reminders.update(args.reminderId, { ...(args.text === undefined ? {} : { text: args.text }), ...(schedule ? { schedule } : {}) }, "agent");
          return { text: `已改好提醒 ${reminder.id}「${reminder.text}」：${when(reminder.schedule, reminder.nextAt)}。`, cardIds: [card.id] };
        }),
    }),
    defineSecretaryTool({
      name: "cancel_reminder",
      description: "取消一条还没响的简单提醒。",
      parameters: CancelParams,
      run: (args) =>
        guarded(() => {
          const { reminder, card } = reminders.cancel(args.reminderId, "agent");
          return { text: `已取消提醒 ${reminder.id}「${reminder.text}」。`, cardIds: [card.id] };
        }),
    }),
  ];
}

/**
 * 改提醒时新的时间规则；没给和时间有关的参数就是不改（undefined）。
 * - 给了 repeat：换成新的重复规则（没给几点就沿用原来的钟点）；
 * - 给了 date、inDays 或 inMinutes：换成一次性的（没给几点就沿用原来的钟点）；
 * - 只给了几点：重复的还按原来的规则，一次性的还在原来那天。
 */
function updatedSchedule(current: ReminderSchedule, spec: ReminderTimeSpec, now: Date): ReminderSchedule | undefined {
  const hasDay = spec.date !== undefined || spec.inDays !== undefined || spec.inMinutes !== undefined;
  if (spec.repeat === undefined && !hasDay && spec.time === undefined) return undefined;
  const currentTime = clockTimeOf(current);
  if (spec.repeat !== undefined) return resolveReminderTime({ time: spec.time ?? currentTime, repeat: spec.repeat }, now);
  if (hasDay) return resolveReminderTime(spec.inMinutes !== undefined ? spec : { ...spec, time: spec.time ?? currentTime }, now);
  if (current.kind === "once") return resolveReminderTime({ date: nowIso(new Date(current.at)).slice(0, 10), ...(spec.time === undefined ? {} : { time: spec.time }) }, now);
  return resolveReminderTime({ ...(spec.time === undefined ? {} : { time: spec.time }), repeat: current }, now);
}

function clockTimeOf(schedule: ReminderSchedule): string {
  if (schedule.kind !== "once") return schedule.time;
  const at = new Date(schedule.at);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
