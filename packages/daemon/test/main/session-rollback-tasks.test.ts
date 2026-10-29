// 主切面：长程任务维护者的会话回退（152 号票：回退之后状态按保留的分支推导）。真的守护进程，维护者、评审子 agent
// 接 faux 剧本，测试扮演前端：
// - 撤回到阶段开始前（阶段是在"宣布阶段完成"验收通过之后接着开始的：回到那次调用的结果之后）：之前那个阶段的验收照样算数，这个阶段
//   回到未开始、运行时替维护者重新开始它（交代里说撤回了、对外做过的别再做），废弃分支上挂着的审批卡作废、写明"用户撤回了会话"；
//   交给维护者的那句记在分支摘要上；之后照常做完。切换到废弃分支（151 号票的切换）时任务按那条分支推导；
// - 撤回到阶段开始前、再切回原来那条分支：阶段状态回到原来那条的样子（那条上验收了的照算、在做的接着做），卡片不作废；
// - 确认计划时维护者还没说完（开始执行的通知排在它收尾的话前面）：照样能撤回到 s1 开始前，会话频道和子进程都截在提交计划的结果之后；
// - 撤回到计划确认之前（回到一条在计划卡等确认时说的话之前）：任务回到规划中、确认过的计划作废；重启后照旧；维护者重新交计划，再确认；
// - 授权项的次数不随回退清零（ADR 0003：按仍然生效的效果、跨分支算）：废弃分支上用掉的那次照样算，再做一次就要问你；
// - 项目维护者：当前这一段里能撤回（没有它执行的任务，只回退会话）；这一段结束了（重置维护者）就不能撤回了。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type BranchSummaryPart,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  ROLLBACK_VOIDED_CARD,
  type RollbackPreview,
  type RollbackSessionResult,
  type RollbackTarget,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  type TaskStageView,
  onBranchPath,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { seedProject } from "../helpers/projects.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const LONG_TEST_MS = 120_000;
const SUMMARY = "摘要：s2 写了草稿，在等你批准写 ask 目录，没有对外效果。";

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const write = (file: string, content: string) => call("write", { path: file, content });
const completeStage = (stageId: string, summary = `阶段 ${stageId} 做完了`) => call("complete_stage", { stageId, summary });
/** 撤回时写分支摘要的那次：要求是 BRANCH_SUMMARY_INSTRUCTIONS 的原话 */
const summaryStep = (text = SUMMARY): FauxStep => ({ kind: "branch_on_context", contains: ["用中文写 3~5 行"], matched: say(text), otherwise: say("摘要写错了") });
const review = (file: string): FauxStep[] => [call("read", { path: file }), call("submit_review", { results: [{ index: 1, passed: true, reason: "看过了，满足" }] }), say("评审完了")];

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => [...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values()];
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const stageStarts = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.stageStart }).map((f) => ({ seq: f.seq, ...(f.payload as StageStartEventPayload) }));
const stageStates = (task: Task) => Object.fromEntries((task.stages?.list ?? []).map((s) => [s.stageId, s.state]));
const latestTree = (frontend: TestFrontend, channel: string) =>
  (frontend.events({ channel, type: EVENT_TYPES.sessionBranch }).at(-1)?.payload as SessionBranchEventPayload | undefined)?.branches;
