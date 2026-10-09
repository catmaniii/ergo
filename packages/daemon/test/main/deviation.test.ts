// 主切面：偏离和阈值（规格第 8 节"阈值""偏离的逐级升级"，14 号票）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// - 拉回满 3 次后再犯、验收退回 2 次第 3 次还不过：这一支停下、任务转等我（卡住求助），待我处理出现卡住求助事项；
//   用户回话（或点"继续执行"）后这一支接着走，计数清零；
// - 每个阶段按 token（账本里这个阶段干活用掉的）加工具调用次数累计用量：用量超过预算让维护者说明进展（任务状态不变），
//   超过预算的 2 倍转等我（超预算）；超预算只有点"追加预算继续"才接着执行，会话里回话只交给维护者回答；
// - 偏离：授权内的放行只在时间线记一笔；超出授权的先问用户；没预料到的类别先问用户并马上暂停这一支；
//   同一任务累计被用户拒绝 5 次，整个任务转已暂停，看板写明原因。
// 这一支停下、催促、说明进展、累计被拒暂停都在任务的时间线上记一笔偏离（timeline_record，带着阶段）。
// 只涉及一个项目的任务由项目的维护者执行（16 号票）：预算一样算，超了一样转等我。
// 无进展的催促和授权项的续期要拨时钟，在 stall-renewal.test.ts；计划变更在 plan-change.test.ts。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type Plan, type ProgressCardPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { TASK_EVENTS, TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { byMaintainer, internalTask, seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import {
  call,
  cardWhere,
  cardsOf,
  completeStage,
  confirmTask,
  connect,
  eventually,
  fwd,
  inboxOf,
  inputsDone,
  itemWhere,
  latestCards,
  maintainerScript,
  messagesOf,
  noticesOf,
  ok,
  real,
  recordsOf,
  say,
  stageStates,
  tasksOf,
  taskWhere,
  textOf,
  toolCallsOf,
  turnsOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const M1 = maintainerChannel("tm-1");

/** s1 能在 outside/s1 建目录，s2 能在 outside/s2 建目录（越出项目目录，"计划里列了才做"） */
function grantPlan(outside: string, overrides: Partial<Plan> = {}): Plan {
  const base = twoStagePlan();
  return {
    ...base,
    stages: [
      { ...base.stages[0]!, policy: { grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }], temporalRules: [] } },
      { ...base.stages[1]!, policy: { grants: [{ id: "dir2", tool: "make_dir", title: "建 s2 目录", scope: { path: path.join(outside, "s2") } }], temporalRules: [] } },
    ],
    ...overrides,
  };
}

const mkdir = (dir: string) => call("bash", { command: `mkdir -p "${fwd(dir)}"` });

