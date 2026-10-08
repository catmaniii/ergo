// 执行中各阶段的状态（规格第 8 节"阶段执行""状态补充""返工"）：控制器的纯函数，表格驱动。
// - 前置阶段没验收的阶段不能开始；
// - 某一支在等用户、别的阶段还能推进时继续推进，所有能推进的分支都在等用户时才转等我；
// - 返工按依赖重开指定阶段和它的全部下游，其余保持已验收。
import { initialStages, type Plan, type TaskStage } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { currentStage, guardStageId, missingPrerequisites, nextStep, reopen, stagePosition } from "../../src/tasks/stages.ts";
import { samplePlan } from "../helpers/plans.ts";

/** 四个阶段：s1 → s2 → s3，s4 不依赖谁 */
const plan: Plan = samplePlan({
  stages: [
    { ...samplePlan().stages[0]!, stageId: "s1", dependsOn: [] },
    { ...samplePlan().stages[0]!, stageId: "s2", dependsOn: ["s1"] },
    { ...samplePlan().stages[0]!, stageId: "s3", dependsOn: ["s2"] },
    { ...samplePlan().stages[0]!, stageId: "s4", dependsOn: [] },
  ],
});

/** 按 "s1:accepted s2:running" 这样的写法给各阶段设状态 */
function stages(spec: string): TaskStage[] {
  const states = Object.fromEntries(spec.split(/\s+/).filter(Boolean).map((x) => x.split(":") as [string, TaskStage["state"]]));
  return initialStages(plan).map((s) => ({
    ...s,
    state: states[s.stageId] ?? "pending",
    ...(states[s.stageId] === "waiting" ? { waitReason: "acceptance" as const } : {}),
  }));
}

describe("开始执行时", () => {
  it("每个阶段都是未开始，验收标准照计划，还没宣布过完成", () => {
    expect(initialStages(samplePlan())).toEqual([
      { stageId: "s1", title: "收集资料", state: "pending", dependsOn: [], acceptance: [{ criterion: "清单里至少有五个来源", method: "review" }], attempts: 0 },
      {
        stageId: "s2",
        title: "写调研报告",
        state: "pending",
        dependsOn: ["s1"],
        acceptance: [
          { criterion: "报告文件存在", method: "script" },
          { criterion: "结论你认可", method: "user" },
        ],
        attempts: 0,
      },
    ]);
  });
});

describe("前置阶段没验收的阶段不能开始", () => {
  it.each([
    ["", "s1", []],
    ["", "s2", ["s1"]],
    ["s1:running", "s2", ["s1"]],
    ["s1:waiting", "s2", ["s1"]],
    ["s1:accepted", "s2", []],
    ["s1:accepted", "s3", ["s2"]],
    ["s1:accepted s2:accepted", "s3", []],
  ] as const)("%s 时开始 %s：缺 %j", (spec, stageId, missing) => {
    expect(missingPrerequisites(stages(spec), stageId)).toEqual(missing);
  });
});

describe("下一步", () => {
  it.each([
    // 还没有在做的：开始第一个能开始的（按计划里的顺序）
    ["", { kind: "start", stageId: "s1" }],
    ["s1:accepted", { kind: "start", stageId: "s2" }],
    // 有阶段在做、在验收：接着做
    ["s1:running", { kind: "continue" }],
    ["s1:accepting", { kind: "continue" }],
    // 一支在等用户：不依赖它的阶段接着推进，任务仍是执行中
    ["s1:waiting", { kind: "start", stageId: "s4" }],
    ["s1:accepted s2:waiting", { kind: "start", stageId: "s4" }],
    // 所有能推进的分支都在等用户：转等我
    ["s1:waiting s4:accepted", { kind: "wait", reason: "acceptance", stageId: "s1" }],
    ["s1:waiting s4:waiting", { kind: "wait", reason: "acceptance", stageId: "s1" }],
    // 全部验收：完成
    ["s1:accepted s2:accepted s3:accepted s4:accepted", { kind: "complete" }],
  ] as const)("%s → %j", (spec, step) => {
    expect(nextStep(stages(spec))).toEqual(step);
  });

  // 并行（20 号票）：有子 agent 在做的阶段不算维护者手头的
  it.each([
    // 维护者自己在做 s1、子 agent 在做 s4：接着做
    ["s1:running s4:running", ["s4"], { kind: "continue" }],
    // 在做的只有子 agent 的：替维护者开始一个能开始的
    ["s1:accepted s4:running", ["s4"], { kind: "start", stageId: "s2" }],
    // 在做的只有子 agent 的、没有能开始的：接着等子 agent（不转等我）
    ["s1:running s4:accepted", ["s1"], { kind: "continue" }],
    ["s1:running", ["s1"], { kind: "start", stageId: "s4" }],
    ["s1:running s4:waiting", ["s1"], { kind: "continue" }],
    // 子 agent 都做完了：它们的阶段又算维护者手头的
    ["s1:accepted s4:running", [], { kind: "continue" }],
  ] as const)("%s，子 agent 在做 %j → %j", (spec, busy, step) => {
    expect(nextStep(stages(spec), new Set(busy))).toEqual(step);
  });

  it("还没建阶段的（空列表）不算完成：什么也不做", () => {
    expect(nextStep([])).toEqual({ kind: "continue" });
  });

  it("之前做到一半停下的阶段（等过用户、被退回过）优先接着做", () => {
    const list = stages("s1:accepted").map((s) => (s.stageId === "s4" ? { ...s, startedAt: "2026-10-08T10:00:00.000+08:00" } : s));
    expect(nextStep(list)).toEqual({ kind: "start", stageId: "s4" });
  });
});

