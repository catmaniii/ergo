// 主切面：定时触发的任务的每次运行与错过补发（规格第 8、13、17 节；19 号票的定时作业，76 号票起并进定时触发的任务，ADR 0025）。
// 真的守护进程，秘书、维护者接 faux 剧本，调度器的时钟换成手动拨的（ManualClock），测试扮演前端。
// （发起、排队合并、接着同一段会话、流程逐步核对、迁移见 triggers.test.ts）
// - 登记：发起对话框里选"定时"建出就登记它的触发（触发底座的一条 scheduled_job），看板的"运营中"一组出现这个任务；
// - 到点：属于项目的作为一张来源为"定时触发"的工单交给项目维护者，不属于项目的由任务自己的 agent 执行；
//   每次运行真正开始时占一个全局执行名额（在项目队列里排着不占），满了排队；每次运行留一条运行记录；用量记在任务名下；
// - 迁移来的定时作业的授权：授权内的对外发送不问，超出的先问（等不到批准被拦下，这次记失败），用户的限制编出的规则禁止的被拦；
// - 失败：标"最近一次失败"，连续失败 3 次自动暂停、待我处理里一条"已自动暂停"；
// - 用户在看板上暂停（排着的运行一并丢掉）、恢复；项目停用、归档时暂停，重新启用、取消归档时恢复；
// - 守护进程停着期间错过的：只补跑一次，补完再重启不再补；停机打断的那次记为中断，不算进连续失败；
// - 每周的归档清单。
// 录给 Web 回放的四段：scheduled-job-project、scheduled-job-failures、missed-triggers、archive-list
// （重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/scheduled-jobs.test.ts）。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type ArchiveListCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  maintainerChannel,
  METHODS,
  type MessageEventPayload,
  nowIso,
  type Plan,
  type PlanCardPayload,
  type Project,
  type ProjectEventPayload,
  type ReminderEventPayload,
  type ReminderSchedule,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type ScopeRecord,
  type ScopeRecordEventPayload,
  type JobRunWorkOrder,
  type TaskEventPayload,
  type WorkOrderEventPayload,
  workOrderTaskId,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { daemonBusy } from "../../src/lsm/busy.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { projectTask, seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { eventually, ok, onePlan } from "../helpers/running-task.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const TM1 = maintainerChannel("tm-1");
const JM1 = maintainerChannel("jm-1");

/** 每天早上 09:00 出一份简报 */
const BRIEFING = { title: "每天早上出简报", schedule: { kind: "daily" as const, time: "09:00" }, each: "汇总昨天的新闻，写一份简报 brief.md" };
/** 发起对话框里写的（第一行是标题）：也是每次要做的事 */
const BRIEFING_TEXT = `${BRIEFING.title}\n${BRIEFING.each}`;

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const jobWhere = (frontend: TestFrontend, match: (e: ScheduledJobEventPayload) => boolean, what = "触发登记", timeoutMs?: number) => eventually(() => jobsOf(frontend), match, what, timeoutMs);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");

async function connect(td: TestDaemon, channels: string[] = [BOARD, CARDS, INBOX, PROJECTS]) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 在发起对话框里建一个定时触发的普通任务（不涉及项目时由任务自己的 agent 执行，只涉及一个项目的是这个项目的内部任务）；返回任务 id */
async function timedTask(frontend: TestFrontend, text = BRIEFING_TEXT, options: { schedule?: ReminderSchedule; projects?: string[]; key?: string } = {}): Promise<string> {
  const trigger = { kind: "schedule" as const, schedule: options.schedule ?? BRIEFING.schedule };
  return (ok(await frontend.startTask(text, options.key ?? `k-${text.split("\n")[0]}`, options.projects ?? [], "plain", trigger)) as { taskId: string }).taskId;
}

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), records: (projectId = "p-1") => path.join(fs.realpathSync.native(dataDir), "projects", projectId) };
}

describe("登记", () => {
  it("发起对话框里选定时建普通任务：任务建出就是运营中，触发登记好（看板频道推送一条）：记着时间表、每次要做的事、不属于项目、由任务自己的 agent 执行；重启之后不重复登记", async () => {
    const d = dirs();
    const first = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir } });
    const frontend = await connect(first);
    const taskId = await timedTask(frontend);

    const registered = await jobWhere(frontend, (e) => e.change === "registered", "登记");
    expect(registered.by).toBe("user");
    expect(registered.job).toMatchObject({
      id: "j-1",
      title: BRIEFING.title,
      schedule: BRIEFING.schedule,
      each: BRIEFING_TEXT,
      maintainerId: "tm-1",
      taskId,
      ownerTaskId: taskId,
      state: "active",
      nextAt: expect.stringMatching(/^2026-10-08T09:00:00/),
      consecutiveFailures: 0,
      runCount: 0,
      // 普通任务不预先授权（每次运行按普通对话判）
      grants: [],
      temporalRules: [],
      grantInfo: {},
    });
    expect(registered.job.projectId).toBeUndefined();
    expect(first.daemon.tasks.get(taskId)).toMatchObject({ state: "operating", kind: "plain", trigger: { kind: "schedule", schedule: BRIEFING.schedule } });
    await frontend.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir } });
    await connect(second);
    expect(second.daemon.scheduledJobs.list().map((j) => j.id)).toEqual(["j-1"]);
    expect(second.daemon.store.read(BOARD, 0, EVENT_TYPES.scheduledJob).filter((e) => (e.payload as ScheduledJobEventPayload).change === "registered")).toHaveLength(1);
  }, 120_000);
});

/**
 * 起一个守护进程（时钟停在 START）：定时触发的任务的 agent（tm-1）照 run 的剧本（每次运行唤起一次：第 n 次唤起做第 n 次运行），
 * 别的任务的维护者交只有一个阶段的计划、执行时干活不出结果（一直在执行中）
 */
async function jobDaemon(run: (spawn: number) => FauxStep[]) {
  const clock = new ManualClock(START);
  const td = await startTestDaemon({
    clock,
    maintainer: (id, n) => {
      if (id === "tm-1") return run(n);
      if (n === 1) return [submitPlanStep(onePlan()), say("计划交上去了")];
      return [say("好"), say("好")];
    },
  });
  const frontend = await connect(td);
  return { td, clock, frontend };
}

