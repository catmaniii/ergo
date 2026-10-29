// 换模型就新开会话（83 号票，规格第 1 节"模型"）在守护进程这一侧要的几样：交接摘要的写法（prompts/handoff-summary.md 填值）、
// 会话里给人看的系统说明、两个模型装配是不是同一个。编排在 agent-session.ts（AgentSession 的 modelSwitch），这里不写流程。
//
// 一个会话固定一个模型（73 号票），所以长会话——秘书的长期主线、项目维护者的对话段、定时作业自己的维护者——改了设置也不会自己换：
// 下一条能换的输入之前（秘书：用户的下一条消息；项目维护者：对话段里的下一条；定时作业的维护者：下一次运行的开头），子进程用原来的
// 模型写一份交接摘要、新开一个会话（agent-child/handoff.ts），聊天里记一条"已换成 X 模型，接着之前的对话"。任务执行中途不换。
import { MODEL_THINKING_LABEL, type ModelThinkingLevel, t } from "@ergo/protocol";
import type { PromptRenderer } from "../prompts/index.ts";
import type { HandoffReport, ModelRef, ModelSpec } from "../runtime/index.ts";

/** 交接摘要的写法（接在 pi 的摘要提示后面）：秘书的长期主线另有几句（任务只留编号和一句话、看板不用写） */
export const handoffInstructions = (prompts: PromptRenderer, options: { secretary?: boolean } = {}): string =>
  prompts.render("handoff-summary", { 秘书: options.secretary === true });

/** 思考档位的说法：设置里有的四档用设置页的叫法，别的（pi 的档）原样 */
function thinkingText(level: string): string {
  return Object.hasOwn(MODEL_THINKING_LABEL, level) ? MODEL_THINKING_LABEL[level as ModelThinkingLevel] : level;
}

/** 一个模型给人看的写法：名字 模型（思考：高） */
function modelText(model: ModelRef): string {
  return t("conversation.modelSwitch.model", { name: model.name, thinking: thinkingText(model.thinkingLevel) });
}

/** 换成了：聊天里的系统说明 */
export const modelSwitchedNote = (report: HandoffReport): string => t("conversation.modelSwitch.done", { model: modelText(report.to) });

/** 交接摘要没写成：聊天里的系统说明（这一轮照旧用原来的模型，下一轮再试） */
export const modelSwitchFailedNote = (report: HandoffReport): string =>
  t("conversation.modelSwitch.failed", { to: modelText(report.to), error: report.error ?? t("conversation.unknownError"), from: modelText(report.from.model) });

/**
 * 两个装配用的模型是不是同一个（模型和思考档位；请求地址不算）：都是目录里的模型才比得了，比不了（faux：剧本按每次拉起给，
 * 不固定模型，也就不换）是 undefined
 */
export function sameModel(a: ModelSpec, b: ModelSpec): boolean | undefined {
  if (a.kind !== "catalog" || b.kind !== "catalog") return undefined;
  return a.provider === b.provider && a.modelId === b.modelId && a.thinkingLevel === b.thinkingLevel;
}