describe("返工：按依赖重开指定阶段和它的全部下游，其余保持已验收", () => {
  const done = stages("s1:accepted s2:accepted s3:accepted s4:accepted").map((s) => ({
    ...s,
    attempts: 1,
    startedAt: "2026-10-08T09:00:00.000+08:00",
    acceptance: s.acceptance.map((a) => ({ ...a, result: { passed: true, at: "2026-10-08T10:00:00.000+08:00" } })),
  }));

  it.each([
    ["s2", ["s2", "s3"]],
    ["s1", ["s1", "s2", "s3"]],
    ["s3", ["s3"]],
    ["s4", ["s4"]],
  ] as const)("返工 %s：重开 %j", (stageId, reopened) => {
    const after = reopen(done, stageId);
    expect(after.filter((s) => s.state === "pending").map((s) => s.stageId)).toEqual(reopened);
    expect(after.filter((s) => s.state === "accepted").map((s) => s.stageId)).toEqual(done.map((s) => s.stageId).filter((id) => !(reopened as readonly string[]).includes(id)));
    // 重开的阶段清掉上次的验收结果，算重新开始
    for (const s of after.filter((x) => x.state === "pending")) {
      expect(s.acceptance.every((a) => a.result === undefined)).toBe(true);
      expect(s.startedAt).toBeUndefined();
    }
  });
});

describe("第 N/M 阶段和守卫看到的当前阶段", () => {
  it.each([
    ["", 1, "s1"],
    ["s1:running", 1, "s1"],
    ["s1:accepted s2:accepting", 2, "s2"],
    ["s1:accepted s2:waiting", 2, "s2"],
    ["s1:waiting s4:running", 4, "s4"],
    ["s1:accepted s2:accepted s3:accepted s4:accepted", 4, "s4"],
  ] as const)("%s：第 %i 阶段，当前阶段 %s", (spec, n, current) => {
    expect(stagePosition(stages(spec))).toBe(n);
    expect(guardStageId(stages(spec))).toBe(current);
  });

  // 并行（20 号票）：维护者的当前阶段是它最后一次开始的（focus），几个阶段同时在做时不按计划里的顺序取
  it.each([
    // 维护者在 s4、子 agent 在 s1：是 s4
    ["s1:running s4:running", "s4", ["s1"], "s4"],
    // 子 agent 做完 s1 之后：维护者还在 s4（不因为 s1 在计划里靠前就换过去）
    ["s1:running s4:running", "s4", [], "s4"],
    // 维护者切到 s1 之后：是 s1
    ["s1:running s4:running", "s1", [], "s1"],
    // 维护者最后开始的阶段在等用户：还是它
    ["s1:running s4:waiting", "s4", ["s1"], "s4"],
    // 维护者最后开始的阶段交给了子 agent：还是它（维护者在协调这一支，结果回来后在这个阶段里合并）
    ["s1:running", "s1", ["s1"], "s1"],
    // 维护者最后开始的阶段放下了（回到未开始）：取它自己在做的（有子 agent 在做的不算），没有就第一支在等的、第一个没开始的
    ["s1:running s4:running", "s2", ["s1"], "s4"],
    ["s1:running", "s4", ["s1"], "s2"],
    // 维护者最后开始的阶段已经验收了：照旧取在做的
    ["s1:accepted s4:running", "s1", [], "s4"],
    // 没记下过（旧任务）：照旧
    ["s1:running s4:running", undefined, [], "s1"],
  ] as const)("%s，维护者最后开始 %s，子 agent 在做 %j：当前阶段 %s", (spec, focus, busy, current) => {
    expect(currentStage(stages(spec), focus, new Set(busy)).stageId).toBe(current);
  });
});
