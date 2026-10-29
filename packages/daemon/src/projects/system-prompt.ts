// 项目维护者的系统提示：固定的一段，加上这个项目的事实（名字、目标、项目档案和工作目录在哪、现在的状态和工具包）。
// 项目的这些事实变了（立项书确认：类型、工作目录、工具包）时会话按新的装配重新拉起，提示随之更新。
// 71 号票起文字在 md 文件里（本包的 prompts/project-maintainer.md，用户改的在数据目录配置区的 prompts/），这里只填值。
// 15 号票：立项问答（grill-with-docs 式：一次问一两个，把结论写进项目档案，最后交出立项书）——立项书确认之前那一段。
// 16 号票：维护者要做的事都以工单送达（起草计划、执行）；计划怎么写、执行怎么推进和任务自己的维护者插同一份片段
// （plan-writing.md、execution.md：14 号票的计划变更、阈值也一样）；会话分段，每段开头的固定上下文
// （work-orders/fixed-context.ts，里面的项目规范是 project-standard.md）由项目维护者模块拼在这段后面。
// 19 号票：定时作业的每次运行是一张工单。64 号票：项目内部任务（立项书确认之后那一段）。
// 114 号票：agentId（项目维护者 id）给了，就带上用户在项目会话的 ⚙ 里给它单独写的提示词（设置跟着项目走，重置之后照旧用）。
import { PROJECT_KIND_LABEL, PROJECT_STATE_LABEL, type Project, toolkitBashWording, forModel } from "@ergo/protocol";
import { thresholdValues } from "../maintainers/system-prompt.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import type { TaskThresholds } from "../tasks/thresholds.ts";
import type { ProjectRecordsPaths } from "./records.ts";

export function projectMaintainerSystemPrompt(prompts: PromptRenderer, project: Project, paths: ProjectRecordsPaths, workdir: string, thresholds: TaskThresholds, agentId?: string): string {
  const confirmed = project.charterConfirmed && project.kind !== undefined;
  // 系统提示给模型看：引的协议包标签（项目状态、类型）在中文下取
  return forModel(() =>
    prompts.render("project-maintainer", {
    项目名: project.name,
    项目编号: project.id,
    项目目标: project.goal,
    档案目录: paths.root,
    工作目录: workdir,
    项目状态: PROJECT_STATE_LABEL[project.state],
    项目类型: confirmed ? PROJECT_KIND_LABEL[project.kind!] : undefined,
    工具包带不带bash: toolkitBashWording(project.toolkit?.bash === true),
    能不能联网: project.toolkit?.network ? "能" : "不能", // @i18n-ignore model：系统提示的占位符
    立项书已确认: confirmed,
    外部工作目录: project.workdir.external,
    ...thresholdValues(thresholds),
  }, agentId),
  );
}

/**
 * 这一段的工单是流程时拼在系统提示后面（64 号票：项目的维护者也起草、执行流程）：流程的工作方式和写参数、条件的规矩
 * 固定计划的工作方式（和任务自己的维护者插同一份 workflow-rules.md）
 */
export function projectWorkflowGuide(prompts: PromptRenderer): string {
  return prompts.render("project-workflow", {});
}

/**
 * 这一段的工单是项目内部的普通任务时拼在系统提示后面（75 号票）：直接做，不规划；做完这一轮任务自动完成，这一段照常收尾写回
 */
export function projectPlainGuide(prompts: PromptRenderer): string {
  return prompts.render("project-plain", {});
}

/** 每段会话开头固定上下文里的项目规范（第一阶段是一段内置的简短说明，完整的项目规范模板是第二阶段） */
export function projectStandard(prompts: PromptRenderer): string {
  return prompts.render("project-standard", {});
}
