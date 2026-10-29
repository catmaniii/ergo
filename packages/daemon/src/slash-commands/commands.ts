// 二狗自己的斜杠命令（82 号票）：输入框里打的 /workflow、/task（发起流程、长程任务，ADR 0019，58 号票），以后加的命令也登记在这张表里。
// - 命令怎么认只写在这里（commandAt）：打的字（去掉开头的空白）以命令开头，后面是空白、标点或者什么都没有
//   （"/流程图怎么画"不是命令）。发起任务的"点明"判定（tasks/launch-intent.ts）和 skill 的展开（skills/skill-command.ts）共用它；
// - 每个命令在哪几种会话里有：/workflow、/task 在秘书和项目的会话里（秘书建全局任务，项目的维护者建项目内部任务，64 号票），
//   任务详情里的会话没有发起任务的工具，就没有这两个命令；
// - 和 skill 同名时**二狗的命令优先，只在命令存在的会话里成立**（主会话 2026-10-10 定）：秘书、项目的会话里打的字被认成
//   /workflow、/task 时 skill 不展开，那个 skill 要写 /skill:目录名（候选里也这样写）；任务的会话里没有这两个命令，同名的 skill 直接
//   /目录名 就展开。候选列表和展开都按 ergoCommandsIn(会话的种类) 判，两边一致。
// 这里只有名字和说法，不引用别的模块（launch-intent.ts、skill-command.ts 都引用它，不绕圈）。
// 174 号票：命令的写法按字认，换语言也不变；候选里的说明给用户看，取的时候按现在的语言查（不在模块加载时取）。
// 175 号票加了英文别名（/ergo_workflow、/ergo_task），候选里中文界面写中文的写法、别的语言写英文别名。
// 310 号票（用户 2026-10-26 定"所有命令用英文"）：
// - 命令的写法一律是英文：/workflow、/task，记忆管理员的会话（含了解你访谈）里的 /interview（开一次访谈）、/consolidate（现在整理一次记忆）；
//   哪种界面语言候选里都写、选中都插英文的（说明照旧按界面语言）。中文的老写法（/流程、/任务、/访谈、/整理）和 175 号票的 /ergo_workflow、
//   /ergo_task 照样认（aliases），只是候选里不再列。175 号票"不占 /task、/workflow"不再成立：秘书、项目的会话里叫 task、workflow 的 skill
//   要写 /skill:目录名；
// - 英文写法后面紧跟 - _ : . / 的还是名字的一部分（/task-runner、/task:x 是 skill），不算这个命令（commandAt）；
// - 命令带参数提示（argumentHint，候选里写在写法后面："/workflow <要做的事>"），按现在的语言取；
// - 记忆管理员的两个命令和 /workflow 一样是给模型看的点名：管理员的工具说明里写明打了它们就调哪个工具（memory/curator-tools.ts、
//   interview-tools.ts 用 commandText 写）；访谈只在记忆插件给了访谈服务时有。
import { type PlannedTaskKind, t } from "@ergo/protocol";

/** 发起任务的斜杠命令：打的字开头就是它（只有要用户点明的流程、长程任务有；普通任务不用点明，75 号票）。310 号票起是英文的 */
export const LAUNCH_COMMANDS: Readonly<Record<PlannedTaskKind, string>> = { workflow: "/workflow", long_running: "/task" };

/** 发起任务的斜杠命令也认的写法：中文的老写法、175 号票的英文别名（打它们和打 LAUNCH_COMMANDS 的一样，候选里不列） */
export const LAUNCH_COMMAND_ALIASES: Readonly<Record<PlannedTaskKind, readonly string[]>> = {
  workflow: ["/流程", "/ergo_workflow"], // @i18n-ignore fixed：命令的写法按字认
  long_running: ["/任务", "/ergo_task"], // @i18n-ignore fixed：命令的写法按字认
};

/** 会话的种类（按它挑二狗自己的命令）：秘书、项目的维护者、任务的维护者（定时作业的维护者也算这一种：没有发起任务的工具）、记忆管理员（310 号票） */
export type SlashConversationKind = "secretary" | "project" | "task" | "curator";

/** 记忆管理员会话里的命令（310 号票）：开一次了解你访谈、现在整理一次记忆 */
export const CURATOR_COMMANDS = { interview: "/interview", consolidate: "/consolidate" } as const;

