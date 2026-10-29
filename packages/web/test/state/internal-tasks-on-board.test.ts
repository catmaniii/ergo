// 前端状态层：运营方案建的内部任务也上任务看板（141 号票，2026-10-18 用户定"显示，只能暂停、恢复"）。
// - 看板分组：运营方案里的一条生效成的内部任务在对应的组里（运营中的定时、事件触发的在运营中；某个时间做一次的照它的状态；
//   跟着项目归档了的在已归档），每张卡带着属于哪个项目（点了进项目）；别的内部任务（维护任务、对话框里选了项目建的定时任务）照旧不上；
//   项目删掉了的随项目一起拿掉；
// - 和项目页、项目卡是同一份：在任务页暂停（触发登记暂停了），看板卡、项目卡的运营概况都是已暂停；
// - 菜单：项目在用时运营方案里的一条只有暂停、恢复，取消、归档换成一行说明（点了进项目维护者的会话）；看板卡上的按钮、项目页的
//   作业行没有取消；多选里取消、归档不算它；去掉了的（不再绑在现在的方案里）照常能归档。
import { describe, expect, test } from "vitest";
import {
  type BoardGroup,
  type BoardItem,
  boardGroups,
  batchCounts,
  canBatch,
  type EventFrame,
  type Project,
  type ProjectEventPayload,
  projectInternalTasks,
  projectOperationsSummary,
  replay,
  type ScheduledJob,
  scheduledJobView,
  type Task,
  taskActionItems,
  taskMenu,
  taskMenuSubject,
  type UiState,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const T = "2026-10-18T09:00:00.000+08:00";
const LATER = "2026-10-18T09:05:00.000+08:00";
const P1 = { projectId: "p-1", projectName: "AI 简报站" };
const NOTE = "这是项目「AI 简报站」运营方案里的一条，要去掉请让项目维护者改运营方案";

const item = (key: string, name: string, taskId: string) => ({
  key,
  name,
  means: "schedule",
  meansLabel: "定时触发的任务",
  automatic: true,
  triggerText: "每天 08:00",
  approach: "plain" as const,
  instructions: name,
  capabilities: {},
  taskId,
});

/** 使用中的「AI 简报站」：现在生效的运营方案里有日报（t-1）、发布会提醒（t-3，某个时间做一次）、上周已做完的一次（t-7） */
const project = (extra: Partial<Project> = {}): Project => ({
  id: "p-1",
  name: "AI 简报站",
  goal: "每天出 AI 日报",
  state: "in_use",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: true,
  operations: { revision: 2, confirmedAt: T, items: [item("daily", "日报", "t-1"), item("launch", "发布会", "t-3"), item("recap", "上周回顾", "t-7")] },
  createdAt: T,
  updatedAt: T,
  ...extra,
});

/** 运营方案建的内部任务（origin operations） */
const ops = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  summary: "",
  state: "operating",
  kind: "plain",
  origin: "operations",
  maintainerId: "pm-1",
  projects: ["AI 简报站"],
  projectIds: ["p-1"],
  projectScope: "single",
  internal: P1,
  trigger: { kind: "schedule", schedule: { kind: "daily", time: "08:00" } },
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const job = (id: string, ownerTaskId: string, extra: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id,
  title: ownerTaskId,
  schedule: { kind: "daily", time: "08:00" },
  each: "出日报",
  projectId: "p-1",
  projectName: "AI 简报站",
  internal: P1,
  maintainerId: "pm-1",
  taskId: ownerTaskId,
  taskTitle: ownerTaskId,
  ownerTaskId,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state: "active",
  nextAt: "2026-10-19T08:00:00.000+08:00",
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: 0,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

/** 按频道自己数序号的事件帧 */
function frames() {
  const seqs: Record<string, number> = {};
  const list: EventFrame[] = [];
  const add = (channel: string, type: string, payload: unknown) => list.push(frame(channel, (seqs[channel] = (seqs[channel] ?? 0) + 1), type, payload));
  return {
    list,
    project: (p: Project, change: ProjectEventPayload["change"] = "created") => add("projects", "project", { project: p, change, from: null, by: "user" } satisfies ProjectEventPayload),
    task: (t: Task) => add("board", "task", { task: t, change: "created", from: null, by: "user" }),
    job: (j: ScheduledJob, change = "registered") => add("board", "scheduled_job", { job: j, change, by: "user" }),
  };
}

/**
 * 看板上的样子：日报 t-1（运营中，触发 j-1）、发布会 t-3（等时间）、t-4（上一版方案里的一条，变更时去掉、取消了）、上周回顾 t-7（做完了）；
 * 不上看板的：t-2（项目的维护任务）、t-5（对话框里选了这个项目建的定时任务，触发 j-5）；全局任务 t-6
 */
function world() {
  const f = frames();
  f.project(project());
  f.task(ops("t-1", { title: "日报" }));
  f.job(job("j-1", "t-1"));
  f.task({ ...ops("t-2", { title: "升级依赖", kind: "long_running", origin: "suggestion", state: "running" }), trigger: undefined });
  f.task(ops("t-3", { title: "发布会", state: "scheduled", trigger: { kind: "schedule", schedule: { kind: "once", at: "2026-10-20T09:00:00.000+08:00" } } }));
  f.task(ops("t-4", { title: "旧周报", state: "cancelled", updatedAt: LATER }));
  f.task(ops("t-5", { title: "自己建的定时", origin: "button" }));
  f.job(job("j-5", "t-5"));
  f.task({ ...ops("t-6", { title: "全局的事", state: "running", internal: undefined, projects: [], projectIds: [], projectScope: "none" }), trigger: undefined, origin: "button" });
  f.task(ops("t-7", { title: "上周回顾", state: "done", trigger: { kind: "schedule", schedule: { kind: "once", at: "2026-10-11T09:00:00.000+08:00" } } }));
  return f;
}

const itemName = (i: BoardItem) =>
  i.kind === "task" ? i.task.id : i.kind === "reminder" ? `r:${i.reminder.id}` : i.kind === "memory_curator" ? "curator" : `j:${i.view.job.id}`;
const groupsOf = (state: UiState) => Object.fromEntries(boardGroups(state).map((g) => [g.group, g.items.map(itemName)])) as Record<BoardGroup, string[]>;
const boardTask = (state: UiState, id: string) => boardGroups(state).flatMap((g) => g.items).find((i): i is Extract<BoardItem, { kind: "task" }> => i.kind === "task" && i.task.id === id);
const subject = (state: UiState, id: string) => taskMenuSubject(state, state.tasks[id]!);

describe("看板分组和项目标签", () => {
  test("运营方案建的内部任务在对应的组里、带着属于哪个项目；别的内部任务照旧不上；全局任务照旧", () => {
    const state = replay(world().list);
    expect(groupsOf(state)).toEqual({ waiting: [], active: ["t-3", "t-6"], ops: ["t-1"], ended: ["t-4", "t-7"], archived: [] });
    expect(boardTask(state, "t-1")).toMatchObject({ project: { id: "p-1", name: "AI 简报站" }, trigger: { statusText: "运营中", scheduleText: "每天 08:00" } });
    expect(boardTask(state, "t-3")!.project).toEqual({ id: "p-1", name: "AI 简报站" });
    expect(boardTask(state, "t-6")!.project).toBeUndefined();
    // 运营中一组的个数把它算进去（看板标题上的"运营中 N"就是这一组的条数）
    expect(boardGroups(state).find((g) => g.group === "ops")!.items).toHaveLength(1);
  });

  test("项目改了名：标签写现在的名字", () => {
    const f = world();
    f.project(project({ name: "AI 简报站 2" }), "charter_confirmed");
    expect(boardTask(replay(f.list), "t-1")!.project).toEqual({ id: "p-1", name: "AI 简报站 2" });
  });

  test("项目归档：跟着归档了的在已归档一组（标着项目）；项目删掉了：随项目一起从看板上拿掉", () => {
    const f = world();
    f.project(project({ state: "archived", archivedFrom: "in_use" }), "archived");
    f.task(ops("t-1", { title: "日报", state: "archived", archivedFrom: "operating", updatedAt: LATER }));
    f.job(job("j-1", "t-1", { state: "paused", pausedBy: "project_archived", nextAt: undefined }), "paused");
    const archived = replay(f.list);
    expect(groupsOf(archived).archived).toEqual(["t-1"]);
    expect(boardTask(archived, "t-1")!.project).toEqual({ id: "p-1", name: "AI 简报站" });

    f.project(project({ state: "archived" }), "deleted");
    expect(groupsOf(replay(f.list))).toEqual({ waiting: [], active: ["t-6"], ops: [], ended: [], archived: [] });
  });
});

describe("和项目页、项目卡是同一份", () => {
  test("在任务页暂停（触发登记暂停了）：看板卡、项目卡的运营概况都是已暂停；恢复了都是运营中", () => {
    const f = world();
    f.job(job("j-1", "t-1", { state: "paused", pausedBy: "user", nextAt: undefined }), "paused");
    const paused = replay(f.list);
    expect(boardTask(paused, "t-1")!.trigger).toMatchObject({ statusText: "已暂停", actions: ["resume"] });
    expect(projectOperationsSummary(paused, "p-1")!.timed.find((t) => t.taskId === "t-1")).toMatchObject({ status: "paused", statusText: "已暂停" });

    f.job(job("j-1", "t-1"), "resumed");
    const resumed = replay(f.list);
    expect(boardTask(resumed, "t-1")!.trigger).toMatchObject({ statusText: "运营中", actions: ["pause"] });
    expect(projectOperationsSummary(resumed, "p-1")!.timed.find((t) => t.taskId === "t-1")).toMatchObject({ status: "active" });
  });
});

describe("项目在用时运营方案里的一条只能暂停、恢复", () => {
  const note = { kind: "operations_note", label: NOTE, projectId: "p-1" };
  const runNow = { kind: "run_now", label: "立即运行一次" };

  test("菜单里只有暂停（暂停着的只有恢复）和立即运行一次，取消、归档、改时间都没有，换成一行说明（带着项目，点了进维护者的会话）", () => {
    const f = world();
    const state = replay(f.list);
    expect(taskActionItems(subject(state, "t-1"))).toEqual([{ kind: "trigger", action: "pause", label: "暂停" }, runNow, note]);
    expect(taskMenu(subject(state, "t-1"), "board").map((i) => i.kind)).toEqual(["open", "trigger", "run_now", "operations_note", "select"]);
    f.job(job("j-1", "t-1", { state: "paused", pausedBy: "user", nextAt: undefined }), "paused");
    expect(taskActionItems(subject(replay(f.list), "t-1"))).toEqual([{ kind: "trigger", action: "resume", label: "恢复" }, runNow, note]);
    // 某个时间做一次、还在等时间的：原来只有取消，现在只有说明；做完了的：原来能归档，现在只有说明
    expect(taskActionItems(subject(state, "t-3"))).toEqual([note]);
    expect(taskActionItems(subject(state, "t-7"))).toEqual([note]);
  });

  test("看板卡上的按钮、项目页的作业行没有取消、改时间，能立即运行一次；对话框里选了项目建的定时任务照旧", () => {
    const state = replay(world().list);
    expect(scheduledJobView(state, state.scheduledJobs["j-1"]!)).toMatchObject({ actions: ["pause"], runNow: true });
    expect(scheduledJobView(state, state.scheduledJobs["j-1"]!).reschedule).toBeUndefined();
    expect(scheduledJobView(state, state.scheduledJobs["j-5"]!)).toMatchObject({ actions: ["pause", "cancel"], runNow: true, reschedule: { kind: "daily", time: "08:00" } });
  });

  test("多选：取消、归档不算它，暂停算；项目页的内部任务一栏里做完了的那条没有“归档”", () => {
    const state = replay(world().list);
    expect(canBatch(subject(state, "t-1"), "cancel")).toBe(false);
    expect(canBatch(subject(state, "t-1"), "pause")).toBe(true);
    expect(canBatch(subject(state, "t-7"), "archive")).toBe(false);
    const entries = ["t-1", "t-4", "t-7"].map((id) => ({ id, title: id, subject: subject(state, id) }));
    // 删除（186 号票）：项目内部任务随项目删，都不算
    expect(batchCounts(entries)).toEqual({ pause: 1, resume: 0, cancel: 0, archive: 1, delete: 0 });
    const { ended } = projectInternalTasks(state, "p-1");
    expect(ended.map((v) => [v.task.id, v.archivable])).toEqual([
      ["t-4", true],
      ["t-7", false],
    ]);
  });

  test("去掉了的（变更时去掉、不再绑在现在的方案里）、项目归档了的：照常（能归档、能取消）", () => {
    const state = replay(world().list);
    // 186 号票：项目内部任务不能单独删，最后一行写明为什么
    expect(taskActionItems(subject(state, "t-4"))).toEqual([
      { kind: "act", action: "archive", label: "归档" },
      { kind: "delete_note", label: "不能删除：这是项目「AI 简报站」的内部任务，项目还在时由项目管：删项目时它一起删掉" },
    ]);
    const f = world();
    f.project(project({ state: "archived", archivedFrom: "in_use" }), "archived");
    // 进行中的（没跟着归档的）项目归档了就能取消
    f.task(ops("t-3", { title: "发布会", state: "paused", trigger: undefined }));
    expect(taskActionItems(subject(replay(f.list), "t-3")).map((i) => ("action" in i ? i.action : i.kind))).toEqual(["resume", "cancel", "archive", "delete_note"]);
  });
});
