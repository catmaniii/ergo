// 主切面：删除任务、没结束的任务先取消再归档（186 号票）。真的守护进程，秘书、维护者、子 agent 都接 faux 剧本，测试扮演前端。
// - 删除（task_action / task_batch_action 的 delete）：任务、维护者会话（事件整条换成"已删除"标记、pi 的会话文件整个删掉）、
//   子 agent 的会话、工作目录（outputs/<任务>）都删掉；执行中的先停（取消、维护者和子 agent 停下），定时的不再触发；
//   用户本人在里面说过的话作为素材留着（原文副本），系统记下的结局这类记录随任务删；别的任务一点不动；
// - 不能删的（转为项目了的……）拒绝、写明原因，什么都不动；
// - 没结束的任务点归档：先取消（运营中的定时任务落到触发上）再归档；
// - 秘书：快速动作 delete_task，总会先出卡，点了执行才删；不能删的不出卡、原因交回秘书。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  isDeletedEventPayload,
  maintainerChannel,
  METHODS,
  type MessageEventPayload,
  type MessagePart,
  type Plan,
  type PlanCardPayload,
  type QuickActionCardPayload,
  type ResponseFrame,
  PURGED_TEXT,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { MEMORY_NIGHTLY } from "../../src/memory/api.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { appendAskMemory, askMemoryNow, evidenceOfMaterial } from "../helpers/ask-memory-record.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const TM2 = maintainerChannel("tm-2");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const changesOf = (frontend: TestFrontend, taskId: string) => tasksOf(frontend).filter((e) => e.task.id === taskId).map((e) => e.change);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const toolCallsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const done = (frontend: TestFrontend, taskId: string, nth = 1) =>
  waitUntil(() => changesOf(frontend, taskId).filter((c) => c === "completed").length >= nth, { timeoutMs: 30_000, describe: () => `等任务 ${taskId} 第 ${nth} 次做完（现在：${changesOf(frontend, taskId).join("、")}）` });

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX, TM1, TM2]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const td = await startTestDaemon(options);
  return { td, frontend: await connect(td.url, channels) };
}

/** 事件日志里还有没有这些字（秘书会话之外：秘书据此说的话照删项目的规矩不改） */
function leftIn(td: TestDaemon, texts: readonly string[]): string[] {
  const log = JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).filter((e) => e.channel !== SECRETARY));
  return texts.filter((text) => log.includes(text));
}

const outputsOf = (td: TestDaemon, taskId: string) => path.join(dataDirLayout(td.dataDir).outputs, taskId);
const sessionOf = (td: TestDaemon, agentId: string) => path.join(td.dataDir, "sessions", agentId);

