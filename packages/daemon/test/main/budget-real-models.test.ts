// 主切面：预算控制和真模型对得上（361 号票，真模型闭环试验查出来的：一次试验停了 28 次，要点 27 次"追加预算继续"，¥4.45 里约 ¥1.00 是空转）。
// 真的守护进程，负责人接 faux 剧本（每步带试验里的用量），测试扮演前端。
// - 用量：没命中缓存的输入 + 输出 + 命中缓存的十分之一，只有预算用这个数；账本和消耗页的真实 token 不变；
// - 预算：负责人只估工具调用次数，token 预算由运行时算（次数 × 校准比例 × 单次计量），上下文 13 万、估 30 次的阶段跑到 30 次左右才到预算线；
// - 校准：前面阶段实际是估的 3 倍，后面的阶段预算跟着放大；
// - 停下：除了 complete_stage、提计划变更都拒绝，拒绝信息写清楚；活做完了能宣布（不再死锁）；确认加预算的计划变更后用量重新算；
// - 过期通知：排着的通知状态一变就作废，只有过期通知时不拉起模型。
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Plan, type PlanChangeCardPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { call, cardWhere, completeStage, confirmTask, connect, eventually, inputsDone, itemWhere, noticesOf, ok, say, taskWhere, textOf, toolCallsOf, twoStagePlan, write } from "../helpers/task-flow.ts";

const M1 = maintainerChannel("tm-1");
const BUDGET_ON = { tasks: { thresholds: { budgetControl: true } } };

/** 试验里的平均一次调用：上下文 13 万、没命中 2900、输出 720，记进预算 16620 */
const TRIAL = { cacheHit: 130_000, cacheMiss: 2900, output: 720 };
const TRIAL_METER = 16_620;
/** 真的超了：没命中缓存的输入就有这么多 */
const HUGE = { cacheHit: 0, cacheMiss: 5_000_000, output: 1000 };

const withUsage = (step: FauxStep, usage: { cacheHit: number; cacheMiss: number; output: number }): FauxStep => (step.kind === "reply" ? { ...step, usage } : step);

/** s1 估 calls 次（s2 估 s2Calls 次）的计划 */
function planOf(calls: number, s2Calls = 0): Plan {
  const base = twoStagePlan();
  return { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 40_000, toolCalls: calls } }, { ...base.stages[1]!, budget: { tokens: 0, toolCalls: s2Calls } }] };
}

