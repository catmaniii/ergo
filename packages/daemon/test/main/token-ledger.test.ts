// 主切面：token 账本与消耗页（规格第 16 节、第 21 节"token 记账"，24 号票）。真的守护进程，秘书、维护者、评审子 agent
// 都接 faux 剧本，剧本里每次回话带固定的用量；测试扮演前端：
// - 每次模型调用在账本里记一条（归属、agent、会话、模型、输入缓存命中 / 未命中、输出、时间），条数和各项之和与剧本一致；
// - 秘书的调用归属为空，消耗页上单列为系统开销；
// - 任务卡上的总量随每次调用经看板频道更新，任务详情按 agent 细分（维护者、评审子 agent 各一行）；
// - 范围审视（18 号票）：工单结束时项目维护者子进程里另开的那一次，剧本给定用量，记在任务名下、标范围审视；任务自己的维护者
//   压缩时的审视、对话段里的用构造的、带标记的用量（压缩时的审视在 scope-review.test.ts 里真的走一遍）；压缩的用量照常（契约测试验子进程报的那一条）；
// - 定时作业的一次运行：输入带着作业身份时记在作业名下（作业自己的维护者 19 号票才有，用构造的）；
// - 消耗页：选一个时间范围，成本 = 用量 × 配置里的单价（粗估，改了单价再算随之变）。
import {
  addTokens,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  localDate,
  maintainerChannel,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  type TaskEventPayload,
  type TokenCounts,
  type TokenTotalsEventPayload,
  type WorkOrderEventPayload,
  ZERO_TOKENS,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { appendAgentNotice } from "../../src/conversation/messages.ts";
import type { FauxStep, FauxUsage } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon, writeConfig } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { usageApi } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { usageInjector } from "../helpers/usage.ts";

const { board: BOARD, cards: CARDS } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const today = () => localDate(new Date());

/** 剧本给定的一次用量 */
const U = (cacheHit: number, cacheMiss: number, output: number): FauxUsage => ({ cacheHit, cacheMiss, output });
const sum = (usages: readonly TokenCounts[]): TokenCounts => usages.reduce<TokenCounts>((a, u) => addTokens(a, u), { ...ZERO_TOKENS });
const total = (t: TokenCounts) => t.cacheHit + t.cacheMiss + t.output;
const withUsage = (step: FauxStep, usage: FauxUsage): FauxStep => ({ ...step, usage }) as FauxStep;
const say = (text: string, usage: FauxUsage): FauxStep => ({ kind: "reply", text, usage });
const call = (name: string, args: Record<string, unknown>, usage: FauxUsage): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }], usage });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const totalsOf = (frontend: TestFrontend, kind: string, id: string) =>
  frontend
    .events({ channel: BOARD, type: EVENT_TYPES.tokenTotals })
    .map((f) => f.payload as TokenTotalsEventPayload)
    .filter((p) => p.owner.kind === kind && p.owner.id === id);

const stage = (stageId: string, title: string, deliverable: string, acceptance: Plan["stages"][number]["acceptance"], dependsOn: string[]) => ({
  stageId,
  title,
  deliverables: [deliverable],
  acceptance,
  mode: "open" as const,
  dependsOn,
  policy: { grants: [], temporalRules: [] },
  budget: { tokens: 100_000, toolCalls: 30 },
});

/** 两个阶段：s1 脚本验收，s2 评审验收（在 s1 之后） */
function twoStagePlan(): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      stage("s1", "收集资料", "资料清单 sources.md", [{ criterion: "资料清单存在", method: "script", script: "test -f sources.md" }], []),
      stage("s2", "写报告", "调研报告 report.md", [{ criterion: "报告结构完整", method: "review" }], ["s1"]),
    ],
    stageGroups: [],
    scheduledJobs: [],
    stops: { count: 0, where: [] },
  };
}

const brief = { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" };

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 建一个任务、写好任务书，等维护者交出计划、这一轮结束，在计划卡上确认；返回任务 id */
async function confirmTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<string> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
  await turnsOf(frontend, M1, 1);
  ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
  return task.id;
}

