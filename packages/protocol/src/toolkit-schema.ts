// 工具包、skill 库和 MCP 登记的 schema（规格第 20、21 节，27 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型：
// - 工具包里能选的东西（ToolkitCatalog，设置里的 skill 库页、项目页和任务详情的工具包区用）：skill 库里的 skill（框架自带的、
//   用户导入的）和配置区里登记的 MCP（每个工具的中文名、要不要联网、能不能当秘书的快速动作）。走 HTTP（GET）；
// - 导入 skill（POST）：把一个含 SKILL.md 的目录复制一份进数据目录的 skill 区；可以导入并改名，也可以把一个目录作为一个集合整套导入（72 号票）；
// - 秘书用的 skill（72 号票，GET 看、POST 改）：秘书也能用 skill 库里的 skill，默认装 agent-browser、yt-dlp，设置里的 skill 库页勾选；
// - 用户在项目页或任务详情里直接改工具包（set_toolkit 请求）：扩大、减少都直接写进工具包，不出计划变更卡；
// - "工具包变更"卡（toolkit_change）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理，用户批准或拒绝。
// 名字和纯函数在 toolkit.ts。
import { type Static, Type } from "typebox";
import { PlanToolkit } from "./task-schema.ts";

/**
 * skill 库里的一个 skill：名字（SKILL.md 的 name）、说明、来源（框架自带的、你导入的）；
 * 整套导入的带上它属于哪个集合（72 号票）。集合里的每个 skill 仍是库里独立的名字，工具包里写的是 skill 名
 */
export const SkillEntry = Type.Object({
  name: Type.String(),
  description: Type.String(),
  origin: Type.Union([Type.Literal("framework"), Type.Literal("imported")]),
  /** 属于哪个集合（集合名）；单个导入的、框架自带的没有 */
  collection: Type.Optional(Type.String()),
});
export type SkillEntry = Static<typeof SkillEntry>;

/**
 * skill 库里的一个集合（72 号票）：一个目录整套导入的一批 skill（比如 matt-pocock、pstack），界面上显示成一项，
 * 点进去才列出成员；工具包、秘书的 skill 选择里可以整套选，也可以单选其中几个
 */
export const SkillCollectionEntry = Type.Object({
  /** 集合名（skill 区里的目录名；小写字母、数字、短横线，IMPORT_NAME_PATTERN） */
  name: Type.String(),
  /** 来源（导入时写的，比如 "github.com/cursor/plugins 的 pstack/"） */
  source: Type.String(),
  /** 版本（导入时写的） */
  version: Type.String(),
  /** 一句说明 */
  description: Type.String(),
  /** 成员的 skill 名，按名字排 */
  skills: Type.Array(Type.String()),
});
export type SkillCollectionEntry = Static<typeof SkillCollectionEntry>;

/** 登记的一个 MCP 工具（给界面看的部分） */
export const McpToolEntry = Type.Object({
  /** 登记的工具名（MCP 服务里的名字） */
  name: Type.String(),
  /** 中文名 */
  title: Type.String(),
  /** 要联网：工具包联网关着时会话里没有它 */
  network: Type.Boolean(),
  /** 只读或幂等 */
  readOnlyOrIdempotent: Type.Boolean(),
  /** 授权给秘书的快速动作（参数按登记固定）：快速动作的说法 */
  quickAction: Type.Optional(Type.String()),
});
export type McpToolEntry = Static<typeof McpToolEntry>;

/** 配置区里登记的一个 MCP */
export const McpServerEntry = Type.Object({
  name: Type.String(),
  title: Type.String(),
  tools: Type.Array(McpToolEntry),
});
export type McpServerEntry = Static<typeof McpServerEntry>;

