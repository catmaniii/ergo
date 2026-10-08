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
  projectPipeline,
  taskWaitingForProject,
  type WorkOrder,
  type WorkOrderEventPayload,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

/** 用户发起的单项目任务的工单（16 号票） */
type UserTaskWorkOrder = Extract<WorkOrder, { source: "user_task" }>;

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

  test("重新同步项目列表频道：清掉手里的项目和工单", () => {
    const state = replay([projectFrame(1, project("p-1")), orderFrame(2, order("wo-1", "p-1", "pending")), { kind: "resync", channel: "projects" }]);
    expect(projectViews(state)).toEqual([]);
    expect(state.workOrders).toEqual({});
  });
});

/** 一张工单（16 号票） */
function order(id: string, projectId: string, state: WorkOrder["state"], overrides: Partial<UserTaskWorkOrder> = {}): UserTaskWorkOrder {
  return { id, projectId, maintainerId: `pm-${projectId}`, source: "user_task", kind: "plan", taskId: "t-1", taskTitle: "t-1", title: `起草计划：t-1`, state, createdAt: T, updatedAt: T, ...overrides };
}

const orderFrame = (seq: number, w: WorkOrder, change: WorkOrderEventPayload["change"] = "created") =>
  frame("projects", seq, "work_order", { workOrder: w, change, from: null, by: "system" } satisfies WorkOrderEventPayload);

describe("工单（16 号票）", () => {
  test("重置维护者是项目页上单独的入口（不和项目状态动作排在一起）：已归档的不能重置", () => {
    const state = replay([projectFrame(1, project("p-1", { state: "in_use" })), projectFrame(2, project("p-2", { state: "archived" }))]);
    expect(selectProject(state, "p-1")).toMatchObject({ actions: ["retire", "archive"], canResetMaintainer: true, archiveBlocked: undefined });
    expect(selectProject(state, "p-2")).toMatchObject({ actions: ["unarchive", "delete"], canResetMaintainer: false });
  });

  test("还有正在做或排队的工单时不能归档：项目页写明先完成或取消哪几个任务（守护进程按同一句拒绝）；工单都结束了就能归档", () => {
    const frames = [
      projectFrame(1, project("p-1", { state: "in_use", name: "记账本" })),
      orderFrame(2, order("wo-1", "p-1", "in_progress", { taskId: "t-1", taskTitle: "加周报" })),
      orderFrame(3, order("wo-2", "p-1", "pending", { taskId: "t-2", taskTitle: "加月报" })),
    ];
    expect(selectProject(replay(frames), "p-1")?.archiveBlocked).toBe("项目还有正在做或排队的工单：先完成或取消任务 t-1「加周报」、t-2「加月报」，再归档");
    const done = replay([
      ...frames,
      orderFrame(4, order("wo-1", "p-1", "ended", { taskId: "t-1", taskTitle: "加周报", outcome: "done" }), "ended"),
      orderFrame(5, order("wo-2", "p-1", "ended", { taskId: "t-2", taskTitle: "加月报", outcome: "returned" }), "ended"),
    ]);
    expect(selectProject(done, "p-1")?.archiveBlocked).toBeUndefined();
  });

  test("“等项目 X”只在真被项目挡住时标：任务正等着这张排着的工单、项目的维护者手上有别的工单；全局执行名额满了、任务暂停了都不算", () => {
    const base = [projectFrame(1, project("p-1", { state: "in_use", name: "记账本" }))];
    const queued = { ...task("t-2", "queued", ["p-1"]), maintainerId: "pm-p-1" };
    const execute = order("wo-2", "p-1", "pending", { taskId: "t-2", kind: "execute" });
    const busy = orderFrame(3, order("wo-1", "p-1", "in_progress", { taskId: "t-1", kind: "execute" }));
    // 项目的维护者正忙着别的工单：等项目
    expect(taskWaitingForProject(replay([...base, taskFrame(1, queued), busy, orderFrame(4, execute)]), "t-2")).toBe("记账本");
    // 维护者空着（工单还排着，是全局执行名额满了）：不标
    expect(taskWaitingForProject(replay([...base, taskFrame(1, queued), orderFrame(4, execute)]), "t-2")).toBeUndefined();
    // 任务暂停了：不标
    expect(taskWaitingForProject(replay([...base, taskFrame(1, { ...queued, state: "paused" }), busy, orderFrame(4, execute)]), "t-2")).toBeUndefined();
    // 起草计划的工单排着、任务还在规划中：等项目
    const planning = { ...queued, state: "planning" as const };
    expect(taskWaitingForProject(replay([...base, taskFrame(1, planning), busy, orderFrame(4, { ...execute, kind: "plan" })]), "t-2")).toBe("记账本");
  });

  test("流水线：每张工单留最新的样子；排队中按派出的先后，已结束的带结局和原因；删掉的项目连同工单一起拿掉", () => {
    const later = "2026-10-08T09:05:00.000+08:00";
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", name: "记账本" })),
      orderFrame(2, order("wo-2", "p-1", "pending", { taskId: "t-2", createdAt: later })),
      orderFrame(3, order("wo-1", "p-1", "pending")),
      orderFrame(4, order("wo-1", "p-1", "clarifying"), "clarifying"),
      orderFrame(5, order("wo-3", "p-1", "ended", { taskId: "t-3", outcome: "returned", reason: "任务取消了", endedAt: later }), "ended"),
    ]);
    const pipeline = projectPipeline(state, "p-1");
    expect(pipeline.queued.map((v) => v.workOrder.id)).toEqual(["wo-2"]);
    expect(pipeline.active.map((v) => [v.workOrder.id, v.status])).toEqual([["wo-1", "等澄清"]]);
    expect(pipeline.ended.map((v) => [v.workOrder.id, v.status, v.workOrder.reason])).toEqual([["wo-3", "已结束 · 退回", "任务取消了"]]);
    // 看板上没收到的任务：流水线上没有它现在到哪了
    expect(pipeline.active[0]!.stage).toBeUndefined();
    expect(taskWaitingForProject(state, "t-2")).toBe("记账本");

    const deleted = replay([...[1, 2].map((seq) => orderFrame(seq, order(`wo-${seq}`, "p-1", "pending"))), projectFrame(3, project("p-1", { state: "archived" }), "deleted")]);
    expect(deleted.workOrders).toEqual({});
  });
});
