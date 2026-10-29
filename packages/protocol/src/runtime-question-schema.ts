// 运行时的提问卡（288 号票，issue 24 方案第三节丁类）：维护者的运行时自己要问你的——Claude Code 的 AskUserQuestion（一到四道选择题，
// 每题两到四个选项、有的可以多选，都不合适可以自己写）、退出计划模式时的批准（批准计划接着干，或者打回让它接着想）。
// 子进程经宿主协议的 ask_user 报上来，守护进程建这张卡放进那个维护者的会话和待我处理；你在卡上答，答案经 ask_user_reply 交回那次调用。
// 这一轮结束了（做完、被打断、子进程退出）还没答的，卡片作废（再点回"这一轮已经结束"）。守护进程和 Web 共用。
import { type Static, Type } from "typebox";

/** 选择题的一个选项：卡上显示的字、说明它意味着什么；preview 是选中时给人看的样子（代码片段、示意） */
export const RuntimeChoiceOption = Type.Object({
  label: Type.String(),
  description: Type.String(),
  preview: Type.Optional(Type.String()),
});
export type RuntimeChoiceOption = Static<typeof RuntimeChoiceOption>;

/** 一道选择题：问题、一个很短的标签（卡上的小标签）、选项、能不能多选 */
export const RuntimeChoiceQuestion = Type.Object({
  question: Type.String(),
  header: Type.String(),
  options: Type.Array(RuntimeChoiceOption),
  multiSelect: Type.Boolean(),
});
export type RuntimeChoiceQuestion = Static<typeof RuntimeChoiceQuestion>;

/** 运行时要问的：几道选择题（choices），或者批准它做好的计划（plan：计划正文，Markdown） */
export const RuntimeQuestion = Type.Union([
  Type.Object({ kind: Type.Literal("choices"), questions: Type.Array(RuntimeChoiceQuestion, { minItems: 1 }) }),
  Type.Object({ kind: Type.Literal("plan"), plan: Type.String() }),
]);
export type RuntimeQuestion = Static<typeof RuntimeQuestion>;

/** 一道题的回答：选了哪几个（选项的 label；单选的最多一个）、自己写的（都不合适时） */
export const RuntimeChoiceAnswer = Type.Object(
  {
    question: Type.String(),
    selected: Type.Array(Type.String()),
    other: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type RuntimeChoiceAnswer = Static<typeof RuntimeChoiceAnswer>;

/**
 * 交回运行时的回答：选择题每题的回答（choices）；计划批准了没有、附的话（plan）；没答（declined：你点了"不答"，或者这一轮结束了还没答）
 */
export const RuntimeQuestionReply = Type.Union([
  Type.Object({ kind: Type.Literal("choices"), answers: Type.Array(RuntimeChoiceAnswer) }),
  Type.Object({ kind: Type.Literal("plan"), approved: Type.Boolean(), note: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("declined"), note: Type.Optional(Type.String()) }),
]);
export type RuntimeQuestionReply = Static<typeof RuntimeQuestionReply>;

/** 运行时的提问卡：谁问的、哪个运行时、问的什么；答了带上回答 */
export const RuntimeQuestionCardPayload = Type.Object({
  /** 问的维护者 */
  agentId: Type.String(),
  /** 运行时给人看的名字（建卡时的语言）："Claude Code" */
  runtimeTitle: Type.String(),
  /** 卡上的来源（和审批卡的一样："任务 t-3「整理发票」"、项目……） */
  source: Type.String(),
  /** 子代理里问的（Claude Code 的 Agent 工具派出去的那个在问） */
  subAgent: Type.Optional(Type.Literal(true)),
  question: RuntimeQuestion,
  /** 你的回答（答了才有；作废的没有） */
  reply: Type.Optional(RuntimeQuestionReply),
});
export type RuntimeQuestionCardPayload = Static<typeof RuntimeQuestionCardPayload>;

/** 提问卡上"提交回答"（answer）的输入：每题一个回答（按卡上的先后） */
export const RuntimeQuestionAnswerInput = Type.Object({ answers: Type.Array(RuntimeChoiceAnswer, { minItems: 1 }) }, { additionalProperties: false });
export type RuntimeQuestionAnswerInput = Static<typeof RuntimeQuestionAnswerInput>;

/**
 * 一份回答哪里不对（守护进程收卡上的回答、网页"提交"按钮能不能点都用它）：每题都要答（选了或者自己写了）、选的是卡上有的、
 * 单选的只能选一个（选了就不再自己写）；对的是 undefined，不对的是出问题的那道题（从 0 数）和原因
 */
export function runtimeAnswerProblem(questions: readonly RuntimeChoiceQuestion[], answers: readonly RuntimeChoiceAnswer[]): { index: number; problem: "missing" | "unknown_option" | "single_select" } | undefined {
  for (const [index, q] of questions.entries()) {
    const a = answers[index];
    if (!a || a.question !== q.question) return { index, problem: "missing" };
    const other = a.other?.trim() ?? "";
    if (a.selected.length === 0 && other === "") return { index, problem: "missing" };
    if (a.selected.some((label) => !q.options.some((o) => o.label === label))) return { index, problem: "unknown_option" };
    if (!q.multiSelect && a.selected.length + (other === "" ? 0 : 1) > 1) return { index, problem: "single_select" };
  }
  return answers.length === questions.length ? undefined : { index: questions.length, problem: "missing" };
}
