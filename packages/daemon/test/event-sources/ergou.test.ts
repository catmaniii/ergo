// 二狗内部事件（77 号票）：从事件日志认出任务完成、失败、转等我，项目状态变化，一次运行失败；按任务、项目过滤；
// 自己的事不触发自己；项目内部的事只交给同一个项目里的、或者点名要它的订阅；去重键是事件日志的全局序号。
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type EventTrigger, type Project, type ScheduledJob, type Task } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { createErgouSource, type EventSubscription, type SourceEvent } from "../../src/event-sources/index.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const TIME = "2026-10-08T09:00:00+08:00";
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `任务${id}`,
  summary: "",
  state: "running",
  origin: "request",
  kind: "plain",
  maintainerId: `tm-${id}`,
  projects: [],
  projectScope: "none",
  createdAt: TIME,
  updatedAt: TIME,
  ...patch,
});
const sub = (id: string, events: string[], filter: Record<string, string> = {}, extra: Partial<EventSubscription> = {}): EventSubscription => {
  const trigger: EventTrigger = { kind: "event", source: "ergou", events, filter };
  return { id, kind: "task", trigger, active: true, ...extra };
};

/** 一个真的事件存储（临时文件）接上内部事件来源；用完关掉（Windows 上开着的数据库删不掉） */
function withHarness(subs: EventSubscription[], body: (h: ReturnType<typeof harness>) => void): void {
  const h = harness(subs);
  try {
    body(h);
  } finally {
    h.source.stop();
    h.store.close();
  }
}

function harness(subs: EventSubscription[]) {
  const store = openEventStore({ file: path.join(makeTempDir(), "ergou.db"), views: [] });
  const got: Array<[string, SourceEvent]> = [];
  const source = createErgouSource({ store, ctx: { emit: (s, e) => got.push([s.id, e]), log: () => undefined } });
  source.sync(subs);
  const taskEvent = (t: Task, from: Task["state"] | null) => store.append({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: t, change: "x", from, by: "system" } });
  return { store, got, source, taskEvent };
}

describe("任务完成、失败、转等我", () => {
  it("状态真的变了的那一条才算；按任务过滤；带上原因、做法、项目；去重键是全局序号", () => {
    withHarness([sub("j-1", ["task_done", "task_failed", "task_waiting"]), sub("j-2", ["task_done"], { taskId: "t-9" })], (h) => {
      h.taskEvent(task("t-2", { state: "done" }), "running");
      h.taskEvent(task("t-2", { state: "done" }), "done");
      h.taskEvent(task("t-3", { state: "failed", failReason: "网站打不开" }), "running");
      h.taskEvent(task("t-4", { state: "waiting_for_user", waitReason: "stuck", waitNote: "缺一个账号" }), "running");
      h.taskEvent(task("t-9", { state: "done", projectIds: ["p-1"], projects: ["记账"], projectScope: "single" }), "running");
      expect(h.got.map(([id, e]) => [id, e.event, e.summary])).toEqual([
        ["j-1", "task_done", "任务 t-2「任务t-2」完成了"],
        ["j-1", "task_failed", "任务 t-3「任务t-3」失败了：网站打不开"],
        ["j-1", "task_waiting", "任务 t-4「任务t-4」转等我：缺一个账号"],
        ["j-1", "task_done", "任务 t-9「任务t-9」完成了"],
        ["j-2", "task_done", "任务 t-9「任务t-9」完成了"],
      ]);
      expect(h.got[1]![1]).toMatchObject({ source: "ergou", at: expect.any(String), data: { taskId: "t-3", taskTitle: "任务t-3", taskKind: "普通任务", reason: "网站打不开" } });
      expect(h.got[3]![1].data).toMatchObject({ projectId: "p-1", projectName: "记账" });
      expect(h.got[3]![1].key).toMatch(/^ergou:\d+:task_done$/);
      expect(h.got[3]![1].key).toBe(h.got[4]![1].key);
    });
  });

  it("自己的事不触发自己；项目内部的事只交给同一个项目里的、或者点名要它的订阅", () => {
    const subs = [
      sub("j-self", ["task_failed"], {}, { taskId: "t-5" }),
      sub("j-any", ["task_done"]),
      sub("j-same", ["task_done"], {}, { projectId: "p-1" }),
      sub("j-named", ["task_done"], { projectId: "p-1" }),
    ];
    withHarness(subs, (h) => {
      h.taskEvent(task("t-5", { state: "failed" }), "running");
      h.taskEvent(task("t-6", { state: "done", internal: { projectId: "p-1", projectName: "记账" } }), "running");
      expect(h.got.map(([id]) => id)).toEqual(["j-same", "j-named"]);
    });
  });
});

describe("项目状态变化、一次运行失败", () => {
  it("项目从一个状态变成另一个状态（写中文名）；定时、事件触发的任务有一次运行失败了", () => {
    withHarness([sub("j-1", ["project_state", "run_failed"])], (h) => {
      const project = { id: "p-1", name: "记账", state: "in_use" } as Project;
      h.store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project, change: "x", from: "building", by: "system" } });
      h.store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project, change: "y", from: "in_use", by: "system" } });
      const job = { id: "j-7", title: "每天出简报", ownerTaskId: "t-7", taskId: "t-7" } as ScheduledJob;
      h.store.append({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job, change: "run_finished", by: "system", run: { runId: "j-7-r3", state: "failed", reason: "网断了" } } });
      h.store.append({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job, change: "run_finished", by: "system", run: { runId: "j-7-r4", state: "done" } } });
      expect(h.got.map(([, e]) => [e.event, e.summary, e.data])).toEqual([
        ["project_state", "项目「记账」从建设中变成使用中", { projectId: "p-1", projectName: "记账", from: "建设中", to: "使用中" }],
        ["run_failed", "任务 t-7「每天出简报」的第 3 次运行失败了：网断了", { taskId: "t-7", taskTitle: "每天出简报", runId: "j-7-r3", reason: "网断了" }],
      ]);
    });
  });
});
