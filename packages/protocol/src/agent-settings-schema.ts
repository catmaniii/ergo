// 每个 agent 的 ⚙ 面板（114 号票）：接口的请求体和响应体。名字和单独提示词的检查在 agent-settings.ts（不引用 TypeBox）。
//
// GET /api/agents/<agent id> 取面板要的全部（AgentSettingsView）：这个 agent 自己的名字和音色（241 号票）、单独的提示词和通用模板、
// 现在实际用的系统提示全文、清空、上下文用量和压缩；
// PUT /api/agents/<agent id>/prompt 存单独的提示词（AgentPromptBody）：占位符写错回 400、写明第几行；追加的是空的等于恢复用通用模板；
// DELETE /api/agents/<agent id>/prompt 恢复用通用模板；
// POST /api/agents/<agent id>/clear 清空当前对话（AgentClearBody，带幂等键）：在处理一条时等它说完再清；
// POST /api/agents/<agent id>/compact 现在压缩：在处理一条时等它说完，没在跑的先拉起再压；不等压完，面板按 compaction 的状态再取；
// PUT /api/agents/<agent id>/model 项目、任务的维护者单独配模型（AgentModelBody，120 号票），DELETE 改回跟随它那一行；
// PUT /api/agents/<agent id>/runtime 项目、任务的维护者用哪个运行时、给它选的模型和设置项（AgentRuntimeBody，289 号票）。
// 都回 AgentSettingsView。只读的（任务结束了、项目归档了）存、清、压、配模型都回 400，写明原因。
import { type Static, Type } from "typebox";
import { AgentIdentityView } from "./agent-profiles-schema.ts";
import { AgentRoleOption } from "./agent-roles-schema.ts";
import { AGENT_CLEAR_KINDS, AGENT_COMPACT_OUTCOMES, AGENT_COMPACTION_STATES, AGENT_PROMPT_MODES, AGENT_PROMPT_STATES, AGENT_SETTINGS_KINDS } from "./agent-settings.ts";
import { MAINTAINER_MODEL_AGENTS, MODEL_SWITCH_AT, MODEL_THINKING_LEVELS } from "./model-settings.ts";
import { AgentRuntimeStateView } from "./runtime-schema.ts";
import { SystemPromptPlaceholder } from "./system-prompt-schema.ts";
import { ReferenceVoice } from "./voice-schema.ts";

/** 这个 agent 的通用模板（设置 · 系统提示里这个角色的那份）：编号、名字、现在的内容（用户改过的就是改过的）、能用的占位符 */
export const AgentPromptTemplate = Type.Object({
  id: Type.String({ minLength: 1 }),
  /** 名字（说到秘书的写名字占位） */
  title: Type.String(),
  content: Type.String(),
  placeholders: Type.Array(SystemPromptPlaceholder),
  allowEmpty: Type.Boolean(),
});
export type AgentPromptTemplate = Static<typeof AgentPromptTemplate>;

/** 单独的提示词 */
export const AgentPromptView = Type.Object({
  /** 用通用模板（没有单独的）、模板后面追加、整份自己写 */
  state: Type.Enum(AGENT_PROMPT_STATES),
  /** 追加的那一段、整份自己写的（用通用模板时是空的） */
  content: Type.String(),
  /** 自己写的那份有错（这时用的是通用模板）：错在哪 */
  problem: Type.Optional(Type.String()),
  template: AgentPromptTemplate,
  /** 现在实际用的系统提示全文（前缀、模板 + 追加或整份；项目维护者后面还有这一段的固定上下文），只读 */
  effective: Type.String(),
});
export type AgentPromptView = Static<typeof AgentPromptView>;

/** 清空当前对话 */
export const AgentClearView = Type.Object({
  /** 新开一段会话；项目维护者是重置维护者 */
  how: Type.Enum(AGENT_CLEAR_KINDS),
  /** 等它说完手头这一条再清 */
  pending: Type.Boolean(),
  /** 上一次清空（重置）的时间；没清过没有 */
  lastAt: Type.Optional(Type.String()),
});
export type AgentClearView = Static<typeof AgentClearView>;

/** 一次手动压缩的结果 */
export const AgentCompactResult = Type.Object({
  outcome: Type.Enum(AGENT_COMPACT_OUTCOMES),
  at: Type.String(),
  /** 没压成的原因 */
  message: Type.Optional(Type.String()),
});
export type AgentCompactResult = Static<typeof AgentCompactResult>;

/**
 * 上下文用量和压缩：数都从子进程每次模型调用报的 usage 来（token 账本，不另数一套）；agent 没在跑时是上一次的。
 * 用量是这段会话（清空、重置之后的这一段）里最近一次模型调用的上下文（缓存命中 + 未命中 + 输出）；压缩之后、清空之后还没调用过模型时没有
 */