describe("秘书的用量和未归属的用量", () => {
  it("秘书的调用也记账：不论处理的输入属于谁都不在任何名下（系统开销）；拉起时没给归属的 agent 记成未归属、单列；消耗页按天、按 agent 汇总", async () => {
    const td = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "在的", usage: { cacheHit: 0, cacheMiss: 1200, output: 30 } },
        { kind: "reply", text: "好的", usage: { cacheHit: 1100, cacheMiss: 150, output: 20 } },
        { kind: "reply", text: "知道了", usage: { cacheHit: 1300, cacheMiss: 40, output: 8 } },
      ],
    });
    const inject = usageInjector(td.daemon);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });
    await frontend.sendText("在吗");
    await frontend.next(CHANNELS.secretary, "turn_end");
    await frontend.sendText("记一下");
    await frontend.next(CHANNELS.secretary, "turn_end");
    // 交给秘书的一条属于某个任务的通知：秘书处理它的用量照样是系统开销，不记到任务名下
    appendAgentNotice(td.daemon.store, CHANNELS.secretary, "任务「X 的调研」的计划等用户确认", "test:secretary-task-notice", { taskId: "t-9" });
    await frontend.next(CHANNELS.secretary, "turn_end");
    // 一个拉起时没给归属的 agent
    inject("stray-1", U(10, 20, 3), { unattributed: true });

    const secretaryEntries = td.daemon.ledger.entries(null).filter((e) => e.role === "secretary");
    expect(secretaryEntries).toEqual([
      expect.objectContaining({ owner: null, agentId: "secretary", model: "faux", purpose: "work", tokens: U(0, 1200, 30) }),
      expect.objectContaining({ owner: null, agentId: "secretary", model: "faux", purpose: "work", tokens: U(1100, 150, 20) }),
      expect.objectContaining({ owner: null, agentId: "secretary", model: "faux", purpose: "work", tokens: U(1300, 40, 8) }),
    ]);
    expect(td.daemon.ledger.entries({ kind: "task", id: "t-9" })).toEqual([]);
    // 同一个会话（秘书常驻，没有重新拉起），时间是记账的时刻
    expect(secretaryEntries[0]!.sessionId).toMatch(/\S/);
    expect(new Set(secretaryEntries.map((e) => e.sessionId)).size).toBe(1);
    expect(secretaryEntries.map((e) => e.time.slice(0, 10))).toEqual([today(), today(), today()]);
    expect(td.daemon.ledger.entries(null).find((e) => e.agentId === "stray-1")).toMatchObject({ owner: null, role: "unattributed", tokens: U(10, 20, 3) });

    const { status, body } = await usageApi.summary(td.url, { from: today(), to: today() });
    expect(status).toBe(200);
    const secretary = U(2400, 1390, 58);
    expect(body.system).toMatchObject({ tokens: secretary, calls: 3 });
    expect(body.unattributed).toMatchObject({ tokens: U(10, 20, 3), calls: 1 });
    expect(body.total).toMatchObject({ tokens: U(2410, 1410, 61), calls: 4 });
    expect(body.agents).toEqual([
      expect.objectContaining({ agentId: "secretary", role: "secretary", category: "system", tokens: secretary, calls: 3 }),
      expect.objectContaining({ agentId: "stray-1", role: "unattributed", category: "unattributed", tokens: U(10, 20, 3), calls: 1 }),
    ]);
    expect(body.days).toEqual([
      expect.objectContaining({
        date: today(),
        total: expect.objectContaining({ tokens: U(2410, 1410, 61), calls: 4 }),
        system: expect.objectContaining({ tokens: secretary }),
        unattributed: expect.objectContaining({ tokens: U(10, 20, 3) }),
        agents: [expect.objectContaining({ agentId: "secretary", category: "system" }), expect.objectContaining({ agentId: "stray-1", category: "unattributed" })],
      }),
    ]);
  });
});

