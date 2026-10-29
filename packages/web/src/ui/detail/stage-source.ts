// 真任务的阶段在页面上的样子（状态层的 StageView 换成 model 的 Stage）和阶段详情、返工选阶段、"从这里重做"用的 StageDetailSource。
// 原来在 pages/TasksPage.tsx 里，274 号票挪出来：待办里"重做之后复验没过"的"把第 N 阶段也重做…"也要出同一个重做对话框
// （复验没过时"把 M1 也重开"打开重开对话框）。
import type { Stage } from "../../model/types.ts";
import { canReopenStage, type StageView, type Task, type TaskAction, type TaskActOptions, taskHasStages, taskStages, t, type UiState } from "../../state/index.ts";
import type { StageDetailSource } from "./StageDetail.tsx";

/**
 * 状态层里的阶段换成阶段抽屉组件用的样子（验收结果写成通过 / 没通过，原因附在后面）；toolCalls 是这个阶段用了几次工具调用
 * （stageToolCalls，60 号票：授权和用量里的"工具调用 N/M"）
 */
export function stageOf(s: StageView, toolCalls: number | undefined): Stage {
  return {
    id: s.stageId,
    title: s.title,
    status: s.state,
    deliverable: s.deliverables.join(t("pages.tasks.deliverableSep")),
    deliverables: s.deliverables,
    acceptance: s.acceptance.map((a) => ({ text: a.criterion, method: a.method, ...(a.result ? { result: a.result.passed ? "pass" : "fail" } : {}), ...(a.result?.note ? { note: a.result.note } : {}) })),
    mode: s.mode,
    ...(s.steps.length > 0 ? { steps: s.steps } : {}),
    after: s.dependsOn,
    ...(s.code === undefined ? {} : { code: s.code }),
    grants: s.grants,
    rules: s.rules,
    budget: {
      tokens: s.budget?.tokens ?? 0,
      toolCalls: s.budget?.toolCalls ?? 0,
      ...(s.budget ? { usedTokens: s.budget.usedTokens, usedToolCalls: toolCalls ?? 0 } : {}),
    },
    ...(s.attempts > 0 ? { attempts: s.attempts } : {}),
    ...(s.waitReason ? { waitReason: s.waitReason } : {}),
    ...(s.waitNote ? { waitNote: s.waitNote } : {}),
    // 84 号票：阶段详情的执行方式理由和初步思路、"从这里重做"、要你留意的、点进规则详情
    ...(s.modeReason ? { modeReason: s.modeReason } : {}),
    ...(s.roughIdea ? { roughIdea: s.roughIdea } : {}),
    started: s.started,
    marks: s.marks,
    ruleDocs: s.ruleDocs,
    ...(s.userWords ? { userWords: s.userWords } : {}),
    // 274 号票：维护者的自报、系统查到的个数
    ...(s.summary ? { summary: s.summary } : {}),
    ...(s.observed ? { observed: s.observed } : {}),
  };
}

/** 真任务的阶段（阶段详情、返工选阶段用）：状态层的阶段换成页面上的样子；能不能从这个阶段重做照 84 号票（开始过的阶段） */
export function realStageSource(ui: UiState, task: Task, act: (action: TaskAction, options?: TaskActOptions) => void, toolCalls: Record<string, number> = {}): StageDetailSource | undefined {
  const stages = taskStages(ui, task.id).map((s) => stageOf(s, toolCalls[s.stageId]));
  if (!taskHasStages(task, stages)) return undefined;
  return {
    taskId: task.id,
    stages,
    canRework: (stageId) => canReopenStage(task, stageId),
    rework: (stageId, text, edit) => act("rework", { stageId, ...(text ? { note: text } : {}), ...(edit ? { stageEdit: edit } : {}) }),
  };
}