describe("删除任务", () => {
  it("已完成的普通任务：任务、维护者会话（事件和会话文件）、工作目录都删掉；用户说过的话作为素材留着，任务的结局随任务删；别的任务一点不动；重发拿到同一个结果", async () => {
    const { td, frontend } = await setup({
      secretary: [say("好"), say("好"), say("好"), say("好")],
      maintainer: (id) => (id === "tm-1" ? [say("截图整理好了：在 screenshots 里"), say("重复的也删了")] : [say("另一件也做好了")]),
    });
    expect(ok(await frontend.startTask("整理下载目录的截图\n按月份归档", "k-1", [], "plain"))).toEqual({ taskId: "t-1" });
    await done(frontend, "t-1");
    // 用户在任务详情里接着说一句：用户本人的话（作为素材保留）
    await frontend.sendText("顺便把重复的截图删掉", { conversation: TM1 });
    await done(frontend, "t-1", 2);
    expect(ok(await frontend.startTask("另一件事：备份照片\n备份到移动硬盘", "k-2", [], "plain"))).toEqual({ taskId: "t-2" });
    await done(frontend, "t-2");
    await settled(td, "tm-1", "tm-2");
    for (const id of ["t-1", "t-2"]) fs.writeFileSync(path.join(outputsOf(td, id), "report.md"), `${id} 的产出`);
    const { daemon } = td;
    await waitUntil(() => daemon.materials.searchKeyword("顺便把重复的截图删掉").length > 0, { describe: () => "等用户的话记成素材" });
    const outcomes = () => daemon.materials.list({ kind: "task_outcome" });
    await waitUntil(() => outcomes().some((m) => m.task === "t-1") && outcomes().some((m) => m.task === "t-2"), { describe: () => "等两个任务的结局记成素材" });
    expect(fs.existsSync(sessionOf(td, "tm-1"))).toBe(true);
    // 272 号票：整理一次（t-1 的结局读进推理库成了证据），秘书问记忆时引过它（简报按证据编号引原话、不带素材 id）——
    // 删任务时连带彻底删除这条结局，问记忆那次调用的记录和完整内容也要按证据编号找到、改写
    expect(await daemon.plugins.service(MEMORY_NIGHTLY)!.runNow()).toMatchObject({ state: "ran" });
    const outcomeEv = evidenceOfMaterial(td.dataDir, outcomes().find((m) => m.task === "t-1")!.id);
    expect(outcomeEv).toBeDefined();
    const ASKED = "（简报里引的结局原话：截图按月归档好了）";
    appendAskMemory(daemon.store, "call-ask-272", ["【记录】", `1. [${outcomeEv}] 2026-10-12 · 系统记的`, `   原话：「${ASKED}」`].join("\n"));

    // 删除：已完成的不用先停；返回删的时候的状态
    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "delete" }, "k-del"))).toEqual({ taskId: "t-1", state: "done" });
    const deleted = tasksOf(frontend).at(-1)!;
    expect(deleted).toMatchObject({ change: "deleted", from: "done", by: "user", task: { id: "t-1", state: "done", deleted: true, title: "（这条内容已彻底删除）" } });
    // 看板上没有了（派生视图读任务时跳过），编号不收回：下一个任务是 t-3
    expect(daemon.tasks.get("t-1")).toBeUndefined();
    expect(daemon.tasks.list().map((x) => x.id)).toEqual(["t-2"]);
    // 维护者会话：事件整条换成"已删除"标记，会话文件、工作目录整个删掉
    const left = daemon.store.read(TM1);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(sessionOf(td, "tm-1"))).toBe(false);
    expect(fs.existsSync(outputsOf(td, "t-1"))).toBe(false);
    // 任务书、标题、维护者说的话一个字不留（秘书会话之外）
    expect(leftIn(td, ["整理下载目录的截图", "按月份归档", "截图整理好了", "重复的也删了", "顺便把重复的截图删掉"])).toEqual([]);
    // 用户本人的话还在素材库里，原文副本也在；任务的结局随任务删了
    const [said] = daemon.materials.searchKeyword("顺便把重复的截图删掉");
    expect(said).toMatchObject({ kind: "user_utterance", conversation: TM1 });
    expect(fs.existsSync(path.join(td.dataDir, "materials", said!.original!.path))).toBe(true);
    expect(outcomes().filter((m) => m.task === "t-1")).toEqual([]);
    // 272 号票：问记忆那次调用的记录和完整内容按证据编号找到、照彻底删除的口径改写了
    expect(askMemoryNow(daemon.store, "call-ask-272")).toEqual({ summary: PURGED_TEXT, result: PURGED_TEXT });
    expect(JSON.stringify(daemon.store.readGlobal(0, 1_000_000))).not.toContain(ASKED);
    // 别的任务一点不动：任务、会话、会话文件、工作目录、素材都在
    expect(daemon.tasks.get("t-2")).toMatchObject({ title: "另一件事：备份照片", state: "done" });
    expect(daemon.store.read(TM2).some((e) => isDeletedEventPayload(e.payload))).toBe(false);
    expect(JSON.stringify(daemon.store.read(TM2))).toContain("另一件也做好了");
    expect(fs.existsSync(sessionOf(td, "tm-2"))).toBe(true);
    expect(fs.readFileSync(path.join(outputsOf(td, "t-2"), "report.md"), "utf8")).toBe("t-2 的产出");
    expect(outcomes().filter((m) => m.task === "t-2")).toHaveLength(1);

    // 重发同一个键：同一个结果；换个键再删：没有这个任务
    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "delete" }, "k-del"))).toEqual({ taskId: "t-1", state: "done" });
    expect(await frontend.taskAction({ taskId: "t-1", action: "delete" })).toMatchObject({ ok: false, error: { code: "not_found", message: "没有任务 t-1" } });
    // 删掉的任务：会话发不了话；新任务接着往下排
    expect(await frontend.request(METHODS.sendMessage, { conversation: TM1, parts: [{ type: "text", text: "在吗" }] }, "k-gone")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(ok(await frontend.startTask("第三件事", "k-3", [], "plain"))).toEqual({ taskId: "t-3" });
    // 重新订阅的前端：看板频道上最后一条是删掉的，会话频道上只有"已删除"标记
    const fresh = await connect(td.url, [BOARD, TM1]);
    await waitUntil(() => tasksOf(fresh).some((e) => e.task.id === "t-3"), { describe: () => "等补发看板" });
    expect(tasksOf(fresh).filter((e) => e.task.id === "t-1").at(-1)).toMatchObject({ change: "deleted", task: { deleted: true } });
    expect(fresh.events({ channel: TM1 }).every((f) => isDeletedEventPayload(f.payload))).toBe(true);
  }, 120_000);

  it("执行中、有子 agent 在等审批的长程任务：先停（取消，维护者、子 agent 停下），再删任务、会话（维护者和子 agent 的）、审批卡和待办、工作目录", async () => {
    const homeDir = makeTempDir("ergo-home-");
    const outside = path.join(homeDir, "参考资料-甲.txt");
    fs.writeFileSync(outside, "参考");
    const { td, frontend } = await setup({
      reuse: { dataDir: makeTempDir("ergo-data-"), homeDir },
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(parallelPlan()), say("计划交上去了")]
          : [call("propose_parallel", { reason: "两个阶段互不依赖", agents: [{ stageId: "s1", instructions: "读一下参考资料甲，写 a.txt" }] }), say("等你确认"), call("start_stage", { stageId: "s2" }), say("我在做 s2"), say("收到"), say("好")],
      subAgent: () => [call("read", { path: outside }), say("读到了")],
    });
    const { daemon } = td;
    const task = daemon.tasks.createByRequest({ title: "做两个文件", summary: "做两个文件" });
    daemon.tasks.writeBrief(task.id, { goal: "做出甲乙两个文件", acceptanceCriteria: ["a.txt 和 b.txt 都在"], constraints: [], projects: [], memoryScope: "" });
    const plan = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
    await waitUntil(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnEnd }).length >= 1, { describe: () => "等交完计划" });
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
    const parallel = await cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");
    ok(await frontend.cardAction({ cardId: parallel.id, action: "parallel", expectedVersion: 1 }));
    // sa-1 读项目外的文件，停在等用户批准上（子进程活着）
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    await waitUntil(() => daemon.agents.live().some((a) => a.agentId === "sa-1"), { describe: () => "等 sa-1 活着" });
    expect(daemon.tasks.get(task.id)?.state).toBe("running");
    const approvalItem = daemon.inbox.list().find((i) => i.kind === "card" && i.cardId === approval.id)!;
    expect(approvalItem).toBeDefined();
    fs.writeFileSync(path.join(outputsOf(td, task.id), "a.txt"), "半成品");
    for (const agentId of ["tm-1", "sa-1"]) expect({ agentId, exists: fs.existsSync(sessionOf(td, agentId)) }).toEqual({ agentId, exists: true });

    // 删除：先取消（维护者、子 agent 停下），再删；返回删的时候的状态（已取消）
    expect(ok(await frontend.taskAction({ taskId: task.id, action: "delete" }))).toEqual({ taskId: task.id, state: "cancelled" });
    expect(changesOf(frontend, task.id).slice(-2)).toEqual(["cancelled", "deleted"]);
    expect(daemon.agents.live().filter((a) => a.agentId === "tm-1" || a.agentId === "sa-1")).toEqual([]);
    // 会话：维护者会话里的事件（含子 agent 的工具调用、交回的说明）都是"已删除"标记；维护者、子 agent 的会话文件、工作目录都没了
    expect(daemon.store.read(TM1).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    for (const agentId of ["tm-1", "sa-1"]) expect({ agentId, exists: fs.existsSync(sessionOf(td, agentId)) }).toEqual({ agentId, exists: false });
    expect(fs.existsSync(outputsOf(td, task.id))).toBe(false);
    // 计划卡、并行确认卡、审批卡的每个版本都换成了标记；待办里它们的事项删掉了
    for (const card of [plan, parallel, approval]) {
      const versions = daemon.store.read(CARDS).filter((e) => e.type === EVENT_TYPES.card && JSON.stringify(e.payload).includes(card.id));
      expect({ card: card.type, left: versions.length }).toEqual({ card: card.type, left: 0 });
    }
    expect(daemon.inbox.list().filter((i) => i.id === approvalItem.id)).toEqual([]);
    // 任务书、计划、子 agent 的工作说明、读的文件名一个字不留
    expect(leftIn(td, ["做出甲乙两个文件", "读一下参考资料甲", "参考资料-甲.txt", "做 a.txt"])).toEqual([]);
    // 审批还是那个状态（字段级改写，不改坏状态）
    expect(daemon.approvals.list().find((a) => a.cardId === approval.id)).toMatchObject({ argsSummary: "（这条内容已彻底删除）" });
  }, 180_000);

  it("宣布阶段完成后、验收脚本还在工作目录里跑时删：先停掉验收（脚本的进程杀掉），再删；工作目录删干净", async () => {
    const logs: string[] = [];
    const plan = acceptancePlan([{ criterion: "a.txt 存在", method: "script", script: "while [ -f hold.flag ]; do sleep 0.2; done; test -f a.txt" }]);
    const { td, frontend } = await setup({
      log: (line) => logs.push(line),
      // 写下 hold.flag：验收脚本卡在它上面（脚本的工作目录就是任务的工作目录）
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : [call("write", { path: "hold.flag", content: "" }), call("write", { path: "a.txt", content: "a" }), call("complete_stage", { stageId: "s1", summary: "a.txt 写好了" }), say("交了")]),
    });
    const taskId = await confirmLongTask(td, frontend);
    // 用例中途失败时拿掉 hold.flag：卡着的脚本退出，临时目录才删得掉
    onTestFinished(async () => {
      const flag = path.join(outputsOf(td, taskId), "hold.flag");
      if (!fs.existsSync(flag)) return;
      fs.rmSync(flag, { force: true });
      await new Promise((r) => setTimeout(r, 2000));
    });
    await eventually(() => tasksOf(frontend), (e) => e.task.id === taskId && e.change === "stage_submitted", "s1 交上来验收");
    await new Promise((r) => setTimeout(r, 1000));
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.state).toBe("accepting");

    expect(ok(await frontend.taskAction({ taskId, action: "delete" }))).toEqual({ taskId, state: "cancelled" });
    expect(fs.existsSync(outputsOf(td, taskId))).toBe(false);
    expect(logs.filter((l) => l.includes(`删除任务 ${taskId} 时删不掉`))).toEqual([]);
    // 停下的那次验收作废：没有记下结论（没有验收结论的进度卡）
    expect(changesOf(frontend, taskId).filter((c) => c === "stage_returned" || c === "stage_accepted")).toEqual([]);
  }, 120_000);

  it("宣布阶段完成后、评审子 agent 还在评时删：先停掉验收（评审子 agent 结束），再删；工作目录删干净", async () => {
    const logs: string[] = [];
    const plan = acceptancePlan([{ criterion: "a.txt 写得清楚", method: "review" }]);
    const { td, frontend } = await setup({
      log: (line) => logs.push(line),
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : [call("write", { path: "a.txt", content: "a" }), call("complete_stage", { stageId: "s1", summary: "a.txt 写好了" }), say("交了")]),
      // 评审慢吞吞地说一大段（它的子进程的工作目录就是任务的工作目录）
      reviewer: () => [say("我先仔细读一遍交付件，".repeat(200)), call("submit_review", { results: [{ index: 1, passed: true, reason: "清楚" }] }), say("评完了")],
      reviewerTokensPerSecond: 5,
    });
    const taskId = await confirmLongTask(td, frontend);
    const reviewer = () => td.daemon.agents.live().filter((a) => a.agentId.startsWith(`review-${taskId}-s1-`));
    await waitUntil(() => reviewer().length > 0, { timeoutMs: 30_000, describe: () => "等评审子 agent 起来" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(reviewer()).toHaveLength(1);

    expect(ok(await frontend.taskAction({ taskId, action: "delete" }))).toEqual({ taskId, state: "cancelled" });
    expect(reviewer()).toEqual([]);
    expect(fs.existsSync(outputsOf(td, taskId))).toBe(false);
    expect(logs.filter((l) => l.includes(`删除任务 ${taskId} 时删不掉`))).toEqual([]);
    expect(changesOf(frontend, taskId).filter((c) => c === "stage_returned" || c === "stage_accepted")).toEqual([]);
  }, 120_000);

  it("运营中的定时任务：先取消触发再删，之后到点不再运行；看板、日历上都没有", async () => {
    const START = new Date(2026, 9, 20, 8, 0);
    const clock = new ManualClock(START);
    const { td, frontend } = await setup({ clock, secretary: [say("好")], maintainer: [say("今天的简报写好了")] });
    const daily = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };
    expect(ok(await frontend.startTask("每天早上出一份简报\n汇总昨天的新闻", "k-daily", [], "plain", daily))).toEqual({ taskId: "t-1" });
    await waitUntil(() => td.daemon.scheduledJobs.ofTask("t-1")?.state === "active", { describe: () => "等登记触发" });
    clock.advanceTo(new Date(2026, 9, 20, 9, 0));
    await waitUntil(() => td.daemon.scheduledJobs.get("j-1")?.lastRun?.state === "done", { describe: () => "等第一次运行做完" });
    await settled(td, "tm-1");
    expect(td.daemon.scheduledJobs.calendar(START, new Date(2026, 9, 23)).map((e) => e.job.id)).toEqual(["j-1"]);

    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "delete" }))).toEqual({ taskId: "t-1", state: "cancelled" });
    expect(td.daemon.scheduledJobs.get("j-1")?.state).toBe("cancelled");
    // 到点不再运行，日历上没有，触发登记的文字也换成了删除标记
    clock.advanceTo(new Date(2026, 9, 22, 9, 30));
    await new Promise((r) => setTimeout(r, 300));
    expect(td.daemon.scheduledJobs.get("j-1")?.runCount).toBe(1);
    expect(td.daemon.scheduledJobs.calendar(START, new Date(2026, 9, 23))).toEqual([]);
    expect(td.daemon.tasks.list()).toEqual([]);
    expect(leftIn(td, ["每天早上出一份简报", "汇总昨天的新闻", "今天的简报写好了"])).toEqual([]);
  }, 60_000);

  it("不能删的：转为项目了的写明原因，什么都不动；批量删除逐条回报", async () => {
    const { td, frontend } = await setup({ secretary: [say("好"), say("好")], maintainer: (_id, spawn) => (spawn === 1 ? [say("先想想")] : [say("好")]) });
    const converted = td.daemon.tasks.createByRequest({ title: "记账本", summary: "做一个记账本" });
    ok(await frontend.request(METHODS.convertTaskToProject, { taskId: converted.id, name: "记账本" }, "k-conv"));
    const other = td.daemon.tasks.createByRequest({ title: "查资料", summary: "查资料" });
    const result = ok(await frontend.taskBatchAction({ taskIds: [converted.id, other.id, "t-9"], action: "delete" }));
    expect(result).toEqual({
      results: [
        { taskId: converted.id, ok: false, code: "not_allowed", message: "任务已转为项目「记账本」，会话和工作目录跟着项目走：项目还在时由项目管，删项目时一起删" },
        { taskId: other.id, ok: true, state: "cancelled" },
        { taskId: "t-9", ok: false, code: "not_found", message: "没有任务 t-9" },
      ],
    });
    expect(td.daemon.tasks.get(converted.id)).toMatchObject({ state: "done", endKind: "converted_to_project" });
    expect(td.daemon.tasks.get(other.id)).toBeUndefined();
  }, 60_000);
});