const ok = <T>(r: ResponseFrame): T => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const rollback = (frontend: TestFrontend, before: RollbackTarget, key: string) => frontend.request(METHODS.rollbackSession, { conversation: M1, before }, key);
const preview = (url: string, before: RollbackTarget) => requestJson<RollbackPreview>(url, HTTP_PATHS.rollbackPreview(M1, before));

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const turnsOf = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等维护者处理完 ${n} 条输入` });

/** 两个阶段：s1 收集资料（脚本验收），s2 写报告（评审验收，在 s1 之后） */
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

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [M1]: 0 });
  return frontend;
}

async function draftTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<{ taskId: string; card: Card }> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id && c.status === "pending", `${task.id} 的计划卡`);
  return { taskId: task.id, card };
}

/**
 * 确认计划：等维护者交计划的这一轮说完再点（计划卡在它调用"提交计划"时就出来了，后面它还要说一句）。这样"开始执行"那条通知在它闲着时交过去，
 * 撤回到 s1 开始前回到那条通知之前；它还没说完就确认的那种另有一条用例（机器忙时两种都会碰上，这里不让用例随机走哪条路）
 */
async function confirmPlan(frontend: TestFrontend, draft: { taskId: string; card: Card }): Promise<string> {
  await turnsOf(frontend, 1);
  ok(await frontend.cardAction({ cardId: draft.card.id, action: "confirm", expectedVersion: draft.card.version, input: {} }));
  return draft.taskId;
}

const maintainerScript =
  (plan: Plan, run: FauxStep[], closing: FauxStep[] = [say("计划交上去了")]) =>
  (_maintainerId: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [submitPlanStep(plan), ...closing] : run;

/** 全局设置里加一个自定义关注类别：写任务工作目录下的 ask/ 先问我 */
function askDir(td: TestDaemon, taskId: string) {
  const dir = fs.realpathSync.native(path.join(td.daemon.layout.outputs, taskId));
  fs.writeFileSync(td.daemon.layout.watchCategoriesFile, JSON.stringify({ custom: [{ id: "ask-dir", title: "动 ask 目录", match: { paths: [path.join(dir, "ask")] }, chat: "ask_first", task: "ask_first" }] }));
}

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

describe("会话回退（长程任务的维护者）", { timeout: LONG_TEST_MS }, () => {
  it("撤回到阶段开始前：之前的验收照样算，这个阶段回到未开始、运行时替维护者重新开始；废弃分支上的审批卡作废；切换到废弃分支时按那条分支推导", async () => {
    const td = await startTestDaemon({
      config: { approvals: { waitMinutes: 0.02 } },
      maintainer: maintainerScript(twoStagePlan(), [
        write("sources.md", "- 来源一\n"),
        // s1 验收通过，s2 在这次调用里接着开始（结果里交代了 s2）
        completeStage("s1", "资料清单在 sources.md"),
        // s2：写 ask/ 要先问，等了一会儿没人批，挂起
        write("ask/draft.txt", "草稿"),
        say("在等批准"),
        summaryStep(),
        // 撤回之后：上下文里有分支摘要和撤回的交代，从 s2 重新开始
        { kind: "branch_on_context", contains: ["用户撤回到阶段 s2「写报告」开始前", SUMMARY], matched: write("report.md", "# X 的调研\n"), otherwise: say("没收到撤回的交代") },
        completeStage("s2", "报告在 report.md"),
        say("做完了"),
        // 切换到废弃分支之后：运行时替维护者重新开始 s2
        say("切过来了"),
      ]),
      reviewer: () => review("report.md"),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "X 的调研");
    askDir(td, draft.taskId);
    const taskId = await confirmPlan(frontend, draft);
    const approval = await cardWhere(frontend, (c) => c.type === "approval" && c.status === "pending", "审批卡");
    await taskWhere(frontend, (e) => e.change === "waiting", "转等我");
    await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "在等批准"));

    // 阶段开始的记号：s1 是"开始执行"那条通知交代的，s2 是在"宣布阶段完成"那次调用里开始的（回到这次调用的结果之后）
    const marks = stageStarts(frontend, M1);
    expect(marks.map((m) => m.stageId)).toEqual(["s1", "s2"]);
    expect(marks[0]!.via).toMatchObject({ notice: expect.any(String) });
    expect(marks[1]!).toMatchObject({ taskId, title: "写报告", code: "2", via: { tool: "complete_stage", after: true } });
    // 确认框：这一段只写了一次草稿（在等批准，没执行），没做成什么事
    expect((await preview(td.url, { stageStart: marks[1]!.id })).body.effects).toEqual([]);

    const result = ok<RollbackSessionResult>(await rollback(frontend, { stageStart: marks[1]!.id }, "k-s2"));
    expect(result.branchId).toBe("b1");
    // 任务按保留的分支推导：s1 验收照样算，s2 回到未开始（从等我恢复执行），运行时替维护者重新开始 s2
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
    expect(rolled).toMatchObject({ from: "waiting_for_user", by: "user", task: { state: "running", reworks: 1 } });
    expect(stageStates(rolled.task)).toEqual({ s1: "accepted", s2: "pending" });
    expect(rolled.task.stages?.list?.[1]).toMatchObject({ reopenNo: 1 });
    expect(rolled.task.stages?.list?.[1]!.waitReason).toBeUndefined();
    const restarted = await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rolled), "重新开始 s2");
    expect(restarted.task.state).toBe("running");
    // 废弃分支上挂着的审批卡作废，写明用户撤回了会话；记进分支事件
    expect(await cardWhere(frontend, (c) => c.id === approval.id && c.status === "expired")).toMatchObject({ expiredNote: ROLLBACK_VOIDED_CARD });
    const branchEvent = frontend.events({ channel: M1, type: EVENT_TYPES.sessionBranch }).at(-1)!;
    expect((branchEvent.payload as SessionBranchEventPayload).expiredCards).toContain(approval.id);
    // 交给维护者接着做的那句：写明撤回到哪、从这一阶段重新开始，带着 s2 的交代；分支摘要上记着它（界面上不重复显示）
    const summary = messagesOf(frontend, M1).find((m) => m.message.id === result.summaryMessageId)!;
    const part = summary.message.parts[0] as BranchSummaryPart;
    expect(part).toMatchObject({ type: "branch_summary", branchId: "b1", summary: SUMMARY, notice: expect.any(String) });
    // 摘要归到重新开始的那个阶段（阶段框、时间线据此放）
    expect(summary).toMatchObject({ taskId, stageId: "s2" });
    const notice = messagesOf(frontend, M1).find((m) => m.message.id === part.notice)!;
    expect(notice).toMatchObject({ agentInput: true, taskId, stageId: "s2" });
    expect(textOf(notice)).toContain("用户撤回到阶段 s2「写报告」开始前");
    expect(textOf(notice)).toContain("从这一阶段重新开始");
    // 重新开始的 s2 也有阶段开始的记号（这次是那条通知交代的），在新分支上
    await waitUntil(() => stageStarts(frontend, M1).length === 3);
    expect(stageStarts(frontend, M1)[2]).toMatchObject({ stageId: "s2", via: { notice: part.notice } });
    expect(stageStarts(frontend, M1)[2]!.seq).toBeGreaterThan(branchEvent.seq);

    // 接着做完：评审通过，任务完成
    const done = await taskWhere(frontend, (e) => e.change === "completed", "撤回后做完");
    expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
    // 往上翻：只有当前分支上的（s2 的草稿、等批准不在）
    const page = await frontend.history(M1);
    const texts = page.messages.map((m) => ("message" in m ? textOf({ message: m.message }) : ""));
    expect(texts).toContain("<branch_summary>");
    expect(texts).not.toContain("在等批准");
    expect(texts).toContain("做完了");

    // 切换到废弃分支（151 号票的切换，同一事务里执行控制器按目标分支推导，不写摘要、不作废）：那条分支上 s1 验收了、s2 在等批准，
    // 批准的卡已经作废了——s2 回到能开始，任务从已完成恢复执行，运行时替维护者开始 s2，交代里说是切换过来的
    expect(ok(await frontend.request(METHODS.switchBranch, { conversation: M1, branchId: "b0" }, "k-switch"))).toEqual({ branchId: "b0" });
    const back = await taskWhere(frontend, (e) => e.change === "rolled_back" && e.from === "done", "切换到废弃分支");
    expect(back.task.state).toBe("running");
    expect(stageStates(back.task)).toEqual({ s1: "accepted", s2: "pending" });
    expect(back.task.reworks).toBe(2);
    const switchEvent = frontend.events({ channel: M1, type: EVENT_TYPES.sessionBranch }).at(-1)!;
    expect(switchEvent.payload).toMatchObject({ change: "switch", from: "b1", to: "b0" });
    expect((switchEvent.payload as SessionBranchEventPayload).expiredCards).toBeUndefined();
    // 交代在切过去的那条分支上（session_branch 之后）
    const switchedNotice = messagesOf(frontend, M1).findLast((m) => textOf(m).includes("用户切换到了会话的另一条分支"))!;
    expect(frontend.events({ channel: M1, type: EVENT_TYPES.message }).find((f) => (f.payload as MessageEventPayload).message.id === switchedNotice.message.id)!.seq).toBeGreaterThan(switchEvent.seq);
    expect(textOf(switchedNotice)).toContain("用户切换到了会话的另一条分支");
  });

  it("撤回到阶段开始前、再切回原来那条分支：阶段状态回到原来那条的样子（验收了的照算、在做的接着做），卡片不作废", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [
        write("sources.md", "- 来源一\n"),
        // s1 验收通过，s2 在这次调用里接着开始
        completeStage("s1", "资料清单在 sources.md"),
        write("report.md", "# 草稿\n"),
        say("s2 写了一半"),
        summaryStep("摘要：s1 做完了，s2 写了一半。"),
        // 撤回到 s1 开始前之后：运行时替维护者重新开始 s1
        say("从 s1 重新来"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmPlan(frontend, await draftTask(td, frontend, "X 的调研"));
    await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "s2 写了一半"));
    await turnsOf(frontend, 2);
    const original = td.daemon.tasks.get(taskId)!;
    expect(original.state).toBe("running");
    expect(stageStates(original)).toEqual({ s1: "accepted", s2: "running" });
    const marks = stageStarts(frontend, M1);
    expect(marks.map((m) => m.stageId)).toEqual(["s1", "s2"]);

    // 撤回到 s1 开始前：s1、s2 都回到未开始，运行时替维护者重新开始 s1
    ok<RollbackSessionResult>(await rollback(frontend, { stageStart: marks[0]!.id }, "k-s1"));
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回到 s1 开始前");
    expect(stageStates(rolled.task)).toEqual({ s1: "pending", s2: "pending" });
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rolled), "重新开始 s1");
    await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "从 s1 重新来"));
    await turnsOf(frontend, 3);
    expect(latestTree(frontend, M1)).toMatchObject({ current: "b1" });

    // 切回原来那条分支：任务回到那条上的样子——s1 的验收照算，s2 接着在做（焦点在 s2）；不作废卡片、不写摘要
    expect(ok(await frontend.request(METHODS.switchBranch, { conversation: M1, branchId: "b0" }, "k-back"))).toEqual({ branchId: "b0" });
    const back = await taskWhere(frontend, (e) => e.change === "rolled_back" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rolled), "切回原来那条");
    expect(back).toMatchObject({ from: "running", by: "user", task: { state: "running", reworks: 2, stages: { focus: "s2" } } });
    expect(stageStates(back.task)).toEqual({ s1: "accepted", s2: "running" });
    expect(back.task.stages?.list?.[0]!.acceptance).toEqual(original.stages?.list?.[0]!.acceptance);
    expect(back.task.stages?.list?.[1]!.startedAt).toBe(original.stages?.list?.[1]!.startedAt);
    const switchEvent = frontend.events({ channel: M1, type: EVENT_TYPES.sessionBranch }).at(-1)!;
    expect(switchEvent.payload).toMatchObject({ change: "switch", from: "b1", to: "b0" });
    // 原来那条上的 s1、s2 两个阶段开始的记号又在当前路径上；撤回后重新开始 s1 的那个不在了
    const tree = latestTree(frontend, M1)!;
    const onPathNow = stageStarts(frontend, M1).filter((m) => onBranchPath(tree, m.seq));
    expect(onPathNow.map((m) => m.id)).toEqual(marks.map((m) => m.id));
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "running", stages: { focus: "s2" } });
  });

  it("确认计划时维护者还没说完（开始执行的通知排在它收尾的话前面）：照样能撤回到 s1 开始前，收尾那几句和通知一起放到废弃分支，子进程里也截在提交计划的结果之后", async () => {
    // 交计划那一轮收尾的话说得慢（4400 字、每秒 400 token，将近 3 秒），计划卡一出来、它一开口就确认："开始执行"那条通知在它说完之前交来
    const closing = "计划交上去了，你看看。".repeat(400);
    const td = await startTestDaemon({
      maintainerTokensPerSecond: (_id, spawn) => (spawn === 1 ? 400 : undefined),
      maintainer: maintainerScript(twoStagePlan(), [
        write("sources.md", "- 来源一\n"),
        say("s1 在做"),
        summaryStep("摘要：s1 写了 sources.md。"),
        // 撤回之后重新开始 s1：模型这次看到的上下文原样回出来
        { kind: "echo_context" },
      ], [say(closing)]),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "X 的调研");
    await waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.stream }).length > 0, { describe: () => "等维护者说起收尾的话" });
    ok(await frontend.cardAction({ cardId: draft.card.id, action: "confirm", expectedVersion: draft.card.version, input: {} }));
    await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "s1 在做"));
    await turnsOf(frontend, 2);
    // 前提：开始执行的通知排在收尾那几句前面（交来时维护者手上正忙着）
    const s1 = stageStarts(frontend, M1)[0]!;
    expect(s1.via).toMatchObject({ notice: expect.any(String) });
    const seqOf = (match: (m: MessageEventPayload) => boolean) => frontend.events({ channel: M1, type: EVENT_TYPES.message }).find((f) => match(f.payload as MessageEventPayload))!.seq;
    const closingSeq = seqOf((m) => textOf(m) === closing);
    expect(seqOf((m) => m.message.id === (s1.via as { notice: string }).notice)).toBeLessThan(closingSeq);

    ok<RollbackSessionResult>(await rollback(frontend, { stageStart: s1.id }, "k-busy"));
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回到 s1 开始前");
    expect(stageStates(rolled.task)).toEqual({ s1: "pending", s2: "pending" });
    // 会话频道上收尾那几句在废弃分支上；子进程里同样截在提交计划的结果之后：重新开始 s1 时模型看到的上下文里没有收尾那几句、没有原来那条通知
    expect(onBranchPath(latestTree(frontend, M1)!, closingSeq)).toBe(false);
    const echoed = textOf(await eventually(() => messagesOf(frontend, M1), (m) => textOf(m).includes("[toolResult]"), "重新开始 s1 时模型看到的上下文"));
    expect(echoed).toContain("用户撤回到阶段 s1「收集资料」开始前");
    expect(echoed).toContain("摘要：s1 写了 sources.md。");
    expect(echoed).not.toContain("计划交上去了，你看看");
    expect(echoed).not.toContain("计划已确认，开始执行任务");
    expect(echoed).not.toContain("s1 在做");
  });

  it("撤回到计划确认之前：任务回到规划中、确认过的计划作废，重启后照旧；维护者重新交计划，确认后接着执行", async () => {
    const dataDir = makeTempDir("ergo-rollback-task-data-");
    const homeDir = makeTempDir("ergo-rollback-task-home-");
    const base = twoStagePlan();
    // s1 有一项写文件的授权：被放弃那段里写 sources.md 用掉一次，重新确认计划之后照样算
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, policy: { grants: [{ id: "w", tool: "write", title: "写资料清单", scope: {}, maxUses: 5 }], temporalRules: [] } }, base.stages[1]!] };
    const first = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了"), say("好的，这样也行")]
          : // 确认之后按计划装配重新拉起：s1 做到一半，你撤回了（写分支摘要）
            [write("sources.md", "- 来源一\n"), say("s1 在做"), summaryStep("摘要：计划确认了，s1 写了 sources.md。")],
    });
    const frontend = await connect(first.url);
    const draft = await draftTask(first, frontend, "X 的调研");
    const taskId = draft.taskId;
    await turnsOf(frontend, 1);
    // 计划卡在等你确认时，你在任务里说了一句
    const said = await frontend.sendText("第二阶段写详细点", { conversation: M1, taskId });
    await turnsOf(frontend, 2);
    await confirmPlan(frontend, draft);
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1", "开始 s1");
    await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "s1 在做"));
    await turnsOf(frontend, 3);
    expect(first.daemon.tasks.confirmedPlan(taskId)).toBeDefined();

    ok<RollbackSessionResult>(await rollback(frontend, { messageId: said.messageId }, "k-plan"));
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
    expect(rolled).toMatchObject({ from: "running", by: "user", task: { state: "planning", stages: { total: 2 } } });
    expect(rolled.task.stages?.list).toBeUndefined();
    // 确认过的计划作废（要重新确认），不算你拒绝
    expect(first.daemon.tasks.confirmedPlan(taskId)).toBeUndefined();
    expect(first.daemon.tasks.plan(draft.card.payload ? (draft.card.payload as PlanCardPayload).planId : "")?.status).toBe("rejected");
    await first.daemon.stop();

    // 重启：任务还在规划中、会话树照旧；你重新说，维护者（按起草计划装配，上下文从你那句之前接着、带着摘要）重新交一版计划
    const again = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: () => [
        { kind: "branch_on_context", contains: ["摘要：计划确认了", "重来：第二阶段写详细点"], matched: submitPlanStep(plan), otherwise: say("上下文不对") },
        say("新计划交了"),
      ],
    });
    expect(again.daemon.tasks.get(taskId)).toMatchObject({ state: "planning" });
    const laptop = await connect(again.url);
    await waitUntil(() => latestTree(laptop, M1) !== undefined);
    expect(latestTree(laptop, M1)).toMatchObject({ current: "b1" });
    await laptop.sendText("重来：第二阶段写详细点", { conversation: M1, taskId });
    const card = await cardWhere(laptop, (c) => c.type === "plan" && c.status === "pending" && (c.payload as PlanCardPayload).revision === 2, "新的一版计划卡");
    await taskWhere(laptop, (e) => e.change === "plan_submitted" && e.task.state === "awaiting_confirm", "重新交计划");
    ok(await laptop.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    await taskWhere(laptop, (e) => e.change === "stage_started" && e.stageId === "s1", "确认后开始 s1");
    // 授权项的次数不随回退清零：重新确认的这一版里原样留着的授权项接着用作废那一版的授予时间，被放弃那段里那次写文件照样算
    const res = await fetch(`${again.url}${HTTP_PATHS.taskStage(taskId, "s1")}`);
    expect(((await res.json()) as TaskStageView).grantUses).toEqual([{ grantId: "w", used: 1 }]);
  });

  it("授权项的次数不随回退清零：废弃分支上用掉的那次照样算，撤回到阶段开始前之后再做一次就要问你", async () => {
    const hook = await localHook();
    try {
      const base = twoStagePlan();
      const plan: Plan = {
        ...base,
        stages: [{ ...base.stages[0]!, policy: { grants: [{ id: "hook", tool: "http_request", title: "往本机的 hook 发请求", scope: {}, maxUses: 1 }], temporalRules: [] } }, base.stages[1]!],
      };
      const post = call("bash", { command: `curl -X POST ${hook.url} -d "hello"` });
      const td = await startTestDaemon({
        config: { approvals: { waitMinutes: 0.02 } },
        maintainer: maintainerScript(plan, [post, say("发过了"), summaryStep("摘要：往 hook 发过一次。"), post, say("在等批准")]),
      });
      const frontend = await connect(td.url);
      const taskId = await confirmPlan(frontend, await draftTask(td, frontend, "发通知"));
      await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "发过了"));
      expect(hook.posts()).toBe(1);
      const s1 = stageStarts(frontend, M1).find((m) => m.stageId === "s1")!;
      expect(s1.via).toMatchObject({ notice: expect.any(String) });
      // 确认框：这一段往外发过一次（收不回）
      const effects = (await preview(td.url, { stageStart: s1.id })).body.effects;
      expect(effects.map((e) => [e.scope, e.undoable])).toEqual([["external", false]]);

      ok<RollbackSessionResult>(await rollback(frontend, { stageStart: s1.id }, "k-s1"));
      const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
      expect(stageStates(rolled.task)).toEqual({ s1: "pending", s2: "pending" });
      await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s1" && tasksOf(frontend).indexOf(e) > tasksOf(frontend).indexOf(rolled), "重新开始 s1");
      // 撤回的交代里写明对外做过的那件撤不回、别再做
      const notice = messagesOf(frontend, M1).findLast((m) => textOf(m).includes("用户撤回到阶段 s1「收集资料」开始前"))!;
      expect(textOf(notice)).toContain("对外已经做了的 1 件撤不回、仍然有效");
      // 再发一次：授权项的次数已经用完（废弃分支上那次照样算），要问你
      const asked = await cardWhere(frontend, (c) => c.type === "approval" && c.status === "pending", "再发一次的审批卡");
      expect(asked.payload).toMatchObject({ taskId, stageId: "s1" });
      await waitUntil(() => messagesOf(frontend, M1).some((m) => textOf(m) === "在等批准"));
      expect(hook.posts()).toBe(1);
      const res = await fetch(`${td.url}${HTTP_PATHS.taskStage(taskId, "s1")}`);
      expect(((await res.json()) as TaskStageView).grantUses).toEqual([{ grantId: "hook", used: 1 }]);
    } finally {
      await hook.close();
    }
  });

  it("项目维护者：当前这一段里能撤回（没有它执行的任务，只回退会话）；这一段结束了就不能撤回", async () => {
    const PM1 = maintainerChannel("pm-1");
    const td = await startTestDaemon({ maintainer: (id) => (id === "pm-1" ? [say("网盘现在 2 TB，用了一半。"), summaryStep("摘要：聊了网盘容量。"), say("照片目录 300 GB。")] : []) });
    const project = seedProject(td.daemon, "家庭网盘", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });
    const turnEnds = () => frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).length;
    const first = await frontend.sendText("讲讲网盘现在的情况", { conversation: PM1 });
    await waitUntil(() => turnEnds() === 1);
    expect((await requestJson<RollbackPreview>(td.url, HTTP_PATHS.rollbackPreview(PM1, { messageId: first.messageId }))).body.effects).toEqual([]);
    const result = ok<RollbackSessionResult>(await frontend.request(METHODS.rollbackSession, { conversation: PM1, before: { messageId: first.messageId } }, "k-rb-pm"));
    expect(result.branchId).toBe("b1");
    // 没有它执行的任务：分支摘要不归到哪个任务
    const summary = messagesOf(frontend, PM1).find((m) => m.message.id === result.summaryMessageId)!;
    expect(summary.taskId).toBeUndefined();
    const second = await frontend.sendText("照片目录多大", { conversation: PM1 });
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => textOf(m) === "照片目录 300 GB。"));
    // 重置维护者：这一段结束了（重置开了新的一段），上一段里的撤回不了
    ok(await frontend.request(METHODS.resetMaintainer, { projectId: project.id }, "k-reset"));
    const refused = await frontend.request(METHODS.rollbackSession, { conversation: PM1, before: { messageId: second.messageId } }, "k-rb-pm-2");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.message).toContain("项目维护者是当前这一段");
  });
});
