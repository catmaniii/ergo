// 主切面：流程的会话回退（153 号票：带 report_step、状态进行中的那条 assistant 消息之前是"撤回到步骤「…」开始前"；
// 回退、切换分支之后授权的计划和已执行的调用按保留的分支重新算；计划核对按保留的分支上成功执行过的调用重建、重放）。真的守护进程，流程的维护者接 faux 剧本，
// 测试扮演前端：
// - 撤回到步骤开始前：那一步及之后回到没做；计划核对按保留的分支重建——被放弃那段里做过的那一步不算做过，跳过它直接做后一步被引回；
//   固定计划撤回之后不自动接着做（等你说话）；切回原来那条分支：步骤、核对按那条分支（那条上做过的照算，后一步放行）；
// - 撤回到计划授权之前（回到一条在计划卡等授权时说的话之前）：流程回到待授权——那一版重新放进待我处理等你授权，原来授权过的那一版作废；
//   重启后照旧；重新授权之后原样留着的授权项接着用原来的授予时间（被放弃那段里用掉的次数照样算）；
// - 授权项的次数不随回退清零：撤回到步骤开始前之后再做一次对外的那一步要问你；废弃分支上挂着的审批卡作废；
// - 定时触发的流程：一次运行是一段会话，回退点只在最近这一次运行里（上一次运行里的步骤开始撤回不了）。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type ApprovalCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type ResponseFrame,
  ROLLBACK_VOIDED_CARD,
  type RollbackPreview,
  type RollbackSessionResult,
  type RollbackTarget,
  type ScheduledJobEventPayload,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  type TaskStageView,
  WORKFLOW_STAGE_ID,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const LONG_TEST_MS = 150_000;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const propose = (draft: WorkflowPlanDraft) => call("propose_plan", draft as unknown as Record<string, unknown>);
const report = (stepId: string, status: string, gist?: string) => call("report_step", { stepId, status, ...(gist ? { gist } : {}) });
/** 撤回时写分支摘要的那次：要求是 BRANCH_SUMMARY_INSTRUCTIONS 的原话 */
const summaryStep = (text: string): FauxStep => ({ kind: "branch_on_context", contains: ["用中文写 3~5 行"], matched: say(text), otherwise: say("摘要写错了") });

const messagesOf = (frontend: TestFrontend, channel = M1) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => [...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values()];
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const stepStarts = (frontend: TestFrontend, channel = M1) =>
  frontend
    .events({ channel, type: EVENT_TYPES.stageStart })
    .map((f) => ({ seq: f.seq, ...(f.payload as StageStartEventPayload) }))
    .filter((m) => m.stepId !== undefined);
