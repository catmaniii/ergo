// 主切面：授权的文件夹升级成全局（355 号票）。所有 agent 读授权的文件夹里的文件都不用问、不进待办；真的守护进程（对话审批开着，
// 没授权时这些读都要出审批卡），agent 接 faux 剧本，文件都在临时目录里，测试扮演前端。
// - 秘书：读 + bash 读都不问，带着写明"可以直接读"的上下文块；拿掉文件夹，下一次调用就恢复原来的判定（出审批卡）；
// - 任务的负责人、子 agent、评审：同一个任务里都读，一张审批卡都没有；负责人、子 agent 带着上下文块；
// - 定时作业的一次运行：读了照样算成功，不算"没等到批准"；
// - 流程：读计划里没写的授权的文件夹不算越出计划，不问；
// - 把数据目录的上级授权了：密钥区照样拒绝，配置区照旧要问。
// 各种写法（bash 拆开的每种命令、写删覆盖、`..`、符号链接、短路径……）在守卫切面（test/guard/authorized-folders.test.ts）。
import fs from "node:fs";
import path from "node:path";
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, HTTP_PATHS, maintainerChannel, type MessageEventPayload, type Plan, type ScheduledJobEventPayload, type TaskEventPayload, type WorkflowPlanDraft, type PlanCardPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { call, fwd, inboxOf, messagesOf, ok, real, say, stageStates, textOf, toolCallsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, secretary: SECRETARY } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const ECHO: FauxStep = { kind: "echo_context" };
const APPROVALS_ON = { guard: { conversationApprovals: "on" } };
const LONG = 120_000;
const CONTENT = "授权的文件夹里的一句话";