describe("拉回超限", () => {
  it("用到别的阶段的授权被拉回：前 3 次只交回维护者，满 3 次后再犯，这一支停下、任务转等我（卡住求助），待我处理出现卡住求助；用户回话后接着执行，计数清零", async () => {
    const outside = real(makeTempDir("ergou-out-"));
    const td = await startTestDaemon({
      maintainer: maintainerScript(grantPlan(outside), [
        // 在 s1 里用 s2 的授权，4 次
        mkdir(path.join(outside, "s2")),
        mkdir(path.join(outside, "s2")),
        mkdir(path.join(outside, "s2")),
        mkdir(path.join(outside, "s2")),
        say("被拉回了好几次"),
        // 停下之后收到的通知
        say("知道了，等你"),
        // 用户回话后接着做
        mkdir(path.join(outside, "s1")),
        say("照你说的做了"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "拉回");

    // 前 3 次：拉回次数记在阶段上，任务照常执行中
    const third = await taskWhere(frontend, (e) => e.change === "pulled_back" && e.task.stages?.list?.[0]?.pullBacks === 3, "第 3 次拉回");
    expect(third.task.state).toBe("running");
    // 第 4 次：这一支停下，没有别的能推进的阶段，任务转等我（卡住求助）
    const waiting = await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "stuck", "转等我");
    expect(waiting).toMatchObject({ by: "system", task: { state: "waiting_for_user", waitReason: "stuck" } });
    expect(waiting.task.waitNote).toContain("被拉回（按规则退回）3 次后又被拉回");
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "stuck", pullBacks: 4 });
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help).toMatchObject({ urgency: "blocking", actions: ["继续执行"], data: { taskId, stageIds: ["s1"] } });
    expect(help.kind === "notice" && help.body).toContain("被拉回");
    // 卡住求助先到、第 4 次调用的记录可能还在路上：等 4 次都有了判定再比对
    const calls = await eventually(() => [toolCallsOf(frontend, M1).filter((c) => c.tool === "bash" && c.blockedBy !== undefined)], (cs) => cs.length === 4, "4 次被拉回的调用");
    expect(calls.map((c) => c.blockedBy)).toEqual(["pull_back", "pull_back", "pull_back", "pull_back"]);
    expect(fs.existsSync(path.join(outside, "s2"))).toBe(false);
    // 维护者收到"这一支停下"的通知；时间线上记一笔偏离（属于 s1）
    await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("这一支停下等用户"), "停下的通知");
    const deviation = recordsOf(frontend, M1).find((r) => r.record.kind === "deviation");
    expect(deviation).toMatchObject({ taskId, stageId: "s1", record: { summary: expect.stringContaining("被拉回（按规则退回）3 次后又被拉回") } });

    // 用户在任务详情里回话：任务接着执行，这一支回到进行中，拉回次数清零；卡住求助事项记成处理过
    await turnsOf(frontend, M1, 3);
    await frontend.sendText("别碰 s2 的目录，先把 s1 的建好", { conversation: M1 });
    const resumed = await taskWhere(frontend, (e) => e.change === "resumed" && e.from === "waiting_for_user");
    expect(resumed.task.state).toBe("running");
    expect(resumed.task.stages?.list?.[0]?.pullBacks).toBeUndefined();
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1" && e.task.stages?.list?.[0]?.state === "running", "s1 接着做");
    await itemWhere(frontend, (i) => i.id === help.id && i.kind === "notice" && i.handled === "继续执行", "卡住求助记成处理过");
    await turnsOf(frontend, M1, 4);
    expect(fs.existsSync(path.join(outside, "s1"))).toBe(true);
  }, 90_000);
});

describe("验收第 3 次还不过", () => {
  it("前 2 次退回只交回维护者；第 3 次还不过，这一支停下、任务转等我（卡住求助），待我处理出现事项；点\"继续执行\"后这一支接着走、退回次数清零", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [completeStage("s1"), completeStage("s1"), completeStage("s1"), say("三次都没过"), say("等你"), write("sources.md", "- 来源\n"), completeStage("s1"), say("过了")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "验收");

    const waiting = await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "stuck", "转等我");
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "stuck", returns: 3, attempts: 3 });
    expect(waiting.task.waitNote).toContain("第 3 次还没通过");
    const returned = toolCallsOf(frontend, M1).filter((c) => c.tool === "complete_stage");
    await waitUntilLength(() => toolCallsOf(frontend, M1).filter((c) => c.tool === "complete_stage"), 3);
    const results = toolCallsOf(frontend, M1).filter((c) => c.tool === "complete_stage").map((c) => c.resultSummary ?? "");
    expect(returned.length).toBeGreaterThan(0);
    expect(results[0]).toContain("验收没通过");
    expect(results[2]).toContain("第 3 次还没通过");
    // 每次的结论都是一张进度卡
    const verdicts = cardsOf(frontend).filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).kind === "acceptance");
    expect(verdicts).toHaveLength(3);
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help.kind === "notice" && help.body).toContain("验收退回 2 次后");

    // 在待我处理里点"继续执行"：这一支接着走，退回次数清零；维护者改好再宣布完成，通过
    ok(await frontend.inboxAction({ itemIds: [help.id], action: "handle", choice: "继续执行" }));
    const unblocked = await taskWhere(frontend, (e) => e.change === "stage_unblocked" && e.stageId === "s1");
    expect(unblocked.task.stages?.list?.[0]?.returns).toBeUndefined();
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "改好后验收通过");
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    expect(noticesOf(frontend, M1).some((m) => textOf(m).includes("用户让") && textOf(m).includes("接着做"))).toBe(true);
  }, 90_000);
});

