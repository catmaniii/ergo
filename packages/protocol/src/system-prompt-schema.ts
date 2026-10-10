// 设置里的"系统提示"（71 号票）：接口的请求体和响应体。占位符的写法和检查在 system-prompts.ts（不引用 TypeBox）。
//
// GET /api/system-prompts 列出全部（前缀、各角色、共用片段）和各自用的是默认还是改过的；
// GET /api/system-prompts/<编号> 取一份：现在用的内容、默认的内容、能用的占位符；
// PUT /api/system-prompts/<编号> 保存（请求体 { content }）：占位符写错时回 400，message 写明第几行错在哪；和默认的一样时等于恢复默认；
// DELETE /api/system-prompts/<编号> 恢复默认（删掉数据目录里用户改的那份）。
// 改的存在数据目录的配置区（config/prompts/<编号>.md），下一次装配 agent 时生效；秘书的（连同前缀）手头这一条处理完就按新的重新拉起。
import { type Static, Type } from "typebox";

/** 前缀（加在每个 agent 的系统提示最前面）、某个角色的系统提示、几个角色共用的片段 */
export const SYSTEM_PROMPT_GROUPS = ["prefix", "role", "fragment"] as const;
export type SystemPromptGroup = (typeof SYSTEM_PROMPT_GROUPS)[number];

/**
 * 用的是默认的、改过的，还是改过但有错（这时用默认的，problem 写明错在哪）：文件里占位符写错，或者装配时这一份要的值没有
 */
export const SYSTEM_PROMPT_STATES = ["default", "custom", "broken"] as const;
export type SystemPromptState = (typeof SYSTEM_PROMPT_STATES)[number];

/** 占位符的种类：填值的、条件、能插的片段 */
export const SYSTEM_PROMPT_PLACEHOLDER_KINDS = ["value", "flag", "partial"] as const;
export type SystemPromptPlaceholderKind = (typeof SYSTEM_PROMPT_PLACEHOLDER_KINDS)[number];

/**
 * 一份提示能用的一个占位符：名字（片段是它的编号）、说明；common 是工具名这类每份提示都能用的；
 * onlyWhen 是只在这个条件成立时才有值的（要写在 {{#条件}}……{{/条件}} 里面）
 */
export const SystemPromptPlaceholder = Type.Object({
  name: Type.String({ minLength: 1 }),
  kind: Type.Enum(SYSTEM_PROMPT_PLACEHOLDER_KINDS),
  description: Type.String(),
  common: Type.Optional(Type.Boolean()),
  onlyWhen: Type.Optional(Type.String()),
});
export type SystemPromptPlaceholder = Static<typeof SystemPromptPlaceholder>;

/** 列表里的一份 */
export const SystemPromptSummary = Type.Object({
  /** 编号，也是文件名（<编号>.md） */
  id: Type.String({ minLength: 1 }),
  /** 给人看的名字（说到秘书的写名字占位） */
  title: Type.String(),
  /** 一句说明：用在哪、什么时候生效 */
  description: Type.String(),
  group: Type.Enum(SYSTEM_PROMPT_GROUPS),
  state: Type.Enum(SYSTEM_PROMPT_STATES),
  /** 共用片段：插在哪几份提示里（那几份的名字） */
  usedIn: Type.Array(Type.String()),
  /** 改过的文件有错（state 是 broken）时错在哪 */
  problem: Type.Optional(Type.String()),
});
export type SystemPromptSummary = Static<typeof SystemPromptSummary>;

/** 全部系统提示（GET /api/system-prompts）：按前缀、角色、共用片段的顺序；userDir 是用户改的存在哪个目录 */
export const SystemPromptList = Type.Object({
  prompts: Type.Array(SystemPromptSummary),
  userDir: Type.String(),
});
export type SystemPromptList = Static<typeof SystemPromptList>;

/** 一份系统提示（GET /api/system-prompts/<编号>，保存、恢复默认的响应也是它） */
export const SystemPromptDetail = Type.Object({
  ...SystemPromptSummary.properties,
  /** 现在用的内容：改过的是用户的，否则是默认的（文件有错时也是默认的） */
  content: Type.String(),
  /** 默认的内容（程序目录里的那份） */
  defaultContent: Type.String(),
  /** 用户改的那份原样的内容（只在文件有错时给，方便照着改） */
  brokenContent: Type.Optional(Type.String()),
  /** 能用的占位符 */
  placeholders: Type.Array(SystemPromptPlaceholder),
  /** 能不能是空的（前缀、片段可以；角色的提示不行） */
  allowEmpty: Type.Boolean(),
  /** 用户改的存在哪个文件 */
  userFile: Type.String(),
});
export type SystemPromptDetail = Static<typeof SystemPromptDetail>;

/** 保存（PUT /api/system-prompts/<编号>） */
export const SystemPromptBody = Type.Object({ content: Type.String() });
export type SystemPromptBody = Static<typeof SystemPromptBody>;
