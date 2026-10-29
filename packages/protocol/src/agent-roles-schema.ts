// 角色（248 号票）：配置文件、接口请求体和响应体的 schema。形状和规矩在 agent-roles.ts（不引用 TypeBox）。
//
// config/agent-roles.json（数据目录配置区）：{ format: 1, defaultRoleId, roles: [{ id, name, voiceId? }], assignments: { "<agent id>": "<角色 id>" } }。
// - GET  /api/agent-roles                 默认角色、角色表（连同谁在用）、每个 agent 现在用哪个角色、参考音色（AgentRolesView）
// - POST /api/agent-roles                 新建一个角色（AgentRoleBody：name、voiceId?），回 AgentRolesView
// - PUT  /api/agent-roles/default         把某个角色设成默认（AgentDefaultRoleBody：roleId），回 AgentRolesView
// - PUT  /api/agent-roles/<角色 id>       改名 / 换音色（AgentRoleUpdateBody，只写要改的），回 AgentRolesView
// - DELETE /api/agent-roles/<角色 id>     删一个角色：默认角色、还有 agent 在用的回 400，写明是谁
// - PUT  /api/agent-roles/assignments/<agent id>  选一个角色（AgentRoleAssignmentBody：roleId，null = 跟默认），回 AgentRolesView
// 名字不合规、音色不存在、语音插件没启用时写音色都回 400 带原因；只读的 agent（任务结束了、项目归档了）分配角色回 400。
import { type Static, Type } from "typebox";
import { AGENT_SETTINGS_KINDS } from "./agent-settings.ts";
import { AgentIdentityView } from "./agent-profiles-schema.ts";
import { ReferenceVoice } from "./voice-schema.ts";

/** 配置文件里的一个角色（roles 里的一项） */
export const AgentRoleStored = Type.Object({
  id: Type.String({ minLength: 1 }),
  /** 照 43 号票的规矩查过的名字（1–8 个字）；默认角色的名字以全局名字为准 */
  name: Type.String(),
  /** 参考音色的 id；没有 = 不指定、跟当前默认音色（31 号票全局选中的那个） */
  voiceId: Type.Optional(Type.String()),
});
export type AgentRoleStored = Static<typeof AgentRoleStored>;

/** 配置文件 config/agent-roles.json */
export const AgentRolesFile = Type.Object({
  format: Type.Literal(1),
  /** 默认角色的 id（roles 里的一项；跟默认的 agent 都用它） */
  defaultRoleId: Type.String({ minLength: 1 }),
  roles: Type.Array(AgentRoleStored),
  assignments: Type.Record(Type.String(), Type.String()),
});
export type AgentRolesFile = Static<typeof AgentRolesFile>;

/** 新建一个角色（POST /api/agent-roles）：名字必填，音色可以不选（不选 = 跟当前默认音色） */
export const AgentRoleBody = Type.Object({
  name: Type.String(),
  voiceId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type AgentRoleBody = Static<typeof AgentRoleBody>;

/** 改一个角色（PUT /api/agent-roles/<角色 id>）：只写要改的那几项，null = 不指定音色（跟当前默认音色） */
export const AgentRoleUpdateBody = Type.Object({
  name: Type.Optional(Type.String()),
  voiceId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type AgentRoleUpdateBody = Static<typeof AgentRoleUpdateBody>;

/** 设默认角色（PUT /api/agent-roles/default） */
export const AgentDefaultRoleBody = Type.Object({ roleId: Type.String({ minLength: 1 }) });
export type AgentDefaultRoleBody = Static<typeof AgentDefaultRoleBody>;

/** 给一个 agent 选角色（PUT /api/agent-roles/assignments/<agent id>）：null = 跟默认 */
export const AgentRoleAssignmentBody = Type.Object({ roleId: Type.Union([Type.String(), Type.Null()]) });
export type AgentRoleAssignmentBody = Static<typeof AgentRoleAssignmentBody>;

/** 角色表里的一行：名字、现在生效的音色、谁在用 */
export const AgentRoleView = Type.Object({
  id: Type.String({ minLength: 1 }),
  /** 默认角色的名字是全局的名字（43 号票） */
  name: Type.String(),
  /** 是不是默认角色（跟默认的 agent 都用它） */
  isDefault: Type.Boolean(),
  /** 现在生效的参考音色（默认角色 = 全局选中的那个；语音插件没启用时没有） */
  voiceId: Type.Optional(Type.String()),
  voiceName: Type.Optional(Type.String()),
  /** 谁在用（agent id；默认角色含所有没指定角色的 agent） */
  usedBy: Type.Array(Type.String()),
});
export type AgentRoleView = Static<typeof AgentRoleView>;

/** 角色下拉里的一个选项（⚙ 面板用；不含谁在用那么重的信息） */
export const AgentRoleOption = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  isDefault: Type.Boolean(),
});
export type AgentRoleOption = Static<typeof AgentRoleOption>;

/** 设置页那张表的一行：哪个 agent、它现在用哪个角色、它的名字和音色 */
export const AgentRoleAssignmentView = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  kind: Type.Enum(AGENT_SETTINGS_KINDS),
  /** 给人看的：秘书是名字占位（界面上换成名字标签）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: Type.String(),
  readOnly: Type.Optional(Type.String()),
  identity: AgentIdentityView,
});
export type AgentRoleAssignmentView = Static<typeof AgentRoleAssignmentView>;

/** GET /api/agent-roles 的样子（增删改、分配角色之后也是它） */
export const AgentRolesView = Type.Object({
  /** 默认角色的 id */
  defaultRoleId: Type.String({ minLength: 1 }),
  /** 角色表（顺序就是文件里的顺序；默认角色在里头） */
  roles: Type.Array(AgentRoleView),
  /** 每个能配的 agent 一行 */
  agents: Type.Array(AgentRoleAssignmentView),
  /** 参考音色（角色里音色下拉的选项）；语音插件没启用时没有 */
  voices: Type.Optional(Type.Array(ReferenceVoice)),
  /** 全局默认用的那个参考音色的 id（"跟默认音色"后面写它的名字）；一个都没有时没有 */
  defaultVoiceId: Type.Optional(Type.String()),
  /** 语音插件没启用：音色改不了、名字和角色照常 */
  voiceUnavailable: Type.Optional(Type.String()),
});
export type AgentRolesView = Static<typeof AgentRolesView>;