async function waitUntilLength<T>(list: () => readonly T[], n: number) {
  await eventually(() => [list()], (l) => l.length >= n, `${n} 条`);
}

describe("预算", () => {
  it("工具调用次数超出预算：让维护者说明进展（一条通知进它的会话，任务状态不变）；超出 2 倍这一支停下、任务转等我（超预算），待我处理出现事项；点\"追加预算继续\"后再给一份预算", async () => {
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 0, toolCalls: 2 } }, base.stages[1]!] };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        write("a.md", "a"),
        write("b.md", "b"),
        write("c.md", "c"),
        // 第 3 次之后超出 1 倍：运行时让它说明进展
        call("report_progress", { text: "资料找了一半，还要两三步" }),
        write("d.md", "d"),
        // 第 5 次之后超出 2 倍：这一支停下
        say("超了"),
        // 说明进展的通知、停下的通知各一轮
        say("知道了"),
        say("等你"),
        write("sources.md", "- 来源\n"),
        completeStage("s1"),
        say("交了"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "预算");

    const explain = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("用量已经超过预算"), "说明进展的通知");
    expect(textOf(explain)).toContain("预算 0 token、2 次");
    expect(textOf(explain)).toContain("用量超过预算的 2 倍时运行时会让这一支停下");
    expect(recordsOf(frontend, M1).find((r) => r.record.summary.includes("让维护者说明进展"))).toMatchObject({ stageId: "s1", record: { kind: "deviation" } });
    const card = await cardWhere(frontend, (c) => c.type === "progress" && (c.payload as ProgressCardPayload).kind === "progress", "进度卡");
    expect(card.payload).toMatchObject({ text: "资料找了一半，还要两三步" });

    const waiting = await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    expect(waiting).toMatchObject({ by: "system", task: { state: "waiting_for_user", waitReason: "over_budget" } });
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "over_budget" });
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    expect(item).toMatchObject({ urgency: "blocking", actions: ["追加预算继续"], data: { taskId, stageIds: ["s1"] } });
    expect(item.kind === "notice" && item.body).toMatch(/用了 \d+ token、5 次工具调用（预算 0 token、2 次），超过预算的 2 倍/);
    // 用户能在任务详情里点继续（超预算是用户点"继续"就接着走的）
    expect(td.daemon.tasks.get(taskId)?.waitReason).toBe("over_budget");

    await inputsDone(frontend, M1);
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd })).toHaveLength(4);
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    await taskWhere(frontend, (e) => e.change === "resumed" && e.from === "waiting_for_user", "接着执行");
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    expect(td.daemon.tasks.stageUsage(taskId, "s1").toolCalls).toBeLessThanOrEqual(2);
    // 给 Web 的回放：说明进展的通知、超预算的事项、看板上的"等我 · 超预算"
    await inputsDone(frontend, M1);
    saveOrCheckRecording("task-over-budget", frontend.recording, { perChannel: true });
  }, 90_000);

  it("超预算的任务在会话里收到用户的话：交给维护者回答，任务仍是等我（超预算）、预算没重给；点\"追加预算继续\"后才接着执行、重新给一整份预算", async () => {
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 0, toolCalls: 1 } }, base.stages[1]!] };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        write("a.md", "a"),
        // 第 2 次之后超过预算：说明进展的通知排在这一轮之后
        write("b.md", "b"),
        // 第 3 次之后超过预算的 2 倍：这一支停下
        write("c.md", "c"),
        say("超了"),
        say("资料比想的多"),
        say("等你"),
        // 用户在会话里问了一句：照常回答，不接着做
        say("超在资料收集上，还差两三个来源"),
        // 点了"追加预算继续"之后
        say("接着做"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "超预算回话");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    const stopped = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("这一支停下等用户（超预算"), "停下的通知");
    expect(textOf(stopped)).toContain("用户点“追加预算继续”后你会收到通知");
    expect(textOf(stopped)).not.toContain("用户回话");
    await inputsDone(frontend, M1);
    const budgetResets = () => td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.budgetReset);
    const usedCalls = td.daemon.tasks.stageUsage(taskId, "s1").toolCalls;
    expect(usedCalls).toBe(3);

    // 用户在会话里问一句：维护者照常回答，任务仍是等我（超预算），预算没重给，超预算事项还在等处理
    const turns = frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length;
    await frontend.sendText("为什么超了？", { conversation: M1 });
    await turnsOf(frontend, M1, turns + 1);
    await inputsDone(frontend, M1);
    expect(messagesOf(frontend, M1).at(-1)).toMatchObject({ message: { speaker: "agent" } });
    expect(textOf(messagesOf(frontend, M1).at(-1)!)).toBe("超在资料收集上，还差两三个来源");
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "waiting_for_user", waitReason: "over_budget" });
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "over_budget" });
    expect(tasksOf(frontend).some((e) => e.change === "resumed")).toBe(false);
    expect(budgetResets()).toHaveLength(0);
    expect(td.daemon.tasks.stageUsage(taskId, "s1").toolCalls).toBe(usedCalls);
    const still = td.daemon.inbox.list().find((i) => i.id === item.id);
    expect(still).toMatchObject({ kind: "notice", urgency: "blocking" });
    expect(still?.kind === "notice" && still.handled).toBeUndefined();

    // 点"追加预算继续"：接着执行，这个阶段重新给一整份预算
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    await taskWhere(frontend, (e) => e.change === "resumed" && e.from === "waiting_for_user", "接着执行");
    expect(budgetResets()).toHaveLength(1);
    expect(td.daemon.tasks.stageUsage(taskId, "s1").toolCalls).toBe(0);
    await inputsDone(frontend, M1);
  }, 90_000);

  it("项目的维护者执行的任务（16 号票）：工具调用超出预算的 2 倍，这一支停下、任务转等我（超预算），停下的通知进项目维护者的会话（带着项目和任务）；点\"追加预算继续\"后接着执行", async () => {
    const PM1 = maintainerChannel("pm-1");
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 0, toolCalls: 1 } }, base.stages[1]!] };
    const td = await startTestDaemon({
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 起草计划的工单段：交计划，写回进展、写这一段的摘要（不写回工单不结束）
        if (spawn === 1)
          return [submitPlanStep(plan), call("write_progress", { content: "调研：计划交了，等确认。" }), call("write_segment_summary", { summary: "起草了调研的计划" }), say("计划交上去了")];
        // 执行的工单段：第 2 次之后超过预算（说明进展），第 3 次之后超过 2 倍（这一支停下）
        return [write("a.md", "a"), write("b.md", "b"), write("c.md", "c"), say("超了"), say("资料比想的多"), say("等你"), say("接着做")];
      },
    });
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, PM1].map((c) => [c, 0])));
    internalTask(td.daemon, "记账本", "项目里的调研");
    const created = await taskWhere(frontend, (e) => e.change === "created" && e.task.title === "项目里的调研", "建好的任务");
    const taskId = created.task.id;
    td.daemon.tasks.writeBrief(taskId, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: ["记账本"], memoryScope: "" }, byMaintainer(td.daemon, taskId));
    // 由项目的维护者执行（不新建任务自己的维护者）
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ maintainerId: "pm-1" });
    const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as { taskId?: string }).taskId === taskId, "计划卡");
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    const waiting = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    expect(waiting).toMatchObject({ by: "system", task: { state: "waiting_for_user", waitReason: "over_budget", maintainerId: "pm-1" } });
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "over_budget" });
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    expect(item).toMatchObject({ urgency: "blocking", actions: ["追加预算继续"], data: { taskId, stageIds: ["s1"] } });
    expect(item.kind === "notice" && item.body).toMatch(/用了 \d+ token、3 次工具调用（预算 0 token、1 次），超过预算的 2 倍/);
    // 说明进展、停下的通知都进了项目维护者的会话，带着项目和任务、阶段
    const explain = await eventually(() => noticesOf(frontend, PM1), (m) => textOf(m).includes("用量已经超过预算"), "说明进展的通知");
    expect(explain).toMatchObject({ projectId: "p-1", taskId, stageId: "s1" });
    const stopped = await eventually(() => noticesOf(frontend, PM1), (m) => textOf(m).includes("这一支停下等用户（超预算"), "停下的通知");
    expect(stopped).toMatchObject({ projectId: "p-1", taskId });
    expect(recordsOf(frontend, PM1).find((r) => r.record.kind === "deviation" && r.record.summary.includes("超预算"))).toMatchObject({ taskId, stageId: "s1" });
    await inputsDone(frontend, PM1);
    expect(td.daemon.tasks.stageUsage(taskId, "s1").toolCalls).toBe(3);

    // 点"追加预算继续"：接着执行，这个阶段重新给一整份预算
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "追加预算继续" }));
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "resumed" && e.from === "waiting_for_user", "接着执行");
    expect(td.daemon.tasks.stageUsage(taskId, "s1").toolCalls).toBe(0);
    await inputsDone(frontend, PM1);
  }, 90_000);

  it("token 取自账本（这个阶段干活用掉的）：预算的 token 超过 2 倍，这一支停下（超预算）", async () => {
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 10, toolCalls: 0 } }, base.stages[1]!] };
    const td = await startTestDaemon({ maintainer: maintainerScript(plan, [say("先想想"), say("好")]) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "token 预算");
    await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "over_budget", "转等我（超预算）");
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "over_budget");
    const tokens = Number(/用了 (\d+) token/.exec(item.kind === "notice" ? (item.body ?? "") : "")?.[1]);
    expect(tokens).toBeGreaterThan(20);
    expect(td.daemon.ledger.stageTokens(taskId, "s1", { budget: true })).toBeGreaterThanOrEqual(tokens);
  }, 60_000);
});