describe("任务的用量", () => {
  it("跑完一个任务：每次模型调用记一条，条数和各项之和与剧本一致；任务卡上的总量随每次调用经看板频道更新；任务详情里维护者和评审子 agent 各占一行；评审记在它评审的阶段、收尾调用不算进阶段（录给前端回放：token-ledger）", async () => {
    // 起草计划（第一次唤起）的两次调用，执行（按计划重新拉起）的五次，评审子 agent 的三次
    const planning = [U(0, 2000, 300), U(2000, 100, 20)];
    const s1 = [U(2500, 400, 60), U(2900, 100, 30)];
    const s2 = [U(3000, 200, 80), U(3300, 100, 30)];
    const after = [U(3400, 50, 10)];
    const reviewer = [U(800, 200, 20), U(1000, 50, 40), U(1100, 20, 5)];
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [withUsage(submitPlanStep(twoStagePlan()), planning[0]!), say("计划交上去了", planning[1]!)]
          : [
              call("write", { path: "sources.md", content: "- 来源一\n" }, s1[0]!),
              call("complete_stage", { stageId: "s1", summary: "资料清单在 sources.md" }, s1[1]!),
              call("write", { path: "report.md", content: "# X 的调研\n" }, s2[0]!),
              call("complete_stage", { stageId: "s2", summary: "报告在 report.md" }, s2[1]!),
              say("两个阶段都做完了", after[0]!),
            ],
      reviewer: () => [
        call("read", { path: "report.md" }, reviewer[0]!),
        call("submit_review", { results: [{ index: 1, passed: true, reason: "看过了" }] }, reviewer[1]!),
        say("评审完了", reviewer[2]!),
      ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [M1]: 0 });
    const taskId = await confirmTask(td, frontend, "X 的调研");
    await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "任务完成");
    await turnsOf(frontend, M1, 2);
    const maintainerAll = [...planning, ...s1, ...s2, ...after];
    const all = [...maintainerAll, ...reviewer];
    await waitUntil(() => totalsOf(frontend, "task", taskId).length >= all.length, { describe: () => "等看板上的合计" });

    // 账本：每次调用一条，带归属、agent、会话、模型、时间；条数和各项之和与剧本一致
    const entries = td.daemon.ledger.entries({ kind: "task", id: taskId });
    expect(entries).toHaveLength(all.length);
    expect(sum(entries.map((e) => e.tokens))).toEqual(sum(all));
    const byAgent = (agentId: string) => entries.filter((e) => e.agentId === agentId);
    expect(byAgent("tm-1").map((e) => e.tokens)).toEqual(maintainerAll);
    expect(byAgent("review-t-1-s2-1").map((e) => e.tokens)).toEqual(reviewer);
    expect(byAgent("tm-1").every((e) => e.role === "maintainer" && e.purpose === "work" && e.model === "faux" && e.sessionId !== "" && e.time.slice(0, 10) === today())).toBe(true);
    // 评审子 agent：记在任务名下、它评审的阶段，角色是评审
    expect(byAgent("review-t-1-s2-1").every((e) => e.role === "reviewer" && e.stageId === "s2")).toBe(true);
    // 起草计划时还没有阶段，执行时记上调用时的阶段；全部验收、任务完成之后的收尾调用不算进任何阶段
    expect(byAgent("tm-1").map((e) => e.stageId)).toEqual([undefined, undefined, "s1", "s1", "s2", "s2", undefined]);
    // 秘书没被叫到：不在任何名下的是空的
    expect(td.daemon.ledger.entries(null)).toEqual([]);

    // 看板：每次调用之后一条最新的合计，总量一路增长，最后等于剧本之和
    const totals = totalsOf(frontend, "task", taskId);
    expect(totals).toHaveLength(all.length);
    expect(totals.map((t) => t.calls)).toEqual(all.map((_, i) => i + 1));
    const last = totals.at(-1)!;
    expect(last.tokens).toEqual(sum(all));
    // 任务详情：维护者、评审子 agent 各占一行，各行之和等于总量
    expect(last.byAgent).toEqual([
      { agentId: "tm-1", role: "maintainer", purpose: "work", tokens: sum(maintainerAll), calls: maintainerAll.length },
      { agentId: "review-t-1-s2-1", role: "reviewer", purpose: "work", tokens: sum(reviewer), calls: reviewer.length },
    ]);
    expect(last.byStage).toEqual([
      { stageId: "s1", tokens: sum(s1), calls: s1.length, budgetTokens: total(sum(s1)) },
      { stageId: "s2", tokens: sum([...s2, ...reviewer]), calls: s2.length + reviewer.length, budgetTokens: total(sum(s2)) },
    ]);
    expect(td.daemon.ledger.totals({ kind: "task", id: taskId })).toEqual(last);
    // 预算比较（14 号票）只算干活的部分：不算评审子 agent 的
    expect(td.daemon.ledger.stageTokens(taskId, "s1")).toBe(total(sum(s1)));
    expect(td.daemon.ledger.stageTokens(taskId, "s2")).toBe(total(sum([...s2, ...reviewer])));
    expect(td.daemon.ledger.stageTokens(taskId, "s2", { budget: true })).toBe(total(sum(s2)));

    saveOrCheckRecording("token-ledger", frontend.recording, { perChannel: true });
  });
});

