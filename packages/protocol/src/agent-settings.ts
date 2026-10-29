// 每个 agent 的会话里一个 ⚙（114 号票，规格第 19 节"Web UI"、系统提示一节）：秘书会话、任务整页（负责它的维护者）、项目整页（项目维护者）
// 的标题栏上点开一个面板——这个 agent 单独的提示词、清空当前对话、上下文用量和"现在压缩"。
// 这里是守护进程和 Web 共用的部分（不引用 TypeBox；接口的 schema 在 agent-settings-schema.ts）：名字、单独的提示词怎么查。
//
// 单独的提示词两种（用户 2026-10-13 定：默认追加，也能整份替换）：
// - 追加（append）：在通用模板（设置 · 系统提示里这个角色的那份）后面接一段这个 agent 自己的话；通用模板以后改了它跟着变；
// - 整份自己写（replace）：从通用模板复制一份来改，通用模板之后再改不影响它，可以"恢复用通用模板"。
// 两种写的都是提示文件的写法（system-prompts.ts：{{名字}}、{{#条件}}……{{/条件}}、{{> 片段}}），能用的占位符和这个角色的通用模板一样，
// 守护进程存之前、设置页边改边用同一个函数查（agentPromptProblem）。
import { t, tTable } from "./i18n/runtime.ts";
import { normalizePromptSource, parsePromptTemplate, promptIssuesText, type PromptTemplateSpec } from "./system-prompts.ts";

/** 有 ⚙ 的会话是谁的：秘书、任务（负责它的维护者）、项目（项目维护者）、记忆管理员（242 号票：那个按需拉起的 agent，243 号票起不常驻） */
export const AGENT_SETTINGS_KINDS = ["secretary", "task", "project", "curator"] as const;
export type AgentSettingsKind = (typeof AGENT_SETTINGS_KINDS)[number];

/** 单独的提示词：在通用模板后面追加、整份自己写 */
export const AGENT_PROMPT_MODES = ["append", "replace"] as const;
export type AgentPromptMode = (typeof AGENT_PROMPT_MODES)[number];

/** 面板上这个 agent 现在用的：通用模板（没有单独的）、模板后面追加、整份自己写 */
export const AGENT_PROMPT_STATES = ["template", ...AGENT_PROMPT_MODES] as const;
export type AgentPromptState = (typeof AGENT_PROMPT_STATES)[number];

export const AGENT_PROMPT_STATE_LABEL: Readonly<Record<AgentPromptState, string>> = tTable({
  template: "protocol.agentSettings.prompt.template",
  append: "protocol.agentSettings.prompt.append",
  replace: "protocol.agentSettings.prompt.replace",
});

/** "清空当前对话"怎么做：秘书、任务的维护者新开一段会话；项目维护者就是重置维护者（16 号票，只凭项目档案重建理解） */
export const AGENT_CLEAR_KINDS = ["new_session", "reset_maintainer"] as const;
export type AgentClearKind = (typeof AGENT_CLEAR_KINDS)[number];

/** "现在压缩"到哪了：没在压、等它说完手头这一条、正在压（没在跑的先拉起） */
export const AGENT_COMPACTION_STATES = ["idle", "waiting", "running"] as const;
export type AgentCompactionState = (typeof AGENT_COMPACTION_STATES)[number];

/** 上一次手动压缩的结果：压好了、没什么可压的（会话还短：最近约 2 万 token 原样保留，前面没有）、没压成 */
export const AGENT_COMPACT_OUTCOMES = ["done", "nothing", "failed"] as const;
export type AgentCompactOutcome = (typeof AGENT_COMPACT_OUTCOMES)[number];

/**
 * pi 的压缩规矩（自动压缩的时机）：上下文用量超过"窗口减 reserveTokens"时自动压缩，最近约 keepRecentTokens 原样保留。
 * 子进程就绪时报回这次会话实际的数（模型的窗口、pi 的压缩设置），这里的只在还不知道时给界面写说明用
 */
export const PI_COMPACTION_DEFAULTS = { reserveTokens: 16_384, keepRecentTokens: 20_000 } as const;

/**
 * 单独的提示词对不对（守护进程存之前、设置页边改边查，同一个函数）：整份自己写的不能是空的（通用模板能是空的除外）；
 * 占位符照这个角色的通用模板查（spec）。追加的可以是空的（等于不追加，存了就是恢复用通用模板）。对的回 undefined
 */
export function agentPromptProblem(mode: AgentPromptMode, content: string, spec: PromptTemplateSpec, allowEmpty: boolean): string | undefined {
  const source = normalizePromptSource(content);
  if (source.trim() === "") return mode === "replace" && !allowEmpty ? t("protocol.agentSettings.prompt.empty") : undefined;
  const parsed = parsePromptTemplate(source, spec);
  return parsed.ok ? undefined : promptIssuesText(parsed.issues);
}
