// 每个 agent 的 ⚙ 面板（114 号票）：接口的请求体和响应体。名字和单独提示词的检查在 agent-settings.ts（不引用 TypeBox）。
//
// GET /api/agents/<agent id> 取面板要的全部（AgentSettingsView）：单独的提示词和通用模板、现在实际用的系统提示全文、清空、上下文用量和压缩；
// PUT /api/agents/<agent id>/prompt 存单独的提示词（AgentPromptBody）：占位符写错回 400、写明第几行；追加的是空的等于恢复用通用模板；
// DELETE /api/agents/<agent id>/prompt 恢复用通用模板；
// POST /api/agents/<agent id>/clear 清空当前对话（AgentClearBody，带幂等键）：在处理一条时等它说完再清；
// POST /api/agents/<agent id>/compact 现在压缩：在处理一条时等它说完，没在跑的先拉起再压；不等压完，面板按 compaction 的状态再取。
// 都回 AgentSettingsView。只读的（任务结束了、项目归档了）存、清、压都回 400，写明原因。
import { type Static, Type } from "typebox";
import { AGENT_CLEAR_KINDS, AGENT_COMPACT_OUTCOMES, AGENT_COMPACTION_STATES, AGENT_PROMPT_MODES, AGENT_PROMPT_STATES, AGENT_SETTINGS_KINDS } from "./agent-settings.ts";
import { SystemPromptPlaceholder } from "./system-prompt-schema.ts";

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

/** ⚙ 面板（GET /api/agents/<agent id>，存、清、压的响应也是它） */
export const AgentSettingsView = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  kind: Type.Enum(AGENT_SETTINGS_KINDS),
  /** 给人看的：秘书是名字占位（界面上换成用户起的名字）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: Type.String(),
  /** 只能看不能改的原因（任务结束了、项目归档了）；能改是没有 */
  readOnly: Type.Optional(Type.String()),
  prompt: AgentPromptView,
  clear: AgentClearView,
  context: AgentContextView,
});
export type AgentSettingsView = Static<typeof AgentSettingsView>;

/** 存单独的提示词（PUT /api/agents/<agent id>/prompt） */
export const AgentPromptBody = Type.Object({ mode: Type.Enum(AGENT_PROMPT_MODES), content: Type.String() });
export type AgentPromptBody = Static<typeof AgentPromptBody>;

/** 清空当前对话（POST /api/agents/<agent id>/clear）：幂等键，重发只清一次 */
export const AgentClearBody = Type.Object({ idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }) });
export type AgentClearBody = Static<typeof AgentClearBody>;
