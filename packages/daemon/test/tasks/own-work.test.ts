// 临时文件，任务、项目这一侧给守卫的东西（111 号票，tasks/own-work.ts）：
// - 派生视图 work_times：任务第一次进执行中或运营中的时间（任务开始）、最近一次交出去的时间（宣布阶段完成、任务做完、
//   定时 / 事件触发的一次运行结束）；项目开始的时间（建出项目，绑定外部工作目录的从绑定时算）；新建表时从事件日志补一遍；
// - 交付件的文字里认路径（deliverablePaths）：绝对路径、带扩展名的文件名、带分隔符的路径，前后是空白或标点；认不出的当认不准；
// - taskOwnWork：还没开始的没有；交出去了的阶段的交付件；产出区按交出去的时间认；认不准的、普通任务和流程、触发的任务交出去过的，
//   工作目录也按交出去的时间认（handovers 里不写 dir 的一项）；
// - projectOwnWork：项目开始的时间，项目里各任务交出去了的交付件合在一起。
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type Plan, type Project, type ScheduledJob, type Task, type TaskStage } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { deliverablePaths, projectOwnWork, projectStartedAt, taskOwnWork, taskWorkTimes, workTimesView } from "../../src/tasks/own-work.ts";
import { samplePlan } from "../helpers/plans.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("交付件的文字里认路径", () => {
  it.each([
    ["资料清单 sources.md", ["sources.md"]],
    ["调研报告（report.md）和图表目录 charts/", ["report.md", "charts/"]],
    ["`out/summary.csv`", ["out/summary.csv"]],
    ["分析报告.md", ["分析报告.md"]],
    ["写在 ./dist/app.js 里。", ["./dist/app.js"]],
    ["最终报告 final.pdf.", ["final.pdf"]],
    ["src\\lib 的改动", ["src\\lib"]],
    ["D:\\work\\out\\report.md", ["D:\\work\\out\\report.md"]],
    ["放到 /d/work/out/ 下", ["D:\\work\\out\\"]],
  ])("%s", (text, expected) => {
    expect(deliverablePaths(text)).toEqual(expected);
  });

  it.each([["一份调研报告"], ["写一份分析报告.md文件"], ["交付report.md"], ["版本 1.2 的说明"], ["https://example.com 上的页面"]])("认不出：%s", (text) => {
    expect(deliverablePaths(text).filter((p) => !p.includes("example"))).toEqual([]);
  });
});

const T0 = Date.parse("2026-10-13T09:00:00+08:00");
const MIN = 60_000;

/** 一个真的事件存储（临时文件），事件时间按拨的时钟；用完关掉（Windows 上开着的数据库删不掉） */
function harness(dir = makeTempDir("ergou-own-work-")) {
  let now = T0;
  const store = openEventStore({ file: path.join(dir, "ergou.db"), views: [workTimesView], now: () => new Date(now).toISOString() });
  const at = (ms: number) => {
    now = ms;
  };
  return { store, at, dir };
}

const stage = (stageId: string, extra: Partial<TaskStage> = {}): TaskStage => ({ stageId, title: stageId, state: "pending", dependsOn: [], acceptance: [], attempts: 0, ...extra });
const task = (patch: Partial<Task> = {}): Task => ({
  id: "t-1",
  title: "调研",
  summary: "调研",
  state: "queued",
  origin: "button",
  kind: "long_running",
  maintainerId: "tm-1",
  projects: [],
  projectScope: "none",
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...patch,
});
const taskEvent = (store: EventStore, t: Task, change: string, from: Task["state"] | null) =>
  store.append({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: t, change, from, by: "system" } });

function plan(deliverables: Record<string, string[]>): Plan {
  const base = samplePlan();
  return { ...base, stages: Object.entries(deliverables).map(([stageId, list]) => ({ ...base.stages[0]!, stageId, deliverables: list, dependsOn: [] })) };
}

