// 定时作业的说明（19 号票）：作业自己的维护者的系统提示（不属于项目的作业）。71 号票起文字在 md 文件里（本包的
// prompts/job-maintainer.md，用户改的在数据目录配置区的 prompts/），这里只填值。项目维护者系统提示里关于定时作业工单的那一句
// 在 project-maintainer.md 里。
import type { PromptRenderer } from "../prompts/index.ts";

/** 作业自己的维护者（不属于项目的定时作业由它执行，jm-<n>）；failureLimit 是连续失败几次自动暂停（配置 scheduledJobs.jobFailures） */
export function jobMaintainerSystemPrompt(prompts: PromptRenderer, failureLimit: number): string {
  return prompts.render("job-maintainer", { 连续失败几次暂停: String(failureLimit) });
}