describe("没结束的任务归档：先取消再归档", () => {
  it("单个、批量都行：执行中的先取消，运营中的定时任务先取消触发；重发拿到同一个结果", async () => {
    const { td, frontend } = await setup({ secretary: [say("好")], maintainer: [say("做着")] });
    const planning = td.daemon.tasks.createByRequest({ title: "查资料", summary: "查资料" }).id;
    const weekly = { kind: "schedule" as const, schedule: { kind: "weekly" as const, time: "09:00", weekdays: [1] } };
    const timed = (ok(await frontend.startTask("每周检查依赖\n看看有没有新版本", "k-timed", [], "plain", weekly)) as { taskId: string }).taskId;
    await waitUntil(() => td.daemon.scheduledJobs.ofTask(timed)?.state === "active", { describe: () => "等登记触发" });

    expect(ok(await frontend.taskAction({ taskId: planning, action: "archive" }, "k-arch"))).toEqual({ taskId: planning, state: "archived" });
    expect(changesOf(frontend, planning).slice(-2)).toEqual(["cancelled", "archived"]);
    expect(ok(await frontend.taskAction({ taskId: planning, action: "archive" }, "k-arch"))).toEqual({ taskId: planning, state: "archived" });
    expect(ok(await frontend.taskBatchAction({ taskIds: [timed], action: "archive" }))).toEqual({ results: [{ taskId: timed, ok: true, state: "archived" }] });
    expect(td.daemon.scheduledJobs.ofTask(timed)?.state).toBe("cancelled");
    expect(changesOf(frontend, timed).slice(-2)).toEqual(["cancelled", "archived"]);
  }, 60_000);
});