describe("任务开始、交出去的时间", () => {
  it("第一次进执行中是开始（之后再进不改）；宣布阶段完成、做完、一次运行结束都算交出去，记最近的一次", () => {
    const { store, at } = harness();
    try {
      taskEvent(store, task(), "created", null);
      expect(taskWorkTimes(store.reader, "t-1")).toEqual({});
      at(T0 + 5 * MIN);
      taskEvent(store, task({ state: "running" }), "started", "queued");
      at(T0 + 6 * MIN);
      taskEvent(store, task({ state: "running" }), "stage_started", "running");
      expect(taskWorkTimes(store.reader, "t-1")).toEqual({ startedAt: T0 + 5 * MIN });
      at(T0 + 20 * MIN);
      taskEvent(store, task({ state: "running" }), "stage_submitted", "running");
      at(T0 + 30 * MIN);
      taskEvent(store, task({ state: "waiting_for_user" }), "waiting", "running");
      at(T0 + 40 * MIN);
      taskEvent(store, task({ state: "running" }), "resumed", "waiting_for_user");
      expect(taskWorkTimes(store.reader, "t-1")).toEqual({ startedAt: T0 + 5 * MIN, handedOverAt: T0 + 20 * MIN });
      at(T0 + 50 * MIN);
      taskEvent(store, task({ state: "done" }), "completed", "running");
      expect(taskWorkTimes(store.reader, "t-1").handedOverAt).toBe(T0 + 50 * MIN);
    } finally {
      store.close();
    }
  });

  it("定时 / 事件触发的任务：登记好进运营中是开始，每次运行结束是交出去", () => {
    const { store, at } = harness();
    try {
      taskEvent(store, task({ id: "t-2", kind: "plain", state: "operating" }), "plan_confirmed", "awaiting_confirm");
      at(T0 + 60 * MIN);
      const job = { id: "j-1", taskId: "t-2", ownerTaskId: "t-2" } as ScheduledJob;
      store.append({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job, change: "run_started", by: "system" } });
      at(T0 + 70 * MIN);
      store.append({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job, change: "run_finished", by: "system" } });
      expect(taskWorkTimes(store.reader, "t-2")).toEqual({ startedAt: T0, handedOverAt: T0 + 70 * MIN });
    } finally {
      store.close();
    }
  });

  it("111 号票之前的库：新建表时从事件日志补一遍", () => {
    const dir = makeTempDir("ergou-own-work-");
    const old = openEventStore({ file: path.join(dir, "ergou.db"), views: [], now: () => new Date(T0).toISOString() });
    taskEvent(old, task({ state: "running" }), "started", "queued");
    old.close();
    const { store } = harness(dir);
    try {
      expect(taskWorkTimes(store.reader, "t-1")).toEqual({ startedAt: T0 });
    } finally {
      store.close();
    }
  });
});

const project = (patch: Partial<Project> = {}): Project => ({
  id: "p-1",
  name: "记账本",
  goal: "记账",
  state: "preparing",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: false,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...patch,
});
const projectEvent = (store: EventStore, p: Project, change: string) => store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project: p, change, from: null, by: "user" } });
/** 剧本：任务开始了 */
const started = (t: Task) => (store: EventStore) => void taskEvent(store, { ...t, state: "running" }, "started", "queued");