describe("到点运行", () => {
  it("不属于项目的到点：任务自己的 agent（tm-1）收到带着任务和触发登记身份的输入、做完这一轮，多一条运行记录（触发时间、成功），用量记在任务名下", async () => {
    const { td, clock, frontend } = await jobDaemon(() => [{ kind: "reply", text: "简报写好了：brief.md", usage: { cacheHit: 0, cacheMiss: 900, output: 40 } }]);
    const taskId = await timedTask(frontend);
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    clock.advanceTo(at(10, 8, 9, 0));
    const triggered = await jobWhere(frontend, (e) => e.change === "triggered", "到点");
    expect(triggered.run).toMatchObject({ runId: "j-1-r1", trigger: "scheduled", dueAt: nowIso(at(10, 8, 9, 0)), state: "queued", events: [{ source: "time", at: nowIso(at(10, 8, 9, 0)) }] });
    // 下一次往后算
    expect(triggered.job.nextAt).toBe(nowIso(at(10, 9, 9, 0)));
    const finished = await jobWhere(frontend, (e) => e.change === "run_finished", "运行结束");
    expect(finished.run).toMatchObject({ runId: "j-1-r1", state: "done", dueAt: nowIso(at(10, 8, 9, 0)) });
    expect(finished.job).toMatchObject({ state: "active", lastFailed: false, consecutiveFailures: 0, runCount: 1, lastRun: { runId: "j-1-r1", state: "done" } });
    // 运行记录的先后：排队 → 开始 → 结束
    expect(jobsOf(frontend).filter((e) => e.run?.runId === "j-1-r1").map((e) => `${e.change}:${e.run!.state}`)).toEqual(["triggered:queued", "run_started:running", "run_finished:done"]);

    // agent 收到的输入写明每次要做的事，带着任务和触发登记的身份
    const input = td.daemon.store
      .read(TM1, 0, EVENT_TYPES.message)
      .map((e) => e.payload as MessageEventPayload)
      .find((m) => m.message.speaker === "system" && m.agentInput === true)!;
    expect(input).toMatchObject({ scheduledJobId: "j-1", taskId });
    expect(textOf(input)).toContain(BRIEFING.each);
    // 用量记在任务名下（消耗页按任务记账），不在触发登记名下
    expect(td.daemon.ledger.totals({ kind: "task", id: taskId })).toMatchObject({ calls: 1, tokens: { cacheHit: 0, cacheMiss: 900, output: 40 } });
    expect(td.daemon.ledger.totals({ kind: "scheduled_job", id: "j-1" })).toBeUndefined();
    // 一次运行做完不算任务完成：任务一直是运营中
    expect(td.daemon.tasks.get(taskId)!.state).toBe("operating");
  });

  // 要拉起四个 agent 子进程：单跑几秒，满载时会超过默认的 30 秒
  it("每次运行真正开始时占一个全局执行名额：已有 3 个在执行中时，到点的运行排队；暂停时排着的这次一并丢掉；名额空出来后下一次到点马上开始", async () => {
    const { td, clock, frontend } = await jobDaemon(() => [say("简报写好了")]);
    await timedTask(frontend);
    // 再起三个执行中的任务：名额（默认 3 个）满了（定时触发的任务运营中不占名额）
    for (const title of ["整理发票", "清理相册", "写周报"]) {
      const task = td.daemon.tasks.createByRequest({ title, summary: title });
      td.daemon.tasks.writeBrief(task.id, { goal: title, acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
      const card = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
      ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
      await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "started", `${task.id} 开始执行`);
    }
    expect(td.daemon.tasks.list().filter((t) => t.state === "running")).toHaveLength(3);

    clock.advanceTo(at(10, 8, 9, 0));
    await jobWhere(frontend, (e) => e.change === "triggered", "到点");
    // 名额满了：排着，不开始
    await new Promise((r) => setTimeout(r, 300));
    expect(jobsOf(frontend).filter((e) => e.change === "run_started")).toEqual([]);
    expect(td.daemon.scheduledJobs.get("j-1")!.lastRun).toMatchObject({ state: "queued" });

    // 暂停：排着的这次一并丢掉（记为没运行，不算进连续失败，也不标"最近一次失败"）
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }));
    const dropped = await jobWhere(frontend, (e) => e.change === "run_finished", "排着的运行被丢掉");
    expect(dropped.run).toMatchObject({ runId: "j-1-r1", state: "dropped", reason: expect.stringContaining("排着的这次不再运行") });
    expect(dropped.job).toMatchObject({ state: "paused", consecutiveFailures: 0, lastFailed: false, lastRun: { runId: "j-1-r1", state: "dropped" } });
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" }));
    await jobWhere(frontend, (e) => e.change === "resumed", "恢复");

    // 暂停一个任务：名额空出来，但已经没有排着的运行
    ok(await frontend.taskAction({ taskId: "t-2", action: "pause" }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2" && e.change === "paused", "t-2 暂停");
    await new Promise((r) => setTimeout(r, 300));
    expect(jobsOf(frontend).filter((e) => e.change === "run_started")).toEqual([]);
    // 下一次到点：有名额，马上开始、做完
    clock.advanceTo(at(10, 9, 9, 0));
    await jobWhere(frontend, (e) => e.change === "run_started" && e.run?.runId === "j-1-r2", "第二次运行开始");
    await jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.state === "done", "运行结束");
    expect(td.daemon.scheduledJobs.currentRun("j-1")).toBeUndefined();
  }, 120_000);
});

