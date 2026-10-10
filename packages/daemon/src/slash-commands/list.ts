// 一个会话能用的斜杠命令（82 号票，GET HTTP_PATHS.slashCommands）：输入框里打 / 弹出的候选。
// - 先是这个会话能用的二狗自己的命令（commands.ts 的表），再是这个会话能用的 skill（按命令名排）；
// - 会话能用哪些 skill 和装配时一样现取：秘书的是设置里的名单（skills/secretary-skills.ts），项目的维护者是它此刻这一段的工具包
//   （对话段是项目的，执行的工单段是任务授权和项目的交集），任务的维护者是任务现在生效的计划里的（起草计划时没有）；
// - skill 的写法：/目录名（几个目录名相同时集合里的是 /集合名:目录名，skills/skill-command.ts 按整个库算）；在这个会话里会被认成
//   二狗自己的命令的（秘书、项目的会话里和 /流程、/任务 同名）写 /skill:目录名，选了照样展开成这个 skill；任务的会话里没有这两个命令，
//   同名的照样写 /目录名（和展开的规则一致）。
import { CHANNELS, MAINTAINER_CHANNEL_PREFIX, type SlashCommandEntry, type SlashCommandList } from "@ergou/protocol";
import { SKILL_COMMAND_PREFIX, type SkillCommand } from "../skills/skill-command.ts";
import { ergouCommandAt, ergouCommandsIn, type SlashConversationKind } from "./commands.ts";

/** 这种会话的候选：二狗自己的命令，再是这些 skill（按命令名排） */
export function slashCommandList(kind: SlashConversationKind, skills: readonly SkillCommand[]): SlashCommandList {
  const ergou = ergouCommandsIn(kind);
  const commands = ergou.map((c): SlashCommandEntry => ({ kind: "command", text: c.text, name: c.text.slice(1), description: c.description }));
  const skillEntries = skills
    // 按命令名的字符先后排（不按语言习惯排：哪台机器上都是同一个顺序）
    .toSorted((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
    .map((s): SlashCommandEntry => ({
      kind: "skill",
      // 在这个会话里会被认成二狗自己的命令的写 /skill:目录名（命令优先只在命令存在的会话里成立）
      text: ergouCommandAt(`/${s.command}`, ergou) ? `${SKILL_COMMAND_PREFIX}${s.command}` : `/${s.command}`,
      name: s.name,
      description: s.description,
      ...(s.collection ? { collection: s.collection } : {}),
    }));
  return { commands: [...commands, ...skillEntries] };
}

/** 现取会话能用的 skill 要的几样（daemon.ts 接上） */
export interface SlashCommandSources {
  /** 库里每个 skill 的斜杠命令（skills/skill-command.ts 的 skillCommands，按整个库算） */
  table(): readonly SkillCommand[];
  /** 秘书现在用的 skill 名 */
  secretarySkills(): readonly string[];
  /** 项目维护者此刻这一段的工具包里的 skill 名；不是项目的维护者时 undefined */
  projectSkills(maintainerId: string): readonly string[] | undefined;
  /** 任务维护者现在的工具包里的 skill 名；不是任务的维护者时 undefined */
  taskSkills(maintainerId: string): readonly string[] | undefined;
}

/** 这个会话能用的斜杠命令；没有这个会话（不是秘书，也不是项目或任务的维护者）时 undefined */
export function conversationSlashCommands(sources: SlashCommandSources, conversation: string): SlashCommandList | undefined {
  const of = (kind: SlashConversationKind, names: readonly string[]) => {
    const wanted = new Set(names);
    return slashCommandList(
      kind,
      sources.table().filter((s) => wanted.has(s.name)),
    );
  };
  if (conversation === CHANNELS.secretary) return of("secretary", sources.secretarySkills());
  if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
  const maintainerId = conversation.slice(MAINTAINER_CHANNEL_PREFIX.length);
  const project = sources.projectSkills(maintainerId);
  if (project) return of("project", project);
  const task = sources.taskSkills(maintainerId);
  return task ? of("task", task) : undefined;
}
