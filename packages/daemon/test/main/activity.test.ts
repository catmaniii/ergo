// 主切面：活动状态（规格术语"活动状态"，25 号票）。agent 此刻在做什么：休眠、干活中（附带在做什么）、等你、排队。
// - 活动状态频道在 agent 被唤起、开始干活、等用户（审批）、闲置退出时各推一条落盘的 activity 事件（排队见 agent-limits.test.ts）；
// - "等你"不只看子进程：审批挂起、这一轮结束以后，还有属于这个 agent 的待处理审批卡、提问卡就是等你（说明写原因），
//   处理掉以后回到休眠；由事件推出，守护进程重启后照样对；
// - 干活中此刻在做什么（思考、写回复、调用某个工具）是临时事件 activity_progress，每个 agent 每 100 毫秒最多一条，不落盘、不补发；
// - 活动状态和任务状态、项目状态是三回事：活动状态事件只在活动状态频道上，不引起任务、项目的迁移；任务、项目变了也不改写活动状态。
// 说明是结构化的（种类加工具名、字数），这里断言结构，不断言中文文案。
import fs from "node:fs";
import path from "node:path";
import {
  type ActivityDetail,
  type ActivityEventPayload,
  type ActivityProgressEventPayload,
  type ActivityState,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type QuestionsCardPayload,
  type TaskEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, activity: ACTIVITY, projects: PROJECTS } = CHANNELS;
const M1 = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

const activityOf = (frontend: TestFrontend, agentId: string) =>
  frontend
    .events({ channel: ACTIVITY, type: EVENT_TYPES.activity })
    .map((f) => f.payload as ActivityEventPayload)
    .filter((a) => a.agentId === agentId)
    .map((a) => ({ state: a.state, ...(a.detail === undefined ? {} : { detail: a.detail }) }));
/** 一条活动状态：状态和说明 */
const is = (state: ActivityState, detail?: ActivityDetail) => ({ state, ...(detail === undefined ? {} : { detail }) });
const kindIs = (kind: ActivityDetail["kind"]) => (a: { detail?: ActivityDetail }) => a.detail?.kind === kind;
const APPROVAL: ActivityDetail = { kind: "approval", tool: "读文件" };
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const taskChanges = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => (f.payload as TaskEventPayload).change);

