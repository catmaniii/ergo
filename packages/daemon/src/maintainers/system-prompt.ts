// 任务自己的维护者（涉及多个项目或不涉及项目的任务在建卡时产生）的系统提示。71 号票起文字在 md 文件里（本包的 prompts/，
// 用户改的在数据目录配置区的 prompts/），这里只填值：
// - 长程任务的维护者（task-maintainer.md）：起草计划（12 号票）和执行（13 号票）共用这一段，不随阶段变：计划、授权、当前阶段
//   由运行时的重注入块给。计划的写法（plan-writing.md，26 号票的关注类别和用户说过的限制）、执行的推进（execution.md，14 号票的
//   计划变更和自行调整、20 号票的并行）是和项目的维护者共用的片段；
// - 流程的维护者（workflow-maintainer.md，58 号票）：工作方式照搬 AgentSense 固定计划的系统提示（workflow-rules.md，项目的维护者
//   做流程工单时也插它）；
// - 涉及多个项目的任务的维护者（multi-project-maintainer.md，17 号票）：开头插长程任务的维护者那一份。
// 运行时的阈值（thresholds.md，14 号票：拉回、催促、验收退回、预算、累计被拒）的数字照配置 tasks.thresholds，不写死。
import type { ConversationApprovals } from "../guard/index.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import type { TaskThresholds } from "../tasks/thresholds.ts";

/** 用量超过预算的几倍："用量超过预算"（1 倍）、"用量超过预算的 2 倍" */
const overBudget = (times: number) => (times === 1 ? "用量超过预算" : `用量超过预算的 ${times} 倍`);

/** 阈值那一段的值（插了阈值片段的提示都要它） */
export function thresholdValues(t: TaskThresholds) {
  return {
    拉回次数: String(t.pullBacks),
    停滞分钟: String(Math.round(t.stallMs / 60_000)),
    催促次数: String(t.nudges),
    验收退回次数: String(t.acceptanceReturns),
    验收退回次数加一: String(t.acceptanceReturns + 1),
    停下的用量: overBudget(t.budgetAskTimes),
    说明进展的用量: overBudget(t.budgetExplainTimes),
    累计拒绝次数: String(t.rejections),
  };
}

/** 运行时盯着偏离的那一段：阈值照配置 */
export const thresholdsText = (prompts: PromptRenderer, t: TaskThresholds): string => prompts.render("thresholds", thresholdValues(t));

/** 长程任务的维护者的系统提示（阈值照配置） */
export const taskMaintainerSystemPrompt = (prompts: PromptRenderer, thresholds: TaskThresholds): string => prompts.render("task-maintainer", thresholdValues(thresholds));

/**
 * 流程的维护者的系统提示（58 号票，"工作方式"照搬 AgentSense runtime.ts 的系统提示）：起草步骤和条件、一次授权、按步骤执行、
 * report_step 自报；执行中不能改步骤（要改就重新发起，执行中交计划会被拒，59 号票）。阈值照配置
 */
export const workflowMaintainerSystemPrompt = (prompts: PromptRenderer, thresholds: TaskThresholds): string => prompts.render("workflow-maintainer", thresholdValues(thresholds));

/**
 * 涉及多个项目的任务的维护者的系统提示（17 号票）：长程任务的维护者那一段（阈值照配置），加上工具包固定、计划逐行写各项目的改动、
 * 执行时等回执、调整做法算一次验收退回、计划外的工单要确认、项目维护者的提问交给它
 */
export const multiProjectSystemPrompt = (prompts: PromptRenderer, thresholds: TaskThresholds): string => prompts.render("multi-project-maintainer", thresholdValues(thresholds));

/**
 * 普通任务的 agent 的系统提示（75 号票，plain-task.md）：像普通的对话 agent 一样直接做，做完用一两句话说结果；
 * 工作目录外的说法跟着对话审批的开关（配置 guard.conversationApprovals，默认关着）
 */
export const plainTaskSystemPrompt = (prompts: PromptRenderer, approvals: ConversationApprovals = "off"): string => prompts.render("plain-task", { 对话审批开着: approvals === "on" });