/** 本机上一个收日报的 hook（测试结束时关掉）：记下收到的请求 */
async function startHook(): Promise<{ url: (p: string) => string; received: string[]; close(): Promise<void> }> {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type ToolCallRecord = { callId: string; tool: string; argsSummary: string; disposition?: string; withinGrant?: boolean; blockedBy?: string; outcome: string; resultSummary?: string };
/** 会话里的工具调用记录（同一次调用的记录会更新：取最新的） */
const toolCallsOf = (frontend: TestFrontend, channel: string): ToolCallRecord[] => {
  const latest = new Map<string, ToolCallRecord>();
  for (const part of messagesOf(frontend, channel).flatMap((m) => m.message.parts)) if (part.type === "tool_call") latest.set(part.callId, part as unknown as ToolCallRecord);
  return [...latest.values()];
};

describe("迁移来的定时作业的授权", () => {
  it("76 号票之前随计划卡确认的定时作业（每次运行的授权、用户的限制编出的规则）迁移后照旧：授权内的对外发送不问，限制编出的规则禁止的被拦，超出的先问、等不到批准被拦下，这次记失败；暂停即收回授权", async () => {
    const hook = await startHook();
    try {
      const daily = hook.url("/daily");
      const secret = hook.url("/secret");
      const other = hook.url("/other");
      const noSecret = { id: "no-secret", title: "不往 secret 发", trigger: { tool: "http_request", where: { eq: ["$current.args.url", secret] } }, on_violation: "block" as const };
      const plan: Plan = { ...onePlan(), toolkit: { skills: [], mcp: [], bash: true, network: true } };
      const curl = (url: string) => call("bash", { command: `curl -s -X POST ${url} -d "今天的日报"` });
      const d = dirs();
      const maintainer = (id: string, n: number): FauxStep[] => {
        if (id === "jm-1") return n === 1 ? [curl(daily), curl(secret), curl(other), say("发完了")] : [say("好")];
        return n === 1 ? [submitPlanStep(plan), say("计划交上去了")] : [say("好"), say("好")];
      };
      // 76 号票之前：一个任务的计划确认了（工具包开着 bash、联网），作业随它登记（作业自己的维护者 jm-1、授权项、限制编出的规则）
      const first = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
      const before = await connect(first);
      const task = first.daemon.tasks.createByRequest({ title: "每天早上发日报", summary: "每天早上发日报" });
      first.daemon.tasks.writeBrief(task.id, { goal: "每天早上发日报", acceptanceCriteria: ["每天都发"], constraints: ["别往 secret 那个地址发"], projects: [], memoryScope: "" });
      const card = await eventually(() => cardsOf(before), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
      await settled(first, task.maintainerId);
      ok(await before.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
      await eventually(() => tasksOf(before), (e) => e.task.id === task.id && e.change === "started", "任务开始执行");
      await settled(first, task.maintainerId);
      const time = nowIso(START);
      const legacy: ScheduledJob = {
        id: "j-1",
        title: "每天早上把日报发到 hook",
        schedule: { kind: "daily", time: "09:00" },
        each: "写日报，发到 hook",
        maintainerId: "jm-1",
        taskId: task.id,
        taskTitle: task.title,
        grants: [{ id: "send-daily", tool: "http_request", title: "把日报发到 hook", scope: { url: [daily, secret] } }],
        temporalRules: [noSecret],
        grantInfo: {},
        state: "active",
        nextAt: nowIso(at(10, 8, 9, 0)),
        lastFailed: false,
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: time,
        updatedAt: time,
      };
      first.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.scheduledJob, payload: { job: legacy, change: "registered", by: "user" } satisfies ScheduledJobEventPayload });
      await before.close();
      await first.daemon.stop();

      const clock = new ManualClock(START);
      const td = await startTestDaemon({ clock, reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
      const frontend = await connect(td, [BOARD, CARDS, INBOX, JM1]);
      // 迁移成定时触发的普通任务，授权、规则照旧在触发登记上
      const migrated = await jobWhere(frontend, (e) => e.change === "migrated", "迁移");
      expect(migrated.job).toMatchObject({ ownerTaskId: "t-2", maintainerId: "jm-1", grants: [{ id: "send-daily" }], temporalRules: [{ id: "no-secret" }] });

      clock.advanceTo(at(10, 8, 9, 0));
      // 超出授权的那一次先问：出审批卡
      const approval = await eventually(() => cardsOf(frontend), (c) => c.type === "approval" && c.status === "pending", "审批卡");
      expect(JSON.stringify(approval.payload)).toContain("/other");
      // 等不到批准（默认等 5 分钟）：拦下，这一轮接着做完，这次运行记为失败
      clock.advanceTo(at(10, 8, 9, 6));
      const finished = await jobWhere(frontend, (e) => e.change === "run_finished", "运行结束");
      expect(finished.run).toMatchObject({ runId: "j-1-r1", state: "failed", reason: expect.stringContaining("要用户批准，等不到被拦下了") });
      expect(finished.job).toMatchObject({ state: "active", lastFailed: true, consecutiveFailures: 1 });

      const calls = toolCallsOf(frontend, JM1).filter((c) => c.tool === "bash");
      expect(calls.map((c) => [c.outcome, c.disposition ?? null, c.withinGrant ?? null])).toEqual([
        // 授权内的对外发送：不问，直接发
        ["done", "do", true],
        // 授权里有、但用户的限制编出的规则禁止：拦下（永不），不出审批卡
        ["blocked", "never", false],
        // 授权外：先问，等不到批准被拦下
        ["blocked", "ask_first", false],
      ]);
      expect(calls[1]!.resultSummary).toContain("不往 secret 发");
      expect(hook.received).toEqual(["POST /daily"]);
      expect(cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1)).toHaveLength(1);

      // 暂停即收回授权（守卫看不到授权项）；恢复后又有
      const grantsNow = () => td.daemon.scheduledJobs.runAssembly("j-1", "jm-1")!.guardTask()!.plan.grants.map((g) => g.grantId);
      expect(grantsNow()).toEqual(["send-daily"]);
      ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }));
      await jobWhere(frontend, (e) => e.change === "paused", "暂停");
      expect(grantsNow()).toEqual([]);
      ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" }));
      await jobWhere(frontend, (e) => e.change === "resumed", "恢复");
      expect(grantsNow()).toEqual(["send-daily"]);
    } finally {
      await hook.close();
    }
  }, 120_000);
});

/** 进展文档的一句改成另一句（维护者写回项目档案） */
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
const summary = (text: string) => call("write_segment_summary", { summary: text });
const writeProgress = (content: string) => call("write_progress", { content });

/** 一个已在使用中的项目（立项书已确认） */
function inUseProject(td: TestDaemon, name: string): Project {
  return seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
}