export const AgentContextView = Type.Object({
  /** 子进程在不在 */
  running: Type.Boolean(),
  /** 正在处理一条输入 */
  busy: Type.Boolean(),
  usedTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 其中缓存命中的（311 号票：界面单写"其中缓存命中 …"）；那次没命中缓存的没有 */
  cacheHitTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 那次调用的时间 */
  measuredAt: Type.Optional(Type.String()),
  /** 模型的上下文窗口；还不知道（守护进程起来以后这个模型还没跑过）时没有 */
  window: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 用量超过它就自动压缩（窗口减 pi 的 reserveTokens） */
  autoCompactAt: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 压缩时最近约这么多 token 原样保留 */
  keepRecentTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 这段会话里上次压缩的时间（自动、手动都算） */
  lastCompactedAt: Type.Optional(Type.String()),
  /** "现在压缩"到哪了 */
  compaction: Type.Enum(AGENT_COMPACTION_STATES),
  /** 上一次手动压缩的结果（守护进程这次起来以后的） */
  lastCompact: Type.Optional(AgentCompactResult),
  /** 现在压不了的原因（项目维护者没有在进行的一段会话）；压得了没有 */
  cannotCompact: Type.Optional(Type.String()),
});
export type AgentContextView = Static<typeof AgentContextView>;

/** 一个模型和思考档位 */
const AgentModelChoice = Type.Object({ modelId: Type.String({ minLength: 1 }), thinkingLevel: Type.Enum(MODEL_THINKING_LEVELS) });

/**
 * 这个维护者用什么模型（120 号票，只有项目、任务的维护者有）：跟随它那一行（设置 · 模型里的项目维护者 / 任务维护者），
 * 或者单独选定模型和思考档位。可选的模型、看图能力和设置 · 模型页是同一份（GET /api/model-settings 的 models）
 */
export const AgentModelView = Type.Object({
  /** 跟随哪一行 */
  agent: Type.Enum(MAINTAINER_MODEL_AGENTS),
  /** 那一行现在实际会用的（跟随默认的换成默认） */
  role: AgentModelChoice,
  /** 单独配的；跟随那一行时没有 */
  own: Type.Optional(AgentModelChoice),
  /** 单独配的模型用不了了（模型目录里没有了）：这时跟随那一行，这是原因 */
  unavailable: Type.Optional(Type.String()),
  /** 下一个新会话用的 */
  next: AgentModelChoice,
  /** 这个维护者最近一次在跑的会话实际用的（接着的会话是它开始时的；守护进程这次起来以后它跑过才有） */
  session: Type.Optional(Type.Object({ modelId: Type.String(), thinkingLevel: Type.String(), vision: Type.Boolean() })),
  /** 改了以后什么时候换（83 号票的规矩：一个会话固定一个模型） */
  switchAt: Type.Enum(MODEL_SWITCH_AT),
});
export type AgentModelView = Static<typeof AgentModelView>;

/** ⚙ 面板（GET /api/agents/<agent id>，存、清、压的响应也是它） */
export const AgentSettingsView = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  kind: Type.Enum(AGENT_SETTINGS_KINDS),
  /** 给人看的：秘书是名字占位（界面上换成用户起的名字）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: Type.String(),
  /** 只能看不能改的原因（任务结束了、项目归档了）；能改是没有 */
  readOnly: Type.Optional(Type.String()),
  /** 这个 agent 现在用哪个角色、名字和音色是什么（248 号票） */
  identity: AgentIdentityView,
  /** 角色下拉的选项（默认角色 + 各个角色；跟默认的那一项不在这里，界面上单独写"跟默认（<默认角色的名字>）"） */
  roles: Type.Array(AgentRoleOption),
  /** 音色下拉的选项（参考音色）；语音插件没启用时没有。角色表那一页用，⚙ 里只显示"现在：名字 · 音色" */
  voices: Type.Optional(Type.Array(ReferenceVoice)),
  /** 全局默认用的那个参考音色的 id（"跟默认音色"后面写它的名字） */
  defaultVoiceId: Type.Optional(Type.String()),
  /** 语音插件没启用：音色改不了、名字照常 */
  voiceUnavailable: Type.Optional(Type.String()),
  prompt: AgentPromptView,
  clear: AgentClearView,
  context: AgentContextView,
  /**
   * 用什么模型（120 号票）：项目、任务的维护者才有；秘书的在设置 · 模型里。289 号票起这是二狗自己的模型目录（pi 用的）：
   * 维护者用的运行时有自己的模型列表的（Claude Code）不看它，看 runtime 里选的
   */
  model: Type.Optional(AgentModelView),
  /** 用哪个运行时、给它选的模型和设置项（289 号票）：项目、任务的维护者才有 */
  runtime: Type.Optional(AgentRuntimeStateView),
});
export type AgentSettingsView = Static<typeof AgentSettingsView>;

/** 存单独的提示词（PUT /api/agents/<agent id>/prompt） */
export const AgentPromptBody = Type.Object({ mode: Type.Enum(AGENT_PROMPT_MODES), content: Type.String() });
export type AgentPromptBody = Static<typeof AgentPromptBody>;

/** 清空当前对话（POST /api/agents/<agent id>/clear）：幂等键，重发只清一次 */
export const AgentClearBody = Type.Object({ idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }) });
export type AgentClearBody = Static<typeof AgentClearBody>;
