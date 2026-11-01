// 主切面：负责人背后的 agent（368 号票）。真的守护进程，负责人、子 agent、评审都接 faux 剧本，测试扮演前端：
// - 派两个子 agent：列表实时（背后的 agent 频道上有临时事件）显示运行中、最近一步、工具调用次数；做完变成做完了；
// - 点开看它的对话：收到的指令、它说的话、工具调用、交回的结果，只读（接口只有 GET，发不了话）；
// - 老的子 agent（368 号票之前跑的，没记它说的话）：打开不报错，写明没记下；老的评审（没有事件，只有账本）有什么显示什么（state/ 那边）；
// - 评审也列出来；
// - 随任务一起删：列表没了、对话回 404，收到的指令、说的话的事件换成删除标记。
import fs from "node:fs";
import path from "node:path";
import {
  type BackgroundAgentList,
  type BackgroundAgentTranscript,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEventPayload,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { LEDGER_CHANNEL, TOKEN_USAGE_EVENT } from "../../src/ledger/entry.ts";
import { SUB_AGENT_EVENTS, SUB_AGENTS_CHANNEL } from "../../src/sub-agents/events.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, backgroundAgents: BACKGROUND } = CHANNELS;
const M1 = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const write = (file: string, content: string) => call("write", { path: file, content });
/** 一边说话一边调工具（只说话不调工具的一步这一轮就结束了） */
const sayAnd = (text: string, step: FauxStep): FauxStep => ({ ...step, text }) as FauxStep;
const propose = (agents: Array<{ stageId: string; instructions: string }>) => call("propose_parallel", { reason: "两个阶段互不依赖", agents });

const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

const cardsOf = (f: TestFrontend): Card[] => f.events({ channel: CARDS, type: EVENT_TYPES.card }).map((x) => (x.payload as CardEventPayload).card);
const cardWhere = async (f: TestFrontend, match: (c: Card) => boolean, what: string): Promise<Card> => {
  let found: Card | undefined;
  await waitUntil(() => (found = cardsOf(f).filter(match).at(-1)) !== undefined, { timeoutMs: 60_000, describe: () => `等${what}` });
  return found!;
};
const turnsOf = (f: TestFrontend, n: number) => waitUntil(() => f.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等负责人处理完 ${n} 条输入` });

function fileStage(stageId: string, file: string, reviewed = false): Plan["stages"][number] {
  return {
    stageId,
    title: `做 ${file}`,
    deliverables: [file],
    acceptance: reviewed ? [{ criterion: `${file} 写得对`, method: "review" }] : [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
    mode: "open",
    dependsOn: [],
    policy: { grants: [], temporalRules: [] },
    budget: { tokens: 1_000_000, toolCalls: 30 },
  };
}

function plan(stages: Plan["stages"]): Plan {
  const base = samplePlan();
  return { ...base, stages, stageGroups: [], toolkit: { ...base.toolkit, bash: false, network: false }, stops: { count: 0, where: [] } };
}

const brief = { goal: "做两个文件", acceptanceCriteria: ["都在"], constraints: [], projects: [], memoryScope: "" };

async function connect(url: string) {
  const f = await TestFrontend.connect(url);
  await f.subscribe({ [BOARD]: 0, [CARDS]: 0, [BACKGROUND]: 0, [M1]: 0 });
  return f;
}

async function confirmTask(td: TestDaemon, f: TestFrontend): Promise<string> {
  const task = td.daemon.tasks.createByRequest({ title: "两个文件", summary: "两个文件" });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await cardWhere(f, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
  await turnsOf(f, 1);
  ok(await f.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
  return task.id;
}

/** waitUntil 只认同步的条件：异步的查一次记一次 */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  let met = false;
  let pending = false;
  await waitUntil(
    () => {
      if (!pending) {
        pending = true;
        void check().then((r) => {
          met = r;
          pending = false;
        });
      }
      return met;
    },
    { timeoutMs: 60_000, describe: () => `等${what}` },
  );
}

const list = async (td: TestDaemon, maintainerId = "tm-1") => (await requestJson<BackgroundAgentList>(td.url, HTTP_PATHS.agentBackground(maintainerId))).body.agents;
const transcript = (td: TestDaemon, agentId: string) => requestJson<BackgroundAgentTranscript>(td.url, HTTP_PATHS.agentTranscript(agentId));

/** 负责人提议派 s1、s2 两个子 agent；sa-1 写完 a.txt 后读项目外的文件（等审批，停在那里），sa-2 写完 b.txt 交回 */
async function twoSubAgents() {
  const outsideDir = makeTempDir("ergo-bg-outside-");
  const outside = path.join(outsideDir, "参考.txt");
  fs.writeFileSync(outside, "参考资料");
  const td = await startTestDaemon({
    maintainer: (_id, spawn) =>
      spawn === 1
        ? [submitPlanStep(plan([fileStage("s1", "a.txt"), fileStage("s2", "b.txt")])), say("计划交上去了")]
        : [
            propose([
              { stageId: "s1", instructions: "写 a.txt，内容是 A\n再核对一下参考资料" },
              { stageId: "s2", instructions: "写 b.txt，内容是 B" },
            ]),
            say("等你确认"),
            say("收到"),
            say("好"),
            say("好"),
          ],
    subAgent: (agentId) => (agentId === "sa-1" ? [sayAnd("我先写 a.txt。", write("a.txt", "A")), call("read", { path: outside }), say("a.txt 写好了，参考资料也对过了")] : [write("b.txt", "B"), say("b.txt 写好了")]),
  });
  const frontend = await connect(td.url);
  const taskId = await confirmTask(td, frontend);
  const card = await cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");
  // 用户同意之前背后一个 agent 都没有（提议了不算）
  await turnsOf(frontend, 2);
  expect(await list(td)).toEqual([]);
  ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));
  return { td, frontend, taskId };
}

describe("背后的 agent", () => {
  it("派两个子 agent：列表实时显示运行中、最近一步、工具调用次数；做完变成做完了，对话能看（收到的指令、说的话、工具调用、交回的结果）；只读，发不了话", async () => {
    const { td, frontend, taskId } = await twoSubAgents();

    // sa-1 停在审批上，还在跑；sa-2 做完了。运行中的排前面
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    await until(async () => (await list(td)).some((a) => a.agentId === "sa-2" && a.state === "done"), "sa-2 做完");
    const running = await list(td);
    expect(running.map((a) => [a.agentId, a.state])).toEqual([
      ["sa-1", "running"],
      ["sa-2", "done"],
    ]);
    expect(running[0]).toMatchObject({
      kind: "sub_agent",
      taskId,
      taskTitle: "两个文件",
      stageId: "s1",
      stageTitle: "做 a.txt",
      // 派去做什么：工作说明的第一行
      brief: "写 a.txt，内容是 A",
      toolCalls: 1,
      lastStep: { tool: "write", argsSummary: "a.txt" },
    });
    expect(running[0]!.startedAt).toBeDefined();
    expect(running[0]!.endedAt).toBeUndefined();
    expect(running[0]!.tokens).toBeGreaterThan(0);
    // 做完了的：有结束时间，不再给"现在在做哪一步"
    expect(running[1]).toMatchObject({ outcome: "done", toolCalls: 1 });
    expect(running[1]!.endedAt).toBeDefined();
    expect(running[1]!.lastStep).toBeUndefined();

    // 有变化时频道上有临时事件（带负责人 id），事件不落盘、不进负责人的会话
    await waitUntil(() => frontend.events({ channel: BACKGROUND, type: EVENT_TYPES.backgroundAgents }).length > 0, { describe: () => "等背后的 agent 的临时事件" });
    expect(frontend.events({ channel: BACKGROUND, type: EVENT_TYPES.backgroundAgents }).at(-1)!.payload).toEqual({ maintainerId: "tm-1" });
    expect(td.daemon.store.read(BACKGROUND)).toEqual([]);

    // 运行中的对话：实时的——已经有的都在，还没交回结果
    const live = (await transcript(td, "sa-1")).body;
    expect(live.saidRecorded).toBe(true);
    expect(live.instructions).toBe("写 a.txt，内容是 A\n再核对一下参考资料");
    expect(live.entries.map((e) => e.kind)).toEqual(["input", "said", "tool_call"]);
    expect(live.entries.find((e) => e.kind === "input")).toMatchObject({ text: expect.stringContaining("写 a.txt，内容是 A") });
    expect(live.entries.find((e) => e.kind === "said")).toMatchObject({ text: "我先写 a.txt。" });
    expect(live.entries.find((e) => e.kind === "tool_call")).toMatchObject({ tool: "write", argsSummary: "a.txt", outcome: "done" });

    // 批准：sa-1 接着做完，变成做完了；交回的结果在对话最后
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: 1 }));
    await until(async () => (await list(td)).every((a) => a.state === "done"), "sa-1 做完");
    const done = (await transcript(td, "sa-1")).body;
    expect(done.agent).toMatchObject({ state: "done", toolCalls: 2 });
    expect(done.entries.map((e) => e.kind)).toEqual(["input", "said", "tool_call", "tool_call", "said", "result"]);
    expect(done.entries.at(-1)).toMatchObject({ text: expect.stringContaining("a.txt 写好了，参考资料也对过了") });
    // 负责人的会话里现有的子 agent 工具调用和交回的消息不动
    const inMaintainer = frontend.events({ channel: M1, type: EVENT_TYPES.message }).map((x) => x.payload as MessageEventPayload).filter((m) => m.agentId === "sa-1");
    expect(inMaintainer.flatMap((m) => m.message.parts.map((p) => p.type)).filter((type) => type === "tool_call")).toHaveLength(2);
    expect(inMaintainer.some((m) => m.message.parts.some((p) => p.type === "text" && p.text.includes("我先写 a.txt。")))).toBe(false);

    // 不能再唤起：接口只有 GET；往它发话没有路（它不是会话）
    expect((await requestJson(td.url, HTTP_PATHS.agentTranscript("sa-1"), { method: "POST", body: {} })).status).toBe(405);
    expect(await frontend.trySendParts([{ type: "text", text: "接着做" }], { conversation: maintainerChannel("sa-1") })).toMatchObject({ ok: false, error: { code: "not_found" } });

    // 没有这个的 404
    expect((await transcript(td, "sa-99")).status).toBe(404);
    expect((await transcript(td, "tm-1")).status).toBe(404);
  }, 180_000);

  it("老的子 agent（368 号票之前跑的，没记它说的话）：打开不报错，写明没记下；提议的工作说明、工具调用、交回的结果有什么显示什么。视图从事件日志补回来", async () => {
    const td = await startTestDaemon({ maintainer: () => [] });
    const { store } = td.daemon;
    const now = store.now();
    const task = td.daemon.tasks.createByRequest({ title: "老任务", summary: "老任务" });
    store.appendBatch([
      {
        channel: SUB_AGENTS_CHANNEL,
        type: SUB_AGENT_EVENTS.parallelProposed,
        payload: {
          proposalId: "par-1",
          taskId: task.id,
          maintainerId: task.maintainerId,
          cardId: "c-old",
          reason: "省时间",
          agents: [{ agentId: "sa-1", stageId: "s1", stageTitle: "老阶段", instructions: "老的工作说明", workDir: "x", ownWorkDir: false }],
          time: now,
        },
      },
      {
        channel: SUB_AGENTS_CHANNEL,
        type: SUB_AGENT_EVENTS.parallelDecided,
        payload: { proposalId: "par-1", taskId: task.id, taskTitle: "老任务", cardId: "c-old", decision: "parallel", agents: [{ agentId: "sa-1", stageId: "s1", stageTitle: "老阶段", instructions: "老的工作说明" }], by: "user", time: now },
      },
      { channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.subAgentStarted, payload: { agentId: "sa-1", taskId: task.id, stageId: "s1", maintainerId: task.maintainerId, proposalId: "par-1", workDir: "x", time: now } },
      { channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.subAgentFinished, payload: { agentId: "sa-1", taskId: task.id, stageId: "s1", maintainerId: task.maintainerId, proposalId: "par-1", outcome: "interrupted", messageId: "m-gone", time: now } },
      // 老的评审没有事件，只有账本里的用量
      {
        channel: LEDGER_CHANNEL,
        type: TOKEN_USAGE_EVENT,
        payload: { time: now, owner: { kind: "task", id: task.id }, stageId: "s1", purpose: "work", agentId: "review-old-s1-1", role: "reviewer", sessionId: "old", model: "faux", tokens: { cacheHit: 10, cacheMiss: 20, output: 5 } },
      },
    ]);
    // 模拟老库升上来：视图整表重建，从事件日志补回来
    store.rebuildViews();
    expect(await list(td, task.maintainerId)).toEqual([
      expect.objectContaining({ agentId: "sa-1", state: "stopped", outcome: "interrupted", brief: "老的工作说明", stageTitle: "老阶段", toolCalls: 0, tokens: 0 }),
      expect.objectContaining({ agentId: "review-old-s1-1", kind: "reviewer", state: "done", stageId: "s1", tokens: 35, cacheHitTokens: 10 }),
    ]);
    const oldReview = await transcript(td, "review-old-s1-1");
    expect(oldReview.status).toBe(200);
    expect(oldReview.body).toMatchObject({ saidRecorded: false, entries: [] });
    const old = await transcript(td, "sa-1");
    expect(old.status).toBe(200);
    expect(old.body).toMatchObject({ saidRecorded: false, instructions: "老的工作说明", entries: [] });
  }, 60_000);

  it("评审也列出来（做完了、收到的输入和说的话、工具调用）；随任务一起删：列表没了、对话 404、指令和说的话换成删除标记", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(plan([fileStage("s1", "a.txt", true)])), say("计划交上去了")] : [write("a.txt", "A"), call("complete_stage", { stageId: "s1", summary: "写好了" }), say("等验收"), say("都做完了"), say("好")]),
      reviewer: () => [sayAnd("我看看 a.txt。", call("read", { path: "a.txt" })), call("submit_review", { results: [{ index: 1, passed: true, reason: "写得对" }] }), say("评完了")],
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend);
    await waitUntil(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).some((x) => (x.payload as TaskEventPayload).task.id === taskId && (x.payload as TaskEventPayload).change === "completed"), { timeoutMs: 90_000, describe: () => "等任务做完" });

    const agents = await list(td);
    expect(agents).toHaveLength(1);
    const review = agents[0]!;
    expect(review).toMatchObject({ kind: "reviewer", taskId, stageId: "s1", stageTitle: "做 a.txt", state: "done", outcome: "done", toolCalls: 2 });
    expect(review.agentId).toMatch(/^review-/);
    const seen = (await transcript(td, review.agentId)).body;
    expect(seen.saidRecorded).toBe(true);
    expect(seen.entries.map((e) => e.kind)).toEqual(["input", "said", "tool_call", "tool_call", "said"]);
    expect(seen.entries[0]).toMatchObject({ text: expect.stringContaining("评审任务「两个文件」的阶段 s1") });

    // 随任务一起删
    ok(await frontend.taskAction({ taskId, action: "delete" }));
    await until(async () => (await list(td)).length === 0, "列表清掉");
    expect((await transcript(td, review.agentId)).status).toBe(404);
    const said = td.daemon.store.read(SUB_AGENTS_CHANNEL, 0, SUB_AGENT_EVENTS.agentSaid).map((e) => (e.payload as { text: string }).text);
    expect(said.length).toBeGreaterThan(0);
    expect(new Set(said)).toEqual(new Set(["（这条内容已彻底删除）"]));
  }, 180_000);
});