describe("范围审视和压缩的用量", () => {
  it("维护者在任务里时记在任务名下、标范围审视 / 压缩：任务详情里各单独一行，计入任务卡上的总量，范围审视不算进阶段预算；项目维护者做工单时记在工单的任务名下，和用户直接对话（不在任务里）时记在项目名下", async () => {
    // 项目维护者起草计划的工单段：交计划、写回进展、写这一段的摘要（16 号票：写回之后这一段和工单才结束）
    const td = await startTestDaemon({
      secretary: [say("好的", U(0, 100, 10))],
      maintainer: (id, spawn) => {
        if (id === "tm-1") return [withUsage(submitPlanStep(twoStagePlan()), U(0, 1000, 100)), say("计划交上去了", U(1000, 50, 10))];
        if (spawn === 1)
          return [
            withUsage(submitPlanStep(twoStagePlan()), U(600, 200, 30)),
            // 起草计划这一段只读，进展用 write_progress 写回（16 号票评审后）
            call("write_progress", { content: "周报：计划交了，等确认。" }, U(800, 20, 5)),
            call("write_segment_summary", { summary: "起草了周报的计划" }, U(820, 20, 5)),
            say("计划交了，档案写回了", U(840, 20, 5)),
          ];
        // 对话段：用户直接和它说话
        return [say("项目的事我记下了", U(0, 600, 40)), say("又聊回项目", U(800, 100, 10))];
      },
      // 起草计划的工单结束时的范围审视（18 号票）：子进程里另开的一次调用，剧本给定用量
      scopeReviewer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [{ kind: "reply", text: '{"records":[]}', usage: U(0, 200, 10) }] : []),
    });
    const inject = usageInjector(td.daemon);
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    const PM = maintainerChannel(project.maintainerId);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [M1]: 0, [PM]: 0, [CHANNELS.projects]: 0 });

    // 任务的维护者：起草计划时（在任务里）做了一次范围审视、压缩了一次会话
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, brief);
    await turnsOf(frontend, M1, 1);
    inject("tm-1", U(0, 500, 60), { purpose: "scope_review" });
    inject("tm-1", U(0, 900, 200), { purpose: "compaction" });
    await waitUntil(() => totalsOf(frontend, "task", task.id).length >= 4, { describe: () => "等看板上的合计" });
    const last = totalsOf(frontend, "task", task.id).at(-1)!;
    expect(last.byAgent).toEqual([
      { agentId: "tm-1", role: "maintainer", purpose: "work", tokens: U(1000, 1050, 110), calls: 2 },
      { agentId: "tm-1", role: "maintainer", purpose: "scope_review", tokens: U(0, 500, 60), calls: 1 },
      { agentId: "tm-1", role: "maintainer", purpose: "compaction", tokens: U(0, 900, 200), calls: 1 },
    ]);
    expect(last.tokens).toEqual(U(1000, 2450, 370));
    expect(td.daemon.ledger.entries({ kind: "task", id: task.id }).slice(-2)).toEqual([
      expect.objectContaining({ agentId: "tm-1", purpose: "scope_review", tokens: U(0, 500, 60) }),
      expect.objectContaining({ agentId: "tm-1", purpose: "compaction", tokens: U(0, 900, 200) }),
    ]);

    // 项目的维护者做单项目任务的工单（16 号票：工单段里交给它的输入带着任务）：这时的用量记在那个任务名下；
    // 工单结束时的范围审视（18 号票，在回合之后、子进程退出之前）记在刚处理完的那条输入所属的任务名下
    ok(await frontend.startTask("给记账本加周报", "start-weekly", ["记账本"]));
    const projectTask = await eventually(() => tasksOf(frontend), (e) => e.change === "created" && e.task.title === "给记账本加周报", "项目的任务");
    td.daemon.tasks.writeBrief(projectTask.task.id, { ...brief, projects: ["记账本"] });
    await eventually(
      () => frontend.events({ channel: CHANNELS.projects, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload),
      (e) => e.change === "ended" && e.workOrder.taskId === projectTask.task.id,
      "起草计划的工单写回后结束",
    );
    await turnsOf(frontend, PM, 1);
    // 用户直接和它说话（工单结束了，开一个对话段，不在任务里）：这时的用量和范围审视记在项目名下
    await frontend.sendText("聊聊这个项目", { conversation: PM });
    await turnsOf(frontend, PM, 2);
    inject(project.maintainerId, U(100, 300, 20), { purpose: "scope_review" });
    await frontend.sendText("再聊聊", { conversation: PM });
    await turnsOf(frontend, PM, 3);
    const projectEntries = td.daemon.ledger.entries({ kind: "project", id: project.id });
    expect(projectEntries.map((e) => ({ agentId: e.agentId, purpose: e.purpose, tokens: e.tokens }))).toEqual([
      { agentId: project.maintainerId, purpose: "work", tokens: U(0, 600, 40) },
      { agentId: project.maintainerId, purpose: "scope_review", tokens: U(100, 300, 20) },
      { agentId: project.maintainerId, purpose: "work", tokens: U(800, 100, 10) },
    ]);
    expect(td.daemon.ledger.entries({ kind: "task", id: projectTask.task.id }).map((e) => ({ agentId: e.agentId, role: e.role, purpose: e.purpose, tokens: e.tokens }))).toEqual([
      { agentId: project.maintainerId, role: "maintainer", purpose: "work", tokens: U(600, 200, 30) },
      { agentId: project.maintainerId, role: "maintainer", purpose: "work", tokens: U(800, 20, 5) },
      { agentId: project.maintainerId, role: "maintainer", purpose: "work", tokens: U(820, 20, 5) },
      { agentId: project.maintainerId, role: "maintainer", purpose: "work", tokens: U(840, 20, 5) },
      { agentId: project.maintainerId, role: "maintainer", purpose: "scope_review", tokens: U(0, 200, 10) },
    ]);
    // 项目名下的不在看板上推合计，也不算系统开销（系统开销只有秘书的）
    expect(totalsOf(frontend, "project", project.id)).toEqual([]);
    expect(td.daemon.ledger.entries(null).map((e) => e.agentId)).toEqual(["secretary"]);
  }, 60_000);

  it("阶段预算只算干活的部分：同一阶段里维护者干活和压缩算，范围审视不算；子 agent 带着它被派去的阶段记账", async () => {
    const td = await startTestDaemon();
    const inject = usageInjector(td.daemon);
    const task = { kind: "task" as const, id: "t-7" };
    inject("tm-7", U(100, 50, 10), { attribution: { owner: task, role: "maintainer", stageId: "s1" } });
    inject("tm-7", U(0, 40, 5), { attribution: { owner: task, role: "maintainer", stageId: "s1" }, purpose: "compaction" });
    inject("tm-7", U(0, 30, 3), { attribution: { owner: task, role: "maintainer", stageId: "s1" }, purpose: "scope_review" });
    inject("review-t-7-s1-1", U(20, 20, 2), { attribution: { owner: task, role: "reviewer", stageId: "s1" } });
    // 20 号票的并行子 agent：拉起时带上它被派去的阶段（这里是 s2，和维护者当时在做的无关）
    inject("sub-t-7-s2", U(0, 70, 7), { attribution: { owner: task, role: "sub_agent", stageId: "s2" } });
    expect(td.daemon.ledger.stageTokens("t-7", "s1")).toBe(160 + 45 + 33 + 42);
    expect(td.daemon.ledger.stageTokens("t-7", "s1", { budget: true })).toBe(160 + 45);
    expect(td.daemon.ledger.stageTokens("t-7", "s2", { budget: true })).toBe(77);
    expect(td.daemon.ledger.totals(task)?.byStage).toEqual([
      { stageId: "s1", tokens: U(120, 140, 20), calls: 4, budgetTokens: 160 + 45 },
      { stageId: "s2", tokens: U(0, 70, 7), calls: 1, budgetTokens: 77 },
    ]);
  });
});

