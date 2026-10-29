// 计划里涉及的项目要对得上任务（17 号票评审后定）：纯函数 planProjectProblems。任务涉及几个项目建卡时定下，不随计划改动重新判断。
// 112 号票：长程任务的阶段自动验收，计划里写由你验收的一并退回（autoAccepted）。
import type { Plan } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { planProjectProblems } from "../../src/tasks/plan-projects.ts";
import { samplePlan } from "../helpers/plans.ts";

const IDS: Record<string, string> = { 记账本: "p-1", "p-1": "p-1", 家电档案: "p-2", "p-2": "p-2" };
const projectIdOf = (name: string) => IDS[name.trim()];

function planWith(projects: Plan["projects"], method: "script" | "review" | "user" = "review"): Plan {
  const plan = samplePlan();
  return {
    ...plan,
    stages: plan.stages.map((s) => ({ ...s, acceptance: s.acceptance.map((a) => (method === "script" ? { ...a, method, script: "exit 0" } : { criterion: a.criterion, method })) })),
    projects,
  };
}

describe("计划里涉及的项目要对得上任务", () => {
  it("不涉及项目的任务：计划里不能写项目行", () => {
    expect(planProjectProblems({ scope: "none", plan: planWith([]), projectIdOf })).toEqual([]);
    expect(planProjectProblems({ scope: "none", plan: planWith([{ project: "记账本", changes: ["加周报"] }]), projectIdOf })).toEqual([
      "这个任务不涉及项目，计划里不能写项目行（「记账本」）。要涉及项目就重新发起任务",
    ]);
  });

  it("单项目任务：只能写它自己那个项目（名字、编号都认），写进别的项目被拒，同一个项目只说一次", () => {
    const own = { project: "记账本", changes: ["加周报"] };
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", plan: planWith([own, { project: "p-1", changes: ["再加月报"] }]), projectIdOf })).toEqual([]);
    expect(
      planProjectProblems({
        scope: "single",
        ownProjectId: "p-1",
        plan: planWith([own, { project: "家电档案", changes: ["顺手改"] }, { project: "家电档案", changes: ["再改"] }, { project: "相册库", changes: ["也改"] }]),
        projectIdOf,
      }),
    ).toEqual([
      "这个任务只涉及它自己那个项目，计划里不能写进别的项目「家电档案」。要涉及多个项目就重新发起任务",
      "这个任务只涉及它自己那个项目，计划里不能写进别的项目「相册库」。要涉及多个项目就重新发起任务",
    ]);
  });

  it("项目内部任务（64 号票）：只动本项目，写进别的项目被拒，告诉用户改成普通任务", () => {
    const own = { project: "记账本", changes: ["加周报"] };
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", internal: true, plan: planWith([own]), projectIdOf })).toEqual([]);
    expect(
      planProjectProblems({ scope: "single", ownProjectId: "p-1", internal: true, plan: planWith([own, { project: "家电档案", changes: ["顺手改"] }, { project: "相册库", changes: ["也改"] }]), projectIdOf }),
    ).toEqual(["项目内部任务只动本项目，不能涉及别的项目（「家电档案」、「相册库」）：要动别的项目，告诉用户改成普通任务（涉及这几个项目的跨项目任务，让秘书发起）"]);
  });

  it("多项目任务：每一行写计划里有的所属阶段和这张工单的验收标准，项目要在项目列表里，同一阶段同一项目只写一行；计划里只剩一个项目也照样查", () => {
    const stageId = samplePlan().stages[0]!.stageId;
    const good = { project: "记账本", changes: ["加导出"], stageId, acceptance: ["有 export.md"] };
    expect(planProjectProblems({ scope: "multi", plan: planWith([good]), projectIdOf })).toEqual([]);
    expect(planProjectProblems({ scope: "multi", plan: planWith([]), projectIdOf })).toEqual([expect.stringContaining("在 projects 里逐行写出每个项目的改动")]);
    expect(
      planProjectProblems({
        scope: "multi",
        plan: planWith([
          good,
          { project: "p-1", changes: ["再加一点"], stageId, acceptance: ["有"] },
          { project: "家电档案", changes: ["加导入"] },
          { project: "相册库", changes: ["加标签"], stageId: "s9", acceptance: ["有"] },
        ]),
        projectIdOf,
      }),
    ).toEqual([
      "projects 第 2 行（项目「p-1」）：同一阶段同一项目只写一行（把改动合并到一行的 changes 里）",
      "projects 第 3 行（项目「家电档案」）：要写所属阶段 stageId（这个阶段开始时派出工单）",
      "projects 第 3 行（项目「家电档案」）：要写这张工单自己的验收标准 acceptance",
      "projects 第 4 行（项目「相册库」）：计划里没有阶段 s9",
      "projects 第 4 行（项目「相册库」）：项目列表里没有「相册库」",
    ]);
  });

  it("多项目任务的阶段验收不用脚本（交付件在各项目那边）；单项目任务可以", () => {
    const stageId = samplePlan().stages[0]!.stageId;
    const line = { project: "记账本", changes: ["加导出"], stageId, acceptance: ["有 export.md"] };
    expect(planProjectProblems({ scope: "multi", plan: planWith([line], "script"), projectIdOf })).toEqual(
      samplePlan().stages.map((s) => `阶段 ${s.stageId} 的验收标准不能用脚本（script）：交付件在各项目那边，脚本在任务的产出区里跑不到。用评审（review）`),
    );
    expect(planProjectProblems({ scope: "multi", plan: planWith([line], "review"), projectIdOf })).toEqual([]);
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", plan: planWith([{ project: "记账本", changes: ["加导出"] }], "script"), projectIdOf })).toEqual([]);
  });

  it("阶段自动验收（112 号票，用户同日同意扩到所有长程任务）：不涉及项目、单项目、多项目的写由用户验收都被退回，说明改成什么（多项目的只能改成评审）；已验收的阶段不管；不是长程任务的不查", () => {
    const refusal = (stageId: string, criteria: string) =>
      `阶段 ${stageId} 的验收标准${criteria}写的是由用户验收（user）：阶段自动验收，改成 script 或 review（能脚本查的先脚本查，再加一条评审综合看）`;
    const plan = planWith([], "user");
    const both = [refusal("s1", "「清单里至少有五个来源」"), refusal("s2", "「报告文件存在」、「结论站得住」")];
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", internal: true, autoAccepted: true, plan, projectIdOf })).toEqual(both);
    expect(planProjectProblems({ scope: "none", autoAccepted: true, plan, projectIdOf })).toEqual(both);
    // 计划变更、自行调整时：已经验收了的阶段（升级前由你验收过的）不管
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", internal: true, autoAccepted: true, plan, projectIdOf, accepted: new Set(["s1"]) })).toEqual([both[1]]);
    expect(planProjectProblems({ scope: "single", ownProjectId: "p-1", autoAccepted: true, plan: planWith([], "review"), projectIdOf })).toEqual([]);
    const stageId = samplePlan().stages[0]!.stageId;
    expect(planProjectProblems({ scope: "multi", autoAccepted: true, plan: planWith([{ project: "记账本", changes: ["加导出"], stageId, acceptance: ["有"] }], "user"), projectIdOf })).toEqual([
      "阶段 s1 的验收标准「清单里至少有五个来源」写的是由用户验收（user）：阶段自动验收，改成 review（评审读得到回执和各项目的交付件）",
      "阶段 s2 的验收标准「报告文件存在」、「结论站得住」写的是由用户验收（user）：阶段自动验收，改成 review（评审读得到回执和各项目的交付件）",
    ]);
    // 不是长程任务（流程那个内部阶段写着 user，只是给人看的）：不查
    expect(planProjectProblems({ scope: "none", plan, projectIdOf })).toEqual([]);
  });
});
