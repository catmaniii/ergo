// 计划里的定时作业定义（规格第 8、13 节，19 号票）：提交计划时再查一遍（schema 之外的），通过的规范化后存进计划。
// - 时间表要是重复的（定时作业按时间表反复执行；一次性的事是简单提醒）；
// - 属于项目的作业就是对那个项目发起的任务（单项目任务：17 号票的 Task.projectScope 是 single，由项目的维护者执行）里的：
//   这种任务里的作业都属于这个项目（没写的补上），写了别的项目的拒绝；不涉及项目、涉及多个项目的任务里的作业不属于项目，
//   不能写属于哪个项目。任务里的作业属于哪个项目只在 jobProjectOf 里判（提交计划时的检查、确认后的登记都用它）。纯函数。
import { isRepeating, type Plan, type Task, taskProjectScope } from "@ergou/protocol";
import { planJobProblems } from "./texts.ts";

/** 任务里的作业属于哪个项目：单项目任务是它那个项目（projectOf 给的），别的任务（不涉及项目、多项目）的不属于项目 */
export function jobProjectOf<P>(task: Task, projectOf: (task: Task) => P | undefined): P | undefined {
  return taskProjectScope(task) === "single" ? projectOf(task) : undefined;
}

export function checkPlanJobs(plan: Plan, project: { name: string } | undefined): { plan: Plan; problems: string[] } {
  const problems: string[] = [];
  const scheduledJobs = plan.scheduledJobs.map((def) => {
    if (!isRepeating(def.schedule)) problems.push(planJobProblems.notRepeating(def.title));
    const named = def.project?.trim();
    if (named && named !== project?.name) problems.push(planJobProblems.wrongProject(def.title, named, project?.name));
    const { project: _named, ...rest } = def;
    return project ? { ...rest, project: project.name } : rest;
  });
  return { plan: { ...plan, scheduledJobs }, problems };
}
