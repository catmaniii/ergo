// 主切面：任务执行与阶段验收（规格第 8 节，13 号票）。真的守护进程，维护者、评审子 agent 都接 faux 剧本，测试扮演前端。
// 任务直接经任务服务建出、写好任务书（秘书那一段在 tasks.test.ts 测过），维护者交计划，用户在计划卡上确认；之后：
// - 全局执行名额（tasks.maxRunning）：多出的排队，等我、已暂停的不占名额，恢复执行时满了回到排队中；
// - 阶段：控制器开始第一个能开始的阶段，维护者"宣布阶段完成"后跑验收（脚本、评审子 agent、由我验收），
//   全部验收后任务自动完成；返工只重开指定阶段和它的下游；
// - 一支在等用户（审批挂起、交给我做、由我验收）时别的阶段接着推进，都在等时任务转等我；
// - 维护者每次唤起、每次压缩之后看到重注入块；用户在任务详情里说的话唤起它或作为插话；
// - 任务完成后的回调接到项目模块：项目的首个建设任务（15 号票）完成时项目自动进入使用中（只验接口衔接，端到端归 16 号票）；
// - 关注类别和用户的限制（26 号票）走真实执行路径：用户的限制编译出的规则拦下执行中的调用，计划卡上给一个任务加的类别只影响它；
// - 阶段开始过就能从它重做（84 号票，照 AgentSense 的里程碑重开）：先停稳维护者手头这一轮再重置，这一阶段和下游回到未开始，
//   会话里一条重做记录，维护者接着做；重做前列出这一段已经做了的事（本机、对外），不撤回；卡着的验收、审批、计划变更随之作废，
//   旧按钮点了回"已经重做过"；暂停的仍暂停，名额满了回到排队中（看板上照样是一条重做）；验收途中重做的，旧的结论作废。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type Plan,
  type PlanCardPayload,
  type ProgressCardPayload,
  type ResponseFrame,
  type Task,
  type TaskEventPayload,
  type TaskStageView,
  type TimelineRecordEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const write = (file: string, content: string) => call("write", { path: file, content });
const completeStage = (stageId: string, summary = `阶段 ${stageId} 做完了`) => call("complete_stage", { stageId, summary });
/** 评审子 agent：读一眼交付件，交出结论 */
const review = (file: string, passed = true, reason = "看过了，满足"): FauxStep[] => [
  call("read", { path: file }),
  call("submit_review", { results: [{ index: 1, passed, reason }] }),
  say("评审完了"),
];

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
/** 每张卡的最新样子 */
const latestCards = (frontend: TestFrontend): Card[] => [...new Map(cardsOf(frontend).map((c) => [c.id, c])).values()];
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const itemWhere = (frontend: TestFrontend, match: (item: InboxItem) => boolean, what = "待我处理事项") => eventually(() => inboxOf(frontend), match, what);
/** 等某个维护者处理完 n 条输入 */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 只有两个阶段：s1 收集资料（脚本验收），s2 写报告（评审验收，在 s1 之后）；不涉及授权 */
function twoStagePlan(overrides: Partial<Plan> = {}): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "收集资料",
        deliverables: ["资料清单 sources.md"],
        acceptance: [{ criterion: "资料清单存在", method: "script", script: "test -f sources.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
      {
        stageId: "s2",
        title: "写报告",
        deliverables: ["调研报告 report.md"],
        acceptance: [{ criterion: "报告结构完整、结论有来源", method: "review" }],
        mode: "open",
        dependsOn: ["s1"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    stops: { count: 0, where: [] },
    ...overrides,
  };
}

const brief = { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" };

/** 连上前端，订阅看板、卡片、待我处理和前几个维护者的会话 */
async function connect(url: string, maintainers = 1) {
  const frontend = await TestFrontend.connect(url);
  const channels = [BOARD, CARDS, INBOX, ...Array.from({ length: maintainers }, (_, i) => maintainerChannel(`tm-${i + 1}`))];
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 建一个任务、写好任务书（可以另给约束），等维护者起草并交出计划；返回任务 id 和计划卡 */
async function draftTask(td: TestDaemon, frontend: TestFrontend, title: string, constraints: string[] = []): Promise<{ taskId: string; card: Card }> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, { ...brief, constraints });
  const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
  return { taskId: task.id, card };
}

/** 在计划卡上确认 */
async function confirmPlan(frontend: TestFrontend, draft: { taskId: string; card: Card }): Promise<string> {
  ok(await frontend.cardAction({ cardId: draft.card.id, action: "confirm", expectedVersion: 1, input: {} }));
  return draft.taskId;
}

/** 建一个任务、写好任务书（维护者起草并交出计划），在计划卡上确认；返回任务 id */
async function confirmTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<string> {
  return confirmPlan(frontend, await draftTask(td, frontend, title));
}

/** 维护者的剧本：第一次唤起起草计划，之后（按计划装配重新拉起）照 run 执行 */
const maintainerScript =
  (plan: Plan, run: FauxStep[] | ((maintainerId: string) => FauxStep[])) =>
  (maintainerId: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : typeof run === "function" ? run(maintainerId) : run;

/** bash 里的路径用正斜杠 */
const fwd = (p: string) => p.replaceAll("\\", "/");
const stageStates = (task: Task) => Object.fromEntries((task.stages?.list ?? []).map((s) => [s.stageId, s.state]));
const findStage = (task: Task, stageId: string) => task.stages?.list?.find((s) => s.stageId === stageId);

describe("演示流程（录给前端回放）", () => {
  it("两阶段任务：第一阶段脚本验收通过，第二阶段评审判定通过，任务自动完成；再要求返工第二阶段，只有它被重开，同一个维护者接着做完", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [
        // 开始执行：第一阶段
        write("sources.md", "- 来源一\n- 来源二\n"),
        completeStage("s1", "资料清单在 sources.md"),
        // 第一阶段验收通过，接着第二阶段
        write("report.md", "# X 的调研\n结论（来源：sources.md）\n"),
        completeStage("s2", "报告在 report.md"),
        say("两个阶段都做完了"),
        // 返工第二阶段：局部修改（整个覆盖要先备份，v1 的时序规则）
        call("edit", { path: "report.md", edits: [{ oldText: "结论（来源：sources.md）", newText: "## 结论\n补上了对比（来源：sources.md）" }] }),
        completeStage("s2", "按意见补了对比"),
        say("返工做完了"),
      ]),
      reviewer: () => review("report.md"),
    });
    const frontend = await connect(td.url);
    // 维护者交完计划、这一轮结束后再确认（录下的事件流每次一样）
    const draft = await draftTask(td, frontend, "X 的调研");
    await turnsOf(frontend, M1, 1);
    const taskId = await confirmPlan(frontend, draft);

    // 确认后排队，有名额马上开始执行：第一阶段开始，维护者被唤起
    await taskWhere(frontend, (e) => e.change === "started");
    const done = await taskWhere(frontend, (e) => e.change === "completed", "任务自动完成");
    expect(done).toMatchObject({ from: "running", by: "system", task: { state: "done", stages: { total: 2, current: 2 } } });
    expect(done.task.stages?.list).toMatchObject([
      { stageId: "s1", state: "accepted", attempts: 1, acceptance: [{ method: "script", result: { passed: true } }] },
      { stageId: "s2", state: "accepted", attempts: 1, acceptance: [{ method: "review", result: { passed: true, note: "看过了，满足" } }] },
    ]);
    // 每个阶段的验收结论是一张进度卡，评审的那张标"评审判定"
    const verdicts = cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).kind === "acceptance");
    // 卡上带着这次交上来时维护者写的那句（84 号票：尝试记录的备注）
    expect(verdicts.map((c) => (c.payload as ProgressCardPayload).acceptance)).toEqual([
      { passed: true, judgedBy: "script", results: [expect.objectContaining({ criterion: "资料清单存在", method: "script", passed: true })], summary: "资料清单在 sources.md" },
      { passed: true, judgedBy: "review", results: [{ criterion: "报告结构完整、结论有来源", method: "review", passed: true, note: "看过了，满足" }], summary: "报告在 report.md" },
    ]);
    expect(td.daemon.cards.get(verdicts[1]!.id)).toMatchObject({ text: expect.stringContaining("评审判定") });
    await turnsOf(frontend, M1, 2);

    // 返工第二阶段：只有它（和它的下游，这里没有）被重开，第一阶段保持已验收
    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s2", note: "缺一段方案对比" }));
    const rework = await taskWhere(frontend, (e) => e.change === "rework");
    expect(rework).toMatchObject({ from: "done", by: "user", stageId: "s2", reopened: ["s2"], task: { state: "running" } });
    expect(stageStates(rework.task)).toEqual({ s1: "accepted", s2: "pending" });
    const again = await eventually(() => tasksOf(frontend).slice(tasksOf(frontend).indexOf(rework)), (e) => e.change === "completed", "返工后再次完成");
    expect(again.task.stages?.list?.[1]).toMatchObject({ stageId: "s2", state: "accepted", attempts: 2 });
    expect(again.task.stages?.list?.[0]).toMatchObject({ stageId: "s1", state: "accepted", attempts: 1 });
    await turnsOf(frontend, M1, 3);
    expect(textOf(messagesOf(frontend, M1).find((m) => m.agentInput && textOf(m).startsWith("用户从阶段 s2"))!)).toContain("缺一段方案对比");
    expect(fs.readFileSync(path.join(td.daemon.layout.outputs, taskId, "report.md"), "utf8")).toContain("补上了对比");
    saveOrCheckRecording("task-execution", frontend.recording, { perChannel: true });
  }, 90_000);
});