describe("偏离的逐级升级", () => {
  it("授权内的放行、只在时间线记一笔；超出授权的先问（审批卡，等用户）；没预料到的类别先问并马上暂停这一支（不等），别的阶段接着推进", async () => {
    const outside = real(makeTempDir("ergou-out-"));
    const base = grantPlan(outside);
    // s2 不依赖 s1：s1 停下时能先做 s2
    const plan: Plan = { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }] };
    const td = await startTestDaemon({
      // 等审批等很久：没预料到的类别不等，这里不会等到超时
      config: { approvals: { waitMinutes: 30 } },
      maintainer: maintainerScript(plan, [
        // 授权内
        mkdir(path.join(outside, "s1")),
        // 超出授权（计划对"越出项目目录"有授权项，对象不对）：先问，等用户
        mkdir(path.join(outside, "other")),
        // 没预料到的类别（在 GitHub 上发 issue 是"以我的名义对外发送"，计划里没有这个类别的授权项）：先问，马上暂停这一支
        call("bash", { command: "gh issue create --title 进展 --body 做了一半" }),
        say("s1 停下了"),
        say("去做 s2"),
      ]),
    });
    const frontend = await connect(td.url);
    await confirmTask(td, frontend, "偏离");

    // 超出授权：审批卡，调用在等用户
    const exceeds = await cardWhere(frontend, (c) => c.type === "approval", "超出授权的审批卡");
    expect(JSON.stringify(exceeds.payload)).toContain("超出授权");
    ok(await frontend.cardAction({ cardId: exceeds.id, action: "approve", expectedVersion: 1 }));
    // 没预料到的类别：审批卡，这一支马上停下（不等 30 分钟），s2 接着做
    const unanticipated = await eventually(() => latestCards(frontend), (c) => c.type === "approval" && c.id !== exceeds.id, "没预料到的类别的审批卡").catch((err) => {
      console.log(JSON.stringify(toolCallsOf(frontend, M1), null, 1), JSON.stringify(messagesOf(frontend, M1).map(textOf), null, 1));
      throw err;
    });
    expect(JSON.stringify(unanticipated.payload)).toContain("计划没预料到这类操作");
    const stopped = await taskWhere(frontend, (e) => e.change === "stage_waiting" && e.stageId === "s1", "s1 停下");
    expect(stopped.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "approval" });
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "s2 开始");

    const recorded = await eventually(() => [toolCallsOf(frontend, M1).filter((c) => c.tool === "bash")], (l) => l.length === 3, "三次调用的记录");
    expect(recorded.map((c) => [c.disposition, c.withinGrant ?? false, c.outcome])).toEqual([
      ["do", true, "done"],
      ["ask_first", false, "done"],
      ["ask_first", false, "blocked"],
    ]);
    expect(recorded[2]!.resultSummary).toContain("已提交审批，等待用户");
    // 授权内的那次：只有时间线上的一笔，没有审批卡、没有待我处理事项
    expect(cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1)).toHaveLength(2);
    expect(inboxOf(frontend).filter((i) => i.kind === "card").length).toBeGreaterThanOrEqual(2);
    expect(stageStates(td.daemon.tasks.get(stopped.task.id)!)).toEqual({ s1: "waiting", s2: "running" });
  }, 90_000);

  it("同一任务累计被用户拒绝 5 次：整个任务转已暂停，看板写明原因；继续后被拒次数清零", async () => {
    const outside = real(makeTempDir("ergou-out-"));
    const plan = grantPlan(outside);
    const td = await startTestDaemon({
      // 先做一次授权内的（只在时间线记一笔），再五次超出授权。第 5 次被拒时任务转已暂停、中止维护者手头这一轮，被拒之后的那次模型调用
      // 和中止谁先到子进程每次不一样（满载时常是中止先到），有三种结果：调用做完、回复落盘；调用做到一半被中止，用掉了剧本的一步、
      // 回复不落盘；还没调用就被中止，剧本的这一步留给继续之后的那次调用。三种都照样记一次账。
      // 让这两次调用都什么也不说（空回复不落盘），不管用掉的是剧本的哪一步，录下的事件流都一样
      maintainer: maintainerScript(plan, [mkdir(path.join(outside, "s1")), ...[1, 2, 3, 4, 5].map((n) => mkdir(path.join(outside, `other${n}`))), say(""), say(""), say("好")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "被拒");
    for (let n = 1; n <= 5; n++) {
      const card = await eventually(() => latestCards(frontend), (c) => c.type === "approval" && c.status === "pending", `第 ${n} 张审批卡`);
      ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version, note: `第 ${n} 次不行` }));
      await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");
      if (n < 5) await taskWhere(frontend, (e) => e.change === "rejection_counted" && e.task.rejections === n, `累计被拒 ${n} 次`);
    }
    const paused = await taskWhere(frontend, (e) => e.change === "paused", "暂停");
    expect(paused).toMatchObject({ by: "system", task: { state: "paused", pauseReason: "too_many_rejections", rejections: 5 } });
    expect(recordsOf(frontend, M1).some((r) => r.record.kind === "deviation" && r.record.summary.includes("累计拒绝了 5 次"))).toBe(true);

    // 暂停时维护者手头这一轮（被拒后的那次模型调用）先收尾，再继续（录下的事件流每次一样）
    await inputsDone(frontend, M1);
    ok(await frontend.taskAction({ taskId, action: "resume" }));
    const resumed = await taskWhere(frontend, (e) => e.change === "resumed" && e.from === "paused");
    expect(resumed.task.pauseReason).toBeUndefined();
    expect(resumed.task.rejections).toBe(0);
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "bash")[0]).toMatchObject({ disposition: "do", withinGrant: true, outcome: "done" });
    // 给 Web 的回放：授权内的一笔、审批卡、看板上的"已暂停 · 累计被拒"
    await inputsDone(frontend, M1);
    saveOrCheckRecording("task-rejections", frontend.recording, { perChannel: true });
  }, 90_000);
});