/** 项目的任务的计划：一个阶段（写出周报，脚本验收） */
function projectPlan(): Plan {
  return {
    ...samplePlan(),
    stages: [
      {
        stageId: "s1",
        title: "写周报",
        deliverables: ["weekly.md"],
        acceptance: [{ criterion: "weekly.md 存在", method: "script", script: "test -f weekly.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    stops: { count: 0, where: [] },
  };
}

/** 项目里的一个长程任务（64 号票起只涉及一个项目的任务是这个项目的内部任务）：项目的维护者建好、写好任务书 */
async function startProjectTask(td: TestDaemon, frontend: TestFrontend, title: string, project: string): Promise<string> {
  const task = projectTask(td.daemon, project, title, { goal: title, acceptanceCriteria: ["每周都有周报"], constraints: [], memoryScope: "" });
  await eventually(() => tasksOf(frontend), (e) => e.change === "created" && e.task.id === task.id, `任务「${title}」`);
  return task.id;
}

const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const scopeRecordsOf = (frontend: TestFrontend): ScopeRecord[] => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.scopeRecord }).map((f) => (f.payload as ScopeRecordEventPayload).record);
const PM1 = maintainerChannel("pm-1");

describe("属于项目的", () => {
  it("在发起对话框里选了项目的定时触发的任务是这个项目的内部任务，由项目的维护者执行：到点时派单器开一张来源为定时触发的工单，维护者被唤起做完、写回项目档案，工单结束，多一条成功的运行记录；用量记在任务名下", async () => {
    const d = dirs();
    const records = d.records();
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id) =>
        id === "pm-1"
          ? // 一次运行：写简报、写回、看一眼能用的工具
            [
              call("write", { path: "brief.md", content: "# 今日简报\n" }),
              progressEdit(records, "做到哪了、下一步做什么：每段工作结束时写回。", "简报：10-08 的简报出了。"),
              summary("出了 10-08 的简报"),
              { kind: "echo_context", usage: { cacheHit: 0, cacheMiss: 500, output: 20 } } as FauxStep,
            ]
          : [],
    });
    inUseProject(td, "资讯站");
    const frontend = await connect(td, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const taskId = await timedTask(frontend, BRIEFING_TEXT, { projects: ["资讯站"] });
    const registered = await jobWhere(frontend, (e) => e.change === "registered", "登记");
    expect(registered.job).toMatchObject({ id: "j-1", projectId: "p-1", projectName: "资讯站", maintainerId: "pm-1", ownerTaskId: taskId, state: "active", internal: { projectId: "p-1" } });
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "operating", projectScope: "single", internal: { projectId: "p-1" } });

    clock.advanceTo(at(10, 8, 9, 0));
    const created = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && e.workOrder.kind === "run", "运行的工单");
    expect(created.workOrder).toMatchObject({ source: "scheduled_job", kind: "run", projectId: "p-1", maintainerId: "pm-1", scheduledJobId: "j-1", runId: "j-1-r1", title: "定时触发：每天早上出简报" });
    expect(workOrderTaskId(created.workOrder)).toBeUndefined();
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "run", "运行的工单结束", 60_000);
    await settled(td, "pm-1");
    expect(ended.workOrder).toMatchObject({ outcome: "done" });
    expect(ended.workOrder.unwritten).toBeUndefined();
    const finished = await jobWhere(frontend, (e) => e.change === "run_finished", "运行结束");
    expect(finished.run).toMatchObject({ runId: "j-1-r1", state: "done", workOrderId: created.workOrder.id });
    expect(fs.readFileSync(path.join(records, "workdir", "brief.md"), "utf8")).toBe("# 今日简报\n");

    // 这一段的消息带着项目和触发登记；固定上下文里的工单写明来自定时触发、第几次运行、要做的事
    const runMessages = messagesOf(frontend, PM1).filter((m) => m.scheduledJobId === "j-1");
    expect(runMessages.length).toBeGreaterThan(0);
    expect(runMessages.every((m) => m.projectId === "p-1")).toBe(true);
    const seen = textOf(runMessages.find((m) => m.message.speaker === "agent" && textOf(m).includes("【固定上下文】"))!);
    expect(seen).toContain(`这次的工单：${created.workOrder.id}「定时触发：每天早上出简报」，来自定时触发，定时触发（触发登记 j-1）的一次运行 j-1-r1`);
    expect(seen).toContain("定时触发的普通任务 t-1「每天早上出简报」的第 1 次运行");
    expect(seen).toContain(BRIEFING.each);
    // 工具：动手干活的那一套，加上报告失败、写摘要；没有阶段的工具、提问
    const tools = seen.split("\n").filter((l) => l.startsWith("[tool] "));
    expect(tools).toContain("[tool] fail_job_run");
    expect(tools).toContain("[tool] write");
    expect(tools).not.toContain("[tool] complete_stage");
    expect(tools).not.toContain("[tool] ask_clarification");
    // 用量记在任务名下（不是项目、触发登记）：这一段的四次模型调用，加上工单结束时的范围审视（18 号票）
    expect(td.daemon.ledger.totals({ kind: "task", id: taskId })).toMatchObject({
      calls: 5,
      byAgent: [
        { agentId: "pm-1", purpose: "work", calls: 4 },
        { agentId: "pm-1", purpose: "scope_review", calls: 1 },
      ],
    });
    // 项目状态没被改过：只有种下的那一条
    expect(frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project })).toHaveLength(1);
    // 项目的定时触发列表
    expect(td.daemon.scheduledJobs.ofProject("p-1").map((j) => j.id)).toEqual(["j-1"]);
    // 录下来给前端回放：项目页的工单流水线和定时触发的任务
    saveOrCheckRecording("scheduled-job-project", frontend.recording, { perChannel: true });
  }, 120_000);

  it("每次运行是一张新工单、新会话：工单里带着前几次运行的结局和最后说的那一两句（不说\"在这一段会话的前面\"）", async () => {
    const d = dirs();
    const records = d.records();
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 每张工单一段新会话：第一次运行写简报、写回、说一句做成了什么；第二次运行先看一眼收到的上下文
      maintainer: (id, spawn) =>
        id !== "pm-1"
          ? []
          : spawn === 1
            ? [
                call("write", { path: "brief.md", content: "# 今日简报\n" }),
                progressEdit(records, "做到哪了、下一步做什么：每段工作结束时写回。", "简报：10-08 的简报出了。"),
                summary("出了 10-08 的简报"),
                say("10-08 的简报出了，在 brief.md，一共 9 条"),
              ]
            : [{ kind: "echo_context" } as FauxStep],
    });
    inUseProject(td, "资讯站");
    const frontend = await connect(td, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    await timedTask(frontend, BRIEFING_TEXT, { projects: ["资讯站"] });
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    clock.advanceTo(at(10, 8, 9, 0));
    const first = await jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.runId === "j-1-r1", "第一次运行结束");
    // 这次运行最后说的那一两句记在运行记录上
    expect(first.run).toMatchObject({ state: "done", summary: "10-08 的简报出了，在 brief.md，一共 9 条" });
    const firstOrder = workOrdersOf(frontend).find((e) => e.change === "created" && e.workOrder.kind === "run")!.workOrder as JobRunWorkOrder;
    expect(firstOrder.instructions).toContain("这是第一次运行。");
    await settled(td, "pm-1");

    clock.advanceTo(at(10, 9, 9, 0));
    const second = await eventually(
      () => workOrdersOf(frontend),
      (e) => e.change === "created" && e.workOrder.kind === "run" && (e.workOrder as JobRunWorkOrder).runId === "j-1-r2",
      "第二次运行的工单",
    );
    const instructions = (second.workOrder as JobRunWorkOrder).instructions;
    expect(instructions).toContain("前几次运行的结果（每次运行是一张新工单，前几次做了什么不在这一段会话里，只有下面这些）：");
    expect(instructions).toContain("- 第 1 次运行（10 月 8 日（周四）09:00）：成功——最后说的：10-08 的简报出了，在 brief.md，一共 9 条");
    expect(instructions).not.toContain("在这一段会话的前面");
    // 新会话里看得到它（工单在固定上下文里）
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "agent" && textOf(m).includes("一共 9 条") && textOf(m).includes("【固定上下文】")), {
      timeoutMs: 60_000,
      describe: () => "等第二次运行的会话",
    });
  }, 120_000);

  it("名额在运行真正开始时才占：项目队首是排队中任务的执行工单、后面排着这次运行、名额满着时，名额空出来先给队首的任务，任务做完运行再开始，不会卡死；运行工单结束时的范围审视对照着它的任务和触发登记", async () => {
    const d = dirs();
    const records = d.records();
    const clock = new ManualClock(START);
    // 审视的模型：每张工单结束时记一条范围变更，说明里放着这次收到的对照物
    const echoReference: FauxStep = {
      kind: "reply_with_context",
      text: JSON.stringify({ records: [{ kind: "scope_change", summary: "核对对照物", detail: "@@" }] }).replace('"@@"', '"{{context}}"'),
    };
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      // 全局只有 1 个执行名额
      config: { tasks: { maxRunning: 1 } },
      secretary: [say("好的"), say("好的")],
      maintainer: (id, spawn) => {
        // 不属于项目的任务：执行起来就一直占着名额
        if (id === "tm-2") return spawn === 1 ? [submitPlanStep(onePlan()), say("计划交上去了")] : [say("好"), say("好")];
        if (id !== "pm-1") return [];
        switch (spawn) {
          case 1:
            return [submitPlanStep(projectPlan()), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")];
          case 2:
            return [
              call("write", { path: "weekly.md", content: "# 周报\n" }),
              call("complete_stage", { stageId: "s1", summary: "周报写好了" }),
              progressEdit(records, "周报：计划交上去了。", "周报：写好了。"),
              summary("写好了周报"),
              say("做完了"),
            ];
          default:
            return [call("write", { path: "brief.md", content: "# 今日简报\n" }), progressEdit(records, "周报：写好了。", "简报：10-08 的简报出了。"), summary("出了 10-08 的简报"), say("简报出了")];
        }
      },
      scopeReviewer: (id) => (id === "pm-1" ? [echoReference, echoReference, echoReference] : []),
    });
    inUseProject(td, "资讯站");
    const frontend = await connect(td);

    // 定时触发的简报（项目内部，t-1）：登记好
    const briefing = await timedTask(frontend, BRIEFING_TEXT, { projects: ["资讯站"] });
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    // 不属于项目的任务执行起来：唯一的名额被它占着
    const invoices = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    td.daemon.tasks.writeBrief(invoices.id, { goal: "整理发票", acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
    const invoiceCard = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === invoices.id, "发票的计划卡");
    await settled(td, invoices.maintainerId);
    ok(await frontend.cardAction({ cardId: invoiceCard.id, action: "confirm", expectedVersion: invoiceCard.version, input: {} }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === invoices.id && e.change === "started", "发票任务开始执行");
    await settled(td, invoices.maintainerId);

    // 周报任务确认后排队（没有名额），它的执行工单排在项目队首
    const report = await startProjectTask(td, frontend, "每周出周报", "资讯站");
    const reportCard = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === report, "周报的计划卡");
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan" && workOrderTaskId(e.workOrder) === report, "周报起草计划的工单结束", 60_000);
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: reportCard.id, action: "confirm", expectedVersion: reportCard.version, input: {} }));
    const executeOrder = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && e.workOrder.kind === "execute" && workOrderTaskId(e.workOrder) === report, "周报的执行工单");
    expect(td.daemon.tasks.get(report)!.state).toBe("queued");

    // 到点：这次运行的工单排在执行工单后面（排着不占名额，也没开始）
    clock.advanceTo(at(10, 8, 9, 0));
    const runOrder = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && e.workOrder.kind === "run", "运行的工单");
    await new Promise((r) => setTimeout(r, 300));
    expect(td.daemon.workOrders.openOf("p-1").map((w) => `${w.id}:${w.kind}:${w.state}`)).toEqual([`${executeOrder.workOrder.id}:execute:pending`, `${runOrder.workOrder.id}:run:pending`]);
    expect(td.daemon.scheduledJobs.get("j-1")!.lastRun).toMatchObject({ state: "queued" });

    // 名额空出来（暂停发票任务）：先给队首的周报任务；它做完、工单结束，运行再开始、做完
    ok(await frontend.taskAction({ taskId: invoices.id, action: "pause" }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === report && e.change === "completed", "周报任务完成", 60_000);
    const finished = await jobWhere(frontend, (e) => e.change === "run_finished", "运行结束", 60_000);
    expect(finished.run).toMatchObject({ runId: "j-1-r1", state: "done", workOrderId: runOrder.workOrder.id });
    await settled(td, "pm-1");
    const started = workOrdersOf(frontend).filter((e) => e.change === "started").map((e) => `${e.workOrder.kind}:${workOrderTaskId(e.workOrder) ?? e.workOrder.title}`);
    expect(started).toEqual([`plan:${report}`, `execute:${report}`, "run:定时触发：每天早上出简报"]);
    const order = workOrdersOf(frontend).map((e) => `${e.change}:${e.workOrder.id}`);
    expect(order.indexOf(`started:${runOrder.workOrder.id}`)).toBeGreaterThan(order.indexOf(`ended:${executeOrder.workOrder.id}`));

    // 运行工单结束时的范围审视：对照物里有它的任务和触发登记
    const reviewed = await eventually(() => scopeRecordsOf(frontend), (r) => r.workOrderId === runOrder.workOrder.id, "运行工单的范围记录");
    expect(reviewed.detail).toContain(`【任务】${briefing}「每天早上出简报」`);
    expect(reviewed.detail).toContain(`【定时触发】任务 ${briefing}「每天早上出简报」的一次运行（触发登记 j-1`);
    expect(reviewed.detail).toContain("普通任务不预先授权");
  }, 180_000);
});