/** 本机起一个只回 ok 的 HTTP 服务（测试"对外"的效果：维护者用 curl 往它发 POST），记下收到过几次 */
async function localHook(): Promise<{ url: string; posts: () => number; close(): Promise<void> }> {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++;
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, posts: () => posts, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 阶段详情从守护进程现取的（84 号票） */
async function stageView(td: TestDaemon, taskId: string, stageId: string): Promise<TaskStageView> {
  const res = await fetch(`${td.url}${HTTP_PATHS.taskStage(taskId, stageId)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as TaskStageView;
}

const recordsOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload);

describe("执行中从某个阶段重做（84 号票）", () => {
  it("维护者正在做 s2 时从 s1 重做：先停掉这一轮，s1、s2 回到未开始、验收结果清掉，会话里一条重做记录，维护者接着从 s1 做；重做前取得到这一段已经做了的事（本机、对外分开）和授权用了几次，都告诉维护者，不撤回", async () => {
    const hook = await localHook();
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const notes = path.join(fs.realpathSync.native(homeDir), "notes");
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [
        {
          ...base.stages[0]!,
          policy: {
            grants: [
              { id: "notes", tool: "make_dir", title: "在主目录建 notes 目录", scope: { path: notes }, maxUses: 3 },
              { id: "hook", tool: "http_request", title: "往本机的 hook 发请求", scope: {}, maxUses: 2 },
            ],
            temporalRules: [],
          },
        },
        base.stages[1]!,
      ],
    };
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(plan, [
        // s1：本机建目录（授权内）、往外发一次（授权内）、写交付件
        call("bash", { command: `mkdir -p "${fwd(notes)}"` }),
        call("bash", { command: `curl -X POST ${hook.url} -d "hello"` }),
        write("sources.md", "- 来源一\n"),
        completeStage("s1", "资料清单在 sources.md"),
        // s2：做到一半（你在这时从 s1 重做，这一轮被停掉）
        call("bash", { command: "sleep 20" }),
        // 收到重做的通知：从 s1 接着做（这一轮新做的事算进这一轮）
        write("sources2.md", "- 来源二\n"),
        completeStage("s1", "又核了一遍来源"),
        write("report.md", "# X 的调研\n结论（来源：sources.md）\n"),
        completeStage("s2", "报告在 report.md"),
        say("重做完了"),
      ]),
      reviewer: () => review("report.md"),
    });
    try {
      const frontend = await connect(td.url);
      const taskId = await confirmTask(td, frontend, "X 的调研");
      await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "开始 s2");
      await new Promise((r) => setTimeout(r, 1500));

      // 重做之前：从 s1 重做会重开 s1、s2（s2 开始过），这一段已经做了三件事——本机两件、对外一件；s1 的两项授权各用了一次
      const view = await stageView(td, taskId, "s1");
      expect(view.reopenScope).toEqual(["s1", "s2"]);
      expect(view.effects.map((e) => [e.stageId, e.tool, e.reach])).toEqual([
        ["s1", "make_dir", "local"],
        ["s1", "http_request", "external"],
        ["s1", "write", "local"],
      ]);
      expect(view.effects[1]!.argsSummary).toContain(hook.url);
      expect(view.grantUses).toEqual([
        { grantId: "notes", used: 1 },
        { grantId: "hook", used: 1 },
      ]);
      expect(hook.posts()).toBe(1);

      // 维护者正在做 s2 时，会话里还排着一条重做之前的运行时通知（s2 的）：重做后作废出队，不再交给它（照 AgentSense 的 generation）
      const stale = buildAgentNotice(M1, "（重做之前的通知）阶段 s2 的那次调用已获批准，可以重试", "test-stale-notice", { taskId, stageId: "s2" });
      td.daemon.store.append(stale.event);

      // 维护者正在做 s2：从 s1 重做（写了这次要怎么改）
      const started = Date.now();
      ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1", note: "换个来源再核一遍" }));
      // 这一轮真的停下了才回（没等到停稳的 10 秒时限）
      expect(Date.now() - started).toBeLessThan(8_000);
      const rework = await taskWhere(frontend, (e) => e.change === "rework");
      expect(rework).toMatchObject({ from: "running", by: "user", stageId: "s1", reopened: ["s1", "s2"], task: { state: "running" } });
      expect(stageStates(rework.task)).toEqual({ s1: "pending", s2: "pending" });
      // 任务第 1 次重做：开始过的阶段记下是第几次重做时重开的（效果日志按判定时的重做次数分轮），上次没过的标准（这里没有）
      expect(rework.task.reworks).toBe(1);
      expect(rework.task.stages?.list?.[0]).toMatchObject({ acceptance: [{ criterion: "资料清单存在", method: "script" }], reopenNo: 1, lastFailed: [] });
      expect(rework.task.stages?.list?.[0]!.acceptance[0]!.result).toBeUndefined();
      // 手头这一轮被停掉（不等 sleep 20 跑完），s1 重新开始
      await waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).some((f) => (f.payload as { outcome?: string }).outcome === "aborted"), {
        timeoutMs: 15_000,
        describe: () => "维护者这一轮被停掉",
      });
      expect(Date.now() - started).toBeLessThan(15_000);
      // 先停稳再重置（照 AgentSense 的 abort + waitForIdle 再 reopen）：这一轮结束的事件在重做的事件之前落盘
      const abortedAt = td.daemon.store.read(M1).find((e) => e.type === EVENT_TYPES.turnEnd && (e.payload as { outcome?: string }).outcome === "aborted")!.globalSeq;
      const reworkAt = td.daemon.store.read(BOARD).find((e) => e.type === EVENT_TYPES.task && (e.payload as TaskEventPayload).change === "rework")!.globalSeq;
      expect(abortedAt).toBeLessThan(reworkAt);
      const restarted = await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rework), "重新开始 s1");
      expect(restarted.task.state).toBe("running");
      // 排着的旧通知随重做作废出队（没开始处理就结束），维护者下一条处理的是重做的交代
      const staleEnd = td.daemon.store.read(M1).find((e) => e.type === EVENT_TYPES.turnEnd && (e.payload as { inputMessageId: string }).inputMessageId === stale.message.id)!;
      expect(staleEnd.payload).toMatchObject({ outcome: "aborted" });
      expect(staleEnd.globalSeq).toBeGreaterThan(abortedAt);
      expect(td.daemon.store.read(M1).some((e) => e.type === EVENT_TYPES.turnStart && (e.payload as { inputMessageId: string }).inputMessageId === stale.message.id)).toBe(false);

      // 会话里一条重做记录（落在 s1）：照 AgentSense 的说法；交给维护者的那句它替着说清楚了（界面上不重复显示）
      const record = recordsOf(frontend, M1).find((r) => r.record.kind === "reopen")!;
      expect(record).toMatchObject({ taskId, stageId: "s1", record: { summary: "你从「收集资料」重做（连带后面的 「写报告」）。你说：「换个来源再核一遍」" } });
      const notice = messagesOf(frontend, M1).find((m) => m.message.id === record.record.noticeId)!;
      expect(notice).toMatchObject({ agentInput: true, taskId });
      const nextStarted = td.daemon.store.read(M1).filter((e) => e.type === EVENT_TYPES.turnStart && e.globalSeq > reworkAt)[0]!;
      expect(nextStarted.payload).toMatchObject({ inputMessageId: notice.message.id });
      const told = textOf(notice);
      expect(told).toContain("换个来源再核一遍");
      expect(told).toContain("重开了 s1、s2");
      // 这一段已经做了的事：不撤回，分本机、对外告诉维护者
      expect(told).toMatch(/本机 2 件/);
      expect(told).toMatch(/对外 1 件/);
      expect(told).toContain("不要再做一遍");
      // 之前那一次的尝试记录开始阶段时给它（照 AgentSense 认领时的交代）：交过几次、最近一次没通过的标准
      expect(told).toContain("之前那一次的尝试记录开始阶段时会给你");
      expect(told).toContain("这个阶段之前做过 1 次，最近一次没通过的标准：（无）");

      // 接着做完：不撤回（目录还在，hook 只收到过一次）
      const done = await taskWhere(frontend, (e) => e.change === "completed", "重做后完成");
      expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
      expect(done.task.stages?.list?.[0]).toMatchObject({ attempts: 2 });
      expect(fs.existsSync(notes)).toBe(true);
      expect(hook.posts()).toBe(1);
      // 尝试记录的备注：每次交上来时维护者写的那句记在结论卡上
      const verdicts = cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).kind === "acceptance");
      expect(verdicts.map((c) => [(c.payload as ProgressCardPayload).stageId, (c.payload as ProgressCardPayload).acceptance?.summary])).toEqual([
        ["s1", "资料清单在 sources.md"],
        ["s1", "又核了一遍来源"],
        ["s2", "报告在 report.md"],
      ]);
      // 重做之后再取：只列这一轮的事（之前那一轮做的不再列，这一轮新写的 sources2.md 列上）；授权用了几次照旧累计（不撤回就不退还）
      const after = await stageView(td, taskId, "s1");
      expect(after.effects.filter((e) => e.stageId === "s1").map((e) => [e.tool, e.reach])).toEqual([["write", "local"]]);
      expect(after.effects[0]!.argsSummary).toContain("sources2.md");
      expect(after.grantUses).toEqual([
        { grantId: "notes", used: 1 },
        { grantId: "hook", used: 1 },
      ]);
      // 用户对产出的反应（素材）照旧：重开了哪几个
      await waitUntil(() => td.daemon.materials.list({ kind: "output_reaction" }).length > 0, { timeoutMs: 10_000, describe: () => "重做的素材" });
      expect(td.daemon.materials.list({ kind: "output_reaction" })[0]!.context).toEqual(["reaction:rework", "stage:s1", "reopened:s1", "reopened:s2"]);
    } finally {
      await hook.close();
    }
  }, 120_000);

  it("等你验收时从前面的阶段重做：在等的那一支一起回到未开始，待办里等你验收的那条作废（再点回“已经重做过”），任务接着执行；暂停着的任务重做后仍暂停", async () => {
    const plan = twoStagePlan();
    const td = await startTestDaemon({
      maintainer: maintainerScript(
        { ...plan, stages: [plan.stages[0]!, { ...plan.stages[1]!, acceptance: [{ criterion: "报告你看过", method: "user" }] }] },
        [
          write("sources.md", "- 来源\n"),
          completeStage("s1"),
          write("report.md", "# 报告\n"),
          completeStage("s2"),
          say("等你验收"),
          // 从 s1 重做
          completeStage("s1", "重核了来源"),
          completeStage("s2", "报告没变"),
          say("又等你验收"),
          say("好"),
          say("好"),
          say("好"),
        ],
      ),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    const notice = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stage_acceptance");
    await taskWhere(frontend, (e) => e.change === "waiting");
    await turnsOf(frontend, M1, 2);

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1" }));
    const rework = await taskWhere(frontend, (e) => e.change === "rework");
    expect(rework).toMatchObject({ from: "waiting_for_user", reopened: ["s1", "s2"], task: { state: "running", reworks: 1 } });
    expect(rework.task.stages?.list?.[1]).toMatchObject({ state: "pending" });
    expect(rework.task.stages?.list?.[1]!.waitReason).toBeUndefined();
    // 待办里等你验收的那条作废（用户 2026-10-11 定：不只是不卡着）：记成处理过，再点旧按钮回"已经重做过"，不会验收新的一轮
    expect(await itemWhere(frontend, (i) => i.id === notice.id && i.version > notice.version)).toMatchObject({ urgency: "non_blocking", handled: "已作废", handledNote: "已经重做过，这一条作废了" });
    expect(await frontend.inboxAction({ itemIds: [notice.id], action: "handle", choice: "验收通过" })).toMatchObject({ ok: false, error: { code: "conflict", message: "已经重做过，这一条作废了" } });
    const again = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stage_acceptance" && i.id !== notice.id, "重做后又等你验收");
    expect(again.urgency).toBe("blocking");
    await taskWhere(frontend, (e) => e.change === "waiting" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rework), "重做后又转等我");
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[1]).toMatchObject({ state: "waiting", waitReason: "acceptance", waitingOn: again.id });
    await turnsOf(frontend, M1, 3);

    // 暂停着的任务也能重做（照 AgentSense 开始过就能，用户 2026-10-11 定）：重做后仍暂停，第二次等你验收的那条一样作废
    ok(await frontend.taskAction({ taskId, action: "pause" }));
    await taskWhere(frontend, (e) => e.change === "paused");
    expect(ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s2", note: "标题改一下" }))).toEqual({ taskId, state: "paused" });
    const paused = await taskWhere(frontend, (e) => e.change === "rework" && e.from === "paused");
    expect(paused).toMatchObject({ by: "user", stageId: "s2", reopened: ["s2"], task: { state: "paused", reworks: 2 } });
    expect(stageStates(paused.task)).toEqual({ s1: "accepted", s2: "pending" });
    // 交上来的还在等你验收、没有结论：没有"上次没过的标准"
    expect(paused.task.stages?.list?.[1]).toMatchObject({ reopenNo: 2, attempts: 2 });
    expect(paused.task.stages?.list?.[1]!.lastFailed).toBeUndefined();
    expect(await itemWhere(frontend, (i) => i.id === again.id && i.version > again.version)).toMatchObject({ handled: "已作废", urgency: "non_blocking" });
    const told = messagesOf(frontend, M1).filter((m) => m.agentInput && textOf(m).startsWith("用户从阶段 s2")).map(textOf);
    expect(told.at(-1)).toContain("任务暂停着：用户继续之后再做");
    // 继续：照重做之后的样子接着做 s2
    ok(await frontend.taskAction({ taskId, action: "resume" }));
    const resumed = await taskWhere(frontend, (e) => e.change === "resumed");
    expect(resumed.task).toMatchObject({ state: "running" });
    const restarted = await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(resumed), "继续后开始 s2");
    expect(stageStates(restarted.task)).toEqual({ s1: "accepted", s2: "running" });
  }, 90_000);

  it("执行名额满时从已完成的任务的某个阶段重做：回到排队中，看板上照样是一条重做（带重开了哪几个），交给维护者的那句写明先排队", async () => {
    const td = await startTestDaemon({
      config: { tasks: { maxRunning: 1 } },
      maintainer: (maintainerId, spawn) =>
        maintainerId === "tm-2"
          ? maintainerScript(twoStagePlan(), Array.from({ length: 4 }, () => say("好的")))(maintainerId, spawn)
          : maintainerScript(twoStagePlan(), [write("sources.md", "- 来源\n"), completeStage("s1"), write("report.md", "# 报告\n"), completeStage("s2"), say("做完了"), say("好的"), say("好的")])(maintainerId, spawn),
      reviewer: () => review("report.md"),
    });
    const frontend = await connect(td.url, 2);
    const t1 = await confirmTask(td, frontend, "任务一");
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "completed", "任务一完成");
    const t2 = await confirmTask(td, frontend, "任务二");
    await taskWhere(frontend, (e) => e.task.id === t2 && e.change === "started", "任务二开始");

    expect(ok(await frontend.taskAction({ taskId: t1, action: "rework", stageId: "s2", note: "缺一段对比" }))).toEqual({ taskId: t1, state: "queued" });
    const rework = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "rework");
    expect(rework).toMatchObject({ from: "done", by: "user", stageId: "s2", reopened: ["s2"], task: { state: "queued", reworks: 1 } });
    expect(stageStates(rework.task)).toEqual({ s1: "accepted", s2: "pending" });
    // 不再记成 requeued（那样看板上没有重做记录、重开了哪几个）
    expect(tasksOf(frontend).filter((e) => e.task.id === t1 && tasksOf(frontend).indexOf(e) >= tasksOf(frontend).indexOf(rework)).map((e) => e.change)).toEqual(["rework"]);
    const told = messagesOf(frontend, M1).find((m) => m.agentInput && textOf(m).startsWith("用户从阶段 s2"))!;
    expect(textOf(told)).toContain("缺一段对比");
    expect(textOf(told)).toContain("执行名额满了，先排队");

    // 名额空出：任务一接着从 s2 做
    ok(await frontend.taskAction({ taskId: t2, action: "cancel" }));
    await taskWhere(frontend, (e) => e.task.id === t1 && e.task.state === "running" && findStage(e.task, "s2")?.state === "running", "任务一接着做 s2");
  }, 90_000);

  it("验收途中从这个阶段重做：旧的那次验收迟到的结论作废，不记到重做后新交的那一次上", async () => {
    const base = twoStagePlan();
    // 验收脚本跑起来先认是第几次（写了 second.txt 之后是第二次）、留个记号（waiting<第几次>），再等测试放行（gate<第几次>）；第二次的才算通过
    const gated = {
      criterion: "第二次交上来的",
      method: "script" as const,
      script: 'n=1; if [ -f second.txt ]; then n=2; fi; touch "waiting$n"; while [ ! -f "gate$n" ]; do sleep 0.2; done; test "$n" = 2',
    };
    const td = await startTestDaemon({
      maintainer: maintainerScript({ ...base, stages: [{ ...base.stages[0]!, acceptance: [gated] }] }, [
        write("first.txt", "1"),
        completeStage("s1", "第一次"),
        // 验收途中你从 s1 重做：这一轮被停掉，收到重做的通知后再交一次
        write("second.txt", "2"),
        completeStage("s1", "第二次"),
        say("做完了"),
        say("好"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    const dir = path.join(td.daemon.layout.outputs, taskId);
    const marked = (name: string) => waitUntil(() => fs.existsSync(path.join(dir, name)), { timeoutMs: 30_000, describe: () => `等验收脚本留下 ${name}` });
    await taskWhere(frontend, (e) => findStage(e.task, "s1")?.state === "accepting", "第一次交上来在验收");
    await marked("waiting1");

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1", note: "再核一遍" }));
    await taskWhere(frontend, (e) => findStage(e.task, "s1")?.state === "accepting" && findStage(e.task, "s1")?.attempts === 2, "重做后第二次交上来在验收");
    await marked("waiting2");
    // 第一次的验收这时才有结论（没通过）：作废，阶段还在验收第二次，没有结论卡、没有"没通过"的通知
    fs.writeFileSync(path.join(dir, "gate1"), "");
    await new Promise((r) => setTimeout(r, 2500));
    expect(findStage(td.daemon.tasks.get(taskId)!, "s1")).toMatchObject({ state: "accepting", attempts: 2 });
    const verdicts = () => cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).kind === "acceptance");
    expect(verdicts()).toEqual([]);
    // 第二次的结论照常记下
    fs.writeFileSync(path.join(dir, "gate2"), "");
    const done = await taskWhere(frontend, (e) => e.change === "completed", "第二次通过后完成");
    expect(findStage(done.task, "s1")).toMatchObject({ state: "accepted", attempts: 2 });
    expect(verdicts().map((c) => [(c.payload as ProgressCardPayload).acceptance?.passed, (c.payload as ProgressCardPayload).acceptance?.summary])).toEqual([[true, "第二次"]]);
    // 维护者这一轮（等着第二次验收的那次 complete_stage）结束了再收尾
    await turnsOf(frontend, M1, 3);
    // 两次验收的 Git Bash 刚退出时 Windows 上还短暂占着工作目录（删临时目录会 EBUSY）：稍等一下再收尾
    await new Promise((r) => setTimeout(r, 1500));
  }, 90_000);

  it("等我时重做：重开的阶段挂着的审批卡作废，旧卡上批准回“已经重做过”、维护者不会收到针对旧调用的“可以重试”；范围外的交给我做照旧", async () => {
    const td = await startTestDaemon({
      config: { approvals: { waitMinutes: 0.02 } },
      maintainer: maintainerScript(branchPlan(), [
        // s1：写 ask/ 要先问，等了一会儿没人批：挂起
        write("ask/x.txt", "x"),
        say("在等批准"),
        // s2：写 hand/ 要你亲手做
        write("hand/y.txt", "y"),
        say("都在等你了"),
        say("好，重做 s1"),
        say("好"),
      ]),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "任务一");
    watchWorkDirs(td, draft.taskId);
    const taskId = await confirmPlan(frontend, draft);
    const approvalCard = await cardWhere(frontend, (c) => c.type === "approval");
    const handOver = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "hand_over");
    await taskWhere(frontend, (e) => e.change === "waiting");
    await turnsOf(frontend, M1, 3);

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1" }));
    const rework = await taskWhere(frontend, (e) => e.change === "rework");
    expect(rework).toMatchObject({ from: "waiting_for_user", reopened: ["s1"], task: { state: "running" } });
    // 审批卡作废（过期，写明为什么）；旧卡上点批准回"已经重做过"，没有"可以重试"
    expect(await cardWhere(frontend, (c) => c.id === approvalCard.id && c.version > approvalCard.version)).toMatchObject({ status: "expired", expiredNote: "已经重做过，这张卡作废了" });
    expect(await frontend.cardAction({ cardId: approvalCard.id, action: "approve", expectedVersion: approvalCard.version + 1 })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "已经重做过，这张卡作废了" },
    });
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1" && tasksOf(frontend).indexOf(e) >= tasksOf(frontend).indexOf(rework), "重新开始 s1");
    await turnsOf(frontend, M1, 4);
    expect(messagesOf(frontend, M1).some((m) => textOf(m).includes("已获用户批准，可以重试"))).toBe(false);
    // 不在重开范围里的 s2 交给你做的那条照旧卡着
    expect(inboxOf(frontend).filter((i) => i.id === handOver.id).at(-1)).toMatchObject({ urgency: "blocking" });
    expect((inboxOf(frontend).filter((i) => i.id === handOver.id).at(-1) as { handled?: string }).handled).toBeUndefined();
  }, 90_000);

  it("等计划变更确认时重做：还没确认的计划变更作废（不算你拒绝、不进素材），在等它的阶段回到未开始，旧卡上确认回“已经重做过”", async () => {
    const outside = fs.realpathSync.native(makeTempDir("ergou-out-"));
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }], toolkit: { ...base.toolkit, network: false } };
    const widened: Plan = {
      ...plan,
      stages: plan.stages.map((s) => (s.stageId === "s1" ? { ...s, policy: { ...s.policy, grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }] } } : s)),
    };
    const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...proposal } = widened;
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [call("propose_plan_change", { plan: proposal, why: "资料要放到外面的共享目录" }), say("等你确认"), say("先做 s2"), say("好"), say("好"), say("好")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "计划变更");
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "s2 照常开始");
    expect(findStage(td.daemon.tasks.get(taskId)!, "s1")).toMatchObject({ state: "waiting", waitReason: "plan_change", waitingOn: card.id });
    await turnsOf(frontend, M1, 2);

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s2" }));
    const rework = await taskWhere(frontend, (e) => e.change === "rework");
    expect(rework).toMatchObject({ reopened: ["s2"], task: { state: "running" } });
    expect(findStage(rework.task, "s1")).toMatchObject({ state: "pending" });
    expect(findStage(rework.task, "s1")!.waitingOn).toBeUndefined();
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.version > card.version)).toMatchObject({ status: "expired", expiredNote: "已经重做过，这张卡作废了" });
    expect(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version + 1, input: {} })).toMatchObject({ ok: false, error: { code: "conflict", message: "已经重做过，这张卡作废了" } });
    // 提议记成作废（系统记的），这一版计划不再生效；现在生效的还是原来那版
    const decided = td.daemon.store.read("tasks").filter((e) => e.type === EVENT_TYPES.planDecided).at(-1)!;
    expect(decided.payload).toMatchObject({ planId: `${taskId}-p2`, decision: "voided", by: "system" });
    expect(td.daemon.tasks.plan(`${taskId}-p2`)?.status).toBe("rejected");
    expect(td.daemon.tasks.confirmedPlan(taskId)?.planId).toBe(`${taskId}-p1`);
    await turnsOf(frontend, M1, 3);
    expect(td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:plan_change"))).toEqual([]);
  }, 90_000);

  it("停稳的时限到了维护者还没停下：照样重置（这一轮作废），它结束之后维护者接着照重做的交代做", async () => {
    const td = await startTestDaemon({
      // 时限调到 1 毫秒：中止送出去了，但子进程还来不及停下
      reworkStopTimeoutMs: 1,
      maintainer: maintainerScript(twoStagePlan(), [
        write("sources.md", "- 来源一\n"),
        completeStage("s1", "资料清单在 sources.md"),
        call("bash", { command: "sleep 20" }),
        completeStage("s1", "又核了一遍来源"),
        write("report.md", "# X 的调研\n结论（来源：sources.md）\n"),
        completeStage("s2", "报告在 report.md"),
        say("重做完了"),
      ]),
      reviewer: () => review("report.md"),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "开始 s2");
    await new Promise((r) => setTimeout(r, 1500));

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1" }));
    await waitUntil(() => td.daemon.store.read(M1).some((e) => e.type === EVENT_TYPES.turnEnd && (e.payload as { outcome?: string }).outcome === "aborted"), {
      timeoutMs: 15_000,
      describe: () => "维护者那一轮结束",
    });
    // 到点没等到它停下就重置了：重做的事件在那一轮结束之前落盘
    const reworkAt = td.daemon.store.read(BOARD).find((e) => e.type === EVENT_TYPES.task && (e.payload as TaskEventPayload).change === "rework")!.globalSeq;
    const abortedAt = td.daemon.store.read(M1).find((e) => e.type === EVENT_TYPES.turnEnd && (e.payload as { outcome?: string }).outcome === "aborted")!.globalSeq;
    expect(reworkAt).toBeLessThan(abortedAt);
    // 那一轮结束后照重做的交代接着做完
    const done = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "重做后完成");
    expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
  }, 90_000);

  it("并行确认卡里有重开的阶段：随重做作废，旧卡上点同意回“已经重做过”，不会按旧提议开始已重开的阶段", async () => {
    const plan = twoStagePlan();
    const td = await startTestDaemon({
      maintainer: maintainerScript({ ...plan, stages: [plan.stages[0]!, { ...plan.stages[1]!, dependsOn: [] }] }, [
        call("propose_parallel", { reason: "两个阶段互不依赖，同时做省时间", agents: [{ stageId: "s1", instructions: "写 sources.md" }, { stageId: "s2", instructions: "写 report.md" }] }),
        say("等你确认"),
        say("好，重做 s1"),
        say("好"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    const card = await cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");
    await turnsOf(frontend, M1, 2);

    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1" }));
    await taskWhere(frontend, (e) => e.change === "rework", "重做");
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.version > card.version)).toMatchObject({ status: "expired", expiredNote: "已经重做过，这张卡作废了" });
    expect(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: card.version + 1 })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "已经重做过，这张卡作废了" },
    });
    await turnsOf(frontend, M1, 3);
    // 没有按旧提议同意并行（没有 parallel_decided），s1 照重做的交代由维护者自己做
    expect(td.daemon.store.read("sub_agents").filter((e) => e.type === EVENT_TYPES.parallelDecided)).toEqual([]);
  }, 90_000);
});

describe("全局执行名额", () => {
  it("最多 maxRunning 个任务在执行中，多出的按排队先后等着；名额空出时排在最前的开始；已暂停的不占名额，继续时名额满了回到排队中", async () => {
    const td = await startTestDaemon({
      config: { tasks: { maxRunning: 1 } },
      maintainer: maintainerScript(twoStagePlan(), Array.from({ length: 6 }, () => say("好的"))),
    });
    const frontend = await connect(td.url, 3);
    const state = (taskId: string) => td.daemon.tasks.get(taskId)?.state;
    const t1 = await confirmTask(td, frontend, "任务一");
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "started");
    const t2 = await confirmTask(td, frontend, "任务二");
    const t3 = await confirmTask(td, frontend, "任务三");
    // 名额只有一个：后两个按确认的先后排队
    expect([state(t1), state(t2), state(t3)]).toEqual(["running", "queued", "queued"]);
    expect(td.daemon.tasks.queued().map((t) => t.id)).toEqual([t2, t3]);
    // 排队中的维护者不处理输入：没被交代开始执行
    expect(messagesOf(frontend, maintainerChannel("tm-2")).some((m) => textOf(m).startsWith("计划已确认"))).toBe(false);

    // 名额空出（取消任务一）：排在最前的任务二开始，任务三接着排
    ok(await frontend.taskAction({ taskId: t1, action: "cancel" }));
    await taskWhere(frontend, (e) => e.task.id === t2 && e.change === "started");
    expect([state(t1), state(t2), state(t3)]).toEqual(["cancelled", "running", "queued"]);

    // 已暂停的不占名额：暂停任务二，任务三开始
    ok(await frontend.taskAction({ taskId: t2, action: "pause" }));
    await taskWhere(frontend, (e) => e.task.id === t3 && e.change === "started");
    expect([state(t2), state(t3)]).toEqual(["paused", "running"]);

    // 继续任务二：名额满了，回到排队中（变化一律记成 requeued）；任务三结束后它接着执行
    expect(ok(await frontend.taskAction({ taskId: t2, action: "resume" }))).toEqual({ taskId: t2, state: "queued" });
    expect(tasksOf(frontend).filter((e) => e.task.id === t2).at(-1)).toMatchObject({ change: "requeued", from: "paused", by: "user", task: { state: "queued" } });
    ok(await frontend.taskAction({ taskId: t3, action: "cancel" }));
    await waitUntil(() => state(t2) === "running", { timeoutMs: 10_000, describe: () => "任务二回到执行中" });
    expect(tasksOf(frontend).filter((e) => e.task.id === t2 && e.change === "started")).toHaveLength(2);
    // 第一次开始时交代过的阶段不重新交代；继续时排着的那条通知由它接着处理
    await turnsOf(frontend, maintainerChannel("tm-2"), 3);
    expect(messagesOf(frontend, maintainerChannel("tm-2")).filter((m) => textOf(m).startsWith("计划已确认"))).toHaveLength(1);
    expect(messagesOf(frontend, maintainerChannel("tm-2")).some((m) => textOf(m).startsWith("用户让任务继续了"))).toBe(true);
  }, 90_000);

  it("排队时暂停、没开始过就继续：从第一个阶段正常开始（建好各阶段、交代开始执行），不会直接算完成", async () => {
    const td = await startTestDaemon({
      config: { tasks: { maxRunning: 1 } },
      maintainer: maintainerScript(twoStagePlan(), Array.from({ length: 4 }, () => say("好的"))),
    });
    const completed: string[] = [];
    td.daemon.taskExecution.onCompleted(({ task }) => completed.push(task.id));
    const frontend = await connect(td.url, 2);
    const t1 = await confirmTask(td, frontend, "任务一");
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "started");
    const t2 = await confirmTask(td, frontend, "任务二");
    expect(td.daemon.tasks.get(t2)?.state).toBe("queued");
    // 排队时暂停；名额空出来也不开始（已暂停的不占名额、不排队）
    ok(await frontend.taskAction({ taskId: t2, action: "pause" }));
    ok(await frontend.taskAction({ taskId: t1, action: "cancel" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(td.daemon.tasks.get(t2)).toMatchObject({ state: "paused" });
    expect(td.daemon.tasks.get(t2)?.stages?.list).toBeUndefined();

    // 继续：有名额，建好各阶段、开始第一个阶段，交代"开始执行"（不是"继续"）
    expect(ok(await frontend.taskAction({ taskId: t2, action: "resume" }))).toEqual({ taskId: t2, state: "running" });
    const resumed = tasksOf(frontend).filter((e) => e.task.id === t2);
    expect(resumed.map((e) => e.change).slice(-2)).toEqual(["resumed", "stage_started"]);
    expect(stageStates(td.daemon.tasks.get(t2)!)).toEqual({ s1: "running", s2: "pending" });
    await turnsOf(frontend, maintainerChannel("tm-2"), 2);
    const notices = messagesOf(frontend, maintainerChannel("tm-2")).filter((m) => m.agentInput && m.message.speaker === "system").map(textOf);
    expect(notices.filter((t) => t.startsWith("计划已确认，开始执行任务"))).toHaveLength(1);
    expect(notices.some((t) => t.startsWith("用户让任务继续了"))).toBe(false);
    expect(notices.find((t) => t.startsWith("计划已确认"))).toContain("现在是第 1/2 阶段 s1「收集资料」");
    // 没有完成：任务、回调都没有
    expect(tasksOf(frontend).some((e) => e.task.id === t2 && e.change === "completed")).toBe(false);
    expect(completed).toEqual([]);
  }, 60_000);
});

/** 某个 agent 会话目录里全部会话文件的内容 */
function sessionText(td: TestDaemon, agentId: string): string {
  const dir = path.join(td.daemon.layout.sessions, agentId);
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

describe("验收不通过", () => {
  it("脚本没通过、评审判没通过：结果交回维护者，阶段不推进；改好再宣布完成，才验收通过。评审子 agent 每次是新的会话，只看到交付件和验收标准", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [
        completeStage("s1", "资料都在脑子里"),
        write("sources.md", "- 来源\n"),
        completeStage("s1", "这回写下来了"),
        write("report.md", "# 报告\n"),
        completeStage("s2", "报告在 report.md，我自己检查过了，没问题"),
        call("edit", { path: "report.md", edits: [{ oldText: "# 报告", newText: "# 报告\n## 结论（来源：sources.md）" }] }),
        completeStage("s2", "补了结论和来源"),
        say("做完了"),
      ]),
      reviewer: (reviewId) => (reviewId.endsWith("-1") ? review("report.md", false, "没有结论，也没有来源") : review("report.md")),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    const done = await taskWhere(frontend, (e) => e.change === "completed");
    expect(done.task.stages?.list).toMatchObject([
      { stageId: "s1", state: "accepted", attempts: 2 },
      { stageId: "s2", state: "accepted", attempts: 2 },
    ]);
    // 没通过的两次：阶段交回维护者（仍在做），结果写在工具结果里
    const returned = tasksOf(frontend).filter((e) => e.change === "stage_returned");
    expect(returned.map((e) => [e.stageId, e.by, e.task.stages?.list?.find((s) => s.stageId === e.stageId)?.state])).toEqual([
      ["s1", "system", "running"],
      ["s2", "system", "running"],
    ]);
    const results = toolCallsOf(frontend, M1)
      .filter((c) => c.tool === "complete_stage")
      .map((c) => c.resultSummary ?? "");
    expect(results[0]).toContain("阶段 s1 验收没通过（脚本检查）");
    expect(results[0]).toContain("退出码 1");
    expect(results[2]).toContain("阶段 s2 验收没通过（评审判定）");
    expect(results[2]).toContain("没有结论，也没有来源");
    const failedCards = cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).acceptance?.passed === false);
    expect(failedCards.map((c) => (c.payload as ProgressCardPayload).acceptance!.judgedBy)).toEqual(["script", "review"]);
    // 评审子 agent：每次一个新会话，输入只有交付件和验收标准（没有维护者的说法）
    const first = sessionText(td, `review-${taskId}-s2-1`);
    expect(first).toContain("调研报告 report.md");
    expect(first).toContain("报告结构完整、结论有来源");
    expect(first).not.toContain("我自己检查过了");
    expect(sessionText(td, `review-${taskId}-s2-2`)).not.toContain("没有结论，也没有来源");
  }, 90_000);
});

/** 国内 2027 年的节假日数据（测试替身：更新任务交付件的样子） */
const CN_2027 = {
  format: 1,
  region: "cn",
  year: 2027,
  sources: [{ title: "国务院办公厅关于2027年部分节假日安排的通知（测试替身）", url: "https://www.gov.cn/zhengce/content/test.htm" }],
  days: [
    { date: "2027-01-01", name: "元旦", kind: "holiday" },
    { date: "2027-01-09", name: "元旦调休上班", kind: "makeup_workday" },
  ],
};

describe("任务完成后的回调：节假日数据的更新任务（29 号票）", () => {
  it("更新任务完成（全部验收）后自动导入交付件；交付件不对时不导入，待我处理里放一条说明（不卡任务）；返工改对了再完成，这次导入，缺失事项随之结束", async () => {
    const clock = new ManualClock(new Date(2026, 10, 30, 12));
    const plan = twoStagePlan();
    const holidayPlan: Plan = {
      ...plan,
      stages: [{ ...plan.stages[0]!, title: "整理数据", deliverables: ["cn-2027.json"], acceptance: [{ criterion: "数据文件存在", method: "script", script: "test -f cn-2027.json" }] }],
    };
    const bad = { ...CN_2027, days: [{ date: "2028-01-01", name: "元旦", kind: "holiday" }] };
    const td = await startTestDaemon({
      clock,
      maintainer: maintainerScript(holidayPlan, [
        write("cn-2027.json", JSON.stringify(bad, null, 2)),
        completeStage("s1"),
        say("交了"),
        // 返工：改对日期
        call("edit", { path: "cn-2027.json", edits: [{ oldText: '"2028-01-01"', newText: '"2027-01-01"' }] }),
        completeStage("s1", "日期改对了"),
        say("改好了"),
      ]),
    });
    const frontend = await connect(td.url);
    clock.advanceTo(new Date(2026, 11, 1, 10));
    await td.daemon.internalJobs.whenIdle();
    const missing = td.daemon.inbox.list().find((i) => i.kind === "notice" && i.notice === "holiday_data_missing")!;
    ok(await frontend.inboxAction({ itemIds: [missing.id], action: "handle", choice: "发起更新任务" }));
    const card = await cardWhere(frontend, (c) => c.type === "plan");
    const taskId = (card.payload as PlanCardPayload).taskId;
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));

    // 完成了，但交付件不对：不导入，放一条说明（不卡任务）
    await taskWhere(frontend, (e) => e.change === "completed");
    const problem = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "holiday_import_problem");
    expect(problem).toMatchObject({ urgency: "non_blocking", data: { taskId, problems: ["cn-2027.json：节假日数据不对：2028-01-01 不在 2027 年里"] } });
    expect(fs.existsSync(path.join(td.daemon.layout.config, "holidays", "cn-2027.json"))).toBe(false);

    // 返工改对了：再完成时导入，缺失事项结束
    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s1", note: "日期不对" }));
    await waitUntil(() => tasksOf(frontend).filter((e) => e.change === "completed").length === 2, { timeoutMs: 30_000, describe: () => "返工后再次完成" });
    expect(fs.existsSync(path.join(td.daemon.layout.config, "holidays", "cn-2027.json"))).toBe(true);
    expect(td.daemon.inbox.list().find((i) => i.id === missing.id)).toMatchObject({ archived: true, title: "缺 2027 年国内节假日数据（已补上）" });
    expect(td.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "holiday_import_problem")).toHaveLength(1);
  }, 90_000);
});

describe("由我验收", () => {
  it("脚本通过后由用户验收的阶段停下等用户（待我处理里卡着任务，没有别的能推进的阶段时任务转等我）；退回时原因交回维护者，阶段不推进；在待我处理里点验收通过后接着下一个阶段；结论和返工都是素材", async () => {
    const plan = twoStagePlan();
    const td = await startTestDaemon({
      maintainer: maintainerScript(
        {
          ...plan,
          stages: [
            { ...plan.stages[0]!, acceptance: [{ criterion: "资料清单存在", method: "script", script: "test -f sources.md" }, { criterion: "来源你认可", method: "user" }] },
            { ...plan.stages[1]!, acceptance: [{ criterion: "报告存在", method: "script", script: "test -f report.md" }] },
          ],
        },
        [
          write("sources.md", "- 来源\n"),
          completeStage("s1"),
          say("等你验收"),
          // 被退回：按意见改了再交
          call("edit", { path: "sources.md", edits: [{ oldText: "- 来源", newText: "- 官方来源" }] }),
          completeStage("s1", "换成了官方来源"),
          say("又交了"),
          // 验收通过，开始 s2
          write("report.md", "# 报告\n"),
          completeStage("s2"),
          say("做完了"),
        ],
      ),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");

    // 脚本过了，还有由我验收的：待我处理里一条卡着任务的事项；s2 依赖它，没有别的能推进，任务转等我（由我验收）
    const notice = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stage_acceptance");
    expect(notice).toMatchObject({ urgency: "blocking", actions: ["验收通过", "退回"], data: { taskId, stageId: "s1" } });
    expect((notice as { body: string }).body).toContain("来源你认可");
    const waiting = await taskWhere(frontend, (e) => e.change === "waiting");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitReason: "acceptance" });
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "acceptance", acceptance: [{ method: "script", result: { passed: true } }, { method: "user" }] });

    // 在任务详情里退回（写了原因）：阶段不推进，交回维护者；待我处理里那条算处理过
    ok(await frontend.taskAction({ taskId, action: "return_stage", stageId: "s1", note: "要官方来源" }));
    const returned = await taskWhere(frontend, (e) => e.change === "stage_returned" && e.by === "user");
    expect(await taskWhere(frontend, (e) => e.change === "resumed")).toMatchObject({ from: "waiting_for_user", task: { state: "running" } });
    expect(returned.task.stages?.list?.[0]).toMatchObject({ state: "pending", acceptance: [expect.anything(), { method: "user", result: { passed: false } }] });
    await itemWhere(frontend, (i) => i.id === notice.id && i.kind === "notice" && i.handled === "退回");
    const told = await eventually(() => messagesOf(frontend, M1), (m) => m.agentInput === true && textOf(m).includes("用户验收没通过阶段 s1"), "交回维护者的通知");
    expect(textOf(told)).toContain("要官方来源");

    // 再交：又等用户；这次在待我处理里点"验收通过"——s1 验收了，任务回到执行中、开始 s2，最后自动完成
    const second = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stage_acceptance" && i.id !== notice.id);
    ok(await frontend.inboxAction({ itemIds: [second.id], action: "handle", choice: "验收通过" }));
    const accepted = await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.by === "user");
    expect(accepted.task.stages?.list?.[0]).toMatchObject({ state: "accepted", attempts: 2 });
    const done = await taskWhere(frontend, (e) => e.change === "completed");
    expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
    const userVerdicts = cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).acceptance?.judgedBy === "user");
    expect(userVerdicts.map((c) => (c.payload as ProgressCardPayload).acceptance!.passed)).toEqual([false, true]);
    // 退回时写的原因挂在那次结论卡上由你验收的那条上（84 号票：阶段详情的尝试记录里"你写的说明"）
    expect(userVerdicts.map((c) => (c.payload as ProgressCardPayload).acceptance!.results.find((r) => r.method === "user")?.note)).toEqual(["要官方来源", undefined]);

    // 素材：用户对产出的反应（退回带原话、验收通过）、任务结局
    await waitUntil(() => td.daemon.materials.list({ kind: "task_outcome" }).length > 0, { timeoutMs: 10_000, describe: () => "任务结局素材" });
    const reactions = td.daemon.materials.list({ kind: "output_reaction" });
    expect(reactions.map((m) => [m.task, m.context])).toEqual([
      [taskId, ["reaction:returned", "stage:s1"]],
      [taskId, ["reaction:accepted", "stage:s1"]],
    ]);
    expect(reactions[0]!.segments).toEqual([
      expect.objectContaining({ form: "choice", text: "退回：任务「X 的调研」阶段 s1「收集资料」的产出" }),
      expect.objectContaining({ form: "typed", source: "self", text: "要官方来源" }),
    ]);
    expect(td.daemon.materials.list({ kind: "task_outcome" })).toEqual([expect.objectContaining({ task: taskId, source: "system", context: ["outcome:completed", "by:system"] })]);
  }, 90_000);
});

describe("报告进展、失败、卡住、暂停和取消", () => {
  it("报告进展出进度卡；判失败必须写原因，失败后待我处理里出抉择，重试回到执行中；卡住求助时任务卡和待我处理写明原因，用户回话后接着执行；失败后可以取消；结局是素材", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [
        call("report_progress", { text: "资料找了一半" }),
        call("fail_task", { reason: "   " }),
        call("fail_task", { reason: "源站打不开" }),
        say("失败了"),
        // 用户让重试
        call("wait_for_user", { reason: "要你给个能登录的账号" }),
        say("等你"),
        // 用户回了话
        call("fail_task", { reason: "账号也登录不了" }),
        say("还是不行"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");

    const progress = await cardWhere(frontend, (c) => c.type === "progress");
    expect(progress.payload).toEqual({ taskId, taskTitle: "X 的调研", stageId: "s1", stageTitle: "收集资料", stageIndex: 1, stageTotal: 2, kind: "progress", text: "资料找了一半" });
    expect(progress.text).toBe("进展：任务「X 的调研」第 1/2 阶段「收集资料」。资料找了一半");
    expect(messagesOf(frontend, M1).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === progress.id))).toBe(true);
    expect(inboxOf(frontend).some((i) => i.kind === "card" && i.cardId === progress.id)).toBe(false);

    // 不写原因的失败被拒；写了原因的：任务失败，待我处理里出"失败后的抉择"
    const failed = await taskWhere(frontend, (e) => e.change === "failed");
    expect(failed).toMatchObject({ from: "running", by: "maintainer", task: { state: "failed", failReason: "源站打不开" } });
    const calls = toolCallsOf(frontend, M1).filter((c) => c.tool === "fail_task");
    expect(calls[0]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("判失败必须写明原因") });
    const choice = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "failure_choice");
    expect(choice).toMatchObject({ urgency: "blocking", actions: ["重试", "取消任务"], data: { taskId } });
    expect((choice as { body: string }).body).toContain("源站打不开");

    // 重试：回到执行中，维护者收到通知（带上次的原因）
    ok(await frontend.inboxAction({ itemIds: [choice.id], action: "handle", choice: "重试" }));
    expect(await taskWhere(frontend, (e) => e.change === "retried")).toMatchObject({ from: "failed", by: "user", task: { state: "running" } });
    expect((await taskWhere(frontend, (e) => e.change === "retried")).task.failReason).toBeUndefined();

    // 卡住求助：任务转等我，任务卡和待我处理都写明原因
    const stuck = await taskWhere(frontend, (e) => e.change === "waiting" && e.by === "maintainer");
    expect(stuck.task).toMatchObject({ state: "waiting_for_user", waitReason: "stuck", waitNote: "要你给个能登录的账号" });
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help).toMatchObject({ urgency: "blocking", actions: ["继续执行"] });
    expect((help as { body: string }).body).toContain("要你给个能登录的账号");
    // 用户在任务详情里回话：接着执行，这句话交给维护者；求助事项算处理过
    await turnsOf(frontend, M1, 3);
    await frontend.sendText("账号是 demo / demo", { conversation: M1 });
    expect(await taskWhere(frontend, (e) => e.change === "resumed")).toMatchObject({ from: "waiting_for_user", by: "user", task: { state: "running" } });
    await itemWhere(frontend, (i) => i.id === help.id && i.kind === "notice" && i.handled === "继续执行");

    // 又失败了：这次取消（任务详情里），抉择事项算处理过
    await eventually(() => tasksOf(frontend).filter((e) => e.change === "failed"), (e) => e.task.failReason === "账号也登录不了", "第二次失败");
    ok(await frontend.taskAction({ taskId, action: "cancel" }));
    expect(await taskWhere(frontend, (e) => e.change === "cancelled")).toMatchObject({ from: "failed", by: "user", task: { state: "cancelled" } });
    const second = inboxOf(frontend).find((i) => i.kind === "notice" && i.notice === "failure_choice" && i.id !== choice.id)!;
    await itemWhere(frontend, (i) => i.id === second.id && i.kind === "notice" && i.handled === "取消任务");
    // 已取消的任务不再收消息
    expect(await frontend.trySendParts([{ type: "text", text: "还在吗" }], { conversation: M1 })).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    await waitUntil(() => td.daemon.materials.list({ kind: "task_outcome" }).length >= 3, { timeoutMs: 10_000, describe: () => "任务结局素材" });
    expect(td.daemon.materials.list({ kind: "task_outcome" }).map((m) => [m.source, m.context[0]])).toEqual([
      ["agent", "outcome:failed"],
      ["agent", "outcome:failed"],
      ["self", "outcome:cancelled"],
    ]);
  }, 90_000);

  it("暂停中止手头这一轮，排着的输入留着；继续后接着做；取消时它留下的待我处理事项不再卡着任务", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [call("bash", { command: "sleep 20" }), call("wait_for_user", { reason: "选哪个方案" }), say("等你")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    await waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnStart }).length >= 2, { timeoutMs: 15_000, describe: () => "维护者开始执行" });
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    ok(await frontend.taskAction({ taskId, action: "pause" }));
    expect(await taskWhere(frontend, (e) => e.change === "paused")).toMatchObject({ from: "running", by: "user", task: { state: "paused" } });
    await turnsOf(frontend, M1, 2);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).at(-1)?.payload).toMatchObject({ outcome: "aborted" });

    ok(await frontend.taskAction({ taskId, action: "resume" }));
    expect(await taskWhere(frontend, (e) => e.change === "resumed")).toMatchObject({ from: "paused", task: { state: "running" } });
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help.urgency).toBe("blocking");
    // 取消等我的任务：留下的求助事项不再卡着任务（可以归档、删除），也不自动处理
    ok(await frontend.taskAction({ taskId, action: "cancel" }));
    await taskWhere(frontend, (e) => e.change === "cancelled");
    const after = await itemWhere(frontend, (i) => i.id === help.id && i.version > help.version);
    expect(after).toMatchObject({ urgency: "non_blocking" });
    expect((after as { handled?: string }).handled).toBeUndefined();
  }, 90_000);
});

/** 两个互不依赖的阶段：s1 的交付件在 ask/ 下，s2 的在 hand/ 下（测试把这两处设成"先问我""交给我做"） */
function branchPlan(): Plan {
  const plan = twoStagePlan();
  return {
    ...plan,
    stages: [
      { ...plan.stages[0]!, deliverables: ["ask/x.txt"], acceptance: [{ criterion: "x.txt 存在", method: "script", script: "test -f ask/x.txt" }] },
      { ...plan.stages[1]!, dependsOn: [], deliverables: ["hand/y.txt"], acceptance: [{ criterion: "y.txt 存在", method: "script", script: "test -f hand/y.txt" }] },
    ],
  };
}

/** 全局设置里加两个自定义关注类别：写任务工作目录下的 ask/ 先问我，写 hand/ 交给我做 */
function watchWorkDirs(td: TestDaemon, taskId: string) {
  const dir = fs.realpathSync.native(path.join(td.daemon.layout.outputs, taskId));
  const custom = [
    { id: "ask-dir", title: "动 ask 目录", match: { paths: [path.join(dir, "ask")] }, chat: "ask_first", task: "ask_first" },
    { id: "hand-dir", title: "动 hand 目录", match: { paths: [path.join(dir, "hand")] }, chat: "hand_over", task: "hand_over" },
  ];
  fs.writeFileSync(td.daemon.layout.watchCategoriesFile, JSON.stringify({ custom }));
  return dir;
}

describe("一支在等用户", () => {
  it("审批挂起、交给我做让各自那一支停下，别的阶段接着推进；都在等时任务转等我（不占名额）；批准后名额满了回到排队中，开始后维护者照通知重试；交给我做点已完成后这一支接着走，全部验收后完成", async () => {
    const td = await startTestDaemon({
      config: { tasks: { maxRunning: 1 }, approvals: { waitMinutes: 0.02 } },
      maintainer: (maintainerId, spawn) =>
        maintainerId === "tm-2"
          ? maintainerScript(twoStagePlan(), Array.from({ length: 4 }, () => say("好的")))(maintainerId, spawn)
          : maintainerScript(branchPlan(), [
              // s1：写 ask/ 要先问，等了一会儿没人批：挂起
              write("ask/x.txt", "x"),
              say("在等批准"),
              // 运行时让它先做 s2：写 hand/ 要用户亲手做
              write("hand/y.txt", "y"),
              say("都在等你了"),
              // 批准之后（任务重新开始时）：照通知原样重试，放行一次；s1 交付
              write("ask/x.txt", "x"),
              completeStage("s1"),
              say("s1 做完了"),
              // 交给我做的事用户做完了：s2 交付
              completeStage("s2"),
              say("全做完了"),
            ])(maintainerId, spawn),
    });
    const frontend = await connect(td.url, 2);
    // 自定义类别在两个计划都交上来之后才加（计划里的关注类别要包含全局的全部），再确认
    const d1 = await draftTask(td, frontend, "任务一");
    const d2 = await draftTask(td, frontend, "任务二");
    const dir = watchWorkDirs(td, d1.taskId);
    const t1 = await confirmPlan(frontend, d1);
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "started");
    const t2 = await confirmPlan(frontend, d2);
    expect(td.daemon.tasks.get(t2)?.state).toBe("queued");

    // s1 的审批挂起：这一支停下，任务一仍在执行中（占着名额），运行时开始 s2
    const suspended = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "stage_waiting" && e.stageId === "s1");
    expect(suspended.task).toMatchObject({ state: "running" });
    expect(suspended.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "approval" });
    const approvalCard = await cardWhere(frontend, (c) => c.type === "approval");
    expect(approvalCard).toMatchObject({ urgency: "blocking", payload: { taskId: t1, stageId: "s1" } });
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "stage_started" && e.stageId === "s2");
    // s2 交给用户做：也停下；所有能推进的都在等用户，任务转等我（写明原因），不再占名额，任务二开始
    const handOver = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "hand_over");
    expect(handOver).toMatchObject({ urgency: "blocking" });
    const waiting = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "waiting");
    expect(waiting).toMatchObject({ from: "running", by: "system", task: { state: "waiting_for_user", waitReason: "approval" } });
    expect(stageStates(waiting.task)).toEqual({ s1: "waiting", s2: "waiting" });
    await taskWhere(frontend, (e) => e.task.id === t2 && e.change === "started");

    // 事后批准：一次性授权；任务一要回到执行中，但名额被任务二占着，回到排队中
    ok(await frontend.cardAction({ cardId: approvalCard.id, action: "approve", expectedVersion: approvalCard.version }));
    const requeued = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "requeued");
    expect(requeued).toMatchObject({ from: "waiting_for_user", task: { state: "queued" } });
    expect(stageStates(requeued.task)).toEqual({ s1: "pending", s2: "waiting" });
    expect(messagesOf(frontend, M1).some((m) => m.agentInput && m.taskId === t1 && textOf(m).includes("已获用户批准，可以重试"))).toBe(true);

    // 任务二取消，名额空出：任务一开始，维护者照通知重试（放行一次），s1 验收通过；s2 还在等用户，任务转等我（交给我做）
    ok(await frontend.taskAction({ taskId: t2, action: "cancel" }));
    const accepted = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "stage_accepted" && e.stageId === "s1");
    expect(fs.readFileSync(path.join(dir, "ask", "x.txt"), "utf8")).toBe("x");
    expect(accepted.task.state).toBe("running");
    const handWait = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "waiting" && e.task.waitReason === "hand_over");
    expect(stageStates(handWait.task)).toEqual({ s1: "accepted", s2: "waiting" });

    // 用户亲手做完、点"已完成"：这一支接着走，任务回到执行中；维护者收到通知交付 s2，全部验收后自动完成
    fs.mkdirSync(path.join(dir, "hand"), { recursive: true });
    fs.writeFileSync(path.join(dir, "hand", "y.txt"), "y");
    ok(await frontend.inboxAction({ itemIds: [handOver.id], action: "handle", choice: "已完成" }));
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "stage_unblocked" && e.stageId === "s2");
    const done = await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "completed", "任务一完成");
    expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
  }, 90_000);

  it("s1 的审批挂起、s2 在做时批准了：通知维护者先切回 s1 再重试；切回后原样重试按批准时记下的阶段放行一次，不再问", async () => {
    const td = await startTestDaemon({
      config: { approvals: { waitMinutes: 0.02 } },
      maintainer: maintainerScript(branchPlan(), [
        // s1：写 ask/ 要先问，等了一会儿没人批：挂起
        write("ask/x.txt", "x"),
        say("在等批准"),
        // 运行时让它先做 s2
        write("notes.md", "s2 的笔记"),
        say("s2 在做"),
        // 批准了：照通知先切回 s1，再原样重试
        call("start_stage", { stageId: "s1" }),
        write("ask/x.txt", "x"),
        say("重试了"),
        say("好"),
      ]),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "任务一");
    const dir = watchWorkDirs(td, draft.taskId);
    const taskId = await confirmPlan(frontend, draft);
    const approvalCard = await cardWhere(frontend, (c) => c.type === "approval");
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "stage_started" && e.stageId === "s2");
    await turnsOf(frontend, M1, 3);
    expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "waiting", s2: "running" });

    // 批准：这一支不用再等了，可当前在做的是 s2——通知写明要先切回 s1
    ok(await frontend.cardAction({ cardId: approvalCard.id, action: "approve", expectedVersion: approvalCard.version }));
    await turnsOf(frontend, M1, 5);
    const notices = messagesOf(frontend, M1).filter((m) => m.agentInput && m.message.speaker === "system").map(textOf);
    expect(notices.some((t) => t.includes("已获用户批准，可以重试"))).toBe(true);
    expect(notices.find((t) => t.includes("挂起的那次调用已获批准"))).toContain("先调用 start_stage 切回 s1，再原样调用一次");

    // 切回 s1 后的重试按批准时记下的阶段（s1）对上指纹：放行一次，没有第二张审批卡
    const writes = toolCallsOf(frontend, M1).filter((c) => c.tool === "write" && c.argsSummary.includes("x.txt"));
    expect(writes.map((c) => c.outcome)).toEqual(["blocked", "done"]);
    expect(fs.readFileSync(path.join(dir, "ask", "x.txt"), "utf8")).toBe("x");
    expect(cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1)).toHaveLength(1);
    expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "running", s2: "pending" });
  }, 90_000);
});

type ToolCallRecord = { tool: string; argsSummary: string; disposition?: string; withinGrant?: boolean; blockedBy?: string; outcome: string; resultSummary?: string };
const toolCallsOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts)
    .filter((p) => p.type === "tool_call") as unknown as ToolCallRecord[];

describe("守卫拿到计划和当前阶段", () => {
  it("当前阶段的授权直接放行，别的阶段的授权被拉回当前阶段，没有授权的先问；先问我类别列进授权也当场问；前置阶段没验收不能开始；对象被判过永不之后再对它发送要先问", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const home = fs.realpathSync.native(homeDir);
    const hook = "http://127.0.0.1:9/hook";
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [
        {
          ...base.stages[0]!,
          policy: {
            grants: [
              { id: "notes", tool: "make_dir", title: "在主目录建 notes 目录", scope: { path: path.join(home, "notes") } },
              { id: "global", tool: "install_global", title: "全局装 left-pad", scope: {} },
              { id: "hook", tool: "http_request", title: "往本机的 hook 发请求", scope: {} },
            ],
            temporalRules: [],
          },
        },
        { ...base.stages[1]!, policy: { grants: [{ id: "later", tool: "make_dir", title: "在主目录建 later 目录", scope: { path: path.join(home, "later") } }], temporalRules: [] } },
      ],
    };
    const secret = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const run = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(plan, [
        call("start_stage", { stageId: "s2" }),
        // 越出工作目录（文件工具一律拒绝，bash 里的按"计划里列了才做"）
        call("bash", { command: `mkdir -p "${fwd(path.join(home, "notes"))}"` }),
        call("bash", { command: `mkdir -p "${fwd(path.join(home, "later"))}"` }),
        call("bash", { command: `mkdir -p "${fwd(path.join(home, "other"))}"` }),
        call("bash", { command: "npm install -g left-pad" }),
        call("bash", { command: `curl -X POST ${hook} -d "token=${secret}"` }),
        call("bash", { command: `curl -X POST ${hook} -d "hello"` }),
        say("完"),
      ]),
    });
    const frontend = await connect(run.url);
    await confirmTask(run, frontend, "守卫");
    // 三次先问：没授权的越出目录、列进授权也要问的全局安装、对象被判过永不的发送；都拒绝
    for (let n = 1; n <= 3; n++) {
      const card = await eventually(() => latestCards(frontend), (c) => c.type === "approval" && c.status === "pending", `第 ${n} 张审批卡`);
      ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version }));
      await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");
    }
    await turnsOf(frontend, M1, 2);
    const calls = toolCallsOf(frontend, M1).filter((c) => c.tool !== "submit_plan");
    expect(calls.map((c) => [c.tool, c.outcome, c.blockedBy ?? null])).toEqual([
      ["start_stage", "error", null],
      ["bash", "done", null],
      ["bash", "blocked", "pull_back"],
      ["bash", "denied", null],
      ["bash", "denied", null],
      ["bash", "blocked", null],
      ["bash", "denied", null],
    ]);
    expect(calls[0]!.resultSummary).toContain("前置阶段 s1 还没验收");
    expect(calls[1]).toMatchObject({ withinGrant: true });
    expect(fs.existsSync(path.join(home, "notes"))).toBe(true);
    expect(calls[2]!.resultSummary).toContain("属于阶段 s2，当前是阶段 s1");
    expect(fs.existsSync(path.join(home, "later"))).toBe(false);
    expect(fs.existsSync(path.join(home, "other"))).toBe(false);
    expect(calls[3]).toMatchObject({ disposition: "ask_first" });
    expect(calls[4]).toMatchObject({ disposition: "ask_first" });
    expect(calls[5]).toMatchObject({ disposition: "never" });
    expect(calls[6]).toMatchObject({ disposition: "ask_first" });
    const approvals = cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1);
    expect(approvals).toHaveLength(3);
    expect(JSON.stringify(approvals[2]!.payload)).toContain('被判过\\"永不\\"');
  }, 90_000);
});

describe("计划里的关注类别和用户的限制（26 号票）在执行中生效", () => {
  it("用户的限制编译出的时序规则：确认后执行中违反它的调用被拦下（判永不、不出审批卡），不违反的照常做", async () => {
    const quote = "草稿别写进 drafts 目录";
    const noDrafts = { id: "no-drafts", title: "不往 drafts 目录写", trigger: { tool: "write", where: { matches: ["$current.args.path", "\\\\drafts\\\\"] } }, on_violation: "block" };
    const plan = twoStagePlan({ userLimits: [{ id: "l1", quote, temporalRules: [noDrafts], grantNarrowings: [] }] });
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [write("drafts/a.md", "草稿"), write("notes/a.md", "笔记"), say("完")]),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "限制", [quote]);
    // 计划卡上列着这条限制，原话出自任务书的约束
    const payload = draft.card.payload as PlanCardPayload;
    expect(payload.plan.userLimits?.[0]?.temporalRules.map((r) => r.id)).toEqual(["no-drafts"]);
    expect(payload.verifiedQuotes).toEqual(["l1"]);
    const taskId = await confirmPlan(frontend, draft);
    await turnsOf(frontend, M1, 2);

    const calls = toolCallsOf(frontend, M1).filter((c) => c.tool === "write");
    expect(calls.map((c) => [c.outcome, c.disposition ?? null])).toEqual([
      ["blocked", "never"],
      ["done", "do"],
    ]);
    expect(calls[0]!.resultSummary).toContain("不往 drafts 目录写");
    const dir = path.join(td.daemon.layout.outputs, taskId);
    expect(fs.existsSync(path.join(dir, "drafts", "a.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "notes", "a.md"), "utf8")).toBe("笔记");
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
  }, 60_000);

  it("计划卡上给一个任务加的关注类别只影响这个任务：同一调用在这个任务里当场问（有授权项也照样问），在另一个任务里按授权项直接做", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const shared = path.join(fs.realpathSync.native(homeDir), "shared");
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [{ ...base.stages[0]!, policy: { grants: [{ id: "shared", tool: "make_dir", title: "在主目录建 shared 目录", scope: { path: shared } }], temporalRules: [] } }, base.stages[1]!],
    };
    const mkdir = call("bash", { command: `mkdir -p "${fwd(shared)}"` });
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer: maintainerScript(plan, [mkdir, say("完")]) });
    const frontend = await connect(td.url, 2);
    const d1 = await draftTask(td, frontend, "任务一");
    const d2 = await draftTask(td, frontend, "任务二");
    // 任务一的计划卡上加一个只对它生效的类别（先问我）；任务二原样确认
    const addition = { title: "动 shared 目录", match: { paths: [shared] }, disposition: "ask_first" as const };
    ok(await frontend.cardAction({ cardId: d1.card.id, action: "confirm", expectedVersion: 1, input: { addWatchCategories: [addition] } }));
    const t2 = await confirmPlan(frontend, d2);

    // 任务一：命中加的类别，有授权项也当场问；拒绝
    const card = await eventually(() => latestCards(frontend), (c) => c.type === "approval" && c.status === "pending", "任务一的审批卡");
    expect(card.payload).toMatchObject({ taskId: d1.taskId, stageId: "s1" });
    expect(JSON.stringify(card.payload)).toContain("动 shared 目录");
    ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version }));
    await turnsOf(frontend, M1, 2);
    await turnsOf(frontend, maintainerChannel("tm-2"), 2);

    const [inT1] = toolCallsOf(frontend, M1).filter((c) => c.tool === "bash");
    const [inT2] = toolCallsOf(frontend, maintainerChannel("tm-2")).filter((c) => c.tool === "bash");
    expect(inT1).toMatchObject({ outcome: "denied", disposition: "ask_first" });
    expect(inT2).toMatchObject({ outcome: "done", withinGrant: true });
    expect(inT1!.argsSummary).toBe(inT2!.argsSummary);
    expect(cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1)).toHaveLength(1);
    expect(fs.existsSync(shared)).toBe(true);
    expect(td.daemon.tasks.get(t2)?.state).toBe("running");
  }, 90_000);
});

const echo: FauxStep = { kind: "echo_context" };
/** 一段 echo_context 回出来的上下文：系统消息（系统提示，和换装配时 pi 追加的工具变化）的文字、各条消息的开头 */
function contextOf(text: string) {
  const blocks = text.split(/\n(?=\[(?:system|tool|user|assistant|toolResult)\] )/);
  return {
    system: blocks.filter((b) => b.startsWith("[system] ")).map((b) => b.slice("[system] ".length)),
    messages: blocks.filter((b) => /^\[(user|assistant|toolResult)\] /.test(b)).map((b) => b.split("\n")[0]!),
  };
}

describe("重注入块和任务详情里的输入框", () => {
  it("每次唤起维护者，会话里先注入一块当前的计划摘要、当前阶段、授权和边界（系统提示不变）；用户在任务详情里说话：休眠时唤起它，正在干活时作为插话在下一步之前插入，记进任务时间线、不建新卡", async () => {
    const td = await startTestDaemon({
      config: { agents: { idleMinutes: 0.02 } },
      maintainer: (_maintainerId, spawn) =>
        spawn === 1
          ? [submitPlanStep(twoStagePlan()), say("计划交上去了")]
          : spawn === 2
            ? [write("sources.md", "- 来源\n"), completeStage("s1"), echo]
            : [call("bash", { command: "sleep 4" }), echo],
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    // 第一次按执行装配唤起：注入块在开始执行的通知之前，写的是第 1 阶段
    await turnsOf(frontend, M1, 2);
    const firstText = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent").at(-1)!);
    const first = contextOf(firstText);
    const injected = first.messages.filter((l) => l.startsWith("[user] 【运行时注入】"));
    expect(injected).toHaveLength(1);
    expect(firstText.indexOf("[user] 【运行时注入】")).toBeLessThan(firstText.indexOf("计划已确认，开始执行任务"));
    expect(firstText).toContain(`任务 ${taskId}「X 的调研」：执行中，第 1/2 阶段`);
    // 系统提示不变：计划、阶段不在系统提示里
    expect(first.system.length).toBeGreaterThan(0);
    for (const system of first.system) {
      expect(system).not.toContain("收集资料");
      expect(system).not.toContain("执行中，第");
    }
    // 计划、阶段在二狗自己的存储里：s1 已验收，s2 开始了
    expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "accepted", s2: "running" });

    // 闲置退出后，用户在任务详情里说话：唤起它，注入的是最新的（第 2 阶段）；这句话带上任务，记进时间线
    await waitUntil(() => td.daemon.agents.live().every((a) => a.agentId !== "tm-1"), { timeoutMs: 10_000, describe: () => "维护者闲置退出" });
    const cardsBefore = cardsOf(frontend).length;
    const asked = await frontend.sendText("先写结论部分", { conversation: M1 });
    await waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnStart }).some((f) => (f.payload as { inputMessageId: string }).inputMessageId === asked.messageId), {
      timeoutMs: 15_000,
      describe: () => "维护者被唤起处理这句话",
    });
    // 它正在跑 sleep 4：这时再说一句，作为插话在下一步之前插入，不另起一轮
    await new Promise((r) => setTimeout(r, 1500));
    const extra = await frontend.sendText("顺便加个摘要", { conversation: M1 });
    await turnsOf(frontend, M1, 4);
    // 这次看到的上下文里，上一次唤起的回复（回出来的上下文）之后：新的注入块（第 2 阶段）、用户的话、sleep 的结果、插话
    const secondText = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent").at(-1)!);
    const sinceWake = secondText.slice(secondText.lastIndexOf("[toolResult] complete_stage"));
    const blocks = contextOf(sinceWake).messages;
    expect(blocks.filter((l) => l.startsWith("[user] 【运行时注入】"))).toHaveLength(1);
    expect(sinceWake.slice(sinceWake.indexOf("[user] 【运行时注入】")).split("\n")[1]).toBe(`任务 ${taskId}「X 的调研」：执行中，第 2/2 阶段`);
    const order = ["[user] 【运行时注入】", "先写结论部分", "[toolResult] bash", "顺便加个摘要"].map((x) => sinceWake.indexOf(x));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    const ends = frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string; outcome: string });
    expect(ends.slice(-2)).toEqual([
      expect.objectContaining({ inputMessageId: extra.messageId, outcome: "completed" }),
      expect.objectContaining({ inputMessageId: asked.messageId, outcome: "completed" }),
    ]);
    const said = messagesOf(frontend, M1).filter((m) => m.message.speaker === "user");
    expect(said.map((m) => [textOf(m), m.taskId])).toEqual([
      ["先写结论部分", taskId],
      ["顺便加个摘要", taskId],
    ]);
    expect(cardsOf(frontend)).toHaveLength(cardsBefore);
    // 用户在维护者会话里的发言是素材，带上所属的任务
    await waitUntil(() => td.daemon.materials.list({ kind: "user_utterance" }).length >= 2, { timeoutMs: 10_000, describe: () => "用户发言素材" });
    expect(td.daemon.materials.list({ kind: "user_utterance" }).map((m) => m.task)).toEqual([taskId, taskId]);
  }, 90_000);

  it("同一个子进程不退出：阶段换了，宣布完成的结论里交代新阶段的授权和边界；闲着时来了新输入，先注入最新的块（新阶段的授权）", async () => {
    const later = path.join(makeTempDir("ergou-later-"), "later");
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [base.stages[0]!, { ...base.stages[1]!, policy: { grants: [{ id: "later", tool: "make_dir", title: "建 later 目录", scope: { path: later } }], temporalRules: [] } }],
    };
    let spawns = 0;
    const td = await startTestDaemon({
      maintainer: (maintainerId, spawn) => {
        spawns = Math.max(spawns, spawn);
        return maintainerScript(plan, [write("sources.md", "- 来源\n"), completeStage("s1"), say("s1 交了"), echo])(maintainerId, spawn);
      },
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "X 的调研");
    await turnsOf(frontend, M1, 2);
    expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "accepted", s2: "running" });
    expect(toolCallsOf(frontend, M1).find((c) => c.tool === "complete_stage")!.resultSummary).toContain("现在是第 2/2 阶段 s2");

    // 子进程还在（没闲置退出）：用户说话，这条输入之前注入最新的块，写的是第 2 阶段和它的授权
    expect(td.daemon.agents.live().some((a) => a.agentId === "tm-1")).toBe(true);
    await frontend.sendText("进度如何", { conversation: M1 });
    await turnsOf(frontend, M1, 3);
    expect(spawns).toBe(2);
    const seen = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent").at(-1)!);
    const sinceLast = seen.slice(seen.lastIndexOf("[toolResult] complete_stage"));
    const blockAt = sinceLast.lastIndexOf("[user] 【运行时注入】");
    expect(blockAt).toBeGreaterThan(0);
    expect(sinceLast.indexOf("进度如何")).toBeGreaterThan(blockAt);
    // 换阶段的交代（宣布完成的结论，模型看到的全文）里有新阶段的授权和边界
    const handoff = sinceLast.slice(0, blockAt);
    for (const part of ["现在是第 2/2 阶段 s2", "建 later 目录", "边界：", "工作目录"]) expect(handoff).toContain(part);
    const block = sinceLast.slice(blockAt, sinceLast.indexOf("进度如何"));
    expect(block).toContain(`任务 ${taskId}「X 的调研」：执行中，第 2/2 阶段`);
    expect(block).toContain("建 later 目录");
  }, 60_000);
});