/** 作业 j-1 的归属（19 号票随输入带上作业身份；作业自己的维护者拉起时给） */
const JOB = { owner: { kind: "scheduled_job" as const, id: "j-1" }, role: "maintainer" as const };

describe("定时作业的用量（19 号票还没做：作业的输入和作业自己的维护者用构造的；可注入时钟）", () => {
  it("每次运行的用量（处理作业输入的项目维护者、作业自己的维护者）都记在作业名下，不算系统开销；看板上作业名下的合计和任务一样推送；按天汇总跟着时钟", async () => {
    const clock = new ManualClock(new Date(2026, 9, 5, 9, 0));
    const td = await startTestDaemon({
      clock,
      secretary: [say("好的", U(500, 100, 10))],
      maintainer: () => [say("今天的账单汇总好了", U(1000, 300, 50)), say("补了一条", U(1200, 100, 30))],
    });
    const inject = usageInjector(td.daemon);
    const project = seedProject(td.daemon, "记账本");
    const PM = maintainerChannel(project.maintainerId);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CHANNELS.secretary]: 0, [PM]: 0 });

    // 10 月 5 日：作业的一次运行交给项目维护者（输入带着作业身份），它处理时的用量记在作业名下
    appendAgentNotice(td.daemon.store, PM, "定时作业「每天汇总账单」到点了：汇总今天的账单", "test:job-run-1", { projectId: project.id, scheduledJobId: "j-1" });
    await turnsOf(frontend, PM, 1);
    appendAgentNotice(td.daemon.store, PM, "定时作业「每天汇总账单」：还有一条漏了", "test:job-run-1b", { projectId: project.id, scheduledJobId: "j-1" });
    await turnsOf(frontend, PM, 2);
    // 10 月 6 日：作业自己的维护者执行
    clock.advanceTo(new Date(2026, 9, 6, 9, 0));
    inject("jm-1", U(0, 800, 40), { attribution: JOB });
    // 同一天秘书也聊了一句：系统开销
    await frontend.sendText("在吗");
    await frontend.next(CHANNELS.secretary, "turn_end");

    await waitUntil(() => totalsOf(frontend, "scheduled_job", "j-1").length >= 3, { describe: () => "等看板上作业的合计" });
    const totals = totalsOf(frontend, "scheduled_job", "j-1");
    expect(totals.map((t) => t.calls)).toEqual([1, 2, 3]);
    expect(totals.at(-1)).toMatchObject({
      owner: { kind: "scheduled_job", id: "j-1" },
      tokens: U(2200, 1200, 120),
      byAgent: [
        { agentId: project.maintainerId, role: "maintainer", purpose: "work", tokens: U(2200, 400, 80), calls: 2 },
        { agentId: "jm-1", role: "maintainer", purpose: "work", tokens: U(0, 800, 40), calls: 1 },
      ],
      byStage: [],
    });
    expect(td.daemon.ledger.entries({ kind: "scheduled_job", id: "j-1" }).map((e) => e.time.slice(0, 10))).toEqual(["2026-10-05", "2026-10-05", "2026-10-06"]);
    // 项目名下没有（作业身份优先于项目）
    expect(td.daemon.ledger.entries({ kind: "project", id: project.id })).toEqual([]);

    const { body } = await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-06" });
    expect(body.days.map((d) => ({ date: d.date, tokens: d.total.tokens, system: d.system.tokens }))).toEqual([
      { date: "2026-10-05", tokens: U(2200, 400, 80), system: U(0, 0, 0) },
      { date: "2026-10-06", tokens: U(500, 900, 50), system: U(500, 100, 10) },
    ]);
    expect(body.agents.map((a) => ({ agentId: a.agentId, category: a.category, tokens: a.tokens }))).toEqual([
      { agentId: project.maintainerId, category: "owned", tokens: U(2200, 400, 80) },
      { agentId: "jm-1", category: "owned", tokens: U(0, 800, 40) },
      { agentId: "secretary", category: "system", tokens: U(500, 100, 10) },
    ]);
    expect(body.system.tokens).toEqual(U(500, 100, 10));
    // 只看 10 月 5 日：没有系统开销
    const fifth = (await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-05" })).body;
    expect(fifth.total.tokens).toEqual(U(2200, 400, 80));
    expect(fifth.system.calls).toBe(0);
  });
});