const inboxOf = (frontend: TestFrontend) => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const fail = (reason: string) => call("fail_job_run", { reason });

/** 拨到第 day 天的 09:00，等这一次运行结束、任务的 agent 安静下来 */
async function runOn(td: TestDaemon, clock: ManualClock, frontend: TestFrontend, day: number, runNo: number) {
  clock.advanceTo(at(10, day, 9, 0));
  const finished = await jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.runId === `j-1-r${runNo}`, `第 ${runNo} 次运行结束`);
  await settled(td, "tm-1");
  return finished;
}

describe("失败和自动暂停", () => {
  it("一次运行失败：记一条失败的运行记录（原因），标最近一次失败；中间有一次成功就重新计数；连续失败 3 次自动暂停，待我处理出现\"已自动暂停\"；已暂停的到点不再触发；在事项上点\"恢复\"接着按时间表运行", async () => {
    // 每次运行按这一次重新拉起任务的 agent（会话接着）：第 n 次唤起做第 n 次运行
    const runs: FauxStep[][] = [
      [fail("新闻源打不开"), say("这次做不了")],
      [fail("新闻源打不开"), say("这次做不了")],
      [say("简报写好了")],
      [fail("新闻源打不开"), say("这次做不了")],
      [fail("新闻源打不开"), say("这次做不了")],
      [fail("磁盘满了"), say("这次做不了")],
    ];
    const { td, clock, frontend } = await jobDaemon((n) => runs[n - 1] ?? []);
    await timedTask(frontend);
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    const first = await runOn(td, clock, frontend, 8, 1);
    expect(first.run).toMatchObject({ state: "failed", reason: "新闻源打不开" });
    expect(first.job).toMatchObject({ state: "active", lastFailed: true, consecutiveFailures: 1 });
    expect((await runOn(td, clock, frontend, 9, 2)).job).toMatchObject({ lastFailed: true, consecutiveFailures: 2 });
    // 中间有一次成功：重新计数，"最近一次失败"的标记去掉
    expect((await runOn(td, clock, frontend, 10, 3)).job).toMatchObject({ state: "active", lastFailed: false, consecutiveFailures: 0 });
    expect((await runOn(td, clock, frontend, 11, 4)).job).toMatchObject({ state: "active", consecutiveFailures: 1 });
    expect((await runOn(td, clock, frontend, 12, 5)).job).toMatchObject({ state: "active", consecutiveFailures: 2 });
    // 连续第 3 次：自动暂停，待我处理里一条事项
    const third = await runOn(td, clock, frontend, 13, 6);
    expect(third.run).toMatchObject({ state: "failed", reason: "磁盘满了" });
    expect(third.job).toMatchObject({ state: "paused", pausedBy: "failures", lastFailed: true, consecutiveFailures: 3 });
    expect(third.job.nextAt).toBeUndefined();
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "scheduled_job_auto_paused", "自动暂停的事项");
    expect(item).toMatchObject({ title: "定时触发的任务「每天早上出简报」已自动暂停", urgency: "non_blocking", actions: ["恢复", "保持暂停"], data: { jobId: "j-1" } });
    expect(item.kind === "notice" && item.body).toContain("连续失败 3 次");
    expect(item.kind === "notice" && item.body).toContain("磁盘满了");
    // 任务照旧是运营中（暂停的是它的触发）
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");

    // 已暂停：到点不再触发
    clock.advanceTo(at(10, 14, 9, 0));
    await new Promise((r) => setTimeout(r, 300));
    expect(jobsOf(frontend).filter((e) => e.change === "triggered")).toHaveLength(6);

    // 在事项上点"恢复"：回到运营中，连续失败重新计数，下一次从现在往后算
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "恢复" }));
    const resumed = await jobWhere(frontend, (e) => e.change === "resumed", "恢复");
    expect(resumed.by).toBe("user");
    expect(resumed.job).toMatchObject({ state: "active", consecutiveFailures: 0, nextAt: nowIso(at(10, 15, 9, 0)) });
    expect(resumed.job.pausedBy).toBeUndefined();
    // 录下来给前端回放：运营中一组卡片上的"最近一次失败"、自动暂停，待我处理里的"已自动暂停"
    saveOrCheckRecording("scheduled-job-failures", frontend.recording, { perChannel: true });
  }, 120_000);
});

