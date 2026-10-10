// 主切面：换模型就新开会话、附一份交接摘要（83 号票，规格第 1 节"模型"）。真的守护进程，目录模型（DeepSeek）的请求一律发到
// 本机的假 DeepSeek（helpers/fake-deepseek.ts），从不连真的；key 是假的。
// - 秘书：改了秘书的模型，用户的下一条消息时先用原来的模型写交接摘要、新开主线会话（第一条是摘要），这条消息和之后的都用新模型；
//   聊天里（同一个会话频道）一条"已换成 X 模型，接着之前的对话"；账本记一笔交接摘要的用量；重启后接着的是新会话；
//   运行时给秘书的通知不触发换；守护进程停着时改的设置，重启后照样是下一条消息时换；
// - 交接摘要没写成（模型出错）：不换，照旧用原来的模型、记一条说明，下一条消息再试；
// - 项目维护者：对话段里同样换，新会话的名字记进这一段；起草计划的工单段做到一半不换；
// - 定时作业的维护者：下一次运行开头换；
// - 任务的维护者：一个任务一个会话，执行中途不换。
import {
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type ModelSettingsBody,
  type Plan,
  type PlanCardPayload,
  type ScheduledJobEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FAKE_DEEPSEEK_REPLY, type FakeDeepSeek, type FakeDeepSeekRequest, requestText, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { modelSettingsApi } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { projectTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { say } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假的 key（守护进程环境里的 DEEPSEEK_API_KEY） */
const KEY = "sk-main-83-fake-key-Hd02Tq";
const SECRETARY = CHANNELS.secretary;

const settings = (agents: ModelSettingsBody["agents"]): ModelSettingsBody => ({ provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents, vision: {} });

/** 写交接摘要的那次请求：pi 的压缩摘要提示，二狗的写法接在后面 */
const isSummary = (r: FakeDeepSeekRequest) => requestText(r).includes("Additional focus:");

/** 等假 DeepSeek 收到第 n 个请求 */
const requests = (fake: FakeDeepSeek, n: number) =>
  waitUntil(() => fake.requests.length >= n, { timeoutMs: 60_000, describe: () => `等第 ${n} 个请求，现在：${JSON.stringify(fake.requests.map((r) => r.body.model))}` });

/** 会话频道里的系统说明（不是交给 agent 的通知） */
const notesIn = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === "system" && p.agentInput !== true)
    .map((p) => p.message.parts.map((part) => ("text" in part ? part.text : "")).join(""));

/** 一个频道里处理完了几条输入 */
const turnsDone = (td: TestDaemon, channel: string) => td.daemon.store.read(channel, 0, EVENT_TYPES.turnEnd).length;

describe("秘书换模型", () => {
  it("改了秘书的模型：用户下一条消息时用原来的模型写交接摘要、新开主线会话，这条和之后的用新模型；聊天里一条系统说明；账本记交接摘要；通知不触发换；重启后接着新会话", async () => {
    const fake = await startFakeDeepSeek();
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const options = { reuse: { dataDir, homeDir }, modelsFromSettings: ["secretary"] as const, catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } };
    const first = await startTestDaemon(options);
    const frontend = await TestFrontend.connect(first.url);
    await frontend.sendText("我在整理十月的发票，按月份分文件夹");
    await requests(fake, 1);
    expect(fake.requests[0]!.body.model).toBe("deepseek-flash");
    await waitUntil(() => turnsDone(first, SECRETARY) === 1);

    expect((await modelSettingsApi.change(first.url, settings({ secretary: { modelId: "deepseek-v4-pro" } }))).status).toBe(200);
    // 运行时给秘书的通知：照旧用原来的模型，不写交接摘要
    first.daemon.store.append(buildAgentNotice(SECRETARY, "【系统通知】任务 t-9 做完了", "test-83-notice").event);
    await requests(fake, 2);
    await waitUntil(() => turnsDone(first, SECRETARY) === 2);
    expect(fake.requests[1]!.body.model).toBe("deepseek-flash");
    expect(isSummary(fake.requests[1]!)).toBe(false);

    // 用户的下一条消息：先用原来的 flash 写交接摘要（秘书的写法：任务只留编号、看板不用写），再交给新会话、用 v4-pro
    await frontend.sendText("接着来");
    await requests(fake, 4);
    const summary = fake.requests[2]!;
    expect(isSummary(summary)).toBe(true);
    expect(summary.body.model).toBe("deepseek-flash");
    expect(requestText(summary)).toContain("我在整理十月的发票");
    expect(requestText(summary)).toContain("交接用的");
    expect(requestText(summary)).toContain("长期主线对话");
    const reply = fake.requests[3]!;
    expect(reply.body.model).toBe("deepseek-v4-pro");
    expect(requestText(reply)).toContain("【交接摘要】");
    expect(requestText(reply)).toContain(FAKE_DEEPSEEK_REPLY);
    expect(requestText(reply)).not.toContain("按月份分文件夹");
    await waitUntil(() => turnsDone(first, SECRETARY) === 3);
    // 同一个会话频道里一条系统说明
    expect(notesIn(first, SECRETARY)).toEqual(["已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。"]);
    // 账本：交接摘要单独一笔，记在原来的模型名下（秘书的是系统开销）
    await waitUntil(() => first.daemon.ledger.entries().filter((e) => e.agentId === "secretary").length === 4);
    expect(first.daemon.ledger.entries().filter((e) => e.agentId === "secretary").map((e) => [e.purpose, e.model])).toEqual([
      ["work", "deepseek/deepseek-flash"],
      ["work", "deepseek/deepseek-flash"],
      ["handoff", "deepseek/deepseek-flash"],
      ["work", "deepseek/deepseek-v4-pro"],
    ]);
    expect((await modelSettingsApi.view(first.url)).body.secretarySession).toMatchObject({ modelId: "deepseek-v4-pro" });
    // 之后的消息接着新会话，不再写摘要
    await frontend.sendText("再说一句");
    await requests(fake, 5);
    expect(fake.requests[4]!.body.model).toBe("deepseek-v4-pro");
    expect(isSummary(fake.requests[4]!)).toBe(false);
    await waitUntil(() => turnsDone(first, SECRETARY) === 4);
    await frontend.close();
    await first.daemon.stop();

    // 重启：接着的是新会话（v4-pro，开头是交接摘要），不再换
    const second = await startTestDaemon(options);
    const again = await TestFrontend.connect(second.url);
    await again.sendText("还在吗");
    await requests(fake, 6);
    expect(fake.requests[5]!.body.model).toBe("deepseek-v4-pro");
    expect(isSummary(fake.requests[5]!)).toBe(false);
    expect(requestText(fake.requests[5]!)).toContain("【交接摘要】");
    expect(notesIn(second, SECRETARY)).toHaveLength(1);
  }, 120_000);

  it("交接摘要没写成（模型出错）：不换，这一条照旧用原来的模型、记一条说明；下一条消息再试，写成了就换", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["secretary"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("在吗");
    await requests(fake, 1);
    await waitUntil(() => turnsDone(td, SECRETARY) === 1);

    expect((await modelSettingsApi.change(td.url, settings({ secretary: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } }))).status).toBe(200);
    fake.failNext("模拟的出错：交接摘要写不出来");
    await frontend.sendText("第二句");
    await requests(fake, 3);
    expect(isSummary(fake.requests[1]!)).toBe(true);
    // 没换：这一条照旧交给原来的会话、用 flash
    expect(fake.requests[2]!.body.model).toBe("deepseek-flash");
    expect(isSummary(fake.requests[2]!)).toBe(false);
    await waitUntil(() => turnsDone(td, SECRETARY) === 2);
    const [failed] = notesIn(td, SECRETARY);
    expect(failed).toMatch(/^没能换成 DeepSeek V4 Pro 模型（思考：关）：写交接摘要时出错（.*模拟的出错：交接摘要写不出来.*）。这一轮照旧用 DeepSeek V4\.1 Flash 模型（思考：高），下一轮再试。$/);
    expect((await modelSettingsApi.view(td.url)).body.secretarySession).toMatchObject({ modelId: "deepseek-flash" });

    // 下一条消息再试：写成了就换
    await frontend.sendText("第三句");
    await requests(fake, 5);
    expect(isSummary(fake.requests[3]!)).toBe(true);
    expect(fake.requests[3]!.body.model).toBe("deepseek-flash");
    expect(fake.requests[4]!.body).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "disabled" } });
    await waitUntil(() => turnsDone(td, SECRETARY) === 3);
    expect(notesIn(td, SECRETARY).at(-1)).toBe("已换成 DeepSeek V4 Pro 模型（思考：关），接着之前的对话。");
  }, 120_000);
});