describe("秘书删除任务", () => {
  it("“把 t-1 删了”：秘书提议快速动作 delete_task，总会先出卡；点了执行才删；不能删的不出卡、原因交回秘书", async () => {
    const { td, frontend } = await setup({
      secretary: [
        call("propose_quick_action", { type: "delete_task", params: { task: "t-1" } }),
        say("请你在卡上确认。"),
        call("propose_quick_action", { type: "delete_task", params: { task: "t-2" } }),
        say("删不了。"),
      ],
      maintainer: [say("好")],
    });
    td.daemon.tasks.createByRequest({ title: "查资料", summary: "查资料" });
    const converted = td.daemon.tasks.createByRequest({ title: "记账本", summary: "做一个记账本" });
    ok(await frontend.request(METHODS.convertTaskToProject, { taskId: converted.id, name: "记账本" }, "k-conv"));

    await frontend.sendText("把 t-1 删了");
    const pending = await cardWhere(frontend, (c) => c.type === "quick_action" && c.status === "pending", "待确认的快速动作卡");
    expect(pending.payload).toMatchObject({ action: { type: "delete_task", params: { taskId: "t-1" } }, name: "删除任务", title: "删除任务 t-1「查资料」" } satisfies Partial<QuickActionCardPayload>);
    expect(td.daemon.tasks.get("t-1")?.state).toBe("planning");
    ok(await frontend.cardAction({ cardId: pending.id, action: "execute", expectedVersion: pending.version }));
    const handled = await cardWhere(frontend, (c) => c.id === pending.id && (c.payload as QuickActionCardPayload).result?.startsWith("已删除") === true, "删完补上结果");
    expect((handled.payload as QuickActionCardPayload).result).toBe("已删除任务 t-1「查资料」：任务、维护者的会话、工作目录和产出都删了；用户在里面说过的话作为素材保留");
    expect(td.daemon.tasks.get("t-1")).toBeUndefined();

    await frontend.sendText("把 t-2 也删了");
    await waitUntil(() => toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "propose_quick_action").length >= 2, { describe: () => "等第二次提议" });
    expect(toolCallsOf(frontend, SECRETARY).at(-1)?.resultSummary).toContain("任务已转为项目「记账本」");
    expect(cardsOf(frontend).filter((c) => c.type === "quick_action" && c.id !== pending.id)).toEqual([]);
  }, 60_000);
});