const stepStates = (task: Pick<Task, "steps">) => Object.fromEntries((task.steps?.list ?? []).map((s) => [s.stepId, s.state]));
const toolParts = (frontend: TestFrontend, channel = M1): ToolCallPart[] =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const ok = <T>(r: ResponseFrame): T => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const rollback = (frontend: TestFrontend, before: RollbackTarget, key: string, conversation = M1) => frontend.request(METHODS.rollbackSession, { conversation, before }, key);
const preview = (url: string, before: RollbackTarget) => requestJson<RollbackPreview>(url, HTTP_PATHS.rollbackPreview(M1, before));

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const turnsOf = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, {
    timeoutMs: 60_000,
    describe: () => `等维护者处理完 ${n} 条输入；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}${p.blockedBy ? `/${p.blockedBy}` : ""}`).join("、")}`,
  });
const after = <T>(list: readonly T[], anchor: T) => (x: T) => list.indexOf(x) > list.indexOf(anchor);

/** 本地时间 2026 年 m 月 d 日 hh:mm（定时触发的流程用手动拨的时钟） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

const brief = { goal: "整理一份周报", acceptanceCriteria: ["周报写好、读过一遍"], constraints: [], projects: [], memoryScope: "" };

/** 写资料、写周报（在写资料之后）、读一遍周报（在写周报之后） */
const threeSteps: WorkflowPlanDraft = {
  goal: "写好周报并读一遍",
  steps: [
    { id: "s1", title: "写资料", tool: TOOL.write, args: { path: "a.md", content: "资料\n" } },
    { id: "s2", title: "写周报", tool: TOOL.write, args: { path: "b.md", content: "# 周报\n" }, after: ["s1"] },
    { id: "s3", title: "读一遍周报", tool: TOOL.read, args: { path: "b.md" }, after: ["s2"] },
  ],
  rules: [],
};

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, M1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 建一个流程、写好任务书，等维护者交上来的流程计划卡 */
async function draftWorkflow(td: TestDaemon, frontend: TestFrontend): Promise<{ taskId: string; card: Card }> {
  const task = td.daemon.tasks.createByRequest({ title: "整理周报", summary: "整理周报", kind: "workflow" });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.status === "pending" && (c.payload as WorkflowPlanCardPayload).taskId === task.id, "流程计划卡");
  return { taskId: task.id, card };
}

const authorize = async (frontend: TestFrontend, card: Card) => ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));

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

describe("会话回退（流程）", { timeout: LONG_TEST_MS }, () => {
  it("撤回到步骤开始前：那一步及之后回到没做，计划核对按保留的分支重建（跳过那一步直接做后一步被引回），不自动接着做；切回原来那条分支后步骤、核对按那条", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(threeSteps), say("计划交上去了")]
          : [
              report("s1", "in_progress"),
              call(TOOL.write, { path: "a.md", content: "资料\n" }),
              report("s2", "in_progress"),
              call(TOOL.write, { path: "b.md", content: "# 周报\n" }),
              say("资料和周报写好了"),
              // 收尾提醒（s3 没做）
              say("s3 晚点做"),
              // 撤回到 s2 开始前：写分支摘要
              summaryStep("摘要：s1 写了资料，s2 写了周报，s3 没做；没有对外效果。"),
              // 撤回之后你说"接着做"：跳过 s2 直接读周报——保留的分支上 s2 没做过，被引回
              call(TOOL.read, { path: "b.md" }),
              say("被引回了，等你的话"),
              // 收尾提醒（s2、s3 没做）
              say("好的"),
              // 切回原来那条分支之后你说"接着做"：那条上 s2 做过了，读周报放行
              report("s3", "in_progress"),
              call(TOOL.read, { path: "b.md" }),
              say("做完了"),
            ],
    });
    const frontend = await connect(td.url);
    const { taskId, card } = await draftWorkflow(td, frontend);
    await turnsOf(frontend, 1);
    await authorize(frontend, card);
    await turnsOf(frontend, 3);
    const original = td.daemon.tasks.get(taskId)!;
    expect(original.state).toBe("running");
    expect(stepStates(original)).toEqual({ s1: "done", s2: "done", s3: "pending" });

    // 步骤开始的记号：每次 report_step(in_progress) 一条，回退点挂在那条回复之前（targetId 是那条 assistant 消息的父条目）
    const marks = stepStarts(frontend);
    expect(marks.map((m) => [m.stepId, m.title])).toEqual([
      ["s1", "写资料"],
      ["s2", "写周报"],
    ]);
    expect(marks[1]).toMatchObject({ taskId, stageId: WORKFLOW_STAGE_ID, via: { tool: "report_step", after: false } });
    // 确认框：这一段写了周报（本机、能申请撤回）
    const effects = (await preview(td.url, { stageStart: marks[1]!.id })).body.effects;
    expect(effects.map((e) => [e.tool, e.scope, e.undoable])).toEqual([[TOOL.write, "local", true]]);

    const result = ok<RollbackSessionResult>(await rollback(frontend, { stageStart: marks[1]!.id }, "k-s2"));
    expect(result.branchId).toBe("b1");
    // 按保留的分支推导：s2 开始之前 s1 在做、s2 和 s3 没做；任务还在执行中
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
    expect(rolled).toMatchObject({ from: "running", by: "user", task: { state: "running" } });
    expect(stepStates(rolled.task)).toEqual({ s1: "in_progress", s2: "pending", s3: "pending" });
    expect(rolled.task.steps?.done).toBe(0);
    // 固定计划撤回之后不自动接着做——没有交给维护者的交代，分支摘要上也不记
    const summary = messagesOf(frontend).find((m) => m.message.id === result.summaryMessageId)!;
    expect(summary.message.parts[0]).toMatchObject({ type: "branch_summary", branchId: "b1" });
    expect((summary.message.parts[0] as { notice?: string }).notice).toBeUndefined();
    await settled(td, "tm-1");
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.turnStart }).length).toBe(3);

    // 你说"接着做"：跳过 s2 直接读周报——被放弃那段里写过周报，但保留的分支上没有，核对按保留的分支重建：引回 s2
    await frontend.sendText("接着做", { conversation: M1, taskId });
    await turnsOf(frontend, 5);
    const redirected = toolParts(frontend).filter((p) => p.tool === TOOL.read).at(-1)!;
    expect([redirected.outcome, redirected.blockedBy]).toEqual(["blocked", "plan_redirect"]);
    expect(stepStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "done", s2: "pending", s3: "pending" });

    // 切回原来那条分支（151 号票的切换）：步骤按那条分支推导（s1、s2 做完了），核对也按那条——读周报放行，流程做完
    expect(ok(await frontend.request(METHODS.switchBranch, { conversation: M1, branchId: "b0" }, "k-back"))).toEqual({ branchId: "b0" });
    const back = await taskWhere(frontend, (e) => e.change === "rolled_back" && after(tasksOf(frontend), rolled)(e), "切回原来那条");
    expect(back.task.state).toBe("running");
    expect(stepStates(back.task)).toEqual({ s1: "done", s2: "done", s3: "pending" });
    expect((frontend.events({ channel: M1, type: EVENT_TYPES.sessionBranch }).at(-1)!.payload as SessionBranchEventPayload).change).toBe("switch");
    await frontend.sendText("接着做", { conversation: M1, taskId });
    const done = await taskWhere(frontend, (e) => e.change === "completed", "流程做完");
    expect(stepStates(done.task)).toEqual({ s1: "done", s2: "done", s3: "done" });
    expect(toolParts(frontend).filter((p) => p.tool === TOOL.read).at(-1)!.outcome).toBe("done");
  });

  it("撤回到计划授权之前：流程回到待授权（那一版重新等你授权，授权过的那一版作废），重启后照旧；重新授权之后原样留着的授权项接着用原来的授予时间", async () => {
    const dataDir = makeTempDir("ergo-rollback-flow-data-");
    const homeDir = makeTempDir("ergo-rollback-flow-home-");
    const FLOW_SUMMARY = "摘要：授权了计划 v1，写了资料，流程做完了。";
    const oneStep: WorkflowPlanDraft = { goal: "写资料", steps: [{ id: "s1", title: "写资料", tool: TOOL.write, args: { path: "a.md", content: "资料\n" } }], rules: [] };
    const first = await startTestDaemon({
      reuse: { dataDir, homeDir },
      // 流程做完之后维护者可能已经退出：撤回时写分支摘要的那次是新拉起的子进程
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(oneStep), say("计划交上去了"), say("好的，授权之后照计划写")]
          : spawn === 2
            ? [report("s1", "in_progress"), call(TOOL.write, { path: "a.md", content: "资料\n" }), say("写好了"), summaryStep(FLOW_SUMMARY)]
            : [summaryStep(FLOW_SUMMARY)],
    });
    const frontend = await connect(first.url);
    const { taskId, card } = await draftWorkflow(first, frontend);
    await turnsOf(frontend, 1);
    // 流程计划卡在等你授权时，你在任务里说了一句
    const said = await frontend.sendText("资料写详细点", { conversation: M1, taskId });
    await turnsOf(frontend, 2);
    await authorize(frontend, card);
    await taskWhere(frontend, (e) => e.change === "completed", "流程做完");
    const v1 = first.daemon.tasks.confirmedPlan(taskId)!;
    expect(v1.revision).toBe(1);

    ok<RollbackSessionResult>(await rollback(frontend, { messageId: said.messageId }, "k-auth"));
    // 回到待授权：授权过的第 1 版作废（不算你拒绝），同样的计划作为第 2 版重新等你授权（新的一张流程计划卡，放进待我处理）
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
    expect(rolled).toMatchObject({ from: "done", by: "user", task: { state: "awaiting_confirm" } });
    expect(rolled.task.steps).toEqual({ total: 1, done: 0 });
    expect(first.daemon.tasks.confirmedPlan(taskId)).toBeUndefined();
    expect(first.daemon.tasks.plan(v1.planId)?.status).toBe("rejected");
    const again = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.status === "pending" && (c.payload as WorkflowPlanCardPayload).revision === 2, "重新等授权的流程计划卡");
    expect((again.payload as WorkflowPlanCardPayload).plan.steps.map((s) => [s.id, s.tool, s.args])).toEqual([["s1", TOOL.write, { path: "a.md", content: "资料\n" }]]);
    expect(rolled.task.planCardId).toBe(again.id);
    await first.daemon.stop();

    // 重启：还在待授权、卡还在等；授权之后照计划执行，原样留着的授权项接着用第 1 版的授予时间：被放弃那段里写的那次照样算
    const second = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: () => [report("s1", "in_progress"), say("在做")],
    });
    expect(second.daemon.tasks.get(taskId)).toMatchObject({ state: "awaiting_confirm", planCardId: again.id });
    const laptop = await connect(second.url);
    await waitUntil(() => cardsOf(laptop).some((c) => c.id === again.id && c.status === "pending"));
    await authorize(laptop, cardsOf(laptop).find((c) => c.id === again.id)!);
    await taskWhere(laptop, (e) => e.change === "started", "重新授权后开始执行");
    const res = await fetch(`${second.url}${HTTP_PATHS.taskStage(taskId, WORKFLOW_STAGE_ID)}`);
    expect(((await res.json()) as TaskStageView).grantUses.map((g) => g.used)).toEqual([1]);
  });

  it("授权项的次数不随回退清零：撤回到步骤开始前之后再做一次对外的那一步要问你；废弃分支上挂着的审批卡作废", async () => {
    const hook = await localHook();
    try {
      const post = `curl -X POST ${hook.url} -d "hello"`;
      const draft: WorkflowPlanDraft = {
        goal: "发通知、写记录",
        steps: [
          { id: "s1", title: "发通知", tool: TOOL.bash, args: { command: post } },
          { id: "s2", title: "写记录", tool: TOOL.write, args: { path: "log.md", content: "发过了\n" }, after: ["s1"] },
        ],
        rules: [],
      };
      const td = await startTestDaemon({
        config: { approvals: { waitMinutes: 0.02 } },
        maintainer: (_id, spawn) =>
          spawn === 1
            ? [propose(draft), say("计划交上去了")]
            : [
                report("s1", "in_progress"),
                call(TOOL.bash, { command: post }),
                // 计划外写 ask/ 目录：先问我，等了一会儿没人批，挂起
                call(TOOL.write, { path: "ask/x.txt", content: "x" }),
                say("在等批准"),
                summaryStep("摘要：往 hook 发过一次，在等批准写 ask 目录。"),
                // 撤回到 s1 开始前之后你说"接着做"：再发一次
                report("s1", "in_progress"),
                call(TOOL.bash, { command: post }),
                say("在等批准"),
              ],
      });
      const frontend = await connect(td.url);
      const { taskId, card } = await draftWorkflow(td, frontend);
      const work = fs.realpathSync.native(path.join(td.daemon.layout.outputs, taskId));
      fs.writeFileSync(td.daemon.layout.watchCategoriesFile, JSON.stringify({ custom: [{ id: "ask-dir", title: "动 ask 目录", match: { paths: [path.join(work, "ask")] }, chat: "ask_first", task: "ask_first" }] }));
      await turnsOf(frontend, 1);
      await authorize(frontend, card);
      const asked = await cardWhere(frontend, (c) => c.type === "approval" && c.status === "pending" && (c.payload as ApprovalCardPayload).tool === TOOL.write, "写 ask 目录的审批卡");
      await waitUntil(() => messagesOf(frontend).some((m) => textOf(m) === "在等批准"));
      expect(hook.posts()).toBe(1);
      const s1 = stepStarts(frontend).find((m) => m.stepId === "s1")!;
      // 确认框：这一段往外发过一次（收不回）
      expect((await preview(td.url, { stageStart: s1.id })).body.effects.map((e) => [e.scope, e.undoable])).toEqual([["external", false]]);

      ok<RollbackSessionResult>(await rollback(frontend, { stageStart: s1.id }, "k-s1"));
      const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
      expect(stepStates(rolled.task)).toEqual({ s1: "pending", s2: "pending" });
      expect(rolled.task.state).toBe("running");
      // 废弃分支上挂着的审批卡作废，写明用户撤回了会话
      expect(await cardWhere(frontend, (c) => c.id === asked.id && c.status === "expired")).toMatchObject({ expiredNote: ROLLBACK_VOIDED_CARD });

      // 你说"接着做"：再发一次——授权项的次数已经用完（废弃分支上那次照样算），要问你
      await frontend.sendText("接着做", { conversation: M1, taskId });
      const again = await cardWhere(frontend, (c) => c.type === "approval" && c.status === "pending" && (c.payload as ApprovalCardPayload).tool === TOOL.bash, "再发一次的审批卡");
      expect(again.payload).toMatchObject({ taskId, stageId: WORKFLOW_STAGE_ID });
      await waitUntil(() => messagesOf(frontend).filter((m) => textOf(m) === "在等批准").length === 2);
      expect(hook.posts()).toBe(1);
      // 核对照常按保留的分支（这一次对上 s1，不算重复、不算计划外）
      expect((again.payload as ApprovalCardPayload).reason).not.toContain("与已授权的计划不一致");
    } finally {
      await hook.close();
    }
  });

  it("定时触发的流程：一次运行是一段会话，回退点只在最近这一次运行里（上一次运行里的步骤开始撤回不了）", async () => {
    const clock = new ManualClock(at(10, 8, 8, 0));
    const ls = call(TOOL.ls, { path: "." });
    const RUN_SUMMARY = "摘要：第二次运行看过工作目录。";
    const draft: WorkflowPlanDraft = { goal: "看看工作目录", steps: [{ id: "s1", title: "看看工作目录", tool: TOOL.ls, args: { path: "." } }], rules: [] };
    const options: StartTestDaemonOptions = {
      clock,
      secretary: [say("好")],
      // 各次运行可能是新拉起的子进程（会话接着原来的）：撤回时写分支摘要的那次可能也是
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(draft), say("计划交上去了")]
          : spawn === 2
            ? [report("s1", "in_progress"), ls, say("第一次做完了")]
            : spawn === 3
              ? [report("s1", "in_progress"), ls, say("第二次做完了"), summaryStep(RUN_SUMMARY)]
              : [summaryStep(RUN_SUMMARY)],
    };
    const td = await startTestDaemon(options);
    const frontend = await connect(td.url);
    ok(await frontend.startTask("每天看看工作目录", "k-flow", [], "workflow", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
    await taskWhere(frontend, (e) => e.change === "created", "建出的流程");
    td.daemon.tasks.writeBrief("t-1", { goal: "看看工作目录", acceptanceCriteria: ["看过"], constraints: [], projects: [], memoryScope: "" });
    const card = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    await settled(td, "tm-1");
    await authorize(frontend, card);
    const runEnded = (runId: string) =>
      eventually(
        () => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload),
        (e) => e.change === "run_finished" && e.run?.runId === runId,
        `${runId} 结束`,
      );
    clock.advanceTo(at(10, 8, 9, 0));
    await runEnded("j-1-r1");
    await settled(td, "tm-1");
    clock.advanceTo(at(10, 9, 9, 0));
    await runEnded("j-1-r2");
    await settled(td, "tm-1");

    // 两次运行各有一个步骤开始的记号
    const marks = stepStarts(frontend);
    expect(marks.map((m) => [m.taskId, m.stepId])).toEqual([
      ["t-1", "s1"],
      ["t-1", "s1"],
    ]);
    // 上一次运行里的撤回不了（一次运行是一段会话）
    const refused = await rollback(frontend, { stageStart: marks[0]!.id }, "k-r1");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.message).toContain("只能在这段会话里撤回");
    // 这一次运行里的能撤回（运行已经结束了：只回退会话，运行记录不动）
    const result = ok<RollbackSessionResult>(await rollback(frontend, { stageStart: marks[1]!.id }, "k-r2"));
    expect(result.branchId).toBe("b1");
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
  });
});