/** 一个已经立项、用着的项目（维护者 pm-1） */
const seedInUse = (td: TestDaemon) => seedProject(td.daemon, "家庭网盘", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });

describe("维护者换模型", () => {
  it("项目维护者的对话段：改了以后下一条消息时写交接摘要、新开会话（名字记进这一段），之后用新模型", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["maintainer"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } });
    seedInUse(td);
    const PM1 = maintainerChannel("pm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("网盘最近满了吗", { conversation: PM1 });
    await requests(fake, 1);
    await waitUntil(() => turnsDone(td, PM1) === 1);
    const segment = td.daemon.workOrders.current("pm-1")!;
    expect(segment).toMatchObject({ kind: "chat", session: segment.segmentId });

    expect((await modelSettingsApi.change(td.url, settings({ project_maintainer: { modelId: "deepseek-v4-pro" } }))).status).toBe(200);
    await frontend.sendText("那清理一下旧照片", { conversation: PM1 });
    await requests(fake, 3);
    expect(isSummary(fake.requests[1]!)).toBe(true);
    expect(fake.requests[1]!.body.model).toBe("deepseek-flash");
    expect(requestText(fake.requests[1]!)).toContain("网盘最近满了吗");
    expect(fake.requests[2]!.body.model).toBe("deepseek-v4-pro");
    expect(requestText(fake.requests[2]!)).toContain("【交接摘要】");
    await waitUntil(() => turnsDone(td, PM1) === 2);
    expect(notesIn(td, PM1)).toContain("已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。");
    // 还是同一段对话段，接的会话换成了新的
    const after = td.daemon.workOrders.current("pm-1")!;
    expect(after.segmentId).toBe(segment.segmentId);
    expect(after.session).not.toBe(segment.session);
  }, 120_000);

  it("项目维护者的工单段（起草计划）做到一半不换：照旧用这一段开始时的模型，不写交接摘要", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["maintainer"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } });
    seedInUse(td);
    const PM1 = maintainerChannel("pm-1");
    projectTask(td.daemon, "家庭网盘", "清理旧照片", { goal: "清理旧照片", acceptanceCriteria: ["空出 10G"], constraints: [], memoryScope: "" });
    await requests(fake, 1);
    await waitUntil(() => turnsDone(td, PM1) === 1);
    expect(td.daemon.workOrders.current("pm-1")).toMatchObject({ kind: "work_order" });

    expect((await modelSettingsApi.change(td.url, settings({ project_maintainer: { modelId: "deepseek-v4-pro" } }))).status).toBe(200);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("计划写得怎样了", { conversation: PM1 });
    await requests(fake, 2);
    await waitUntil(() => turnsDone(td, PM1) === 2);
    expect(fake.requests.map((r) => r.body.model)).toEqual(["deepseek-flash", "deepseek-flash"]);
    expect(fake.requests.some(isSummary)).toBe(false);
    expect(notesIn(td, PM1).filter((t) => t.includes("换成"))).toEqual([]);
  }, 120_000);

  it("任务的维护者：一个任务一个会话，改了设置也不中途换", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["maintainer"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } });
    const TM1 = maintainerChannel("tm-1");
    const task = td.daemon.tasks.createByRequest({ title: "A 的调研", summary: "A 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "调研 A", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    await requests(fake, 1);
    await waitUntil(() => turnsDone(td, TM1) === 1);
    expect((await modelSettingsApi.change(td.url, settings({ task_maintainer: { modelId: "deepseek-v4-pro" } }))).status).toBe(200);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("再查一下来源", { conversation: TM1 });
    await requests(fake, 2);
    await waitUntil(() => turnsDone(td, TM1) === 2);
    expect(fake.requests.map((r) => r.body.model)).toEqual(["deepseek-flash", "deepseek-flash"]);
    expect(fake.requests.some(isSummary)).toBe(false);
  }, 120_000);

  it("定时作业的维护者：改了以后下一次运行开头写交接摘要、新开会话，这次运行用新模型", async () => {
    const fake = await startFakeDeepSeek();
    const clock = new ManualClock(at(8, 8));
    const td = await startTestDaemon({
      clock,
      catalogBaseUrl: fake.baseUrl,
      env: { DEEPSEEK_API_KEY: KEY },
      // 建作业的任务的维护者照 faux 剧本交带着作业的计划；作业自己的维护者按设置用目录模型
      maintainersFromSettings: (id) => id === "jm-1",
      maintainer: (id, n) => (id === "tm-1" && n === 1 ? [submitPlanStep(jobPlan()), say("计划交上去了")] : [say("好")]),
    });
    const JM1 = maintainerChannel("jm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.board]: 0, [CHANNELS.cards]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "每天早上出简报", summary: "每天早上出简报" });
    td.daemon.tasks.writeBrief(task.id, { goal: "每天早上出简报", acceptanceCriteria: ["每天都有简报"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(
      () => frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as { card: { id: string; type: string; version: number; payload: unknown } }).card),
      (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id,
      "计划卡",
    );
    await waitUntil(() => turnsDone(td, maintainerChannel(task.maintainerId)) >= 1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    const jobs = () => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
    await eventually(jobs, (e) => e.change === "registered", "作业登记");

    // 第一次运行：flash
    clock.advanceTo(at(8, 9));
    await eventually(jobs, (e) => e.change === "run_finished" && e.run?.runId === "j-1-r1", "第一次运行结束", 60_000);
    expect(fake.requests.map((r) => r.body.model)).toEqual(["deepseek-flash"]);

    // 改了（定时作业的维护者算任务维护者）：第二次运行开头先用 flash 写交接摘要，再用 v4-pro 做这次运行
    expect((await modelSettingsApi.change(td.url, settings({ task_maintainer: { modelId: "deepseek-v4-pro" } }))).status).toBe(200);
    clock.advanceTo(at(9, 9));
    await eventually(jobs, (e) => e.change === "run_finished" && e.run?.runId === "j-1-r2", "第二次运行结束", 60_000);
    expect(fake.requests.map((r) => [r.body.model, isSummary(r)])).toEqual([
      ["deepseek-flash", false],
      ["deepseek-flash", true],
      ["deepseek-v4-pro", false],
    ]);
    expect(requestText(fake.requests[2]!)).toContain("【交接摘要】");
    expect(notesIn(td, JM1)).toContain("已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。");
  }, 180_000);
});

/** 本地时间 2026 年 10 月 d 日 hh:00 */
const at = (d: number, hh: number) => new Date(2026, 9, d, hh, 0);

/** 每天早上 09:00 出一份简报 */
const BRIEFING = { title: "每天早上出简报", schedule: { kind: "daily" as const, time: "09:00" }, each: "汇总昨天的新闻，写一份简报 brief.md" };

/** 一个阶段（由用户验收）的计划，带着作业定义（同 scheduled-jobs.test.ts） */
function jobPlan(): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "准备简报模板",
        deliverables: ["template.md"],
        acceptance: [{ criterion: "你看过觉得行", method: "user" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    scheduledJobs: [BRIEFING],
    stops: { count: 1, where: ["由你验收"] },
  };
}
