// 项目列表（15 号票）：项目列表频道上的 project 事件归并成每个项目的最新状态；进行中任务数来自看板频道上的任务；
// 项目页上的入口按协议包的 projectActions；删掉的项目连同它的维护者会话从界面上拿掉。
import { describe, expect, test } from "vitest";
import {
  maintainerChannel,
  type Project,
  type ProjectEventPayload,
  projectViews,
  replay,
  selectableProjectNames,
  selectProject,
  type Task,
  type TaskEventPayload,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, name: `项目${id}`, goal: "目标", state: "preparing", origin: "suggestion", maintainerId: `pm-${id}`, workdir: { external: false }, charterConfirmed: false, createdAt: T, updatedAt: T, ...overrides };
}

const projectFrame = (seq: number, p: Project, change: ProjectEventPayload["change"] = "created") =>
  frame("projects", seq, "project", { project: p, change, from: null, by: "user" } satisfies ProjectEventPayload);

/** 一个涉及这些项目（编号）的任务 */
function task(id: string, state: Task["state"], projectIds: string[]): Task {
  return { id, title: id, summary: id, state, origin: "button", maintainerId: `tm-${id}`, projects: projectIds.map((p) => `项目${p}`), projectIds, createdAt: T, updatedAt: T };
}

const taskFrame = (seq: number, t: Task) => frame("board", seq, "task", { task: t, change: "created", from: null, by: "user" } satisfies TaskEventPayload);

describe("项目列表", () => {
  test("每个项目留最新的状态；按状态排（使用中、建设中、筹备中、已停用、已归档），带进行中的任务数（未结束、按编号涉及它的）", () => {
    const state = replay([
      projectFrame(1, project("p-1", { name: "记账本" })),
      projectFrame(2, project("p-2", { name: "家电档案" })),
      projectFrame(3, project("p-1", { name: "记账本", state: "in_use" }), "in_use"),
      projectFrame(4, project("p-3", { name: "旧网站", state: "archived", archivedFrom: "retired" }), "archived"),
      taskFrame(1, task("t-1", "running", ["p-1"])),
      taskFrame(2, task("t-2", "done", ["p-1"])),
      taskFrame(3, task("t-3", "planning", ["p-1", "p-2"])),
      // 只有名字、没有编号的（同名的旧项目的任务）不算
      taskFrame(4, { ...task("t-4", "running", []), projects: ["记账本"] }),
    ]);
    expect(projectViews(state).map((v) => [v.project.id, v.project.state, v.activeTasks])).toEqual([
      ["p-1", "in_use", 2],
      ["p-2", "preparing", 1],
      ["p-3", "archived", 0],
    ]);
    // 项目页上的入口按状态给出
    expect(selectProject(state, "p-1")?.actions).toEqual(["retire", "archive"]);
    expect(selectProject(state, "p-3")?.actions).toEqual(["unarchive", "delete"]);
    // "发起任务"时能选的项目：没归档的
    expect(selectableProjectNames(state)).toEqual(["记账本", "家电档案"]);
  });

  test("首个建设任务失败了：建设中的项目可以再开工", () => {
    const state = replay([projectFrame(1, project("p-1", { name: "记账本", state: "building", charterConfirmed: true, buildTaskId: "t-1" })), taskFrame(1, task("t-1", "failed", ["p-1"]))]);
    expect(selectProject(state, "p-1")?.actions).toEqual(["start_build", "abandon"]);
  });

  test("删掉的项目：从列表里拿掉，它的维护者会话也从界面上拿掉（游标归零）", () => {
    const pm = maintainerChannel("pm-p-1");
    const state = replay([
      projectFrame(1, project("p-1", { state: "archived" })),
      frame(pm, 1, "message", { message: textMessage("m1", "user", "在吗", pm), projectId: "p-1" }),
      projectFrame(2, project("p-1", { state: "archived" }), "deleted"),
    ]);
    expect(projectViews(state)).toEqual([]);
    expect(state.conversations[pm]).toBeUndefined();
    expect(state.cursors[pm]).toBeUndefined();
  });

  test("重新同步项目列表频道：清掉手里的项目", () => {
    const state = replay([projectFrame(1, project("p-1")), { kind: "resync", channel: "projects" }]);
    expect(projectViews(state)).toEqual([]);
  });
});