/** 工具包里能选的东西：skill 库（集合的成员也在 skills 里，带着集合名）、集合和登记的 MCP（GET HTTP_PATHS.toolkitCatalog 的响应） */
export const ToolkitCatalog = Type.Object({
  skills: Type.Array(SkillEntry),
  /** 整套导入的集合（72 号票） */
  collections: Type.Array(SkillCollectionEntry),
  mcp: Type.Array(McpServerEntry),
  /** MCP 登记文件读不了、写错了时的说明（这时 mcp 是空的） */
  mcpProblem: Type.Optional(Type.String()),
  /**
   * skill 目录名的问题（82 号票）：斜杠命令就是目录名，目录名要是小写、不带空格的写法；不合的（手放进 skill 区的、更早导入的）
   * 二狗不自动改名，在这里一条一条说明，skill 库页上提示
   */
  skillDirProblems: Type.Optional(Type.Array(Type.String())),
});
export type ToolkitCatalog = Static<typeof ToolkitCatalog>;

/**
 * 输入框里打 / 弹出的候选（82 号票）：二狗自己的命令（/workflow、/task……，310 号票起一律英文）和这个会话能用的 skill。
 * skill 的命令名就是它的目录名（/poteto-mode），几个 skill 目录名相同时集合里的写成"集合名:目录名"；
 * 和二狗自己的命令同名的 skill 要写 /skill:目录名。
 * 289 号票：维护者用的运行时能转交斜杠命令的（Claude Code，能力清单 slash_passthrough）——除了二狗自己的命令，候选是运行时报的命令
 * （kind 是 runtime，集合名写运行时的名字），打了原样交给它执行；二狗的 skill 不再展开
 * 310 号票：带参数提示（argumentHint）；不是用户语言的说明换成用户语言的（Claude Code 内置命令查表，别的用二狗的模型翻、缓存），
 * 原文留在 originalDescription；还没翻好的标 translating
 */
export const SlashCommandEntry = Type.Object({
  /** 二狗自己的命令、一个 skill，还是维护者用的运行时自己的命令（289 号票） */
  kind: Type.Union([Type.Literal("command"), Type.Literal("skill"), Type.Literal("runtime")]),
  /** 选中后插进输入框的写法（后面不带空格）："/workflow"、"/poteto-mode"、"/pstack:tdd"、和命令同名时 "/skill:workflow" */
  text: Type.String({ minLength: 2 }),
  /** 显示的名字：命令是命令名（"流程"），skill 是 SKILL.md 里的名字（照原样，"Poteto Mode"） */
  name: Type.String(),
  /** 一句说明 */
  description: Type.String(),
  /** skill 属于哪个集合（候选里作小标）；运行时的命令写运行时的名字（"Claude Code"）；单个导入的、框架自带的、二狗的命令没有 */
  collection: Type.Optional(Type.String()),
  /** 参数提示（310 号票）：显示在写法后面（"/review <PR 号>"），选中插入时不插它；没有参数的没有 */
  argumentHint: Type.Optional(Type.String()),
  /**
   * 说明的原文（310 号票）：description 换成了用户语言的说法时（Claude Code 内置命令查的中文说明表、模型翻的译文）原来那句，
   * 展开的说明下面小字显示；description 本来就是用户的语言时没有
   */
  originalDescription: Type.Optional(Type.String()),
  /** 说明正在翻（310 号票）：description 还是原文，过一会儿再取会换成译文（界面开着候选时隔一会儿再取一次） */
  translating: Type.Optional(Type.Literal(true)),
});
export type SlashCommandEntry = Static<typeof SlashCommandEntry>;

/** 一个会话能用的斜杠命令（GET HTTP_PATHS.slashCommands 的响应）：先是二狗自己的命令，再是 skill（按命令名排） */
export const SlashCommandList = Type.Object({ commands: Type.Array(SlashCommandEntry) });
export type SlashCommandList = Static<typeof SlashCommandList>;

/**
 * 导入时新起的名字（集合名、导入并改名的新名字）的写法：小写字母、数字和短横线，最长 64（同 Agent Skills 的约定），
 * 它们也是 skill 区里的目录名。skill 自己在 SKILL.md 里写的名字不受它限制（"Poteto Mode" 这类照原样认，pi 也只是告警）
 */
export const IMPORT_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

