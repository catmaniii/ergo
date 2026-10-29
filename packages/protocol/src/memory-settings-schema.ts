// 记忆的设置（264 号票起）：秘书回话时顺口问"了解你问题"开不开（264）、每条消息有相关记忆时自动带记忆简报开不开（266）、
// 记忆管理员每周在待办里约一次了解你访谈开不开（284），都默认开。
// 配置文件、设置接口的 schema。
//
// 照"我的名字"（user-name-schema.ts）存，**不走事件**：GET /api/memory/settings 现取，PUT 现写。
// 数据目录配置区的 memory-settings.json 是真相，只由运行时写（设置接口）；没有这个文件就是默认（都开着）；
// 266 号票以前写的文件没有 memoryBrief、284 号票以前的没有 interviewInvites，按默认（开着）。
import { type Static, Type } from "typebox";

/** 记忆的设置在数据目录配置区里的文件（config/memory-settings.json）；没有这个文件 = 默认 */
export const MemorySettingsFile = Type.Object({
  format: Type.Literal(1),
  wovenQuestions: Type.Boolean(),
  memoryBrief: Type.Optional(Type.Boolean()),
  interviewInvites: Type.Optional(Type.Boolean()),
});
export type MemorySettingsFile = Static<typeof MemorySettingsFile>;

/** GET /api/memory/settings、PUT 之后回的：现在的设置 */
export const MemorySettingsView = Type.Object({
  /** 秘书回话时顺口问一个了解你问题（话题对上、不急、每天最多一个，见 198 号票）；默认 true */
  wovenQuestions: Type.Boolean(),
  /** 每条消息有相关的记忆时自动给秘书带一份记忆简报（相关的结论连原话，266 号票）；默认 true */
  memoryBrief: Type.Boolean(),
  /**
   * 记忆管理员约了解你访谈（284 号票）：每周在待办里放一张不卡事的约访卡，五个主题都聊过以后每月一次；默认 true。
   * 约访卡上点"不想做了"会把它关掉；关着时用户照样能自己开访谈
   */
  interviewInvites: Type.Boolean(),
});
export type MemorySettingsView = Static<typeof MemorySettingsView>;

/** 改设置（PUT /api/memory/settings）：改哪项给哪项（266 号票起；至少给一项），没给的照旧 */
export const MemorySettingsBody = Type.Object(
  { wovenQuestions: Type.Optional(Type.Boolean()), memoryBrief: Type.Optional(Type.Boolean()), interviewInvites: Type.Optional(Type.Boolean()) },
  { minProperties: 1, additionalProperties: false },
);
export type MemorySettingsBody = Static<typeof MemorySettingsBody>;

/** 默认的设置：没有文件、文件读坏了时用 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettingsView = { wovenQuestions: true, memoryBrief: true, interviewInvites: true };