describe("暂停和恢复", () => {
  it("用户在看板上把它在运营中和已暂停之间切换：状态变化是事件，同时打开的两个前端都看到；已暂停的到点不触发，恢复后下一次从现在往后算；做不了的动作被拒；取消后任务一起取消、到点不触发", async () => {
    const { td, clock, frontend } = await jobDaemon(() => [say("简报写好了")]);
    const other = await connect(td, [BOARD]);
    const taskId = await timedTask(frontend);
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    expect(ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }, "pause-1"))).toEqual({ jobId: "j-1", state: "paused" });
    for (const f of [frontend, other]) {
      const paused = await jobWhere(f, (e) => e.change === "paused", "暂停");
      expect(paused.by).toBe("user");
      expect(paused.job).toMatchObject({ state: "paused", pausedBy: "user" });
    }
    // 同一个幂等键重发：拿到同一个结果，不多一条事件
    expect(ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }, "pause-1"))).toEqual({ jobId: "j-1", state: "paused" });
    // 已暂停的不能再暂停
    const again = await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" });
    expect(again.ok ? undefined : again.error.code).toBe("not_allowed");

    clock.advanceTo(at(10, 9, 9, 30));
    await new Promise((r) => setTimeout(r, 300));
    expect(jobsOf(frontend).filter((e) => e.change === "triggered")).toEqual([]);

    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" }));
    for (const f of [frontend, other]) {
      const resumed = await jobWhere(f, (e) => e.change === "resumed", "恢复");
      expect(resumed.job).toMatchObject({ state: "active", nextAt: nowIso(at(10, 10, 9, 0)) });
    }
    // 恢复后照常到点
    clock.advanceTo(at(10, 10, 9, 0));
    await jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.state === "done", "运行结束");
    // 日历上的查询（35 号票用）：时间表展开（暂停期间的照样列出）、这段时间里的运行记录
    const [entry] = td.daemon.scheduledJobs.calendar(at(10, 8, 0), at(10, 11, 0));
    expect(entry!.job).toMatchObject({ id: "j-1", state: "active" });
    expect(entry!.occurrences).toEqual([nowIso(at(10, 8, 9)), nowIso(at(10, 9, 9)), nowIso(at(10, 10, 9))]);
    expect(entry!.runs.map((r) => `${r.runId} ${r.state}`)).toEqual(["j-1-r1 done"]);

    // 取消：任务一起取消（看板上到最近结束），到点不再触发
    await settled(td, "tm-1");
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "cancel" }));
    const cancelled = await jobWhere(other, (e) => e.change === "cancelled", "取消");
    expect(cancelled.job).toMatchObject({ state: "cancelled" });
    expect(cancelled.job.nextAt).toBeUndefined();
    expect(td.daemon.tasks.get(taskId)!.state).toBe("cancelled");
    clock.advanceTo(at(10, 11, 9, 0));
    await new Promise((r) => setTimeout(r, 300));
    expect(jobsOf(frontend).filter((e) => e.change === "triggered")).toHaveLength(1);
    const notFound = await frontend.scheduledJobAction({ jobId: "j-9", action: "pause" });
    expect(notFound.ok ? undefined : notFound.error.code).toBe("not_found");
  }, 120_000);
});

describe("项目停用、归档和恢复", () => {
  it("项目转为已停用、已归档时它运营中的定时触发全部暂停；重新启用、取消归档后因此暂停的恢复，之前就暂停了的保持暂停；这期间恢复被拒；登记、暂停、取消都不改项目状态", async () => {
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ clock, secretary: [say("好的")], maintainer: () => [say("好")] });
    inUseProject(td, "资讯站");
    const frontend = await connect(td);
    await timedTask(frontend, BRIEFING_TEXT, { projects: ["资讯站"] });
    await timedTask(frontend, "每周一出周报\n汇总上周的简报出一份周报", { projects: ["资讯站"], schedule: { kind: "weekly", time: "08:00", weekdays: [1] } });
    await jobWhere(frontend, (e) => e.change === "registered" && e.job.id === "j-2", "两个都登记");

    // 停用前先暂停周报
    ok(await frontend.scheduledJobAction({ jobId: "j-2", action: "pause" }));
    await jobWhere(frontend, (e) => e.change === "paused" && e.job.id === "j-2", "暂停周报");

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "retire"));
    const retired = await jobWhere(frontend, (e) => e.change === "paused" && e.job.id === "j-1", "停用时暂停简报");
    expect(retired.by).toBe("system");
    expect(retired.job).toMatchObject({ state: "paused", pausedBy: "project_retired" });
    expect(td.daemon.scheduledJobs.get("j-2")).toMatchObject({ state: "paused", pausedBy: "user" });
    // 停用期间：到点不触发，恢复被拒
    clock.advanceTo(at(10, 9, 9, 0));
    const refused = await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" });
    expect(refused.ok ? undefined : refused.error).toMatchObject({ code: "not_allowed", message: expect.stringContaining("项目「资讯站」已停用") });

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "reactivate" }, "reactivate"));
    const back = await jobWhere(frontend, (e) => e.change === "resumed" && e.job.id === "j-1", "重新启用时恢复简报");
    expect(back.job).toMatchObject({ state: "active", nextAt: nowIso(at(10, 10, 9, 0)) });
    expect(back.job.pausedBy).toBeUndefined();
    expect(td.daemon.scheduledJobs.get("j-2")).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(jobsOf(frontend).filter((e) => e.job.id === "j-2" && e.change === "resumed")).toEqual([]);

    // 归档：运营中的简报暂停，暂停着的周报不动
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "archive"));
    const archived = await jobWhere(frontend, (e) => e.change === "paused" && e.job.pausedBy === "project_archived", "归档时暂停简报");
    expect(archived).toMatchObject({ by: "system", job: { id: "j-1", state: "paused" } });
    expect(td.daemon.scheduledJobs.get("j-2")).toMatchObject({ state: "paused", pausedBy: "user" });
    const refusedArchived = await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" });
    expect(refusedArchived.ok ? undefined : refusedArchived.error).toMatchObject({ code: "not_allowed", message: expect.stringContaining("项目「资讯站」已归档") });
    // 取消归档：回到使用中，因归档而暂停的恢复
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "unarchive"));
    await waitUntil(() => jobsOf(frontend).filter((e) => e.change === "resumed" && e.job.id === "j-1").length === 2, { timeoutMs: 30_000, describe: () => "等取消归档时恢复简报" });
    expect(td.daemon.scheduledJobs.get("j-1")).toMatchObject({ state: "active", nextAt: nowIso(at(10, 10, 9, 0)) });
    expect(td.daemon.scheduledJobs.get("j-2")).toMatchObject({ state: "paused", pausedBy: "user" });

    // 取消也不改项目状态：项目列表频道上只有种下的、停用、重新启用、归档、取消归档
    ok(await frontend.scheduledJobAction({ jobId: "j-2", action: "cancel" }));
    await jobWhere(frontend, (e) => e.change === "cancelled" && e.job.id === "j-2", "取消周报");
    const projectChanges = frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => (f.payload as ProjectEventPayload).change);
    expect(projectChanges).toEqual(["created", "retired", "reactivated", "archived", "unarchived"]);
    expect(td.daemon.projects.get("p-1")!.state).toBe("in_use");
    expect(td.daemon.scheduledJobs.ofProject("p-1").map((j) => `${j.id}:${j.state}`)).toEqual(["j-1:active", "j-2:cancelled"]);
  }, 120_000);
});