/** 一个开放模式的阶段：写一个文件，脚本验收它在不在 */
const stage = (stageId: string, file: string): Plan["stages"][number] => ({
  stageId,
  title: `做 ${file}`,
  deliverables: [file],
  acceptance: [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
  mode: "open",
  dependsOn: [],
  policy: { grants: [], temporalRules: [] },
  budget: { tokens: 1_000_000, toolCalls: 30 },
});

/** 只有一个阶段（写 a.txt），验收标准照给的；不开 bash、不联网 */
function acceptancePlan(acceptance: Plan["stages"][number]["acceptance"]): Plan {
  const base = samplePlan();
  return { ...base, stages: [{ ...stage("s1", "a.txt"), acceptance }], stageGroups: [], toolkit: { ...base.toolkit, bash: false, network: false }, stops: { count: 0, where: [] } };
}

/** 建一个长程任务、写好任务书，等维护者交计划，在计划卡上确认；返回任务 id */
async function confirmLongTask(td: TestDaemon, frontend: TestFrontend): Promise<string> {
  const task = td.daemon.tasks.createByRequest({ title: "写一个文件", summary: "写一个文件" });
  td.daemon.tasks.writeBrief(task.id, { goal: "写出 a.txt", acceptanceCriteria: ["a.txt 在"], constraints: [], projects: [], memoryScope: "" });
  const plan = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
  await waitUntil(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnEnd }).length >= 1, { describe: () => "等交完计划" });
  ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
  return task.id;
}

/** 两个互不依赖的阶段（写两个文件，脚本验收），不开 bash、不联网 */
function parallelPlan(): Plan {
  const base = samplePlan();
  return { ...base, stages: [stage("s1", "a.txt"), stage("s2", "b.txt")], stageGroups: [], toolkit: { ...base.toolkit, bash: false, network: false }, stops: { count: 0, where: [] } };
}
