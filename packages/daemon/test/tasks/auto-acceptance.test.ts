// 阶段自动验收（112 号票）的纯函数：升级前确认的计划里，没验收的阶段写着由你验收的标准改由评审验收；
// 哪几条是原定由你验收、按新规矩改由评审的（进度卡上写明）。
import type { Plan } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { autoAcceptedPlan, convertedCriteria } from "../../src/tasks/auto-acceptance.ts";
import { samplePlan } from "../helpers/plans.ts";

/** 两个阶段都有由你验收的标准（升级前的计划） */
function userPlan(): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      { ...base.stages[0]!, acceptance: [...base.stages[0]!.acceptance, { criterion: "来源你认可", method: "user" }] },
      { ...base.stages[1]!, acceptance: [base.stages[1]!.acceptance[0]!, { criterion: "结论你认可", method: "user" }] },
    ],
  };
}

describe("autoAcceptedPlan", () => {
  it("没验收的阶段里由你验收的标准改由评审（照原文），别的标准、别的字段不动；给出改了哪几条", () => {
    const { plan, converted } = autoAcceptedPlan(userPlan(), new Set());
    expect(plan.stages.map((s) => s.acceptance)).toEqual([
      [
        { criterion: "清单里至少有五个来源", method: "review" },
        { criterion: "来源你认可", method: "review" },
      ],
      [
        { criterion: "报告文件存在", method: "script", script: "test -f report.md" },
        { criterion: "结论你认可", method: "review" },
      ],
    ]);
    expect(converted).toEqual([
      { stageId: "s1", title: "收集资料", criteria: ["来源你认可"] },
      { stageId: "s2", title: "写调研报告", criteria: ["结论你认可"] },
    ]);
    expect({ ...plan, stages: [] }).toEqual({ ...userPlan(), stages: [] });
  });

  it("已验收的阶段不动；没有要改的原样返回（再做一遍什么也不改）", () => {
    const { plan, converted } = autoAcceptedPlan(userPlan(), new Set(["s1"]));
    expect(plan.stages[0]).toEqual(userPlan().stages[0]);
    expect(converted.map((c) => c.stageId)).toEqual(["s2"]);
    const again = autoAcceptedPlan(plan, new Set(["s1"]));
    expect(again.converted).toEqual([]);
    expect(again.plan).toBe(plan);
  });
});

describe("convertedCriteria", () => {
  it("现在由评审验收、之前确认过的某一版里由你验收的那几条", () => {
    const before = userPlan();
    const { plan } = autoAcceptedPlan(before, new Set());
    expect([...convertedCriteria([before, plan], plan, "s1")]).toEqual(["来源你认可"]);
    expect([...convertedCriteria([before, plan], plan, "s2")]).toEqual(["结论你认可"]);
    // 一直是评审的、还是由你验收的不算
    expect([...convertedCriteria([before], before, "s2")]).toEqual([]);
    expect([...convertedCriteria([plan], plan, "s1")]).toEqual([]);
  });
});
