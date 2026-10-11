// 删除项目时它的内部任务一起删掉（64 号票）：任务的文字换成删除标记（ADR 0010）。84 号票起阶段上多了维护者宣布完成时写的那句
// （summary）、重开时记下的上次没过的标准（lastFailed），一样换掉；编号、状态、计数这些结构字段原样。
import { PURGED_TEXT, type Task, type TaskStage } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { purgedTask } from "../../src/tasks/material-sources.ts";

const stage = (stageId: string, extra: Partial<TaskStage>): TaskStage => ({
  stageId,
  title: `阶段 ${stageId} 的名字`,
  state: "pending",
  dependsOn: [],
  attempts: 0,
  acceptance: [{ criterion: "报告里列了来源", method: "user" }],
  ...extra,
});

const task: Task = {
  id: "t-7",
  title: "调研记账软件",
  summary: "比较三款记账软件",
  state: "running",
  origin: "button",
  maintainerId: "m-p-1",
  projects: [],
  projectIds: ["p-1"],
  projectScope: "single",
  reworks: 1,
  stages: {
    total: 2,
    list: [
      stage("s1", {
        state: "accepting",
        attempts: 2,
        summary: "按你说的去掉了营销号的来源",
        acceptance: [{ criterion: "报告里列了来源", method: "user", result: { passed: false, note: "营销号的来源去掉", at: "2026-10-11T09:00:00+08:00" } }],
      }),
      stage("s2", { attempts: 1, reopenNo: 1, lastFailed: ["表格对得上原始数据"], waitNote: "等你看一眼" }),
    ],
  },
  createdAt: "2026-10-11T08:00:00+08:00",
  updatedAt: "2026-10-11T09:00:00+08:00",
};

describe("删项目时内部任务的文字换成删除标记", () => {
  it("阶段上宣布完成时写的那句、上次没过的标准也换掉；没写的不添，结构字段原样", () => {
    const purged = purgedTask(task);
    const [s1, s2] = purged.stages!.list!;
    expect([purged.title, purged.summary]).toEqual([PURGED_TEXT, PURGED_TEXT]);
    expect([s1!.title, s1!.summary, s1!.acceptance[0]!.criterion, s1!.acceptance[0]!.result?.note]).toEqual([PURGED_TEXT, PURGED_TEXT, PURGED_TEXT, PURGED_TEXT]);
    expect([s2!.summary, s2!.lastFailed, s2!.waitNote]).toEqual([undefined, [PURGED_TEXT], PURGED_TEXT]);
    expect("summary" in s2!).toBe(false);
    expect([purged.id, purged.state, purged.reworks, s1!.attempts, s1!.state, s2!.reopenNo, s1!.acceptance[0]!.result?.passed]).toEqual(["t-7", "running", 1, 2, "accepting", 1, false]);
    // 原文一个字都不剩
    expect(JSON.stringify(purged)).not.toMatch(/营销号|列了来源|对得上原始数据|看一眼|记账/);
  });
});
