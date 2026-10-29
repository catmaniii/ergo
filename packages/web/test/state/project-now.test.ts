// 项目的"运营概况"和项目页最上面的"现在"（140 号票）的状态层：
// - 运营概况：服务入口带缩略图（截过的给截图时间、上线了还没图的只悄悄取一次、不在线的灰掉）；定时任务收起时一行写清几条、各几点
//   （名字用运营方案里那一条的名字，你暂停了的标"已暂停"），展开每条有时间表、下次、上次和结果、状态；没有定时任务的没有那一行、
//   没有服务的没有入口、两样都没有就没有；只有使用中的有，停用、归档了的照样列、整块标出来；
// - "现在"按项目状态挑内容：筹备中（起草中、等你确认、已确认等开工）；建设中（建设任务的进度、正在做的工单、卡住的：等你、失败、
//   被拦、超时没动并写原因，最近一句进展，"首版做完了"卡）；使用中（运营概况和最近几次运行，失败的标出来）；停用、归档（停了什么、怎么重新启用）。
import { describe, expect, test } from "vitest";
import {
  type Card,
  type EventFrame,
  type JobRun,
  type Project,
  type ProjectEventPayload,
  projectNow,
  projectOperationsSummary,
  projectRecentRuns,
  type ProjectServiceView,
  replay,
  type ScheduledJob,
  STALE_WORK_ORDER_MS,
  type Task,
  type WorkOrder,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";
const NOW = Date.parse("2026-10-18T09:00:00.000+08:00");

const project = (extra: Partial<Project> = {}): Project => ({
  id: "p-1",
  name: "AI 简报站",
  goal: "每天出 AI 日报",
  state: "in_use",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  summary: "",
  state: "operating",
  origin: "button",
  maintainerId: "pm-1",
  projects: ["AI 简报站"],
  projectIds: ["p-1"],
  internal: { projectId: "p-1", projectName: "AI 简报站" },
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const run = (jobId: string, n: number, state: JobRun["state"], endedAt: string, extra: Partial<JobRun> = {}): JobRun => ({
  runId: `${jobId}-r${n}`,
  jobId,
  trigger: "scheduled",
  dueAt: endedAt,
  state,
  queuedAt: endedAt,
  endedAt,
  ...extra,
});

const job = (id: string, extra: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id,
  title: `${id} 的标题`,
  schedule: { kind: "daily", time: "08:00" },
  each: "做一期",
  projectId: "p-1",
  projectName: "AI 简报站",
  internal: { projectId: "p-1", projectName: "AI 简报站" },
  maintainerId: "pm-1",
  taskId: `t-${id}`,
  taskTitle: `任务 ${id}`,
  ownerTaskId: `t-${id}`,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state: "active",
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: 0,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const service = (extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({
  projectId: "p-1",
  key: "site",
  title: "简报站",
  name: "site",
  app: "p-1-site",
  port: 18080,
  autostart: true,
  url: "/apps/p-1-site/",
  rollout: "live",
  status: "online",
  ...extra,
});

/** 按频道自己数序号的事件帧 */
function frames() {
  const seqs: Record<string, number> = {};
  const list: EventFrame[] = [];
  const add = (channel: string, type: string, payload: unknown) => list.push(frame(channel, (seqs[channel] = (seqs[channel] ?? 0) + 1), type, payload));
  return {
    list,
    project: (p: Project) => add("projects", "project", { project: p, change: "created", from: null, by: "user" } satisfies ProjectEventPayload),
    task: (t: Task) => add("board", "task", { task: t, change: "created", from: null, by: "user" }),
    job: (j: ScheduledJob, r?: JobRun) => add("board", "scheduled_job", { job: j, change: r ? "run_finished" : "registered", by: "system", ...(r ? { run: r } : {}) }),
    services: (services: ProjectServiceView[]) => add("projects", "project_services", { services }),
    workOrder: (w: WorkOrder) => add("projects", "work_order", { workOrder: w, change: "created" }),
    card: (c: Card) => add("cards", "card", { card: c }),
    activity: (state: string) => add("activity", "activity", { agentId: "pm-1", state, since: T }),
  };
}

/** 家庭菜谱那样：日报每天 08:00（运营方案里叫"日报"）、周报每周日 18:00、新书摘入库（事件触发）；一个在线的网页服务 */
function inUse(extra: { p?: Partial<Project>; services?: ProjectServiceView[]; jobs?: ScheduledJob[] } = {}) {
  const f = frames();
  f.project(
    project({
      operations: {
        revision: 1,
        confirmedAt: T,
        items: [{ key: "daily", name: "日报", means: "schedule", meansLabel: "定时触发的任务", automatic: true, triggerText: "每天 08:00", approach: "plain", instructions: "出日报", capabilities: {}, taskId: "t-j-1" }],
      },
      ...extra.p,
    }),
  );
  for (const j of extra.jobs ?? [job("j-1", { nextAt: "2026-10-19T08:00:00.000+08:00" }), job("j-2", { title: "周报", schedule: { kind: "weekly", time: "18:00", weekdays: [0] }, ownerTaskId: "t-j-2" })]) f.job(j);
  f.task(task("t-j-2", { title: "周报" }));
  f.services(extra.services ?? [service({ thumbnailAt: "2026-10-18T08:00:00.000+08:00" })]);
  return f;
}

/** 筹备中的项目（带着给的卡）现在怎样 */
function preparingAt(p: Partial<Project>, cards: Card[] = []) {
  const f = frames();
  for (const c of cards) f.card(c);
  f.project(project({ state: "preparing", charterConfirmed: false, ...p }));
  return projectNow(replay(f.list), "p-1", NOW);
}

/** 一张工单（默认是建设任务 t-1 的执行工单，进行中） */
const wo = (id: string, extra: Partial<WorkOrder>): WorkOrder =>
  ({ id, projectId: "p-1", maintainerId: "pm-1", title: `工单 ${id}`, state: "in_progress", source: "user_task", kind: "execute", taskId: "t-1", taskTitle: "建设", createdAt: T, updatedAt: T, ...extra }) as WorkOrder;

describe("运营概况", () => {
  test("收起时一行写清几条、各几点（名字用运营方案里的短名字，没有就用任务标题）；展开每条有时间表、下次、上次和结果、状态；服务入口带缩略图", () => {
    const f = inUse();
    f.job(job("j-1", { nextAt: "2026-10-19T08:00:00.000+08:00", lastRun: run("j-1", 3, "done", "2026-10-18T08:03:00.000+08:00") }), run("j-1", 3, "done", "2026-10-18T08:03:00.000+08:00"));
    const s = projectOperationsSummary(replay(f.list), "p-1")!;
    expect(s.line).toBe("2 个定时任务：每天 08:00 日报、每周日 18:00 周报");
    expect(s.timed).toEqual([
      { jobId: "j-1", taskId: "t-j-1", name: "日报", scheduleText: "每天 08:00", brief: "每天 08:00 日报", nextAt: "2026-10-19T08:00:00.000+08:00", last: { at: "2026-10-18T08:03:00.000+08:00", text: "成功", failed: false }, status: "active", statusText: "运营中" },
      { jobId: "j-2", taskId: "t-j-2", name: "周报", scheduleText: "每周日 18:00", brief: "每周日 18:00 周报", status: "active", statusText: "运营中" },
    ]);
    expect(s.services).toHaveLength(1);
    expect(s.services[0]).toMatchObject({ entry: { label: "打开「简报站」", canOpen: true, kind: "online" }, thumbnail: { kind: "shot", at: "2026-10-18T08:00:00.000+08:00" } });
    expect(s.services[0]!.dim).toBeUndefined();
    expect(s.stopped).toBeUndefined();
  });

  test("你暂停了的标“已暂停”（上次失败的标出来）；事件触发的写“事件触发”；取消了的、别的项目的、不是内部任务的不算", () => {
    const f = inUse({
      jobs: [
        job("j-1", { state: "paused", pausedBy: "user", lastRun: run("j-1", 1, "failed", "2026-10-17T08:01:00.000+08:00", { reason: "网站打不开" }) }),
        job("j-3", { schedule: undefined, event: { kind: "event", source: "folder", events: ["added"], filter: { path: "/示例/书摘", pattern: "*.md" } }, ownerTaskId: "t-j-3" }),
        job("j-4", { state: "cancelled" }),
        job("j-5", { projectId: "p-2", internal: { projectId: "p-2", projectName: "别的" } }),
      ],
    });
    f.task(task("t-j-3", { title: "新书摘入库" }));
    const s = projectOperationsSummary(replay(f.list), "p-1")!;
    expect(s.line).toBe("2 个定时、事件触发的任务：每天 08:00 日报（已暂停）、事件触发 新书摘入库");
    expect(s.timed[0]).toMatchObject({ status: "paused", statusText: "已暂停", last: { text: "失败", failed: true } });
    expect(s.timed[0]!.last!.partial).toBeUndefined();
    expect(s.timed[0]!.nextAt).toBeUndefined();
    expect(s.timed[1]!.scheduleText).toContain("事件发生时：");
  });

  test("没有定时任务的没有那一行；没有服务的没有入口；两样都没有整块没有；不在线的缩略图灰掉；上线了还没截图的只悄悄取一次；没有网页的没有缩略图", () => {
    const noJobs = projectOperationsSummary(replay(inUse({ jobs: [] }).list), "p-1")!;
    expect(noJobs.line).toBeUndefined();
    expect(noJobs.timed).toEqual([]);
    expect(noJobs.services).toHaveLength(1);
    const noServices = projectOperationsSummary(replay(inUse({ services: [] }).list), "p-1")!;
    expect(noServices.services).toEqual([]);
    expect(noServices.line).toBeDefined();
    expect(projectOperationsSummary(replay(inUse({ services: [], jobs: [] }).list), "p-1")).toBeUndefined();
    // 撤下了的服务不算
    expect(projectOperationsSummary(replay(inUse({ services: [service({ rollout: "withdrawn" })], jobs: [] }).list), "p-1")).toBeUndefined();

    const { url: _url, ...noWeb } = service();
    const s = projectOperationsSummary(
      replay(inUse({ services: [service({ status: "failed", detail: "退出码 1", thumbnailAt: "2026-10-18T08:00:00.000+08:00" }), service({ app: "p-1-api", key: "api", name: "api" }), { ...noWeb, app: "p-1-worker", key: "worker" }] }).list),
      "p-1",
    )!;
    expect(s.services.map((v) => [v.view.app, v.thumbnail?.kind, v.dim])).toEqual([
      ["p-1-site", "shot", "不在线"],
      ["p-1-api", "probe", undefined],
      ["p-1-worker", undefined, undefined],
    ]);
  });

  test("只有使用中的有；停用、归档了的照样列（撤下了的服务也列、缩略图灰着），整块标出来；筹备中、建设中的没有", () => {
    const retired = projectOperationsSummary(replay(inUse({ p: { state: "retired" }, services: [service({ rollout: "withdrawn", thumbnailAt: "2026-10-18T08:00:00.000+08:00" })], jobs: [job("j-1", { state: "paused", pausedBy: "project_retired" })] }).list), "p-1")!;
    expect(retired.stopped).toBe("已停用");
    expect(retired.services.map((v) => [v.view.app, v.thumbnail?.kind, v.dim])).toEqual([["p-1-site", "shot", "已停用"]]);
    expect(retired.timed[0]).toMatchObject({ status: "stopped", statusText: "已停用", brief: "每天 08:00 日报" });
    expect(projectOperationsSummary(replay(inUse({ p: { state: "archived" } }).list), "p-1")!.stopped).toBe("已归档");
    expect(projectOperationsSummary(replay(inUse({ p: { state: "building" } }).list), "p-1")).toBeUndefined();
    expect(projectOperationsSummary(replay(inUse({ p: { state: "preparing", charterConfirmed: false } }).list), "p-1")).toBeUndefined();
  });
});

describe("运营概况里的“启动”“关闭”（257 号票）", () => {
  test("使用中、有在 LSM 上的服务的才有那一行：在线时只能关闭；你关着的写“已关闭”、只能启动，缩略图灰着标“已关闭”；停用了的、只有定时任务的没有", () => {
    expect(projectOperationsSummary(replay(inUse().list), "p-1")!.power).toEqual({ state: "online", text: "在线", canStart: false, canStop: true });
    const off = projectOperationsSummary(replay(inUse({ services: [service({ paused: true, status: "offline", thumbnailAt: "2026-10-18T08:00:00.000+08:00" })] }).list), "p-1")!;
    expect(off.power).toEqual({ state: "off", text: "已关闭", canStart: true, canStop: false });
    expect(off.services[0]).toMatchObject({ entry: { text: "已关闭", kind: "offline" }, dim: "已关闭" });
    expect(projectOperationsSummary(replay(inUse({ services: [service({ power: "starting", status: "offline" })] }).list), "p-1")!.power).toMatchObject({ state: "starting", text: "启动中…", canStart: false, canStop: true });
    expect(projectOperationsSummary(replay(inUse({ services: [service({ rollout: "failed", reason: "端口被占" })] }).list), "p-1")!.power).toMatchObject({ state: "failed", detail: "端口被占", canStart: true, canStop: true });
    expect(projectOperationsSummary(replay(inUse({ p: { state: "retired" }, services: [service({ rollout: "withdrawn" })] }).list), "p-1")!.power).toBeUndefined();
    expect(projectOperationsSummary(replay(inUse({ services: [] }).list), "p-1")!.power).toBeUndefined();
    // LSM 没连上：两个都不能点，写原因
    expect(projectOperationsSummary(replay(inUse({ services: [service({ status: "unknown" })] }).list), "p-1")!.power).toMatchObject({ canStart: false, canStop: false, blocked: "LSM 没连上，现在启动、关闭不了" });
  });
});

describe("“现在”按项目状态挑内容", () => {
  test("筹备中：起草中（和维护者交流）、立项书等你确认（去确认）、你打回了在改、已确认等你开工", () => {
    const at = preparingAt;
    expect(at({})).toEqual({ kind: "preparing", step: "drafting", text: "维护者在和你做立项问答、起草立项书", action: "chat" });
    expect(at({ charterCardId: "c-ch" }, [card("c-ch", 1, { type: "charter" })])).toMatchObject({ step: "awaiting_confirm", text: "立项书交上来了，等你确认", action: "charter" });
    expect(at({ charterCardId: "c-ch" }, [card("c-ch", 2, { type: "charter", status: "dismissed" })])).toMatchObject({ step: "revising", action: "chat" });
    expect(at({ charterCardId: "c-ch", charterConfirmed: true })).toMatchObject({ step: "confirmed", text: "立项书已确认，等你开工", action: "start_build" });
  });

  test("建设中：建设任务的进度和状态、正在做的工单、卡住的醒目列出并写原因（等你、失败、被拦、超时没动），最近一句进展，“首版做完了”卡", () => {
    const f = frames();
    f.project(project({ state: "building", buildTaskId: "t-1" }));
    f.task(
      task("t-1", {
        title: "建设「AI 简报站」首版",
        kind: "long_running",
        state: "running",
        stages: {
          total: 3,
          current: 2,
          list: [
            { stageId: "s1", title: "抓取", state: "accepted", dependsOn: [], acceptance: [], attempts: 1, summary: "三个来源都能抓到" },
            { stageId: "s2", title: "写日报", state: "running", dependsOn: ["s1"], acceptance: [], attempts: 0 },
            { stageId: "s3", title: "网页", state: "pending", dependsOn: ["s2"], acceptance: [], attempts: 0 },
          ],
        },
      }),
    );
    // 进行中、刚有动静的：正在做（维护者睡着了也不算超时）
    f.workOrder(wo("wo-1", { updatedAt: new Date(NOW - 60_000).toISOString() }));
    // 内部任务等你批准（被拦）、等你验收（等你）、做不了的工单（任务还没结束：失败）、等澄清的工单（等你）、很久没动静的（超时没动）
    f.task(task("t-2", { title: "补抓取源", state: "waiting_for_user", waitReason: "approval", kind: "workflow" }));
    f.task(task("t-3", { title: "写周报模板", state: "waiting_for_user", waitReason: "stuck", waitNote: "缺少 API key" }));
    f.task(task("t-4", { title: "接 RSS", state: "running" }));
    f.workOrder(wo("wo-4", { taskId: "t-4", state: "ended", outcome: "unable", reason: "RSS 源 403" }));
    f.task(task("t-5", { title: "改样式", state: "running" }));
    f.workOrder(wo("wo-5", { taskId: "t-5", state: "clarifying" }));
    f.task(task("t-6", { title: "清缓存", state: "running" }));
    f.workOrder(wo("wo-6", { taskId: "t-6", updatedAt: new Date(NOW - STALE_WORK_ORDER_MS - 5 * 60_000).toISOString() }));
    f.card(card("c-done", 1, { type: "build_done", payload: { projectId: "p-1" } }));
    const now = projectNow(replay(f.list), "p-1", NOW);
    expect(now?.kind).toBe("building");
    if (now?.kind !== "building") return;
    expect(now.build).toMatchObject({ taskId: "t-1", title: "建设「AI 简报站」首版", status: "执行中" });
    expect(now.doing.map((w) => w.id)).toEqual(["wo-1", "wo-6"]);
    expect(now.stuck.map((s) => [s.kind, s.title, s.reason]).toSorted()).toEqual(
      [
        ["blocked", "补抓取源", "被拦下，等你批准"],
        ["waiting", "写周报模板", "等你卡住求助：缺少 API key"],
        ["failed", "工单 wo-4", "RSS 源 403"],
        ["waiting", "工单 wo-5", "维护者在等你回答提问"],
        ["stale", "工单 wo-6", "进行中，35 分钟没有动静"],
      ].toSorted(),
    );
    expect(now.latest).toBe("「抓取」验收了：三个来源都能抓到");
    expect(now.buildDoneCardId).toBe("c-done");

    // 维护者在干活：进行中的工单不算超时没动
    f.activity("working");
    const working = projectNow(replay(f.list), "p-1", NOW);
    expect(working?.kind === "building" && working.stuck.some((s) => s.kind === "stale")).toBe(false);
  });

  test("建设中：“转入使用”确认卡还在等（259 号票）——“现在”里直接放这张卡；处理了就不放", () => {
    const f = frames();
    f.project(project({ state: "building", buildTaskId: "t-1" }));
    f.task(task("t-1", { title: "建设首版", state: "running" }));
    f.card(card("c-go", 1, { type: "go_live", payload: { projectId: "p-1" } }));
    const now = projectNow(replay(f.list), "p-1", NOW);
    expect(now?.kind === "building" && now.goLiveCardId).toBe("c-go");
    expect(now?.kind === "building" && now.buildDoneCardId).toBeUndefined();
    f.card(card("c-go", 2, { type: "go_live", status: "handled", payload: { projectId: "p-1" } }));
    const after = projectNow(replay(f.list), "p-1", NOW);
    expect(after?.kind === "building" && after.goLiveCardId).toBeUndefined();
  });

  // 311 号票（294 号票端到端小测第 6 条，截图 25）：建设任务那一行同时写"待确认 · 计划等你确认"和"尚无计划"
  test("建设任务的计划还没授权（规划中、计划等你确认）：只写状态，不再另写“尚无计划”；授权了照旧有进度", () => {
    const f = frames();
    f.project(project({ state: "building", buildTaskId: "t-1" }));
    f.task(task("t-1", { title: "建设首版", kind: "long_running", state: "awaiting_confirm", stages: { total: 1 } }));
    const now = projectNow(replay(f.list), "p-1", NOW);
    expect(now?.kind === "building" && now.build).toEqual({ taskId: "t-1", title: "建设首版", status: "待确认 · 计划等你确认" });
    f.task(task("t-1", { title: "建设首版", kind: "long_running", state: "running", stages: { total: 1, current: 1, list: [{ stageId: "s1", title: "写", state: "running", dependsOn: [], acceptance: [], attempts: 0 }] } }));
    const running = projectNow(replay(f.list), "p-1", NOW);
    expect(running?.kind === "building" && running.build).toMatchObject({ status: "执行中", progress: { done: 0, total: 1, unit: "stage" } });
  });

  test("建设任务失败了：卡住的里写失败的原因", () => {
    const f = frames();
    f.project(project({ state: "building", buildTaskId: "t-1" }));
    f.task(task("t-1", { title: "建设首版", state: "failed", failReason: "依赖装不上" }));
    const now = projectNow(replay(f.list), "p-1", NOW);
    expect(now?.kind === "building" && now.stuck).toEqual([{ key: "task:t-1", kind: "failed", title: "建设首版", taskId: "t-1", reason: "依赖装不上" }]);
  });

  test("使用中：运营概况和最近几次运行（新的在前，失败的标出来、带原因）", () => {
    const f = inUse();
    f.job(job("j-1", { lastRun: run("j-1", 2, "failed", "2026-10-18T08:02:00.000+08:00", { reason: "网站打不开" }) }), run("j-1", 1, "done", "2026-10-17T08:02:00.000+08:00"));
    f.job(job("j-1", { lastRun: run("j-1", 2, "failed", "2026-10-18T08:02:00.000+08:00", { reason: "网站打不开" }) }), run("j-1", 2, "failed", "2026-10-18T08:02:00.000+08:00", { reason: "网站打不开" }));
    f.job(job("j-2", { title: "周报", schedule: { kind: "weekly", time: "18:00", weekdays: [0] }, ownerTaskId: "t-j-2" }), run("j-2", 1, "done", "2026-10-11T18:05:00.000+08:00"));
    const now = projectNow(replay(f.list), "p-1", NOW);
    expect(now?.kind).toBe("in_use");
    if (now?.kind !== "in_use") return;
    expect(now.summary?.line).toBe("2 个定时任务：每天 08:00 日报、每周日 18:00 周报");
    expect(now.runs.map((r) => [r.name, r.at, r.text, r.failed, r.reason])).toEqual([
      ["日报", "2026-10-18T08:02:00.000+08:00", "失败", true, "网站打不开"],
      ["日报", "2026-10-17T08:02:00.000+08:00", "成功", false, undefined],
      ["周报", "2026-10-11T18:05:00.000+08:00", "成功", false, undefined],
    ]);
    expect(projectRecentRuns(replay(f.list), "p-1", 1)).toHaveLength(1);
  });

  test("已停用、已归档：一句话说清停了什么、怎么重新启用；运营概况照样列、整块标出来", () => {
    const retired = projectNow(replay(inUse({ p: { state: "retired" }, services: [service({ rollout: "withdrawn" })] }).list), "p-1", NOW);
    expect(retired).toMatchObject({ kind: "stopped", state: "retired", text: "已停用：服务「简报站」撤下了，2 个定时任务暂停了。", how: "点上面的“重新启用”：服务重新上线、定时任务恢复。", summary: { stopped: "已停用" } });
    const archived = projectNow(replay(inUse({ p: { state: "archived" }, services: [], jobs: [] }).list), "p-1", NOW);
    expect(archived).toEqual({ kind: "stopped", state: "archived", text: "已归档：没有在跑的服务和定时任务。", how: "要重新用：先点上面的“取消归档”。" });
  });
});
