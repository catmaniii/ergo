// 定时作业的说明（19 号票）：作业自己的维护者的系统提示（不属于项目的作业）。71 号票起文字在 md 文件里（本包的
// prompts/job-maintainer.md，用户改的在数据目录配置区的 prompts/），这里只填值。项目维护者系统提示里关于定时作业工单的那一句
// 在 project-maintainer.md 里。预先授权之外的操作怎么说跟着对话审批的开关（101 号票：关着时任务的 agent 超出授权先不管）。
import type { ConversationApprovals } from "../guard/index.ts";
import type { PromptRenderer } from "../prompts/index.ts";

/**
 * 作业自己的维护者（不属于项目的定时作业由它执行，jm-<n>）；failureLimit 是连续失败几次自动暂停（配置 scheduledJobs.jobFailures），
 * approvals 是对话审批的开关（配置 guard.conversationApprovals，默认关着）
 */
export function jobMaintainerSystemPrompt(prompts: PromptRenderer, failureLimit: number, approvals: ConversationApprovals = "off"): string {
  return prompts.render("job-maintainer", { 连续失败几次暂停: String(failureLimit), 对话审批开着: approvals === "on" });
}
