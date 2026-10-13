// 计划里涉及的项目要对得上任务（规格第 8 节"执行者"，17 号票评审后定）。任务涉及几个项目在建卡时定下（Task.projectScope），
// 之后不随计划改动重新判断，提交计划、计划变更、自行调整都过这一遍：
// - 不涉及项目的任务：计划里不能写项目行；
// - 单项目任务：只能写它自己那个项目；
// - 多项目任务：每一行写所属阶段（计划里有的）和这张工单的验收标准，项目要在项目列表里，同一阶段同一项目只写一行；
//   阶段的验收不用脚本——交付件在各项目那边，脚本在任务的产出区里跑不到（评审能看到回执和各项目）。
// 要涉及别的项目就重新发起任务。planProjectProblems 是纯函数（项目名怎么认成编号由调用方给）；planProjectsCheck 接上项目列表，
// 交给任务服务（提交计划）和执行控制器（计划变更、自行调整），daemon.ts 接。
// 112 号票：长程任务的阶段自动验收（不管涉及几个项目），没验收的阶段不能写由你验收（auto-acceptance.ts）。
import { isProjectInternal, type Plan, stagesAutoAccepted, type Task, type TaskProjectScope, taskProjectScope } from "@ergou/protocol";
import type { ProjectService } from "../projects/projects.ts";
import { userCriteriaProblems } from "./auto-acceptance.ts";

/**
 * 项目内部任务只动本项目（64 号票）：要动别的项目，告诉用户改成普通任务（写任务书、提交计划、计划变更都是这个说法）
 */
export const internalOtherProjects = (names: readonly string[]) =>
  `项目内部任务只动本项目，不能涉及别的项目（${names.map((n) => `「${n}」`).join("、")}）：要动别的项目，告诉用户改成普通任务（涉及这几个项目的跨项目任务，让秘书发起）`;

const say = {
  noProjects: (names: readonly string[]) => `这个任务不涉及项目，计划里不能写项目行（${names.map((n) => `「${n}」`).join("、")}）。要涉及项目就重新发起任务`,
  otherProject: (name: string) => `这个任务只涉及它自己那个项目，计划里不能写进别的项目「${name}」。要涉及多个项目就重新发起任务`,
  noLines: "涉及多个项目的任务：在 projects 里逐行写出每个项目的改动（项目名 project、改动 changes、所属阶段 stageId、这张工单的验收标准 acceptance）",
  line: (i: number, name: string) => `projects 第 ${i + 1} 行（项目「${name}」）`,
  noStage: "要写所属阶段 stageId（这个阶段开始时派出工单）",
  unknownStage: (stageId: string) => `计划里没有阶段 ${stageId}`,
  noAcceptance: "要写这张工单自己的验收标准 acceptance",
  unknownProject: (name: string) => `项目列表里没有「${name}」`,
  duplicate: "同一阶段同一项目只写一行（把改动合并到一行的 changes 里）",
  script: (stageId: string) => `阶段 ${stageId} 的验收标准不能用脚本（script）：交付件在各项目那边，脚本在任务的产出区里跑不到。用评审（review）`,
};

export function planProjectProblems(input: {
  scope: TaskProjectScope;
  /** 单项目任务自己的那个项目 */
  ownProjectId?: string | undefined;
  /** 项目内部任务（64 号票）：写进别的项目时说法是"改成普通任务" */
  internal?: boolean;
  plan: Plan;
  /** 项目名（或编号）认成项目列表里的编号；不在列表里是 undefined */
  projectIdOf: (name: string) => string | undefined;
  /** 阶段自动验收（112 号票：长程任务）：没验收的阶段不能写由你验收 */
  autoAccepted?: boolean;
  /** 已经验收了的阶段（计划变更、自行调整时）：它们写着的由你验收不管（112 号票） */
  accepted?: ReadonlySet<string>;
}): string[] {
  const { plan, scope } = input;
  const autoAccepted = input.autoAccepted ? userCriteriaProblems(plan, input.accepted, { multi: scope === "multi" }) : [];
  if (scope === "none") return [...(plan.projects.length > 0 ? [say.noProjects(plan.projects.map((p) => p.project))] : []), ...autoAccepted];
  if (scope === "single") {
    const others = [...new Set(plan.projects.filter((p) => input.ownProjectId === undefined || input.projectIdOf(p.project) !== input.ownProjectId).map((p) => p.project))];
    if (input.internal) return [...(others.length > 0 ? [internalOtherProjects(others)] : []), ...autoAccepted];
    return [...others.map(say.otherProject), ...autoAccepted];
  }
  const problems: string[] = [];
  if (plan.projects.length === 0) problems.push(say.noLines);
  const seen = new Set<string>();
  plan.projects.forEach((line, i) => {
    const where = say.line(i, line.project);
    if (line.stageId === undefined) problems.push(`${where}：${say.noStage}`);
    else if (!plan.stages.some((s) => s.stageId === line.stageId)) problems.push(`${where}：${say.unknownStage(line.stageId)}`);
    if (!line.acceptance?.length) problems.push(`${where}：${say.noAcceptance}`);
    const id = input.projectIdOf(line.project);
    if (id === undefined) problems.push(`${where}：${say.unknownProject(line.project)}`);
    const key = `${id ?? line.project.trim()}@${line.stageId ?? ""}`;
    if (line.stageId !== undefined && seen.has(key)) problems.push(`${where}：${say.duplicate}`);
    seen.add(key);
  });
  for (const stage of plan.stages) if (stage.acceptance.some((a) => a.method === "script")) problems.push(say.script(stage.stageId));
  return [...problems, ...autoAccepted];
}

/** 接上项目列表的检查：项目名或编号认成现在的项目 */
export function planProjectsCheck(projects: () => Pick<ProjectService, "get" | "projectIdsOf" | "projectOf">): (task: Task, plan: Plan) => string[] {
  const idOf = (name: string) => projects().projectIdsOf([name])[0] ?? projects().get(name.trim())?.id;
  return (task, plan) =>
    planProjectProblems({
      scope: taskProjectScope(task),
      ownProjectId: projects().projectOf(task)?.id,
      internal: isProjectInternal(task),
      plan,
      projectIdOf: idOf,
      autoAccepted: stagesAutoAccepted(task),
      accepted: new Set((task.stages?.list ?? []).filter((s) => s.state === "accepted").map((s) => s.stageId)),
    });
}
