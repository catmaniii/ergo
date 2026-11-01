// skill 变更（和登记 MCP 走一样的路）的卡、事件和审批决定的 schema。
// 负责人用 request_skill_change 提"把一个 skill 加进 skill 库、改、删"，运行时只校验、出一张"skill 变更"卡进待办；
// 用户确认之后才由运行时复制进数据目录的 skill 区（skills/library.ts）、自检、配进提交人的工具包，拒绝则一个字节都不动。
// 卡上给用户看：名字、说明、谁提的、哪个项目或任务、文件清单和大小、有没有脚本、SKILL.md 全文；改、删的还有哪些工具包在用它。
import { type Static, Type } from "typebox";
import { McpChangeSubmitter } from "./mcp-schema.ts";

/** 三种动作：加一个、改一个（内容整个换掉，名字不变）、删一个，都要用户确认 */
export const SKILL_CHANGE_ACTIONS = ["add", "update", "remove"] as const;
export type SkillChangeAction = (typeof SKILL_CHANGE_ACTIONS)[number];

/** 是谁提的：和 MCP 登记变更同一个形状（项目的负责人，或者任务的负责人；项目内部任务带上所属的项目） */
export const SkillChangeSubmitter = McpChangeSubmitter;
export type SkillChangeSubmitter = McpChangeSubmitter;

/** 卡上的文件清单最多列多少行（脚本排在前面）；数字（fileCount、scriptCount）是全部的 */
export const SKILL_CHANGE_FILES_SHOWN = 200;

/** 文件清单里的一行：相对来源目录的路径（用 / 分隔）、字节数；是脚本的标上 */
export const SkillChangeFile = Type.Object({
  path: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  script: Type.Optional(Type.Boolean()),
});
export type SkillChangeFile = Static<typeof SkillChangeFile>;

/**
 * 读卡时看到的来源（加、改才有）：确认时按它核对——内容指纹对不上（提交之后来源变了）就不进库，要重新提交。
 * skillMd 是 SKILL.md 全文（可以展开看）；不带的东西（.env、私钥、隐藏目录）列在 excluded，依赖目录（不复制、按原路径引用）列在 linked
 */
export const SkillChangeSource = Type.Object({
  /** 来源目录的真实路径 */
  path: Type.String(),
  /** 进了 skill 区之后的目录名（也是斜杠命令名） */
  dirName: Type.String(),
  skillMd: Type.String(),
  files: Type.Array(SkillChangeFile),
  /** 一共多少个文件、多少字节（只算要复制的） */
  fileCount: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Integer({ minimum: 0 }),
  /** 其中多少个是脚本（用它的 agent 可能会运行） */
  scriptCount: Type.Integer({ minimum: 0 }),
  /** 不带进 skill 区的（相对来源目录；目录以 / 结尾） */
  excluded: Type.Array(Type.String()),
  /** 依赖目录（node_modules、.venv、venv）：不复制，按原路径引用 */
  linked: Type.Array(Type.String()),
  /** 内容指纹（要复制的文件的相对路径和内容算出来的） */
  fingerprint: Type.String(),
});
export type SkillChangeSource = Static<typeof SkillChangeSource>;

/** 现在在用这个 skill 的一方：项目的工具包、没结束的任务的工具包，或者个人助理（设置里勾的那一份） */
export const SkillChangeUser = Type.Object({
  kind: Type.Union([Type.Literal("project"), Type.Literal("task"), Type.Literal("assistant")]),
  /** 项目名、任务标题（个人助理没有：界面上写它现在的名字） */
  title: Type.Optional(Type.String()),
});
export type SkillChangeUser = Static<typeof SkillChangeUser>;

/** 批准之后的自检结果：skill 库里读得到、名字说明对（删的是读不到了） */
export const SkillChangeCheck = Type.Object({
  ok: Type.Boolean(),
  /** 对不上的原因（ok 为 false 时有） */
  problem: Type.Optional(Type.String()),
  time: Type.String(),
});
export type SkillChangeCheck = Static<typeof SkillChangeCheck>;

/**
 * "skill 变更"卡（skill_change）：负责人提的把一个 skill 加进 skill 库、改、删。批准（approve）后运行时写 skill 区并自检，
 * 拒绝（deny）则不变。批准、拒绝都是"审批决定"素材
 */
export const SkillChangeCardPayload = Type.Object({
  action: Type.Enum(SKILL_CHANGE_ACTIONS),
  /** skill 名（SKILL.md 的 name；库里唯一） */
  name: Type.String({ minLength: 1 }),
  /** 说明（加、改是新的 SKILL.md 里的，删是库里现在的） */
  description: Type.String(),
  /** 来源；删的时候不带 */
  source: Type.Optional(SkillChangeSource),
  /** 现在在用它的（改、删的时候列） */
  usedBy: Type.Optional(Type.Array(SkillChangeUser)),
  submitter: SkillChangeSubmitter,
  /** 负责人为什么要这么改（卡上显示） */
  why: Type.Optional(Type.String()),
  /** 批准之后由运行时补上：已经改好 skill 库了；批准了但没改成（来源变了、重名了）时是 false，原因在 problem */
  applied: Type.Optional(Type.Boolean()),
  /** 批准了但没改成的原因 */
  problem: Type.Optional(Type.String()),
  check: Type.Optional(SkillChangeCheck),
  /** 批准之后由运行时补上：配进了提交人的工具包 */
  addedToToolkit: Type.Optional(Type.Boolean()),
  /** 进库了、但没配进工具包的原因（项目归档了、任务结束了） */
  toolkitProblem: Type.Optional(Type.String()),
});
export type SkillChangeCardPayload = Static<typeof SkillChangeCardPayload>;

/**
 * `skill_decided` 事件（守护进程内部的 skills 频道，前端不订阅）：用户批准或拒绝了一张"skill 变更"卡。"审批决定"素材的来源
 */
export const SkillDecidedPayload = Type.Object({
  decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
  action: Type.Enum(SKILL_CHANGE_ACTIONS),
  name: Type.String(),
  submitter: SkillChangeSubmitter,
  /** 卡片 */
  cardId: Type.Optional(Type.String()),
  /** 用户附带的说明 */
  note: Type.Optional(Type.String()),
  /** 改好 skill 库了没有 */
  applied: Type.Boolean(),
  /** 批准了但没改成的原因 */
  problem: Type.Optional(Type.String()),
  check: Type.Optional(SkillChangeCheck),
  /** 这一版的内容指纹（加、改） */
  fingerprint: Type.Optional(Type.String()),
  time: Type.String(),
});
export type SkillDecidedPayload = Static<typeof SkillDecidedPayload>;