/** 起草时也是这个上下文（单次计量有实测可看），执行照 run */
const script =
  (plan: Plan, run: FauxStep[] | ((spawn: number) => FauxStep[]), drafted = TRIAL) =>
  (_id: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [withUsage(submitPlanStep(plan), drafted), withUsage(say("计划交上去了"), drafted)] : typeof run === "function" ? run(spawn) : run;

const stageOf = (td: { daemon: { tasks: { get(id: string): { stages?: { list?: Array<{ stageId: string }> } } | undefined } } }, taskId: string, stageId: string) =>
  td.daemon.tasks.get(taskId)?.stages?.list?.find((s) => s.stageId === stageId) as ({ state: string; budget?: { tokens: number; toolCalls: number; perCall: number; scale: number }; calls?: { estimated: number; actual: number } } & { stageId: string }) | undefined;

/** 这个任务名下记了几次模型调用 */
const modelCalls = (td: { daemon: { ledger: { entries(owner: { kind: "task"; id: string }): unknown[] } } }, taskId: string) => td.daemon.ledger.entries({ kind: "task", id: taskId }).length;

describe("用量和预算怎么算", () => {
  it("回放试验的数字：一次调用缓存 15 万、没命中 2000、输出 500，记 17500；写了 4 万 token 的阶段不会一次就停（token 由运行时算，写的不作数）；账本和消耗页的真实 token 不变", async () => {
    const usage = { cacheHit: 150_000, cacheMiss: 2000, output: 500 };
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(planOf(30), [withUsage(write("sources.md", "- 来源\n"), usage), withUsage(completeStage("s1"), usage), withUsage(say("交了"), usage)]) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "回放");
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    await inputsDone(frontend, M1);
    // 交来的 4 万 token 没进计划；一次调用只记 17500
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.stages[0]?.budget).toEqual({ tokens: 0, toolCalls: 30 });
    expect(td.daemon.ledger.stageTokens(taskId, "s1", { budget: true })).toBe(2 * 17_500);
    expect(frontend.events({ channel: "inbox" }).some((e) => JSON.stringify(e.payload).includes("over_budget"))).toBe(false);
    // 账本的逐笔、合计、消耗页都是真实的 token
    const real = { cacheHit: 150_000, cacheMiss: 2000, output: 500 };
    const entries = td.daemon.ledger.entries({ kind: "task", id: taskId });
    expect(entries.filter((e) => e.stageId === "s1").map((e) => e.tokens)).toEqual([real, real]);
    expect(td.daemon.ledger.stageTokens(taskId, "s1")).toBe(2 * 152_500);
    const totals = td.daemon.ledger.totals({ kind: "task", id: taskId })!;
    expect(totals.byStage.find((s) => s.stageId === "s1")).toMatchObject({ tokens: { cacheHit: 300_000, cacheMiss: 4000, output: 1000 }, calls: 2, budgetTokens: 2 * 17_500 });
    const today = entries[0]!.time.slice(0, 10);
    const summary = td.daemon.ledger.summary({ from: today, to: today });
    expect(summary.total.tokens.cacheHit).toBeGreaterThanOrEqual(300_000);
    expect(summary.total.tokens.output).toBeGreaterThanOrEqual(1000);
  }, 90_000);

  it("回放试验的上下文：估 30 次的阶段、上下文 13 万，3 到 7 次不停，跑到 30 次左右才到预算线（才让说明进展），超过两倍才停", async () => {
    const writes = Array.from({ length: 34 }, (_, i) => withUsage(write(`f${i}.md`, "x"), TRIAL));
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(planOf(30), [...writes, withUsage(say("这一段写完了"), TRIAL)]) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "30 次");
    await inputsDone(frontend, M1);
    // token 预算 = 30 次 × 单次计量，运行时算好记在阶段上
    expect(stageOf(td, taskId, "s1")?.budget).toMatchObject({ toolCalls: 30, perCall: TRIAL_METER, tokens: 30 * TRIAL_METER, scale: 1 });
    const explain = noticesOf(frontend, M1).find((m) => textOf(m).includes("用量已经超过预算"));
    expect(explain).toBeDefined();
    // 说明进展的那一刻已经 30 次工具调用左右
    const atCalls = Number(/用了 \d+ token、(\d+) 次工具调用/.exec(textOf(explain!))?.[1]);
    expect(atCalls).toBeGreaterThanOrEqual(29);
    expect(atCalls).toBeLessThanOrEqual(32);
    // 34 次没到两倍：一直没停
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    expect(stageOf(td, taskId, "s1")?.state).toBe("running");
  }, 180_000);

  it("校准：前一阶段实际是估计的 3 倍时，下一阶段的预算跟着放大；负责人看得到估的和实际的次数", async () => {
    // s1 估 2 次；超过 2 倍停下，点继续之后接着做，一共 6 次；用量小，只看次数
    const small = { cacheHit: 0, cacheMiss: 10, output: 5 };
    const run = [
      write("a.md", "a"),
      write("b.md", "b"),
      write("c.md", "c"),
      write("d.md", "d"),
      write("e.md", "e"),
      say("超了"),
      write("sources.md", "- 来源\n"),
      completeStage("s1"),
      say("s1 交了"),
    ].map((s) => withUsage(s, small));
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(planOf(2, 10), run) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "校准");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "s1 超预算");
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    await inputsDone(frontend, M1);
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    await inputsDone(frontend, M1);
    expect(stageOf(td, taskId, "s1")?.calls).toEqual({ estimated: 2, actual: 6 });
    // s2 估 10 次，按 3 倍放大：30 次，token 预算跟着放大
    const s2 = stageOf(td, taskId, "s2")!;
    expect(s2.budget?.scale).toBe(3);
    expect(s2.budget?.toolCalls).toBe(30);
    expect(s2.budget?.tokens).toBe(30 * s2.budget!.perCall);
    // 重注入块里写着
    const block = td.daemon.taskExecution.contextBlock(taskId);
    expect(block).toContain("s1 估 2 次，实际 6 次");
    expect(block).toContain("不用自己再乘");
    expect(block).toContain("工具调用 30 次");
  }, 120_000);
});