/** 作为集合导入（72 号票）：集合名、来源、版本、一句说明，成员在哪个子目录，哪些成员改名 */
export const ImportCollectionSpec = Type.Object(
  {
    /** 集合名（skill 区里的目录名） */
    name: Type.String({ pattern: IMPORT_NAME_PATTERN }),
    /** 来源（比如 "github.com/cursor/plugins 的 pstack/"、"~/.claude/plugins 里 mattpocock-skills 的 skills/engineering"） */
    source: Type.String({ minLength: 1, maxLength: 300 }),
    /** 版本 */
    version: Type.String({ minLength: 1, maxLength: 64 }),
    /** 一句说明（skill 库页上集合那一行显示） */
    description: Type.String({ minLength: 1, maxLength: 300 }),
    /**
     * 成员在根目录下的哪个子目录（相对路径，比如 pstack 的 "skills"）：这个子目录下面一层每个含 SKILL.md 的目录是一个成员。
     * 不写是根目录本身。整个根目录都复制进来（README、docs、agents 这些成员引用的 ../../ 文件一起带上）
     */
    skillsDir: Type.Optional(Type.String({ maxLength: 200 })),
    /** 导入并改名：成员原来的 skill 名 → 新名字（只改目录名和 SKILL.md 里的 name，内容不动） */
    rename: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: IMPORT_NAME_PATTERN }))),
  },
  { additionalProperties: false },
);
export type ImportCollectionSpec = Static<typeof ImportCollectionSpec>;

/**
 * 导入 skill（POST HTTP_PATHS.skillImport 的请求体）：path 是来源目录的绝对路径。
 * - 单个 skill：path 是含 SKILL.md 的目录；rename 给了就导入并改名；
 * - 一个集合（72 号票）：给 collection，path 是集合的根目录
 */
export const ImportSkillBody = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    /** 单个 skill 导入并改名：新名字（只改目录名和 SKILL.md 里的 name，内容不动） */
    rename: Type.Optional(Type.String({ pattern: IMPORT_NAME_PATTERN })),
    collection: Type.Optional(ImportCollectionSpec),
  },
  { additionalProperties: false },
);
export type ImportSkillBody = Static<typeof ImportSkillBody>;

/** 导入报告里的一行：一个 skill 导入成功与否（72 号票） */
export const ImportReportLine = Type.Object({
  /** skill 名（改了名的是新名字）；SKILL.md 读不出名字时是目录名 */
  name: Type.String(),
  /** 来源里的目录（相对来源的根目录；单个 skill 是 "."） */
  dir: Type.String(),
  ok: Type.Boolean(),
  /** 没导入的原因，或者导入成功的补充（改了名、依赖目录按原路径引用） */
  note: Type.Optional(Type.String()),
});
export type ImportReportLine = Static<typeof ImportReportLine>;

/**
 * 导入的结果：导入进来的 skill（单个导入是一个，集合是导入成功的成员）、集合（作为集合导入时）、
 * 每个 skill 的报告、按原路径引用（没复制）的依赖目录，以及没带进来的东西
 */
export const ImportSkillResult = Type.Object({
  skills: Type.Array(SkillEntry),
  collection: Type.Optional(SkillCollectionEntry),
  report: Type.Array(ImportReportLine),
  /** 没复制、按原路径引用的依赖目录（node_modules 这类）：导进来的位置（相对 skill 区） → 来源里的绝对路径 */
  linked: Type.Array(Type.Object({ dir: Type.String(), target: Type.String() })),
  /** 没带进来的（相对来源的根目录，目录以 / 结尾）：.git 和别的隐藏目录、.env*、*.pem、*.key */
  excluded: Type.Array(Type.String()),
});
export type ImportSkillResult = Static<typeof ImportSkillResult>;

/** 秘书默认装的 skill（72 号票，用户 2026-10-10 定）：库里还没有的不装，导入后自动装上 */
export const DEFAULT_SECRETARY_SKILLS: readonly string[] = ["agent-browser", "yt-dlp"];

/** 秘书的系统提示里 skill 说明超过这么多字节，设置页上提醒一句（72 号票：整套选 pstack 这类集合时很长） */
export const SECRETARY_SKILL_PROMPT_WARN_BYTES = 8 * 1024;

