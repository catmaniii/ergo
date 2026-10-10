// 二狗自己的斜杠命令（82 号票）：输入框里打的 /流程、/任务（ADR 0019，58 号票），以后加的命令也登记在这张表里。
// - 命令怎么认只写在这里（commandAt）：打的字（去掉开头的空白）以命令开头，后面是空白、标点或者什么都没有
//   （"/流程图怎么画"不是命令）。发起任务的"点明"判定（tasks/launch-intent.ts）和 skill 的展开（skills/skill-command.ts）共用它；
// - 每个命令在哪几种会话里有：/流程、/任务 在秘书和项目的会话里（秘书建全局任务，项目的维护者建项目内部任务，64 号票），
//   任务详情里的会话没有发起任务的工具，就没有这两个命令；
// - 和 skill 同名时**二狗的命令优先，只在命令存在的会话里成立**（主会话 2026-10-10 定）：秘书、项目的会话里打的字被认成
//   /流程、/任务 时 skill 不展开，那个 skill 要写 /skill:目录名（候选里也这样写）；任务的会话里没有这两个命令，同名的 skill 直接
//   /目录名 就展开。候选列表和展开都按 ergouCommandsIn(会话的种类) 判，两边一致。
// 这里只有名字和说法，不引用别的模块（launch-intent.ts、skill-command.ts 都引用它，不绕圈）。
import { type TaskKind, TASK_KIND_LABEL } from "@ergou/protocol";

/** 发起任务的斜杠命令：打的字开头就是它 */
export const LAUNCH_COMMANDS: Readonly<Record<TaskKind, string>> = { workflow: "/流程", long_running: "/任务" };

/** 会话的种类（按它挑二狗自己的命令）：秘书、项目的维护者、任务的维护者（定时作业的维护者也算这一种：没有发起任务的工具） */
export type SlashConversationKind = "secretary" | "project" | "task";

/** 二狗自己的一个斜杠命令 */
export interface ErgouCommand {
  /** 写法（带 /）："/流程" */
  text: string;
  /** 一句说明（候选列表里显示） */
  description: string;
  /** 在哪几种会话里能用 */
  conversations: readonly SlashConversationKind[];
}

/** 二狗自己的斜杠命令（以后加的也登记在这里） */
export const ERGOU_COMMANDS: readonly ErgouCommand[] = [
  {
    text: LAUNCH_COMMANDS.workflow,
    description: `发起一个${TASK_KIND_LABEL.workflow}：维护者把要做的事排成步骤，你授权一次，照步骤做`,
    conversations: ["secretary", "project"],
  },
  {
    text: LAUNCH_COMMANDS.long_running,
    description: `发起一个${TASK_KIND_LABEL.long_running}：维护者分阶段做，逐阶段验收`,
    conversations: ["secretary", "project"],
  },
];

/** 打的字（去掉开头的空白）是不是以这个命令开头：命令后面是空白、标点或者什么都没有（"/流程图怎么画"不是命令） */
export function commandAt(text: string, command: string): boolean {
  const head = text.trimStart();
  return head.startsWith(command) && /^(?:$|[\s\p{P}])/u.test(head.slice(command.length));
}

/** 这种会话里有的二狗自己的命令 */
export function ergouCommandsIn(kind: SlashConversationKind): ErgouCommand[] {
  return ERGOU_COMMANDS.filter((c) => c.conversations.includes(kind));
}

/** 打的字以这些命令里的哪个开头（给的是这个会话里有的命令，见 ergouCommandsIn）；都不是时 undefined */
export function ergouCommandAt(text: string, commands: readonly ErgouCommand[]): ErgouCommand | undefined {
  return commands.find((c) => commandAt(text, c.text));
}