describe("超预算停下", () => {
  it("真的超了：别的工具被拒，拒绝信息写清楚因为什么停、用了多少、预算多少、等什么、不是审批卡的问题；提计划变更放行，确认加预算后马上再调用不停", async () => {
    const plan = planOf(30);
    const raised = { ...plan.stages[0]!, budget: { tokens: 0, toolCalls: 300 } };
    const run = [
      // 这一次调用就超了两倍：这次回复里的调用被拒
      withUsage(write("a.md", "a"), HUGE),
      withUsage(say("超了，等你"), TRIAL),
      // 用户在会话里说了一句之后：提加预算
      withUsage(call("propose_plan_change", { plan: { stages: [raised] }, why: "要接着做，加预算" }), TRIAL),
      withUsage(say("卡交了"), TRIAL),
      // 确认之后：马上再调用（上下文一样大）也不停
      withUsage(write("b.md", "b"), TRIAL),
      withUsage(say("接着做了"), TRIAL),
    ];
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(plan, run) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "真超");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    await inputsDone(frontend, M1);

    const refused = toolCallsOf(frontend, M1).find((c) => c.tool === "write");
    expect(refused?.blockedBy).toBe("over_budget");
    expect(refused?.resultSummary).toContain("超预算");
    // 交回模型的全文（调用记录上的摘要是截短的）
    const reason = td.daemon.taskExecution.heldCall({ taskId, stageId: "s1" }, "write") ?? "";
    expect(td.daemon.taskExecution.heldCall({ taskId, stageId: "s1" }, "complete_stage")).toBeUndefined();
    expect(td.daemon.taskExecution.heldCall({ taskId, stageId: "s1" }, "propose_plan_change")).toBeUndefined();
    expect(reason).toContain("超预算");
    expect(reason).toMatch(/用了 \d+ token、\d+ 次工具调用（预算 \d+ token、30 次/);
    expect(reason).toContain("追加预算继续");
    expect(reason).toContain("批准加预算的计划变更");
    expect(reason).toContain("不要叫用户去处理审批卡");
    expect(reason).toContain("complete_stage");
    expect(reason).toContain("propose_plan_change");
    // 停下了不再叫醒它：这一轮之后没有新的调用
    const calls = modelCalls(td, taskId);
    await inputsDone(frontend, M1);
    expect(modelCalls(td, taskId)).toBe(calls);

    // 用户问一句，它提计划变更：放行，阶段还停在超预算（卡被拒了也还是停着）
    await frontend.sendText("要加预算吗", { conversation: M1 });
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    await inputsDone(frontend, M1);
    expect(stageOf(td, taskId, "s1")).toMatchObject({ state: "waiting", waitReason: "over_budget" });
    expect((card.payload as PlanChangeCardPayload).changes.some((c) => c.kind === "budget" && c.expands)).toBe(true);

    // 确认：用量从现在起重新算，超预算的事项不用再点，接着做不会马上又停
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    await taskWhere(frontend, (e) => e.change === "plan_changed", "计划变更生效");
    await inputsDone(frontend, M1);
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    expect(stageOf(td, taskId, "s1")).toMatchObject({ state: "running", budget: { toolCalls: 300 } });
    expect(td.daemon.tasks.stageUsage(taskId, "s1").baseTokens).toBeGreaterThanOrEqual(5_000_000);
    expect(td.daemon.inbox.list().find((i) => i.kind === "notice" && i.notice === "over_budget")).toMatchObject({ urgency: "non_blocking", handled: "已加预算" });
    // 确认之后的那次写文件照常执行了
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "write").at(-1)?.blockedBy).toBeUndefined();
  }, 120_000);

  it("回放死锁：上下文超预算 2 倍，这次回复里的 complete_stage 照样放行，阶段验收通过，超预算的事项不用再点，任务接着走", async () => {
    const plan = planOf(30, 5);
    // 第一次写文件（用量还没超）；第二次回复就超了两倍，回复里宣布完成
    const run = [withUsage(write("sources.md", "- 来源\n"), TRIAL), withUsage(completeStage("s1"), HUGE), withUsage(say("交了"), TRIAL)];
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(plan, run) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "死锁");
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    await inputsDone(frontend, M1);
    expect(toolCallsOf(frontend, M1).find((c) => c.tool === "complete_stage")?.blockedBy).toBeUndefined();
    expect(stageOf(td, taskId, "s1")).toMatchObject({ state: "accepted", calls: { estimated: 30 } });
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    expect(stageOf(td, taskId, "s2")?.state).toBe("running");
    expect(td.daemon.inbox.list().find((i) => i.kind === "notice" && i.notice === "over_budget")).toMatchObject({ urgency: "non_blocking", handled: "已交验收" });
  }, 120_000);

  it("超预算时交上来、验收没过：这一支重新停下（放一条新的事项），不是一直宣布不了，点继续之后改好再宣布就过了", async () => {
    const plan = planOf(30);
    const run = [
      // 超了，宣布完成：交付件还没有，脚本验收不过
      withUsage(completeStage("s1"), HUGE),
      withUsage(say("差交付件"), TRIAL),
      withUsage(write("sources.md", "- 来源\n"), TRIAL),
      withUsage(completeStage("s1"), TRIAL),
      withUsage(say("交了"), TRIAL),
    ];
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(plan, run) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "没过");
    await taskWhere(frontend, (e) => e.change === "stage_returned" && e.stageId === "s1", "验收退回");
    await inputsDone(frontend, M1);
    const result = toolCallsOf(frontend, M1).find((c) => c.tool === "complete_stage")?.resultSummary ?? "";
    expect(result).toContain("验收没通过");
    expect(result).toContain("还超着预算");
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "waiting_for_user", waitReason: "over_budget" });
    const open = td.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "over_budget" && i.handled === undefined);
    expect(open).toHaveLength(1);
    ok(await frontend.inboxAction({ itemIds: [open[0]!.id], action: "handle", choice: "追加预算继续" }));
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    await inputsDone(frontend, M1);
  }, 120_000);

  it("别的等用户（等审批、等回答）的拒绝信息也说清楚在等什么", async () => {
    const plan = planOf(0);
    const run = [call("wait_for_user", { reason: "要你选一个来源" }), withUsage(call("report_progress", { text: "还在等" }), TRIAL), withUsage(completeStage("s1"), TRIAL), withUsage(say("等着"), TRIAL)];
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(plan, run) });
    const frontend = await connect(td.url);
    await confirmTask(td, frontend, "等我");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "stuck", "转等我");
    const refused = await eventually(() => toolCallsOf(frontend, M1).filter((c) => c.tool === "complete_stage"), () => true, "宣布完成被拒");
    expect(refused.resultSummary).toContain("这次调用没有执行");
    expect(refused.resultSummary).toContain("要你选一个来源");
    expect(refused.resultSummary).toContain("用户回话或点“继续执行”");
    expect(refused.resultSummary).not.toContain("不能这样做");
    await inputsDone(frontend, M1);
  }, 90_000);

  it("模型照着重试：连着被拒 5 次中止手头这一轮，不再花钱陪它试", async () => {
    const plan = planOf(30);
    const retries = Array.from({ length: 12 }, (_, i) => withUsage(write(`r${i}.md`, "x"), TRIAL));
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(plan, [withUsage(write("first.md", "x"), HUGE), ...retries, withUsage(say("不试了"), TRIAL)]) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "重试");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    await inputsDone(frontend, M1);
    const blocked = toolCallsOf(frontend, M1).filter((c) => c.blockedBy === "over_budget");
    expect(blocked.length).toBeGreaterThanOrEqual(5);
    expect(blocked.length).toBeLessThanOrEqual(6);
    // 起草 2 次 + 这一轮最多 6 次：没有把 12 次重试都跑完
    expect(modelCalls(td, taskId)).toBeLessThanOrEqual(8);
  }, 120_000);
});