/** 一个授权用的文件夹，里面一个文件 */
function photos() {
  const dir = real(makeTempDir("ergo-photos-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, CONTENT);
  return { dir, file };
}

const patchFolders = (td: TestDaemon, body: unknown) => requestJson(td.url, HTTP_PATHS.localFolders, { method: "PATCH", body });
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const approvalCards = (frontend: TestFrontend) => cardsOf(frontend).filter((c) => c.type === "approval");
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 处理完 ${n} 条输入；工具调用：${toolCallsOf(frontend, channel).map((c) => `${c.tool}:${c.outcome}`).join("、")}` });
/** 某一次调用是不是读到了内容（真的执行了，没被拦下） */
const readDone = (frontend: TestFrontend, channel: string, tool: string) => toolCallsOf(frontend, channel).filter((c) => c.tool === tool);

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

/** 一个写文件的开放阶段 */
const stage = (stageId: string, name: string): Plan["stages"][number] => ({
  stageId,
  title: `做 ${name}`,
  deliverables: [name],
  acceptance: [{ criterion: `${name} 存在`, method: "script", script: `test -f ${name}` }],
  mode: "open",
  dependsOn: [],
  policy: { grants: [], temporalRules: [] },
  budget: { tokens: 1_000_000, toolCalls: 30 },
});

/** 2026-10-08（周四）的 hh:mm */
const at = (hh: number, mm = 0) => new Date(2026, 9, 8, hh, mm);

describe("秘书", () => {
  it("读授权的文件夹不问、不进待办，上下文里写着可以直接读；拿掉文件夹下一次调用就恢复原来的判定", { timeout: LONG }, async () => {
    const { dir, file } = photos();
    const td = await startTestDaemon({
      config: APPROVALS_ON,
      secretary: [ECHO, call("read", { path: file }), call("bash", { command: `cat ${fwd(file)}` }), say("读到了"), call("read", { path: file }), say("这回问了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });
    await patchFolders(td, { add: [dir] });

    await frontend.sendText("你看得到哪些文件夹");
    await turnsOf(frontend, SECRETARY, 1);
    const echo = textOf(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent" && textOf(m).includes("[system] ")).at(-1)!);
    expect(echo).toContain(`- ${dir}`);
    expect(echo).toContain("这些文件夹里的文件可以直接读，不用问用户");

    await frontend.sendText("读一下");
    await turnsOf(frontend, SECRETARY, 2);
    const done = () => [...readDone(frontend, SECRETARY, "read"), ...readDone(frontend, SECRETARY, "bash")];
    expect(done().map((c) => c.outcome)).toEqual(["done", "done"]);
    expect(approvalCards(frontend)).toEqual([]);
    expect(inboxOf(frontend)).toEqual([]);

    // 设置里拿掉：下一次调用就要问
    await patchFolders(td, { remove: [dir] });
    await frontend.sendText("再读一下");
    const asked = await eventually(() => approvalCards(frontend), () => true, "审批卡");
    expect(asked.status).toBe("pending");
  });
});

describe("任务的负责人、子 agent、评审", () => {
  it("同一个任务里都读授权的文件夹：不用写进计划，一张审批卡都没有；负责人和子 agent 带着上下文块，评审拉起时也带着", { timeout: LONG * 2 }, async () => {
    const { dir, file } = photos();
    const base = samplePlan();
    const plan: Plan = {
      ...base,
      stages: [stage("s1", "a.txt"), { ...stage("s2", "b.txt"), acceptance: [{ criterion: "看过了", method: "review" }] }],
      stageGroups: [],
      toolkit: { ...base.toolkit, bash: true, network: false },
      stops: { count: 0, where: [] },
    };
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了")]
          : [
              call("read", { path: file }),
              call("bash", { command: `cat ${fwd(file)}` }),
              call("propose_parallel", { reason: "两个阶段互不依赖", agents: [{ stageId: "s1", instructions: "读那份文件，写 a.txt" }] }),
              ECHO,
              call("start_stage", { stageId: "s2" }),
              call("write", { path: "b.txt", content: "B" }),
              call("complete_stage", { stageId: "s2", summary: "做完了" }),
              say("收到"),
              say("好"),
              say("好"),
              say("好"),
            ],
      subAgent: () => [call("read", { path: file }), call("bash", { command: `cat ${fwd(file)}` }), call("write", { path: "a.txt", content: "A" }), ECHO],
      reviewer: () => [call("read", { path: file }), call("submit_review", { results: [{ index: 1, passed: true, reason: "看过了" }] }), say("评审完了")],
    });
    const contributions = new Map<string, unknown>();
    const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
    td.daemon.agents.spawn = (request) => {
      contributions.set(request.agentId, request.contributions);
      return spawn(request);
    };
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [M1]: 0 });
    await patchFolders(td, { add: [dir] });

    const task = td.daemon.tasks.createByRequest({ title: "两个文件", summary: "两个文件" });
    td.daemon.tasks.writeBrief(task.id, { goal: "做两个文件", acceptanceCriteria: ["都在"], constraints: [], projects: [], memoryScope: "" });
    const planCard = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
    await turnsOf(frontend, M1, 1);
    ok(await frontend.cardAction({ cardId: planCard.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 负责人：读、bash 读都做了，这一轮的上下文里写着授权的文件夹
    await turnsOf(frontend, M1, 2);
    const seen = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent" && m.agentId === undefined).at(-1)!);
    expect(seen).toContain(`- ${dir}`);
    expect(seen).toContain("这些文件夹里的文件可以直接读，不用问用户");
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "read" || c.tool === "bash").map((c) => c.outcome)).toEqual(["done", "done"]);

    // 子 agent：同样不问，结果里是它看到的上下文
    const parallel = await eventually(() => cardsOf(frontend), (c) => c.type === "parallel", "并行确认卡");
    ok(await frontend.cardAction({ cardId: parallel.id, action: "parallel", expectedVersion: 1 }));
    const result = await eventually(() => messagesOf(frontend, M1), (m: MessageEventPayload) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 的结果");
    expect(textOf(result)).toContain(`- ${dir}`);
    expect(textOf(result)).toContain("这些文件夹里的文件可以直接读，不用问用户");
    expect(toolCallsOf(frontend, M1).filter((c) => (c.tool === "read" || c.tool === "bash") && c.outcome !== "done")).toEqual([]);

    // 评审：读完交了结论（要是在等审批，这一步走不到），拉起时带着那一块
    await waitUntil(() => [...contributions.keys()].some((id) => id.includes("review")), { timeoutMs: 60_000, describe: () => `等评审拉起：${[...contributions.keys()].join("、")}；负责人的工具调用：${toolCallsOf(frontend, M1).map((c) => `${c.tool}:${c.outcome}`).join("、")}` });
    await waitUntil(() => stageStates(td.daemon.tasks.get(task.id)!).s2 !== "running", { timeoutMs: 60_000, describe: () => "等 s2 评审完" });
    const reviewId = [...contributions.keys()].find((id) => id.includes("review"))!;
    expect(contributions.get(reviewId)).toMatchObject({ contextBlocks: [{ id: "authorized-folders", text: expect.stringContaining(`- ${dir}`) }] });

    expect(approvalCards(frontend)).toEqual([]);
    expect(td.daemon.approvals.list()).toEqual([]);
  });
});

describe("项目的负责人", () => {
  it("在项目的对话里读授权的文件夹：不问，上下文里写着可以直接读", { timeout: LONG }, async () => {
    const { dir, file } = photos();
    const td = await startTestDaemon({ maintainer: () => [call("read", { path: file }), ECHO] });
    const frontend = await TestFrontend.connect(td.url);
    const project = seedProject(td.daemon, "记账本", { state: "in_use" });
    const channel = maintainerChannel(project.maintainerId);
    await frontend.subscribe({ [CARDS]: 0, [INBOX]: 0, [channel]: 0 });
    await patchFolders(td, { add: [dir] });
    await frontend.sendText("读一下那份文件", { conversation: channel });
    await turnsOf(frontend, channel, 1);
    expect(toolCallsOf(frontend, channel).filter((c) => c.tool === "read").map((c) => c.outcome)).toEqual(["done"]);
    expect(approvalCards(frontend)).toEqual([]);
    const seen = textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(seen).toContain("这些文件夹里的文件可以直接读，不用问用户");
  });
});

describe("定时作业的一次运行", () => {
  it("读授权的文件夹不问，这次运行是成功、不是部分完成；上下文里写着可以直接读", { timeout: LONG }, async () => {
    const { dir, file } = photos();
    const clock = new ManualClock(at(8));
    const td = await startTestDaemon({
      clock,
      config: APPROVALS_ON,
      secretary: [say("好")],
      maintainer: () => [call(TOOL.read, { path: file }), ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [SECRETARY]: 0, [M1]: 0 });
    await patchFolders(td, { add: [dir] });
    const jobs = () => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
    ok(await frontend.startTask("每天早上出一份简报\n读一遍那份文件", "k-daily", [], "plain", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
    await eventually(jobs, (e) => e.change === "registered", "登记的触发");
    clock.advanceTo(at(9));
    const run = await eventually(jobs, (e) => e.change === "run_finished" && e.run?.runId === "j-1-r1", "这次运行结束");
    expect(run.run?.state).toBe("done");
    expect(approvalCards(frontend)).toEqual([]);
    const seen = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(seen).toContain("这些文件夹里的文件可以直接读，不用问用户");
  });
});

describe("流程", () => {
  it("读计划里没写的授权的文件夹：不算越出计划，不问；没授权的照样问", { timeout: LONG }, async () => {
    const { dir, file } = photos();
    const other = photos();
    const draft: WorkflowPlanDraft = {
      goal: "写好周报",
      steps: [{ id: "s1", title: "写周报", tool: TOOL.write, args: { path: "notes.md", content: "周报" } }],
      rules: [],
    };
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    fs.mkdirSync(path.join(dataDirLayout(dataDir).outputs, "t-1"), { recursive: true });
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("propose_plan", draft as unknown as Record<string, unknown>), say("计划交上去了")]
          : [call(TOOL.read, { path: file }), call(TOOL.ls, { path: dir }), call(TOOL.read, { path: other.file }), say("读完了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [M1]: 0 });
    await patchFolders(td, { add: [dir] });
    const task = td.daemon.tasks.createByRequest({ title: "整理周报", summary: "整理周报", kind: "workflow" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份周报", acceptanceCriteria: ["写好"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan", "流程计划卡");
    await turnsOf(frontend, M1, 1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
    await eventually(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload), (e) => e.change === "started", "流程开始执行");

    // 没授权的那个读才问
    const asked = await eventually(() => approvalCards(frontend), () => true, "读没授权的文件的审批卡");
    expect(JSON.stringify(asked.payload)).toContain(path.basename(path.dirname(other.file)));
    expect(JSON.stringify(asked.payload)).not.toContain(path.basename(dir));
    const calls = toolCallsOf(frontend, M1);
    expect(calls.filter((c) => c.tool === TOOL.ls || (c.tool === TOOL.read && c.outcome === "done")).map((c) => [c.tool, c.outcome])).toEqual([
      [TOOL.read, "done"],
      [TOOL.ls, "done"],
    ]);
  });
});

describe("把数据目录的上级授权了", () => {
  it("密钥区照样拒绝，配置区照旧要问，外面的文件才算授权", { timeout: LONG }, async () => {
    const dataDir = real(makeTempDir("ergo-data-"));
    const homeDir = makeTempDir("ergo-home-");
    const layout = dataDirLayout(dataDir);
    const beside = path.join(path.dirname(dataDir), `ergo-beside-${path.basename(dataDir)}.txt`);
    fs.writeFileSync(beside, CONTENT);
    fs.mkdirSync(layout.secrets, { recursive: true });
    const secret = path.join(layout.secrets, "key.txt");
    fs.writeFileSync(secret, "不该读到");
    const config = path.join(layout.config, "x.json");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      config: APPROVALS_ON,
      secretary: [call("read", { path: beside }), call("read", { path: secret }), call("bash", { command: `cat ${fwd(secret)}` }), say("读不了"), call("read", { path: config }), say("问了")],
    });
    fs.writeFileSync(config, "{}");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });
    await patchFolders(td, { add: [path.dirname(dataDir)] });

    await frontend.sendText("读一下");
    await turnsOf(frontend, SECRETARY, 1);
    const calls = toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "read" || c.tool === "bash");
    expect(calls.map((c) => [c.tool, c.outcome, c.blockedBy])).toEqual([
      ["read", "done", undefined],
      ["read", "blocked", "hard_refusal"],
      ["bash", "blocked", "hard_refusal"],
    ]);
    expect(approvalCards(frontend)).toEqual([]);

    await frontend.sendText("再读一下配置");
    await eventually(() => approvalCards(frontend), () => true, "读配置区的审批卡");
    fs.rmSync(beside, { force: true });
  });
});
