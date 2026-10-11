// 秘书眼里的任务看板（22 号票）：一个任务写成的那一项里的"第几阶段"（93 号票：写编号，和界面一致）。纯函数。
import type { Task, TaskStage } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { taskEntry } from "../../src/board/board.ts";

const stage = (stageId: string, dependsOn: string[], extra: Partial<TaskStage> = {}): TaskStage => ({ stageId, title: stageId, state: "pending", dependsOn, acceptance: [], attempts: 0, ...extra });

const task = (stages: Task["stages"]): Task => ({ id: "t-1", title: "换新电脑", summary: "", state: "running", origin: "button", maintainerId: "tm-1", projects: [], createdAt: "2026-10-12T09:00:00+08:00", updatedAt: "2026-10-12T09:00:00+08:00", ...(stages ? { stages } : {}) });

describe("看板上的第几阶段（93 号票）", () => {
  it("写正在做的那一阶段的编号 / 一共几个阶段号：并行的写 1b，计划里存的号优先", () => {
    const list = [stage("s1", [], { code: "1a" }), stage("s2", [], { code: "1b", state: "running" }), stage("s3", ["s1", "s2"], { code: "2" })];
    expect(taskEntry(task({ total: 3, current: 2, list, focus: "s2" })).stage).toBe("第 1b/2 阶段");
  });

  it("去掉了中间的阶段（93 号票评审）：编号不改名，\"/\" 后面是存下的编号里最大的阶段号，不写成\"第 3/2 阶段\"", () => {
    const list = [stage("s1", [], { code: "1", state: "accepted" }), stage("s3", ["s1"], { code: "3", state: "running" })];
    expect(taskEntry(task({ total: 2, current: 2, list, focus: "s3" })).stage).toBe("第 3/3 阶段");
  });

  it("之前开始执行的任务（阶段列表里没有编号）：按依赖图现算，和界面一样", () => {
    const list = [stage("s1", []), stage("s2", []), stage("s3", ["s1", "s2"])];
    expect(taskEntry(task({ total: 3, current: 3, list })).stage).toBe("第 2/2 阶段");
  });

  it("看板上还没有阶段列表的照旧写计划里的第几个 / 共几个", () => {
    expect(taskEntry(task({ total: 3, current: 1 })).stage).toBe("第 1/3 阶段");
    expect(taskEntry(task({ total: 3 })).stage).toBeUndefined();
  });
});