const remindersOf = (store: { read(channel: string, after: number, type?: string): Array<{ payload: unknown }> }) =>
  store.read(BOARD, 0, EVENT_TYPES.reminder).map((e) => e.payload as ReminderEventPayload);
const jobEventsOf = (store: { read(channel: string, after: number, type?: string): Array<{ payload: unknown }> }) =>
  store.read(BOARD, 0, EVENT_TYPES.scheduledJob).map((e) => e.payload as ScheduledJobEventPayload);

/** 错过的触发：任务的 agent 每次补出简报 */
function catchUpMaintainer(id: string): FauxStep[] {
  return id === "tm-1" ? [say("补出了今天的简报")] : [say("好")];
}

/** 被打断的运行：任务的 agent 第一次唤起时慢慢说一大段（守护进程在它说到一半时停下） */
function slowMaintainer(id: string, n: number): FauxStep[] {
  if (id === "tm-1") return n === 1 ? [say("我先慢慢想一想今天的简报该怎么写，".repeat(20))] : [say("简报写好了")];
  return [say("好")];
}

describe("错过的触发", () => {
  it("停机期间错过的：晚了 60 分钟以内的提醒照发并标明晚了多久，更晚的不发通知、改放一条错过的提醒（重复的错过多次只按最近一次）；定时触发的任务不管错过几次只补跑一次；错过的当晚备份开机后补做一次；补完再重启不再补", async () => {
    const d = dirs();
    const maintainer = catchUpMaintainer;
    const first = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
    const frontend = await connect(first);
    await timedTask(frontend);
    await jobWhere(frontend, (e) => e.change === "registered", "登记");
    // 一次性的提醒（10-10 09:00）和每天 07:00 的提醒
    first.daemon.reminders.create({ text: "交报告", schedule: { kind: "once", at: nowIso(at(10, 10, 9, 0)) } }, "agent");
    first.daemon.reminders.create({ text: "吃药", schedule: { kind: "daily", time: "07:00" } }, "agent");
    await frontend.close();
    await first.daemon.stop();

    // 停到 10-10 09:20 才起来：错过了 10-08、10-09、10-10 三次；交报告晚了 20 分钟；吃药错过了 10-09、10-10 两次，最近一次晚了 2 小时 20 分钟；
    // 10-09、10-10 两晚的备份都错过了
    const second = await startTestDaemon({ clock: new ManualClock(at(10, 10, 9, 20)), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
    const again = await connect(second);
    const caught = await jobWhere(again, (e) => e.change === "triggered", "补跑");
    expect(caught.run).toMatchObject({ trigger: "catch_up", missed: 3, dueAt: nowIso(at(10, 10, 9, 0)), state: "queued" });
    expect(caught.job.nextAt).toBe(nowIso(at(10, 11, 9, 0)));
    await jobWhere(again, (e) => e.change === "run_finished" && e.run?.state === "done", "补跑做完");
    await settled(second, "tm-1");
    expect(jobsOf(again).filter((e) => e.change === "triggered")).toHaveLength(1);

    const fired = await eventually(() => inboxOf(again), (i) => i.kind === "notice" && i.notice === "reminder_due", "晚到的提醒");
    expect(fired.kind === "notice" && fired.body).toContain("晚了 20 分钟");
    const missed = await eventually(() => inboxOf(again), (i) => i.kind === "notice" && i.notice === "missed_reminder", "错过的提醒");
    expect(missed).toMatchObject({ title: "错过的提醒：吃药", pinned: false });
    expect(missed.kind === "notice" && missed.body).toContain("10 月 10 日（周六）07:00 的提醒没有按时响");
    expect(inboxOf(again).filter((i) => i.kind === "notice" && i.notice === "missed_reminder")).toHaveLength(1);
    expect(remindersOf(second.daemon.store).filter((r) => r.change === "fired" || r.change === "missed").map((r) => `${r.reminder.id}:${r.change}:${r.lateMinutes ?? ""}`)).toEqual([
      "r-1:fired:20",
      "r-2:missed:140",
    ]);
    await second.daemon.internalJobs.whenIdle();
    expect(second.daemon.internalJobs.state("backup")).toMatchObject({ lastRunAt: nowIso(at(10, 10, 9, 20)) });
    // 录下来给前端回放：待我处理里的"错过的提醒"、补跑的运行记录
    saveOrCheckRecording("missed-triggers", again.recording, { perChannel: true });
    await again.close();
    await second.daemon.stop();

    // 补完再重启：不再补发提醒、不再补跑和补做备份
    const third = await startTestDaemon({ clock: new ManualClock(at(10, 10, 9, 25)), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
    await connect(third);
    await new Promise((r) => setTimeout(r, 500));
    await third.daemon.internalJobs.whenIdle();
    expect(jobEventsOf(third.daemon.store).filter((e) => e.change === "triggered")).toHaveLength(1);
    expect(remindersOf(third.daemon.store).filter((r) => r.change === "fired" || r.change === "missed")).toHaveLength(2);
    expect(third.daemon.internalJobs.state("backup")).toMatchObject({ lastRunAt: nowIso(at(10, 10, 9, 20)) });
    expect(third.daemon.inbox.list().filter((i) => i.kind === "notice" && (i.notice === "missed_reminder" || i.notice === "reminder_due"))).toHaveLength(2);
  }, 120_000);

  it("守护进程停的时候一次运行正做到一半：重启后这次运行记为中断，不重做、不算进连续失败；之后照常按时间表运行", async () => {
    const d = dirs();
    const maintainer = slowMaintainer;
    const clock = new ManualClock(START);
    const first = await startTestDaemon({ clock, reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer, maintainerTokensPerSecond: 20 });
    const frontend = await connect(first, [BOARD, CARDS, TM1]);
    await timedTask(frontend);
    await jobWhere(frontend, (e) => e.change === "registered", "登记");
    clock.advanceTo(at(10, 8, 9, 0));
    await eventually(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnStart }), () => true, "任务的 agent 开始做");
    // 正在运行的也算忙（报给 LSM：等空闲再停会等它做完）
    expect(daemonBusy(first.daemon.tasks, first.daemon.store.reader)).toMatchObject({ busy: true, reason: expect.stringContaining("1 个定时触发的任务正在运行：「每天早上出简报」") });
    await frontend.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ clock: new ManualClock(at(10, 8, 9, 5)), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer });
    const again = await connect(second);
    const interrupted = await jobWhere(again, (e) => e.change === "run_finished", "被打断的运行结束");
    expect(interrupted.run).toMatchObject({ runId: "j-1-r1", state: "interrupted", reason: expect.stringContaining("被打断") });
    // 不算进连续失败：几次重启不会把它自动暂停
    expect(interrupted.job).toMatchObject({ state: "active", lastFailed: false, consecutiveFailures: 0, nextAt: nowIso(at(10, 9, 9, 0)) });
    // 没有补跑（10-08 09:00 那次已经开始跑了，只是被打断）：补发的事件里只有停机前那一次到点
    expect(jobsOf(again).filter((e) => e.change === "triggered").map((e) => e.run!.runId)).toEqual(["j-1-r1"]);
  }, 120_000);
});