/** 记忆管理员会话里的命令也认的中文写法（310 号票） */
export const CURATOR_COMMAND_ALIASES: Readonly<Record<keyof typeof CURATOR_COMMANDS, readonly string[]>> = {
  interview: ["/访谈"], // @i18n-ignore fixed：命令的写法按字认
  consolidate: ["/整理"], // @i18n-ignore fixed：命令的写法按字认
};

/** 给模型看的说法里怎么写一个命令（工具说明、系统提示、交回秘书的原因）：英文的写法，也认的写法跟一句 */
export function commandText(text: string, aliases: readonly string[]): string {
  return aliases.length === 0 ? text : `${text}（也认 ${aliases.join("、")}）`; // @i18n-ignore model：工具说明、系统提示里的写法
}

/** 发起任务的命令给模型看的写法："/workflow（也认 /流程、/ergo_workflow）" */
export function launchCommandText(kind: PlannedTaskKind): string {
  return commandText(LAUNCH_COMMANDS[kind], LAUNCH_COMMAND_ALIASES[kind]);
}

/** 二狗自己的一个斜杠命令 */
export interface ErgoCommand {
  /** 写法（带 /，310 号票起是英文的）："/workflow"；候选里写它、选中插它 */
  text: string;
  /** 也认的写法（中文的老写法 "/流程"、175 号票的 "/ergo_workflow"）：打它也算这个命令，候选里不列 */
  aliases: readonly string[];
  /** 一句说明（候选列表里显示） */
  description: string;
  /** 参数提示（310 号票：候选里写在写法后面，选中插入时不插）；没有参数的没有 */
  argumentHint?: string;
  /** 在哪几种会话里能用 */
  conversations: readonly SlashConversationKind[];
}

/** 二狗自己的斜杠命令（以后加的也登记在这里） */
export const ERGO_COMMANDS: readonly ErgoCommand[] = [
  {
    text: LAUNCH_COMMANDS.workflow,
    aliases: LAUNCH_COMMAND_ALIASES.workflow,
    get description() {
      return t("slashCommands.workflow");
    },
    get argumentHint() {
      return t("slashCommands.hint.whatToDo");
    },
    conversations: ["secretary", "project"],
  },
  {
    text: LAUNCH_COMMANDS.long_running,
    aliases: LAUNCH_COMMAND_ALIASES.long_running,
    get description() {
      return t("slashCommands.longRunning");
    },
    get argumentHint() {
      return t("slashCommands.hint.whatToDo");
    },
    conversations: ["secretary", "project"],
  },
  {
    text: CURATOR_COMMANDS.interview,
    aliases: CURATOR_COMMAND_ALIASES.interview,
    get description() {
      return t("slashCommands.interview");
    },
    get argumentHint() {
      return t("slashCommands.hint.topic");
    },
    conversations: ["curator"],
  },
  {
    text: CURATOR_COMMANDS.consolidate,
    aliases: CURATOR_COMMAND_ALIASES.consolidate,
    get description() {
      return t("slashCommands.consolidate");
    },
    conversations: ["curator"],
  },
];

/**
 * 打的字（去掉开头的空白）是不是以这个命令开头：命令后面是空白、标点或者什么都没有（"/流程图怎么画"、"/tasks" 不是命令）；
 * 英文的写法后面紧跟 - _ : . / 的还是名字的一部分（"/task-runner"、"/task:x" 是 skill 的写法，310 号票），不算
 */
export function commandAt(text: string, command: string): boolean {
  const head = text.trimStart();
  if (!head.startsWith(command)) return false;
  const rest = head.slice(command.length);
  if (/[A-Za-z0-9]$/.test(command) && /^[-_:./]/.test(rest)) return false;
  return /^(?:$|[\s\p{P}])/u.test(rest);
}

/** 这种会话里有的二狗自己的命令 */
export function ergoCommandsIn(kind: SlashConversationKind): ErgoCommand[] {
  return ERGO_COMMANDS.filter((c) => c.conversations.includes(kind));
}

/** 打的字以这些命令里的哪个开头（给的是这个会话里有的命令，见 ergoCommandsIn；英文的写法、也认的写法都算）；都不是时 undefined */
export function ergoCommandAt(text: string, commands: readonly ErgoCommand[]): ErgoCommand | undefined {
  return commands.find((c) => [c.text, ...c.aliases].some((writing) => commandAt(text, writing)));
}