describe("活动状态频道", () => {
  it("维护者被唤起、开始干活、等你批准、批准后接着干、做完空闲、闲置退出：各推一条活动状态事件，干活中和等你写着在做什么；活动状态不引起任务的迁移", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const outside = path.join(fs.realpathSync.native(homeDir), "notes.txt");
    fs.writeFileSync(outside, "主目录里的笔记");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      config: { agents: { idleMinutes: 0.02 } },
      // 起草计划时读一个工作目录外的文件：越出项目目录，对话里先问
      maintainer: [call("read", { path: outside }), submitPlanStep(), say("计划交上去了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [CARDS]: 0, [BOARD]: 0, [M1]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });

    // 等你批准：子进程里这次调用在等用户
    await waitUntil(() => activityOf(frontend, "tm-1").some((a) => a.state === "waiting_for_user"), { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    const card = cardsOf(frontend).find((c) => c.type === "approval" && c.status === "pending")!;
    expect(card).toBeDefined();
    const approved = await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version });
    expect(approved.ok).toBe(true);

    // 做完、空闲，闲置 1.2 秒后退出
    await waitUntil(() => activityOf(frontend, "tm-1").some(kindIs("idle_exit")), { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    expect(activityOf(frontend, "tm-1")).toEqual([
      is("working", { kind: "woken" }),
      is("working", { kind: "handling_input" }),
      is("waiting_for_user", APPROVAL),
      is("working", { kind: "handling_input" }),
      is("sleeping", { kind: "idle" }),
      is("sleeping", { kind: "idle_exit" }),
    ]);
    // 活动状态事件只在活动状态频道上；等你批准、批准、闲置退出都没让任务迁移（任务只有建出和交计划两次变化）
    expect(frontend.events({ type: EVENT_TYPES.activity }).every((f) => f.channel === ACTIVITY)).toBe(true);
    expect(td.daemon.store.read(ACTIVITY).every((e) => e.type === EVENT_TYPES.activity)).toBe(true);
    expect(taskChanges(frontend)).toEqual(["created", "plan_submitted"]);
  }, 60_000);

  it("干活中在做什么（思考、写回复）作为临时事件推送：每个 agent 每 100 毫秒最多一条，不落盘", async () => {
    const text = "这是一段比较长的回复，".repeat(12);
    const td = await startTestDaemon({ secretary: [{ kind: "reply", thinking: "先想一想再回答。", text }], secretaryTokensPerSecond: 80 });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [SECRETARY]: 0 });
    await frontend.sendText("讲一段");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    await waitUntil(() => activityOf(frontend, "secretary").at(-1)?.state === "sleeping", { describe: () => JSON.stringify(activityOf(frontend, "secretary")) });

    const progress = frontend.timedEvents({ channel: ACTIVITY, type: EVENT_TYPES.activityProgress }).filter((e) => (e.frame.payload as ActivityProgressEventPayload).agentId === "secretary");
    expect(progress.length).toBeGreaterThan(3);
    const details = progress.map((e) => (e.frame.payload as ActivityProgressEventPayload).detail);
    expect(details[0]).toMatchObject({ kind: "thinking", chars: expect.any(Number) });
    expect(details.at(-1)).toMatchObject({ kind: "replying", chars: expect.any(Number) });
    // 字数只增不减，同样的不重复推
    const replying = details.flatMap((d) => (d.kind === "replying" ? [d.chars!] : []));
    expect(replying).toEqual(replying.toSorted((a, b) => a - b));
    expect(new Set(replying).size).toBe(replying.length);
    // 每 100 毫秒最多一条（收到的时间比发出的有一点抖动，跨度放 20 毫秒的余量）
    const arrivals = progress.map((e) => e.at);
    const span = arrivals.at(-1)! - arrivals[0]!;
    expect(arrivals.length).toBeLessThanOrEqual(Math.floor((span + 20) / 100) + 1);
    // 落盘的只有状态的变化：干活中、做完回到休眠（秘书常驻，闲着就是休眠）
    expect(td.daemon.store.read(ACTIVITY).map((e) => e.type)).not.toContain(EVENT_TYPES.activityProgress);
    expect(activityOf(frontend, "secretary").slice(-2)).toEqual([is("working", { kind: "handling_input" }), is("sleeping")]);
  }, 60_000);

  it("任务、项目的状态变了不改写活动状态：休眠的维护者，它的任务被暂停、项目被停用，活动状态频道上没有新事件", async () => {
    const td = await startTestDaemon({ config: { agents: { idleMinutes: 0.01 } }, maintainer: [submitPlanStep(), say("计划交上去了")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [BOARD]: 0, [CARDS]: 0, [PROJECTS]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    await waitUntil(() => activityOf(frontend, "tm-1").some(kindIs("idle_exit")), { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    const project = seedProject(td.daemon, "家庭网盘", { state: "in_use" });
    await waitUntil(() => frontend.events({ channel: PROJECTS }).length > 0);
    const before = frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.activity }).length;

    // 项目停用、任务取消（都不给维护者新的输入）
    expect((await frontend.request("project_action", { projectId: project.id, action: "retire" }, "k-retire")).ok).toBe(true);
    await waitUntil(() => frontend.events({ channel: PROJECTS }).length > 1);
    expect((await frontend.taskAction({ taskId: task.id, action: "cancel" })).ok).toBe(true);
    await waitUntil(() => taskChanges(frontend).includes("cancelled"));
    // 给变化留一点时间：真有事件也该到了
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.activity }).length).toBe(before);
    expect(activityOf(frontend, "tm-1").at(-1)).toEqual(is("sleeping", { kind: "idle_exit" }));
  }, 60_000);

  it("审批挂起、这一轮结束以后还有待处理的审批卡：维护者是等你（审批），闲置退出也不变；守护进程重启后照样是等你；批准后不再等你", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const outside = path.join(fs.realpathSync.native(homeDir), "notes.txt");
    fs.writeFileSync(outside, "主目录里的笔记");
    // 子进程里只等 0.6 秒：没人批就挂起，维护者接着交计划、做完这一轮，闲 1.2 秒退出
    const config = { agents: { idleMinutes: 0.02 }, approvals: { waitMinutes: 0.01 } };
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, config, maintainer: [call("read", { path: outside }), submitPlanStep(), say("计划交上去了，读笔记的事等你批准")] });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [CARDS]: 0 });
    const task = first.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    first.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });

    // 子进程里等着 → 挂起、接着干 → 这一轮结束：卡还没处理，是等你
    await waitUntil(() => activityOf(frontend, "tm-1").filter((a) => a.state === "waiting_for_user").length === 2, { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    // 闲置退出了（子进程不在了），仍是等你，不多记
    await waitUntil(() => first.daemon.agents.live().every((a) => a.agentId !== "tm-1"), { timeoutMs: 20_000 });
    expect(activityOf(frontend, "tm-1")).toEqual([
      is("working", { kind: "woken" }),
      is("working", { kind: "handling_input" }),
      is("waiting_for_user", APPROVAL),
      is("working", { kind: "handling_input" }),
      is("waiting_for_user", APPROVAL),
    ]);
    const card = cardsOf(frontend).find((c) => c.type === "approval" && c.status === "pending")!;
    expect(card).toBeDefined();
    await first.daemon.stop();

    // 重启：子进程都不在了，待处理的审批卡还在，仍是等你（不多记一条）
    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, config, maintainer: [say("好，我重试")] });
    const fresh = await TestFrontend.connect(second.url);
    await fresh.subscribe({ [ACTIVITY]: 0, [CARDS]: 0 });
    await waitUntil(() => activityOf(fresh, "tm-1").length >= 5);
    expect(activityOf(fresh, "tm-1")).toEqual(activityOf(frontend, "tm-1"));

    // 批准：卡处理掉了，不再等你（维护者收到"可以重试"，被唤起接着干，做完回到空闲）
    const latest = cardsOf(fresh).findLast((c) => c.id === card.id)!;
    expect((await fresh.cardAction({ cardId: card.id, action: "approve", expectedVersion: latest.version })).ok).toBe(true);
    await waitUntil(() => activityOf(fresh, "tm-1").some(kindIs("idle")), { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(fresh, "tm-1")) });
    expect(activityOf(fresh, "tm-1").slice(5).some((a) => a.state === "waiting_for_user")).toBe(false);
  }, 90_000);

  it("提问卡没回答时秘书是等你（澄清）；回答以后回到休眠，接着处理交回来的答案", async () => {
    const td = await startTestDaemon({
      secretary: [call("ask_questions", { questions: [{ question: "调研给谁看？", options: ["自己", "团队"], recommended: "自己" }] }), say("先回答这个问题"), say("好的，给你自己看")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [SECRETARY]: 0, [CARDS]: 0 });
    await frontend.sendText("帮我整理一份 X 的调研");
    await waitUntil(() => activityOf(frontend, "secretary").some((a) => a.state === "waiting_for_user"), { timeoutMs: 20_000, describe: () => JSON.stringify(activityOf(frontend, "secretary")) });
    expect(activityOf(frontend, "secretary").slice(-2)).toEqual([is("working", { kind: "handling_input" }), is("waiting_for_user", { kind: "clarification" })]);

    const card = cardsOf(frontend).find((c) => c.type === "questions")!;
    const answers = (card.payload as QuestionsCardPayload).questions.map((q) => ({ questionId: q.id, answer: q.recommended }));
    expect((await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: card.version, input: { answers } })).ok).toBe(true);
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length === 2, { timeoutMs: 20_000 });
    await waitUntil(() => activityOf(frontend, "secretary").at(-1)?.state === "sleeping", { describe: () => JSON.stringify(activityOf(frontend, "secretary")) });
    const all = activityOf(frontend, "secretary");
    expect(all.slice(all.findIndex((a) => a.state === "waiting_for_user") + 1)).toEqual([is("sleeping"), is("working", { kind: "handling_input" }), is("sleeping")]);
  }, 60_000);
});