/** 配置里的单价（每百万 token），k 倍；测试里的 faux provider 在配置里的键是 faux */
const prices = (k: number) => ({ tokenPrices: { currency: "CNY", models: { faux: { cacheHit: 0.5 * k, cacheMiss: 2 * k, output: 8 * k } } } });

describe("消耗页的粗估成本", () => {
  it("选一个时间范围，成本 = 范围内的用量 × 配置里的单价，标明粗估；夜里和白天的单价一样；没配单价的模型列出来、不算进成本；改了配置里的单价再算，结果随之变", async () => {
    const clock = new ManualClock(new Date(2026, 9, 5, 2, 0));
    const td = await startTestDaemon({ clock, config: prices(1) });
    const inject = usageInjector(td.daemon);
    // 10 月 5 日夜里 2 点：作业 0.23；下午 2 点：秘书 0.18；另一个没配单价的模型
    inject("pm-1", U(100_000, 50_000, 10_000), { attribution: JOB });
    clock.advanceTo(new Date(2026, 9, 5, 14, 0));
    inject("secretary", U(200_000, 20_000, 5_000), { attribution: { owner: null, role: "secretary" } });
    inject("pm-1", U(1_000, 1_000, 1_000), { attribution: JOB, model: "other/m" });
    // 10 月 6 日：任务 2.8
    clock.advanceTo(new Date(2026, 9, 6, 10, 0));
    inject("tm-9", U(0, 1_000_000, 100_000), { attribution: { owner: { kind: "task", id: "t-9" }, role: "maintainer" } });

    const fifth = (await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-05" })).body;
    expect(fifth.pricing).toEqual({ estimate: true, currency: "CNY", prices: [{ model: "faux", cacheHit: 0.5, cacheMiss: 2, output: 8 }], unpriced: ["other/m"] });
    expect(fifth.total.cost).toBeCloseTo(0.41, 10);
    expect(fifth.system.cost).toBeCloseTo(0.18, 10);
    expect(fifth.agents.find((a) => a.agentId === "pm-1")!.cost).toBeCloseTo(0.23, 10);
    expect(fifth.total.tokens).toEqual(U(301_000, 71_000, 16_000));

    const both = (await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-06" })).body;
    expect(both.total.cost).toBeCloseTo(3.21, 10);
    expect(both.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(both.days[1]!.total.cost).toBeCloseTo(2.8, 10);

    // 改配置里的单价（翻倍），不用重启：再算一次成本跟着变
    writeConfig(td.dataDir, prices(2));
    const again = (await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-05" })).body;
    expect(again.total.cost).toBeCloseTo(0.82, 10);
    expect(again.pricing.prices).toEqual([{ model: "faux", cacheHit: 1, cacheMiss: 4, output: 16 }]);
    // 配置改坏了：成本按 0，写明原因（用量照常）
    writeConfig(td.dataDir, { tokenPrices: { models: { faux: { cacheHit: -1, cacheMiss: 2, output: 8 } } } });
    const broken = (await usageApi.summary(td.url, { from: "2026-10-05", to: "2026-10-05" })).body;
    expect(broken.pricing.problem).toContain("tokenPrices.models");
    expect(broken.total).toMatchObject({ tokens: U(301_000, 71_000, 16_000), cost: 0 });
  });

  it("范围写错了回 400（不是 YYYY-MM-DD、日期不存在、起点在终点之后）", async () => {
    const td = await startTestDaemon();
    expect((await usageApi.summary(td.url, { from: "2026-10", to: "2026-10-05" })).status).toBe(400);
    expect((await usageApi.summary(td.url, { from: "2026-02-30", to: "2026-03-01" })).status).toBe(400);
    expect((await usageApi.summary(td.url, { from: "2026-10-06", to: "2026-10-05" })).status).toBe(400);
  });
});