describe("过期通知不再各叫醒一轮", () => {
  it("连着点几次\"继续\"：每点一次最多多一轮，模型调用次数有上限；说明进展、停下的通知没有各叫醒一轮", async () => {
    // 估 1 次：每一份里第 2 次调用之后说明进展，第 3 次之后停下；停下之后它说一句，这一轮结束
    const small = { cacheHit: 0, cacheMiss: 10, output: 5 };
    const round = [write("a.md", "a"), write("b.md", "b"), write("c.md", "c"), say("超了，等你")].map((s) => withUsage(s, small));
    const clicks = 4;
    const run = Array.from({ length: clicks + 1 }, () => round).flat();
    const td = await startTestDaemon({ config: BUDGET_ON, maintainer: script(planOf(1), run, small) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "连点");
    const openItems = () => td.daemon.inbox.list().filter((x) => x.kind === "notice" && x.notice === "over_budget" && x.handled === undefined);
    for (let i = 0; i < clicks; i++) {
      const item = await eventually(openItems, () => true, `第 ${i + 1} 次超预算`);
      await inputsDone(frontend, M1);
      ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    }
    await eventually(openItems, () => true, "最后一次超预算");
    await inputsDone(frontend, M1);
    // 起草一轮；开始执行一轮，点一次继续多一轮。试验里每点一次多三轮（说明进展、停下、继续）
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.turnStart })).toHaveLength(1 + (clicks + 1));
    // 模型调用：起草 2 次，每一轮 4 次，没有多的
    expect(modelCalls(td, taskId)).toBe(2 + (clicks + 1) * 4);
    const notices = frontend.events({ channel: M1, type: EVENT_TYPES.message }).map((e) => e.payload as MessageEventPayload).filter((m) => m.agentInput);
    // "这一支停下"没有进它的输入；说明进展的通知都没交给它就作废了
    expect(notices.filter((m) => m.message.parts.some((p) => "text" in p && p.text.includes("这一支停下等用户")))).toHaveLength(0);
    const aborted = frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).map((e) => e.payload as { outcome: string; error?: string }).filter((e) => e.outcome === "aborted");
    expect(aborted).toHaveLength(clicks + 1);
    for (const end of aborted) expect(end.error).toContain("过时");
  }, 180_000);

  it("这一轮还没结束时点了继续、接着又超了：排着的\"接着做\"过时了，没有输入，不拉起模型", async () => {
    const plan = planOf(1);
    // 慢慢说话，给测试留出点"继续"的时候；第一次回复就超了，第二次回复还超（追加之后这一份按实测算，所以要超得更多）
    const slow = "还在写".repeat(1000);
    const run = [withUsage(write("a.md", "a"), HUGE), withUsage(say(slow), { cacheHit: 0, cacheMiss: 50_000_000, output: 1000 }), withUsage(say("不该走到这一步"), TRIAL)];
    const td = await startTestDaemon({
      config: BUDGET_ON,
      maintainer: script(plan, run),
      maintainerTokensPerSecond: (_id: string, spawn: number) => (spawn === 2 ? 200 : undefined),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "排着");
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    // 第一次回复里的写文件被拒之后，模型正慢慢说第二段：这时点继续
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    await inputsDone(frontend, M1);
    // 第二段说完又超了：这一支又停下，那条"接着做"没交给它（作废出队），"不该走到这一步"没有走到
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "waiting_for_user", waitReason: "over_budget" });
    const ends = frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).map((e) => e.payload as { outcome: string; error?: string });
    expect(ends.some((e) => e.outcome === "aborted" && (e.error ?? "").includes("过时"))).toBe(true);
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.message }).some((e) => JSON.stringify(e.payload).includes("不该走到这一步"))).toBe(false);
  }, 120_000);
});