/** 秘书用的 skill（GET HTTP_PATHS.secretarySkills 的响应、POST 的结果，72 号票） */
export const SecretarySkillsView = Type.Object({
  /** 选中的 skill 名（默认的两个还没导入的也列着，装配时跳过） */
  skills: Type.Array(Type.String()),
  /** 还没改过（用的是默认的 agent-browser、yt-dlp） */
  isDefault: Type.Boolean(),
  /** 这些 skill 在秘书的系统提示里的说明（名字、说明、位置）一共多少字、多少字节（UTF-8） */
  promptChars: Type.Integer({ minimum: 0 }),
  promptBytes: Type.Integer({ minimum: 0 }),
  /** 设置文件读不了、写错了时的说明（这时按默认的装） */
  problem: Type.Optional(Type.String()),
});
export type SecretarySkillsView = Static<typeof SecretarySkillsView>;

/** 改秘书用的 skill（POST HTTP_PATHS.secretarySkills 的请求体）：整份名单，只能选 skill 库里有的 */
export const SecretarySkillsBody = Type.Object({ skills: Type.Array(Type.String({ minLength: 1 }), { maxItems: 500 }) }, { additionalProperties: false });
export type SecretarySkillsBody = Static<typeof SecretarySkillsBody>;

/** 秘书用的 skill 在数据目录配置区里的文件（config/secretary-skills.json） */
export const SecretarySkillsFile = Type.Object({ format: Type.Literal(1), skills: Type.Array(Type.String()) });
export type SecretarySkillsFile = Static<typeof SecretarySkillsFile>;

/** 改谁的工具包：一个项目，或者一个任务（任务的是它现在生效的计划里的工具包） */
export const ToolkitTarget = Type.Union([
  Type.Object({ kind: Type.Literal("project"), projectId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export type ToolkitTarget = Static<typeof ToolkitTarget>;

/** 用户在项目页或任务详情里直接改工具包（set_toolkit 请求）：给出改完的整个工具包 */
export const SetToolkitParams = Type.Object({ target: ToolkitTarget, toolkit: PlanToolkit }, { additionalProperties: false });
export type SetToolkitParams = Static<typeof SetToolkitParams>;

/** 改完之后的工具包，以及改了什么（没有改动时 changed 为 false） */
export const SetToolkitResult = Type.Object({ toolkit: PlanToolkit, changed: Type.Boolean() });
export type SetToolkitResult = Static<typeof SetToolkitResult>;

/**
 * "工具包变更"卡（toolkit_change）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理。
 * 批准（approve）后这几样加进项目的工具包、维护者按新工具包重新装配；拒绝（deny）则工具包不变。
 * 批准、拒绝都是"审批决定"素材
 */
export const ToolkitChangeCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  maintainerId: Type.String(),
  /** 维护者为什么要加 */
  why: Type.String(),
  /** 提交时项目的工具包 */
  before: PlanToolkit,
  /** 要加的能力（开 bash、加 MCP、开联网）加上去之后的样子 */
  after: PlanToolkit,
  /** 卡上"工具包变更"一栏：要加的能力的说法（"联网"、"MCP exif"……） */
  additions: Type.Array(Type.String()),
  /** 批准之后项目的工具包（批准时现在的工具包加上要加的能力） */
  applied: Type.Optional(PlanToolkit),
});
export type ToolkitChangeCardPayload = Static<typeof ToolkitChangeCardPayload>;

/**
 * `toolkit_change_decided` 事件（守护进程内部的 toolkits 频道，前端不订阅）：用户批准或拒绝了一张"工具包变更"卡，
 * 或者在项目页、任务详情里直接扩大、减少了工具包。"审批决定"素材的来源（08 号票的采集按事件类型登记）
 */
export const ToolkitDecidedPayload = Type.Object({
  /** 卡上批准（approved）、拒绝（denied），或者用户直接改的（edited） */
  decision: Type.Union([Type.Literal("approved"), Type.Literal("denied"), Type.Literal("edited")]),
  target: ToolkitTarget,
  /** 项目名或任务标题 */
  targetTitle: Type.String(),
  before: PlanToolkit,
  after: PlanToolkit,
  /** 卡片（批准、拒绝时有） */
  cardId: Type.Optional(Type.String()),
  /** 用户附带的说明 */
  note: Type.Optional(Type.String()),
  time: Type.String(),
});
export type ToolkitDecidedPayload = Static<typeof ToolkitDecidedPayload>;
