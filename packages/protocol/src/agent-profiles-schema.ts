// 每个 agent 自己的名字和音色（241 号票）：配置文件、接口请求体和响应体的 schema。形状和规矩在 agent-profiles.ts（不引用 TypeBox）。
//
// 248 号票起"每个 agent 各管各的名字和音色"改成角色（agent-roles-schema.ts）：名字和音色都从 agent 用的角色来。
// 这里留下的 AgentProfilesView / AgentProfileEntryView 是**旧的 GET /api/agent-profiles 的只读兼容**（从角色算出来的结果，形状不变）；
// config/agent-profiles.json 只在迁移时读一次（agent-profiles.ts 的注释里写着）。
//
// config/agent-profiles.json（数据目录配置区）：{ format: 1, agents: { "<agent id>": { name?, voiceId? } } }。
// GET /api/agent-profiles 列出全部能配的 agent（AgentProfilesView，名字和音色连同来源）。
import { type Static, Type } from "typebox";
import { AGENT_PROFILE_NAME_SOURCES, AGENT_PROFILE_VOICE_SOURCES } from "./agent-profiles.ts";
import { AGENT_SETTINGS_KINDS } from "./agent-settings.ts";
import { ReferenceVoice } from "./voice-schema.ts";

/** 一个 agent 配的（两项都可以不写：不写就是跟默认） */
export const AgentProfile = Type.Object({
  name: Type.Optional(Type.String()),
  voiceId: Type.Optional(Type.String()),
});
export type AgentProfile = Static<typeof AgentProfile>;

/** 配置文件 config/agent-profiles.json */
export const AgentProfilesFile = Type.Object({
  format: Type.Literal(1),
  agents: Type.Record(Type.String(), AgentProfile),
});
export type AgentProfilesFile = Static<typeof AgentProfilesFile>;

/** 改一个 agent（PUT /api/agent-profiles/<agent id>）：null = 恢复跟默认（不写这一项也一样） */
export const AgentProfileBody = Type.Object({
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  voiceId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type AgentProfileBody = Static<typeof AgentProfileBody>;

/**
 * 一个 agent 现在的名字和音色，连同来源。
 * 248 号票起名字和音色都从它用的角色来：现在生效的角色是 `roleId`（默认角色也算），自己指定的那个在 `ownRoleId`（跟默认时没有）；
 * 名字和音色的来源照旧（own = 指定的角色给的，default = 跟默认角色 / 当前默认音色，none = 还没有参考音色）
 */
export const AgentIdentityView = Type.Object({
  /** 现在生效的角色（默认角色也算） */
  roleId: Type.String({ minLength: 1 }),
  /** 现在生效的角色的名字 */
  name: Type.String(),
  /** 跟默认时的名字（"跟默认：<默认角色的名字>"） */
  defaultName: Type.String(),
  nameSource: Type.Enum(AGENT_PROFILE_NAME_SOURCES),
  /** 自己指定的角色；跟默认时没有 */
  ownRoleId: Type.Optional(Type.String()),
  /** 现在生效的参考音色；一个都没有时没有 */
  voiceId: Type.Optional(Type.String()),
  voiceName: Type.Optional(Type.String()),
  voiceSource: Type.Enum(AGENT_PROFILE_VOICE_SOURCES),
});
export type AgentIdentityView = Static<typeof AgentIdentityView>;

/** 设置页那张表的一行 */
export const AgentProfileEntryView = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  kind: Type.Enum(AGENT_SETTINGS_KINDS),
  /** 给人看的：秘书是名字占位（界面上换成名字标签）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: Type.String(),
  readOnly: Type.Optional(Type.String()),
  identity: AgentIdentityView,
});
export type AgentProfileEntryView = Static<typeof AgentProfileEntryView>;

/** GET /api/agent-profiles 的样子（PUT 之后也是它） */
export const AgentProfilesView = Type.Object({
  agents: Type.Array(AgentProfileEntryView),
  /** 参考音色（音色下拉的选项）；语音插件没启用时没有 */
  voices: Type.Optional(Type.Array(ReferenceVoice)),
  /** 全局默认用的那个参考音色的 id（"跟默认"后面写它的名字）；一个都没有时没有 */
  defaultVoiceId: Type.Optional(Type.String()),
  /** 语音插件没启用：音色改不了、名字照常 */
  voiceUnavailable: Type.Optional(Type.String()),
});
export type AgentProfilesView = Static<typeof AgentProfilesView>;
