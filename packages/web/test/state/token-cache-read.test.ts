// token 总数里单写缓存命中的（311 号票，294 号票端到端小测第 4 条）：Claude Code 跑一个小任务"124 万 token"，其中 104 万是缓存命中，
// 看着吓人。任务卡、任务详情顶上、项目页的内部任务、⚙ 的上下文用量写总数时带一句"（其中缓存命中 …）"，说法照消耗页的
// "缓存命中"；pi 和 Claude Code 一样（都来自账本的 cacheHit）。消耗页、任务详情的明细表不变。
import { describe, expect, test } from "vitest";
import { tokensText } from "../../src/model/labels.ts";
import { agentContextLines, boardGroups, type Project, projectInternalTasks, replay, type Task, taskUsage, type TokenTotalsEventPayload } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const T = "2026-10-26T09:00:00.000+08:00";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: "命令行待办小工具 todo.py",
  summary: "",
  state: "done",
  origin: "button",
  maintainerId: "tm-1",
  projects: [],
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const totals = (taskId: string, tokens: TokenTotalsEventPayload["tokens"]): TokenTotalsEventPayload => ({ owner: { kind: "task", id: taskId }, tokens, calls: 18, byAgent: [], byStage: [], time: T });

const project: Project = { id: "p-1", name: "单位换算小工具", goal: "换算", state: "building", origin: "suggestion", maintainerId: "pm-1", workdir: { external: false }, charterConfirmed: true, createdAt: T, updatedAt: T };

describe("token 总数里单写缓存命中的（311 号票）", () => {
  test("写法：有缓存命中的带“（其中缓存命中 …）”，没有的照旧", () => {
    expect(tokensText(1_240_000, 1_040_000)).toBe("124 万 token（其中缓存命中 104 万）");
    expect(tokensText(23_815, 20_000)).toBe("2.4 万 token（其中缓存命中 2 万）");
    expect(tokensText(23_815, 0)).toBe("2.4 万 token");
    expect(tokensText(5_000)).toBe("5000 token");
  });

  test("看板任务卡、任务详情的合计带上缓存命中的数（账本的 cacheHit）；还没有用量的是 0", () => {
    const state = replay([
      frame("board", 1, "task", { task: task("t-1"), change: "created", from: null, by: "user" }),
      frame("board", 2, "task", { task: task("t-2", { state: "running" }), change: "created", from: null, by: "user" }),
      frame("board", 3, "token_totals", totals("t-1", { cacheHit: 1_040_000, cacheMiss: 186_000, output: 14_000 })),
    ]);
    const items = boardGroups(state).flatMap((g) => g.items.flatMap((i) => (i.kind === "task" ? [[i.task.id, i.tokens, i.cacheHitTokens]] : [])));
    expect(items.toSorted()).toEqual([
      ["t-1", 1_240_000, 1_040_000],
      ["t-2", 0, 0],
    ]);
    expect(taskUsage(state, "t-1")).toMatchObject({ total: 1_240_000, cacheHit: 1_040_000 });
  });

  test("项目页的内部任务那一行也带上", () => {
    const state = replay([
      frame("projects", 1, "project", { project, change: "created", from: null, by: "user" }),
      frame("board", 1, "task", { task: task("t-2", { state: "running", maintainerId: "pm-1", projects: ["单位换算小工具"], projectIds: ["p-1"], internal: { projectId: "p-1", projectName: "单位换算小工具" } }), change: "created", from: null, by: "user" }),
      frame("board", 2, "token_totals", totals("t-2", { cacheHit: 900_000, cacheMiss: 100_000, output: 5_000 })),
    ]);
    expect(projectInternalTasks(state, "p-1").open.map((v) => [v.task.id, v.tokens, v.cacheHitTokens])).toEqual([["t-2", 1_005_000, 900_000]]);
  });

  test("⚙ 的上下文用量：最近一次调用的上下文里缓存命中的单写；没有的照旧", () => {
    const base = { running: true, busy: false, compaction: "idle" as const, window: 200_000, autoCompactAt: 200_000 - 16_384 };
    expect(agentContextLines({ ...base, usedTokens: 82_000, cacheHitTokens: 80_000 }, undefined).usage).toBe("8.2 万 / 20 万 token（其中缓存命中 8 万）");
    expect(agentContextLines({ ...base, usedTokens: 82_000 }, undefined).usage).toBe("8.2 万 / 20 万 token");
  });
});