describe("项目开始的时间", () => {
  it("建出项目是开始；确认立项书不改；绑定了外部工作目录的从绑定（确认立项书）时算", () => {
    const { store, at } = harness();
    try {
      projectEvent(store, project(), "created");
      at(T0 + 10 * MIN);
      projectEvent(store, project({ charterConfirmed: true }), "charter_confirmed");
      expect(projectStartedAt(store.reader, "p-1")).toBe(T0);
      projectEvent(store, project({ id: "p-2" }), "created");
      at(T0 + 20 * MIN);
      projectEvent(store, project({ id: "p-2", charterConfirmed: true, workdir: { external: true, path: "E:\\repo" } }), "charter_confirmed");
      expect(projectStartedAt(store.reader, "p-2")).toBe(T0 + 20 * MIN);
      expect(projectStartedAt(store.reader, "p-3")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("绑定外部工作目录、点的是确认并开工（building_started）：也从那一刻算；之后再开工不改（评审返修）", () => {
    const { store, at } = harness();
    const external = { charterConfirmed: true, workdir: { external: true, path: "E:\\repo" } };
    try {
      projectEvent(store, project(), "created");
      at(T0 + 30 * MIN);
      projectEvent(store, project({ ...external, state: "building" }), "building_started");
      expect(projectStartedAt(store.reader, "p-1")).toBe(T0 + 30 * MIN);
      at(T0 + 90 * MIN);
      projectEvent(store, project({ ...external, state: "building" }), "building_started");
      expect(projectStartedAt(store.reader, "p-1")).toBe(T0 + 30 * MIN);
      // 只确认、稍后开工：从确认时算，之后开工不改
      projectEvent(store, project({ id: "p-2" }), "created");
      at(T0 + 100 * MIN);
      projectEvent(store, project({ id: "p-2", ...external }), "charter_confirmed");
      at(T0 + 120 * MIN);
      projectEvent(store, project({ id: "p-2", ...external, state: "building" }), "building_started");
      expect(projectStartedAt(store.reader, "p-2")).toBe(T0 + 100 * MIN);
    } finally {
      store.close();
    }
  });
});

describe("交给守卫的任务自己的东西", () => {
  const OUTPUTS = "D:\\ergou-data\\outputs";
  function ownWorkOf(t: Task, p: Plan | undefined, events: (store: EventStore, at: (ms: number) => void) => void) {
    const { store, at } = harness();
    try {
      events(store, at);
      return taskOwnWork({ reader: store.reader, task: t, plan: p, outputsDir: OUTPUTS });
    } finally {
      store.close();
    }
  }
  const submitted = (t: Task) => (store: EventStore, at: (ms: number) => void) => {
    taskEvent(store, { ...t, state: "running" }, "started", "queued");
    at(T0 + 30 * MIN);
    taskEvent(store, { ...t, state: "running" }, "stage_submitted", "running");
  };

  it("还没开始（起草计划时只能读）：没有", () => {
    expect(ownWorkOf(task(), undefined, () => undefined)).toBeNull();
  });

  const HANDED = T0 + 30 * MIN;
  const OUT = `${OUTPUTS}\\t-1`;

  it("开始了、还没交出去：只有开始的时间", () => {
    const t = task({ stages: { total: 2, list: [stage("s1", { state: "running" }), stage("s2")] } });
    expect(ownWorkOf(t, plan({ s1: ["资料清单 sources.md"], s2: ["报告 report.md"] }), started(t))).toEqual({ startedAt: T0, deliverables: [], handovers: [] });
  });

  it("交出去了的阶段（宣布完成过、在验收、已验收）的交付件，产出区按交出去的时间认；还在做的阶段的不算", () => {
    const t = task({ stages: { total: 3, list: [stage("s1", { state: "accepted", attempts: 1 }), stage("s2", { state: "running", attempts: 1 }), stage("s3", { state: "running" })] } });
    const own = ownWorkOf(t, plan({ s1: ["资料清单 sources.md"], s2: ["报告 report.md、图表 charts/"], s3: ["附录 appendix.md"] }), submitted(t));
    expect(own).toEqual({ startedAt: T0, deliverables: ["sources.md", "report.md", "charts/"], handovers: [{ dir: OUT, at: HANDED }] });
  });

  it("交出去了的阶段里有认不出路径的交付件：认不准，工作目录也按交出去的时间认", () => {
    const t = task({ stages: { total: 1, list: [stage("s1", { state: "accepting", attempts: 1 })] } });
    expect(ownWorkOf(t, plan({ s1: ["资料清单 sources.md", "一份调研报告"] }), submitted(t))).toEqual({
      startedAt: T0,
      deliverables: ["sources.md"],
      handovers: [{ dir: OUT, at: HANDED }, { at: HANDED }],
    });
  });

  it("普通任务、流程做完过、触发的任务运行结束过：交出去的结果在产出区里，按时间认；没有逐个写明的交付件（流程那一个阶段写的是目标），工作目录不另算", () => {
    for (const kind of ["plain", "workflow"] as const) {
      const t = task({ kind, stages: { total: 1, list: [stage("w", { state: "accepted", attempts: 1 })] } });
      expect(ownWorkOf(t, plan({ w: ["把下载目录里的截图归档"] }), submitted(t))).toEqual({ startedAt: T0, deliverables: [], handovers: [{ dir: OUT, at: HANDED }] });
      expect(ownWorkOf(t, undefined, started(t))?.handovers).toEqual([]);
    }
  });
});

describe("交给守卫的项目的东西", () => {
  const OUTPUTS = "D:\\ergou-data\\outputs";
  const HANDED = T0 + 30 * MIN;
  const OUT = `${OUTPUTS}\\t-1`;
  it("项目开始的时间，项目里各任务交出去了的交付件合在一起；没记下开始的没有", () => {
    const { store, at } = harness();
    try {
      store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project: { id: "p-1" }, change: "created", from: null, by: "user" } });
      const long = task({ id: "t-1", stages: { total: 1, list: [stage("s1", { state: "accepted", attempts: 1 })] } });
      const vague = task({ id: "t-2", stages: { total: 1, list: [stage("s1", { state: "accepted", attempts: 1 })] } });
      const plainOne = task({ id: "t-3", kind: "plain" });
      const fresh = task({ id: "t-4", kind: "plain" });
      at(T0 + 5 * MIN);
      for (const t of [long, vague, plainOne, fresh]) taskEvent(store, { ...t, state: "running" }, "started", "queued");
      at(HANDED);
      for (const t of [long, vague, plainOne]) taskEvent(store, { ...t, state: "done" }, "completed", "running");
      const plans: Record<string, Plan> = { "t-1": plan({ s1: ["报告 report.md"] }), "t-2": plan({ s1: ["一份说明"] }) };
      const own = projectOwnWork({ reader: store.reader, projectId: "p-1", tasks: [long, vague, plainOne, fresh], plan: (id) => plans[id], outputsDir: OUTPUTS });
      expect(own).toEqual({
        startedAt: T0,
        deliverables: ["report.md"],
        handovers: [{ dir: OUT, at: HANDED }, { dir: `${OUTPUTS}\\t-2`, at: HANDED }, { at: HANDED }, { dir: `${OUTPUTS}\\t-3`, at: HANDED }],
      });
      expect(projectOwnWork({ reader: store.reader, projectId: "p-9", tasks: [], plan: () => undefined, outputsDir: OUTPUTS })).toBeNull();
    } finally {
      store.close();
    }
  });
});
