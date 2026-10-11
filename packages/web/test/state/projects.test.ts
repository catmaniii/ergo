// 项目列表（15 号票）：项目列表频道上的 project 事件归并成每个项目的最新状态；进行中任务数来自看板频道上的任务；
// 项目页上的入口按协议包的 projectActions；删掉的项目连同它的维护者会话从界面上拿掉。
import { describe, expect, test } from "vitest";
import {
  availableTaskActions,
  boardGroups,
  maintainerChannel,
  type Project,
  type ProjectEventPayload,
  projectViews,
  replay,
  selectableProjectNames,
  selectProject,
  stillChartering,
  type Task,
  type TaskEventPayload,
  projectInternalTasks,
  projectPipeline,
  projectScheduledJobs,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  taskWaitingForProject,
  type UserTaskWorkOrder,
  type WorkOrder,
  type WorkOrderEventPayload,
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

  test("还在立项（立项书没确认）的项目：只选了它时不能发起（64 号票）", () => {
    const state = replay([
      projectFrame(1, project("p-1", { name: "记账本", state: "in_use", charterConfirmed: true })),
      projectFrame(2, project("p-2", { name: "家电档案" })),
    ]);
    expect(stillChartering(state, "记账本")).toBe(false);
    expect(stillChartering(state, "家电档案")).toBe(true);
    expect(stillChartering(state, "没有的项目")).toBe(false);
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

/** 一张用户发起的任务的工单（16 号票） */
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

/** 项目 p-1（记账本）的标记和它的一个内部任务（64 号票） */
const P1_INTERNAL = { projectId: "p-1", projectName: "记账本" };
const internal = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({ ...task(id, state, ["p-1"]), maintainerId: "pm-p-1", projects: ["记账本"], internal: P1_INTERNAL, ...extra });

/** 一个定时作业（属于项目 p-1） */
const p1Job = (id: string, extra: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id,
  title: id,
  schedule: { kind: "daily", time: "09:00" },
  each: "检查依赖",
  projectId: "p-1",
  projectName: "记账本",
  maintainerId: "pm-p-1",
  taskId: "t-1",
  taskTitle: "升级依赖",
  state: "active",
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: 0,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const jobFrame = (seq: number, job: ScheduledJob) => frame("board", seq, "scheduled_job", { job, change: "registered", by: "system" } satisfies ScheduledJobEventPayload);

describe("项目内部任务（64 号票）", () => {
  test("不上全局看板；项目页的“内部任务”一栏列出它们（没结束的、结束了的、归档了的三组，写明种类、状态和进度；结束了的能归档）；别的项目、普通任务不在这一栏", () => {
    const later = "2026-10-08T09:05:00.000+08:00";
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", name: "记账本" })),
      taskFrame(1, internal("t-1", "running", { kind: "workflow", steps: { total: 3, done: 1 } })),
      taskFrame(2, internal("t-2", "awaiting_confirm", { kind: "long_running", stages: { total: 2 }, updatedAt: later })),
      taskFrame(3, internal("t-3", "done", { kind: "long_running", stages: { total: 1, current: 1, list: [{ stageId: "s1", title: "s1", state: "accepted", dependsOn: [], acceptance: [], attempts: 1 }] } })),
      taskFrame(4, task("t-4", "running", ["p-1"])),
      taskFrame(5, internal("t-5", "archived")),
      // 全局任务（不属于项目内部的）结束了也不在这一栏：在全局看板上（90 号票起直接归档，或者在每周的归档清单上）
      taskFrame(6, task("t-6", "done", ["p-1"])),
    ]);
    // 全局看板上只有普通任务
    expect(boardGroups(state).flatMap((g) => g.items.flatMap((i) => (i.kind === "task" ? [i.task.id] : [])))).toEqual(["t-4", "t-6"]);
    const { open, ended, archived } = projectInternalTasks(state, "p-1");
    // 进度和看板卡同一份（60 号票）：计划授权之前两种做法都是"尚无计划"（0/0；这里的流程没有授权了的计划卡），长程任务是已验收的阶段数
    expect(open.map((v) => [v.task.id, v.kindLabel, v.status, v.progress, v.archivable])).toEqual([
      ["t-2", "长程任务", "待确认 · 计划等你确认", { done: 0, total: 0, unit: "stage" }, false],
      ["t-1", "流程", "执行中", { done: 0, total: 0, unit: "step" }, false],
    ]);
    expect(ended.map((v) => [v.task.id, v.status, v.progress, v.archivable])).toEqual([["t-3", "已完成", { done: 1, total: 1, unit: "stage" }, true]]);
    expect(archived.map((v) => [v.task.id, v.archivable])).toEqual([["t-5", false]]);
    // 结束了的全局任务也能直接归档（90 号票：看板卡的菜单、多选），不在这一栏
    expect(availableTaskActions(state.tasks["t-6"]!, "user")).toContain("archive");
    // 进行中的任务数照样算上内部任务
    expect(selectProject(state, "p-1")?.activeTasks).toBe(3);
    expect(projectInternalTasks(state, "p-2")).toEqual({ open: [], ended: [], archived: [] });
  });

  test("项目内部任务的计划里定的作业不上全局看板的“运营中”，在项目页的定时作业里", () => {
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", name: "记账本" })),
      jobFrame(1, p1Job("j-1", { internal: P1_INTERNAL })),
      jobFrame(2, p1Job("j-2", { taskId: "t-2" })),
    ]);
    expect(boardGroups(state).flatMap((g) => g.items.flatMap((i) => (i.kind === "scheduled_job" ? [i.view.job.id] : [])))).toEqual(["j-2"]);
    expect(projectScheduledJobs(state, "p-1").map((v) => v.job.id)).toEqual(["j-1", "j-2"]);
  });

  test("项目删掉了：它的内部任务随项目一起从界面上拿掉，普通任务不动", () => {
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", name: "记账本" })),
      taskFrame(1, internal("t-1", "awaiting_confirm")),
      taskFrame(2, task("t-2", "planning", ["p-1"])),
      projectFrame(2, project("p-1", { state: "archived" }), "deleted"),
    ]);
    expect(Object.keys(state.tasks)).toEqual(["t-2"]);
    expect(projectInternalTasks(state, "p-1")).toEqual({ open: [], ended: [], archived: [] });
  });
});
