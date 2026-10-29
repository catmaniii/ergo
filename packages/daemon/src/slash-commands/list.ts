// 一个会话能用的斜杠命令（82 号票，GET HTTP_PATHS.slashCommands）：输入框里打 / 弹出的候选。
// - 先是这个会话能用的二狗自己的命令（commands.ts 的表），再是这个会话能用的 skill（按命令名排）；
// - 会话能用哪些 skill 和装配时一样现取：秘书的是设置里的名单（skills/secretary-skills.ts），项目的维护者是它此刻这一段的工具包
//   （对话段是项目的，执行的工单段是任务授权和项目的交集），任务的维护者是任务现在生效的计划里的（起草计划时没有）；
// - skill 的写法：/目录名（几个目录名相同时集合里的是 /集合名:目录名，skills/skill-command.ts 按整个库算）；在这个会话里会被认成
//   二狗自己的命令的（秘书、项目的会话里和 /workflow、/task 同名，中文老写法 /流程、/任务 也算）写 /skill:目录名，选了照样展开成这个 skill；任务的会话里没有这两个命令，
//   同名的照样写 /目录名（和展开的规则一致）。
// - 289 号票：维护者用的运行时能转交斜杠命令的（Claude Code，能力清单 slash_passthrough）——二狗自己的命令之后是运行时报的命令
//   （kind 是 runtime，集合名写运行时的名字），二狗的 skill 不按 /目录名 列（打了也原样交给运行时，不展开）。
// - 291 号票：这个维护者工具包里的 skill 交给了运行时（Claude Code 拼成本地插件 ergo），按运行时里的写法列（kind 是 skill，/ergo:<目录名>，
//   显示的名字照 SKILL.md），排在二狗自己的命令之后、运行时报的命令之前；运行时报的命令里有同名的不重复列。
// - 310 号票：
//   - 带参数提示（argumentHint：二狗的命令按现在的语言写的、运行时报的；空的不带），候选里写在写法后面；
//   - 运行时报的说明不是用户的语言时，先查运行时自带命令的说明表（AgentRuntime.commandText：Claude Code 内置命令的中文说明），查到的换上、
//     原文放 originalDescription；参数提示同样（只换运行时报了的）。表里没有的由 translations.ts 交给二狗的模型翻；
//   - 记忆管理员的会话（含了解你访谈）：/interview、/consolidate（commands.ts，访谈只在记忆插件给了访谈服务时有）；管理员没在运行时没有这个会话；
//   - 二狗自己的命令哪种界面语言都写英文的（用户 2026-10-26 定），中文的老写法打了照样算、候选里不列。
import { activeLanguage, CHANNELS, MAINTAINER_CHANNEL_PREFIX, MEMORY_CURATOR_CONVERSATION, type SlashCommandEntry, type SlashCommandList } from "@ergo/protocol";
import { SKILL_COMMAND_PREFIX, type SkillCommand } from "../skills/skill-command.ts";
import { CURATOR_COMMANDS, type ErgoCommand, ergoCommandAt, ergoCommandsIn, type SlashConversationKind } from "./commands.ts";
import { inLanguage } from "./translations.ts";

/** 二狗自己的命令在候选里的样子 */
function commandEntry(c: ErgoCommand): SlashCommandEntry {
  const hint = c.argumentHint;
  return { kind: "command", text: c.text, name: c.text.slice(1), description: c.description, ...(hint ? { argumentHint: hint } : {}) };
}

