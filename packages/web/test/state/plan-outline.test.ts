// 93 号票：聊天里计划卡、计划变更卡一直列着的阶段提纲——
// 按阶段号分组，一个阶段号只有一个的写在那一行，几个并行的写"可并行 · N 个"；每一项写标题、新 / 改、要你留意的、状态（没开始的不写）、
// 计划变更去掉的写"已去掉"；还有计划详情里的小流程图（"流程"一节）画哪一份。
// 回放 task-plan-change（两个阶段并行；计划变更等你确认、被拒绝、维护者自行调整了顺序），录不出来的按协议的 schema 构造。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type Card, type PlanChangeCardPayload, type PlanOutlineView, planDetailGraph, planOutline, replay, type UiInput, type UiState } from "../../src/state/index.ts";
import { frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const until = (inputs: UiInput[], n: number) => replay(inputs.slice(0, n));

/** 提纲写成短串：第几阶段（可并行几个）：每一项 标题 新/改 状态 */
function brief(view: PlanOutlineView | undefined): string[] {
  return (view?.stages ?? []).map(
    (st) =>
      `第 ${st.no} 阶段${st.items.length > 1 ? `（可并行 · ${st.live} 个）` : ""}：${st.items
        .map((x) => [x.title, x.mark, x.gone ? "已去掉" : x.look?.text].filter(Boolean).join(" "))
        .join("、")}`,
  );
}

/** 这个状态里某种卡的最后一张 */
const lastCard = (state: UiState, type: string) =>
  Object.values(state.cards)
    .map((c) => c.card)
    .filter((c) => c.type === type)
    .at(-1)!;

describe("计划卡的提纲：回放 task-plan-change", () => {
  const inputs = load("task-plan-change");

  test("计划等你确认：两个阶段都没有前置，同在第 1 阶段（可并行 · 2 个）；没开始的不写状态；没有要你留意的就没有图例", () => {
    const state = until(inputs, 7);
    const view = planOutline(state, lastCard(state, "plan"));
    expect(brief(view)).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料、写报告"]);
    expect(view!.stages[0]!.items.map((x) => x.code)).toEqual(["1a", "1b"]);
    expect(view!.legend).toEqual({ perm: undefined, out: undefined, ask: false });
  });

  test("计划确认了、在执行：现在生效的那份写各阶段的状态；换过版之后，旧的那张计划卡不再写状态", () => {
    const running = until(inputs, 23);
    expect(brief(planOutline(running, lastCard(running, "plan")))).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料 进行中、写报告"]);
    const state = replay(inputs);
    expect(brief(planOutline(state, lastCard(state, "plan")))).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料、写报告"]);
  });

  test("计划变更卡：改过的阶段标\"改\"，状态照各阶段现在的；新加的授权算进要你留意的（权），图例写是哪种动作", () => {
    const state = until(inputs, 34);
    const view = planOutline(state, lastCard(state, "plan_change"));
    expect(brief(view)).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料 改 等你、写报告 进行中"]);
    expect(view!.stages[0]!.items[0]!.marks?.perm.map((m) => m.grantId)).toEqual(["dir1"]);
    expect(view!.legend.perm).toEqual(["建目录"]);
    expect(view!.legend.out).toBeUndefined();
  });

  test("做完的阶段写\"已验收\"（93 号票，用户定），在做、在等的照依赖图的说法", () => {
    const state = replay(inputs);
    // 被拒的那张计划变更卡也写各阶段现在的：s2 做完了，s1 卡住在等
    expect(brief(planOutline(state, lastCard(state, "plan_change")))).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料 改 等你、写报告 已验收"]);
  });

  test("不是计划卡的没有提纲", () => {
    const state = replay(inputs);
    const progress = lastCard(state, "progress");
    expect(planOutline(state, progress)).toBeUndefined();
    expect(planDetailGraph(state, progress)).toBeUndefined();
  });
});

describe("计划变更加一个阶段、去掉一个阶段（构造）", () => {
  const inputs = load("task-plan-change");
  // 计划变更卡交上来之前的那一刻：s1 在做、s2 还没开始
  const base = until(inputs, 23);
  const planCard = base.cards[base.tasks["t-1"]!.planCardId!]!.card;
  const basePlan = (planCard.payload as { plan: PlanChangeCardPayload["plan"] }).plan;
  const s1 = basePlan.stages[0]!;
  const { code: _code, ...s1Fields } = s1;
  // 变更后：s2 去掉，加 s3（在 s1 之后）、s4（和 s1 并行）
  const s3 = { ...s1Fields, stageId: "s3", title: "写摘要", dependsOn: ["s1"], policy: { grants: [], temporalRules: [] } };
  const s4 = { ...s1Fields, stageId: "s4", title: "补充资料", dependsOn: [], policy: { grants: [], temporalRules: [] } };
  const { scheduledJobs: _legacy, ...rest } = basePlan as typeof basePlan & { scheduledJobs?: unknown };
  const payload: PlanChangeCardPayload = {
    taskId: "t-1",
    taskTitle: "拒绝",
    planId: "t-1-p2",
    revision: 2,
    basePlanId: "t-1-p1",
    why: "报告改成摘要",
    changes: [
      { kind: "stage_removed", expands: false, stageId: "s2", title: "写报告" },
      { kind: "stage_added", expands: false, stageId: "s3", title: "写摘要" },
      { kind: "stage_added", expands: false, stageId: "s4", title: "补充资料" },
    ],
    affectedStages: [{ stageId: "s2", title: "写报告" }],
    plan: { ...rest, stages: [s1, s3, s4] },
    grantInfo: {},
  };
  const change: Card = { id: "c-change", type: "plan_change", typeVersion: 1, version: 1, status: "pending", payload, text: "计划变更", createdAt: "2026-10-08T15:00:00+08:00" };
  const pending = replay([frame("cards", 900, "card", { card: change })], base);

  test("新加的标\"新\"，去掉的也列上（划掉、写已去掉），阶段号和还在的一起排；并行的写可并行几个（去掉的不算）", () => {
    const view = planOutline(pending, change);
    expect(brief(view)).toEqual(["第 1 阶段（可并行 · 2 个）：收集资料 进行中、补充资料 新、写报告 已去掉", "第 2 阶段：写摘要 新"]);
    expect(view!.stages[0]!.items.find((x) => x.gone)!.marks).toBeUndefined();
  });

  test("详情里的小流程图：画变更后的那份，新加的标新、去掉的也画上（和左栏一样）", () => {
    const g = planDetailGraph(pending, change);
    expect(g?.kind).toBe("change");
    expect(g!.nodes.map((n) => `${n.id} ${n.state}${n.mark ? ` ${n.mark}` : ""}`)).toEqual(["s1 running", "s3 pending 新", "s4 pending 新", "s2 removed"]);
  });

  test("计划卡的小流程图：还没确认的画成计划卡的样子（没开始、标要你留意的），在执行的带状态", () => {
    const state = until(inputs, 7);
    const g = planDetailGraph(state, lastCard(state, "plan"));
    expect(g?.kind).toBe("plan");
    expect(g!.nodes.map((n) => n.state)).toEqual(["pending", "pending"]);
    const live = planDetailGraph(base, planCard);
    expect(live?.kind).toBe("change");
    expect(live!.nodes.map((n) => n.state)).toEqual(["running", "pending"]);
  });
});
