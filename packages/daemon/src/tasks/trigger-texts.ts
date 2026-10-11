// 任务的触发方式的说法（76、77 号票）：任务书、通知里"什么时候做"那几句，事件触发方式被拒的原因。编排（tasks.ts）里不写文字。
import { describeEventTrigger, describeSchedule, describeTime, type EventTrigger, type ReminderSchedule, triggerFields } from "@ergou/protocol";

/** 事件触发的写得不对（77 号票）：来源、事件、过滤条件哪里不对 */
export const EVENT_TRIGGER_PROBLEMS = (problems: readonly string[]) => `"事件发生时"写得不对：${problems.join("；")}`;

/** 没接上事件来源（测试里不给 checkEventTrigger 时） */
export const NO_EVENT_SOURCES = "事件来源还没接上";

/**
 * 事件触发的流程（77 号票）：任务书里"什么时候做"那几句——在等什么事件、步骤参数里怎么写占位、能用哪些字段、执行时怎么代入
 * （文件工具的参数直接代入；通用 bash 的命令里换成引用环境变量，值不拼进命令）
 */
export function eventTriggerLines(event: EventTrigger): string {
  const fields = triggerFields(event);
  return [
    `什么时候做：事件发生时——${describeEventTrigger(event)}（用户授权计划之后，每来一次事件是一次运行，各次运行接着同一段会话；上一次还没跑完又来的事件合成一批交给下一次运行）。`,
    `步骤的参数（和标题）里要用这次事件的值，就写成占位 {{事件.字段名}}，比如 {{事件.${fields[0]?.label ?? "字段名"}}}；能用的字段：${fields.map((f) => `${f.label}（${f.hint}）`).join("、")}。`,
    "每次运行执行前代入这次事件的值，守卫按代入后的值逐步核对、授权；一批里有几个事件，就对每个事件各走一遍步骤。",
    "通用 bash 的命令里照样写占位（不用加引号）：执行时值不拼进命令，占位换成引用环境变量（ERGOU_EVENT_…），文件名里有引号、$ 这些也不会改变命令的意思。",
    "所以要排成每个事件都能照着做的步骤，写死的只写每次都一样的东西。",
  ].join("\n");
}

/** 某个时间做一次（76 号票） */
export const onceTriggerLine = (at: string) => `什么时候做：${describeTime(new Date(at))} 做一次（用户授权计划之后等到那个时间再开始，之后和现在做一次的一样，做完就算完成）`;

/** 按时间表反复做（76 号票） */
export const scheduleTriggerLine = (schedule: ReminderSchedule) =>
  `什么时候做：定时，${describeSchedule(schedule)}（用户授权计划之后按时间表反复运行，每次一次运行，各次运行接着同一段会话；每次运行都按授权的步骤核对，所以要排成每次都能照着重复做的步骤）`;