/** 这种会话的候选：二狗自己的命令，再是这些 skill（按命令名排） */
export function slashCommandList(kind: SlashConversationKind, skills: readonly SkillCommand[]): SlashCommandList {
  const ergo = ergoCommandsIn(kind);
  // 310 号票：哪种界面语言都写英文的 /workflow、/task（中文的老写法打了照样算，候选里不列）
  const commands = ergo.map(commandEntry);
  const skillEntries = skills
    // 按命令名的字符先后排（不按语言习惯排：哪台机器上都是同一个顺序）
    .toSorted((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
    .map((s): SlashCommandEntry => ({
      kind: "skill",
      // 在这个会话里会被认成二狗自己的命令的写 /skill:目录名（命令优先只在命令存在的会话里成立）
      text: ergoCommandAt(`/${s.command}`, ergo) ? `${SKILL_COMMAND_PREFIX}${s.command}` : `/${s.command}`,
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
  /**
   * 维护者用的运行时能转交斜杠命令时（289 号票）：运行时给人看的名字和它报的命令（还没报过是空的）；不能转交（pi）是 undefined。不给就都是 pi 的规矩。
   * skills（291 号票）：这个维护者工具包里交给了运行时的 skill 在运行时里的命令名（不带 /）、显示的名字、说明。
   * builtin（310 号票）：运行时自带命令按用户语言的说明、参数提示（AgentRuntime.commandText）；没有的是 undefined
   */
  runtimeCommands?(maintainerId: string): RuntimeCommandSource | undefined;
  /**
   * 记忆管理员（310 号票）：它在运行时给出访谈能不能开（记忆插件给了访谈服务）；没在运行（记忆插件停用）是 undefined——这个会话没有命令。
   * 不给就当没有
   */
  curator?(): { interview: boolean } | undefined;
}

/** 维护者用的运行时报的命令（289、291、310 号票），见 SlashCommandSources.runtimeCommands */
export interface RuntimeCommandSource {
  title: string;
  commands: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>;
  skills?: ReadonlyArray<{ command: string; name: string; description: string }>;
  builtin?(name: string): { description?: string; argumentHint?: string } | undefined;
}

/**
 * 运行时报的命令（289 号票）：写法是 /命令名，集合名写运行时的名字；和这个会话里二狗自己的命令同名的不列（打了是二狗的命令）。
 * 310 号票：带参数提示；说明（和参数提示）不是用户的语言、运行时自带的说明表里有的换上，原文放 originalDescription
 */
function runtimeEntries(kind: SlashConversationKind, runtime: RuntimeCommandSource): SlashCommandEntry[] {
  const ergo = ergoCommandsIn(kind);
  const language = activeLanguage();
  return runtime.commands
    .filter((c) => c.name !== "" && !ergoCommandAt(`/${c.name}`, ergo))
    .map((c): SlashCommandEntry => {
      const original = c.description.trim();
      const reportedHint = c.argumentHint?.trim() ?? "";
      const foreign = original === "" || !inLanguage(original, language);
      const known = foreign || (reportedHint !== "" && !inLanguage(reportedHint, language)) ? runtime.builtin?.(c.name) : undefined;
      const description = foreign && known?.description ? known.description : c.description;
      const hint = reportedHint === "" ? "" : !inLanguage(reportedHint, language) && known?.argumentHint ? known.argumentHint : reportedHint;
      return {
        kind: "runtime",
        text: `/${c.name}`,
        name: c.name,
        description,
        collection: runtime.title,
        ...(hint ? { argumentHint: hint } : {}),
        ...(description !== c.description && original !== "" ? { originalDescription: c.description } : {}),
      };
    });
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
  // 310 号票：记忆管理员（它的会话也是 maintainer: 开头，先认它）
  if (conversation === MEMORY_CURATOR_CONVERSATION) {
    const curator = sources.curator?.();
    if (!curator) return undefined;
    return { commands: ergoCommandsIn("curator").filter((c) => curator.interview || c.text !== CURATOR_COMMANDS.interview).map(commandEntry) };
  }
  if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
  const maintainerId = conversation.slice(MAINTAINER_CHANNEL_PREFIX.length);
  const project = sources.projectSkills(maintainerId);
  const task = project ? undefined : sources.taskSkills(maintainerId);
  const kind: SlashConversationKind | undefined = project ? "project" : task ? "task" : undefined;
  if (!kind) return undefined;
  // 运行时转交斜杠命令的（289 号票）：二狗自己的命令，再是工具包里交给运行时的 skill（291 号票，按运行时里的写法），再是运行时报的命令
  const runtime = sources.runtimeCommands?.(maintainerId);
  if (runtime) {
    const skills = (runtime.skills ?? [])
      .toSorted((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
      .map((s): SlashCommandEntry => ({ kind: "skill", text: `/${s.command}`, name: s.name, description: s.description }));
    const taken = new Set((runtime.skills ?? []).map((s) => s.command));
    return { commands: [...slashCommandList(kind, []).commands, ...skills, ...runtimeEntries(kind, runtime).filter((e) => !taken.has(e.name))] };
  }
  return of(kind, project ?? task ?? []);
}