describe("归档清单", () => {
  it("每周一次把结束超过 7 天、还没归档的任务汇总成一张归档清单放进待我处理：选归档的变为已归档；继续改的已完成任务走返工（要求返工的素材事件照常产生）、失败的走重试，回到执行中；已取消的只能归档或先留着；先留着的不变；每项都选了清单算处理完", async () => {
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      clock,
      maintainer: (id, n) => {
        if (n === 1) return [submitPlanStep(onePlan()), say("计划交上去了")];
        // 订机票做不下去；别的宣布完成，等你验收
        if (id === "tm-3") return [call("fail_task", { reason: "航司页面改版，抓不到价格" }), say("失败了"), say("重试中")];
        return [call("complete_stage", { stageId: "s1", summary: "做完了" }), say("做完了，等你验收"), say("好，接着改")];
      },
    });
    const frontend = await connect(td);
    const titles = ["整理发票", "写周报", "订机票", "搬家清单"];
    for (const title of titles) {
      const task = td.daemon.tasks.createByRequest({ title, summary: title });
      td.daemon.tasks.writeBrief(task.id, { goal: title, acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
      const card = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
      await settled(td, `tm-${task.id.slice(2)}`);
      ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
      await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "started", `${task.id} 开始执行`);
      // 一个一个来：录下来的事件流里各个维护者不同时干活
      await settled(td, `tm-${task.id.slice(2)}`);
    }
    // 整理发票、写周报：验收通过、完成；订机票：失败；搬家清单：取消
    for (const taskId of ["t-1", "t-2"]) {
      await eventually(() => tasksOf(frontend), (e) => e.task.id === taskId && e.task.stages?.list?.[0]?.waitReason === "acceptance", `${taskId} 等验收`);
      ok(await frontend.taskAction({ taskId, action: "accept_stage", stageId: "s1" }));
      await eventually(() => tasksOf(frontend), (e) => e.task.id === taskId && e.change === "completed", `${taskId} 完成`);
      await settled(td, `tm-${taskId.slice(2)}`);
    }
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-3" && e.change === "failed", "t-3 失败");
    ok(await frontend.taskAction({ taskId: "t-4", action: "cancel" }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-4" && e.change === "cancelled", "t-4 取消");
    await settled(td, "tm-1", "tm-2", "tm-3", "tm-4");

    // 下周一 09:00：结束才 4 天，不出清单
    clock.advanceTo(at(10, 12, 9, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(cardsOf(frontend).filter((c) => c.type === "archive_list")).toEqual([]);
    // 再下周一：结束超过 7 天，出一张清单（不卡任务）
    clock.advanceTo(at(10, 19, 9, 0));
    await td.daemon.internalJobs.whenIdle();
    const list = await eventually(() => cardsOf(frontend), (c) => c.type === "archive_list", "归档清单");
    const payload = list.payload as ArchiveListCardPayload;
    expect(payload.items.map((i) => `${i.taskId}:${i.state}:${i.choices.join("/")}`)).toEqual([
      "t-1:done:archive/continue/keep",
      "t-2:done:archive/continue/keep",
      "t-3:failed:archive/continue/keep",
      "t-4:cancelled:archive/keep",
    ]);
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === list.id, "清单的待我处理事项");
    expect(item).toMatchObject({ title: "归档清单：4 个任务结束超过 7 天", urgency: "non_blocking", source: "系统" });

    const decide = async (taskId: string, choice: string) => {
      const card = cardsOf(frontend).filter((c) => c.id === list.id).at(-1)!;
      return frontend.cardAction({ cardId: list.id, action: "decide", expectedVersion: card.version, input: { taskId, choice } });
    };
    const versionAfter = (n: number) => eventually(() => cardsOf(frontend), (c) => c.id === list.id && c.version === n, `清单第 ${n} 版`);

    // 归档：任务变为已归档（看板的已归档分组）
    ok(await decide("t-1", "archive"));
    const archived = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.change === "archived", "t-1 归档");
    expect(archived).toMatchObject({ by: "user", from: "done", task: { state: "archived" } });
    await versionAfter(2);
    // 已完成的继续改：返工（从最后一个阶段重开），回到执行中；要求返工的素材事件照常产生
    ok(await decide("t-2", "continue"));
    const rework = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2" && e.change === "rework", "t-2 返工");
    expect(rework.task.state).toBe("running");
    expect(td.daemon.store.read(TASKS_CHANNEL, 0, EVENT_TYPES.outputReaction).map((e) => e.payload as { taskId: string; reaction: string })).toContainEqual(
      expect.objectContaining({ taskId: "t-2", reaction: "rework" }),
    );
    await versionAfter(3);
    await settled(td, "tm-2");
    // 失败的继续改：重试
    ok(await decide("t-3", "continue"));
    const retried = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-3" && e.change === "retried", "t-3 重试");
    expect(retried.task.state).toBe("running");
    await versionAfter(4);
    await settled(td, "tm-3");
    // 已取消的不能继续改；先留着：任务不变
    const refused = await decide("t-4", "continue");
    expect(refused.ok ? undefined : refused.error.code).toBe("not_allowed");
    ok(await decide("t-4", "keep"));
    const handled = await versionAfter(5);
    expect(handled.status).toBe("handled");
    expect((handled.payload as ArchiveListCardPayload).items.map((i) => i.decision)).toEqual(["archive", "continue", "continue", "keep"]);
    expect(td.daemon.tasks.get("t-4")!.state).toBe("cancelled");
    // 录下来给前端回放：待我处理里的归档清单、看板的已归档分组
    saveOrCheckRecording("archive-list", frontend.recording, { perChannel: true });
  }, 180_000);
});
