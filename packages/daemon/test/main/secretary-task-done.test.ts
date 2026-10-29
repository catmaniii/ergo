// 主切面：任务做完告诉秘书（99 号票，规格第 7 节"任务做完告诉秘书"）。真的守护进程，秘书、维护者接 faux 剧本，测试扮演前端：
// - 普通任务、流程、长程任务做完，定时触发的任务每次运行成功，秘书都收到一条"任务做完"的通知（剧本里 echo_context 回显它收到的），
//   写明哪个任务、做它的 agent 最后说的那段话（太长截短并写明）、交付的文件；秘书接着在主线里说一声（不等用户开口）；
// - 流程报完最后一步、长程任务最后一个阶段验收通过时 agent 这一轮还没说完：等它说完再交（通知里是它最后那段话）；
// - 运行失败的不发；项目内部的不发（plain-tasks.test.ts 里项目内部的普通任务只收到"在哪个项目里做完了"）；
// - 几件差不多同时做完的并成一条；秘书正在和用户说话时排在这一轮后面；停机前攒着没交的，起来后补；
// - 秘书处理这条通知到一半被打断（子进程崩溃、守护进程重启）：不出"请重发"的说明，起来后重新交一次，只说一遍；
// - 运行的最后说的话只算收工那一轮（属于项目的旧作业之后催写回的几轮不算）；几次运行并在一条里时交付的文件各算各的；
// - 用户说要念：秘书用发语音（send_voice）把结果的口语稿念成语音气泡。
// 安静多久、并成一条按时钟算：要控制时机的用手动拨的时钟（ManualClock），拨过安静的那段才交。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  nowIso,
  type Plan,
  type ResponseFrame,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Task,
  type TaskEventPayload,
  type TurnEndEventPayload,
  Type,
  type WorkflowPlanDraft,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { taskDoneItemText, TASK_DONE_TAG } from "../../src/secretary/task-done.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { media } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { onePlan } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { agentVoiceSettled, importReferenceVoice, startFakeSpeechService } from "../helpers/tts.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX } = CHANNELS;
const TM1 = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const report = (stepId: string, status: string) => call("report_step", { stepId, status });
/** 对话审批关着（正式的默认）：普通任务的 agent 在工作目录里写文件直接做 */
const APPROVALS_OFF = { guard: { conversationApprovals: "off" } };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
/** 秘书会话里任务做完的通知（运行时发的、排进它输入队列的系统消息） */
const doneNotices = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && textOf(m).startsWith(TASK_DONE_TAG));
const doneTexts = (frontend: TestFrontend) => doneNotices(frontend).map(textOf);
/** 秘书在主线里说的话（有文字的） */
const secretarySaid = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY)
    .filter((m) => m.message.speaker === "agent")
    .map((m) => m.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .filter((t) => t !== "");
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions) {
  const td = await startTestDaemon(options);
  return { ...td, frontend: await connect(td.url) };
}

/** 等秘书会话里有 n 条任务做完的通知 */
const noticesArrived = (frontend: TestFrontend, n: number, timeoutMs = 30_000) =>
  waitUntil(() => doneNotices(frontend).length >= n, { timeoutMs, describe: () => `等第 ${n} 条任务做完的通知（现在：${JSON.stringify(doneTexts(frontend))}）` });
/** 等秘书处理完第 n 条输入 */
const secretaryTurns = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等秘书处理完 ${n} 条输入` });
/** 等某个任务第 n 次做完（看板上的 completed） */
const completed = (frontend: TestFrontend, taskId: string, n = 1) =>
  waitUntil(() => tasksOf(frontend).filter((e) => e.task.id === taskId && e.change === "completed").length >= n, { timeoutMs: 30_000, describe: () => `等任务 ${taskId} 做完` });
/** 秘书最后一次模型调用看到的上下文（剧本里 echo_context 的回显，去掉时间标记） */
const lastEcho = (frontend: TestFrontend) => stripTimeMarkers(secretarySaid(frontend).at(-1) ?? "");
/** 由测试放行的闸门：秘书的工具等着它，秘书就一直"在这一轮里" */
function testGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
/** 真等一会儿（确认某件事没有发生） */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 通知最后那句：要秘书在主线里说一声、问要不要念 */
const ASK_ONE = "在主线里主动跟用户说一声：用一两句话说这件做完了、结果大概是什么，然后问“要我念给你听吗？”。他说要，就用 send_voice 把结果的口语稿念给他听；说不用就算了。";

describe("做完就告诉秘书，秘书在主线里说一声", () => {
  it("普通任务做完：秘书收到通知（哪个任务、它最后说的话、交付的文件），模型看到的就是它；秘书接着在主线里说一声", async () => {
    const { frontend } = await setup({
      config: APPROVALS_OFF,
      secretary: [ECHO],
      maintainer: [call(TOOL.write, { path: "qingtian.mp3", content: "假的音频" }), say("下好了：工作目录里的 qingtian.mp3")],
    });
    ok(await frontend.startTask("去把《晴天》的音频下下来\n要 mp3", "k-plain", [], "plain"));
    await noticesArrived(frontend, 1);
    await secretaryTurns(frontend, 1);

    const [notice] = doneTexts(frontend);
    expect(notice).toBe(
      [
        `${TASK_DONE_TAG}后台有一件事做完了（运行时发来的，不是用户说的）：`,
        "普通任务 t-1「去把《晴天》的音频下下来」在后台做完了。\n它最后说：\n下好了：工作目录里的 qingtian.mp3\n交付的文件（在任务的产出区里）：qingtian.mp3",
        ASK_ONE,
      ].join("\n\n"),
    );
    // 交给秘书的就是它（开头标着系统通知），不是用户说的；秘书没等用户开口就在主线里回了一条
    expect(lastEcho(frontend)).toContain(`[user] [系统通知]\n${notice}`);
    expect(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "user")).toEqual([]);
    expect(messagesOf(frontend, SECRETARY).map((m) => m.message.speaker)).toEqual(["system", "agent"]);
  });

  // 311 号票（294 号票端到端小测第 5 条：跑 pytest 留下的 __pycache__ 里的 .pyc 也数进了"交了几个文件"）
  it("交付的文件不算缓存和编译产物：__pycache__、*.pyc、node_modules、.pytest_cache 这类不列也不数", async () => {
    const { frontend } = await setup({
      config: APPROVALS_OFF,
      secretary: [ECHO],
      maintainer: [
        call(TOOL.write, { path: "todo.py", content: "print('todo')\n" }),
        call(TOOL.write, { path: "__pycache__/todo.cpython-312.pyc", content: "假的字节码" }),
        call(TOOL.write, { path: "build/app.pyc", content: "假的字节码" }),
        call(TOOL.write, { path: "node_modules/left-pad/index.js", content: "module.exports = 1;\n" }),
        call(TOOL.write, { path: ".pytest_cache/v/cache/lastfailed", content: "{}" }),
        say("写好了 todo.py"),
      ],
    });
    ok(await frontend.startTask("写个待办小工具", "k-pyc", [], "plain"));
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    expect(notice).toContain("交付的文件（在任务的产出区里）：todo.py\n");
    expect(notice).not.toMatch(/pyc|node_modules|pytest_cache/);
  });

  it("流程报完最后一步时维护者这一轮还没说完：等它说完再交，通知里是它最后那段话和写出的文件", async () => {
    const draft: WorkflowPlanDraft = {
      goal: "写好笔记并读一遍",
      steps: [
        { id: "s1", title: "写笔记", tool: TOOL.write, args: { path: "notes.md", content: "# 笔记\n- 第一条\n" } },
        { id: "s2", title: "读一遍笔记", tool: TOOL.read, args: { path: "notes.md" }, after: ["s1"] },
      ],
      rules: [],
    };
    // 安静 1 毫秒：不等维护者说完的话，交的时候它最后那段话还没出来
    const { frontend, daemon } = await setup({
      taskDoneSettleMs: 1,
      secretary: [say("笔记写好了，要我念给你听吗？")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("propose_plan", draft as unknown as Record<string, unknown>), say("计划交上去了")]
          : [
              call(TOOL.write, { path: "notes.md", content: "# 笔记\n- 第一条\n" }),
              report("s1", "done"),
              call(TOOL.read, { path: "notes.md" }),
              report("s2", "done"),
              say("都做完了：笔记写好、读过一遍"),
            ],
    });
    const task = daemon.tasks.createByRequest({ title: "整理笔记", summary: "整理笔记", kind: "workflow" });
    daemon.tasks.writeBrief(task.id, { goal: "整理一份笔记", acceptanceCriteria: ["笔记写好、读过一遍"], constraints: [], projects: [], memoryScope: "" });
    let card: Card | undefined;
    await waitUntil(() => (card = cardsOf(frontend).find((c) => c.type === "workflow_plan")) !== undefined, { timeoutMs: 30_000, describe: () => "等流程计划卡" });
    ok(await frontend.cardAction({ cardId: card!.id, action: "confirm", expectedVersion: card!.version, input: { confirmations: [] } }));

    await completed(frontend, task.id);
    await noticesArrived(frontend, 1);
    expect(doneTexts(frontend)[0]).toContain("流程 t-1「整理笔记」在后台做完了。\n它最后说：\n都做完了：笔记写好、读过一遍\n交付的文件（在任务的产出区里）：notes.md");
    // 维护者这一轮结束之后才交
    const turnEnd = daemon.store.read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.turnEnd).at(-1)!;
    const noticeEvent = daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).find((e) => textOf(e.payload as MessageEventPayload).startsWith(TASK_DONE_TAG))!;
    expect(noticeEvent.globalSeq).toBeGreaterThan(turnEnd.globalSeq);
    await secretaryTurns(frontend, 1);
    expect(secretarySaid(frontend)).toEqual(["笔记写好了，要我念给你听吗？"]);
  }, 60_000);

  it("长程任务最后一个阶段验收通过：等维护者这一轮说完再交；最后说的话太长的截短并写明", async () => {
    const plan: Plan = { ...onePlan(), stages: [{ ...onePlan().stages[0]!, acceptance: [{ criterion: "跑得通", method: "script", script: "true" }] }], stops: { count: 0, where: [] } };
    const long = `发票整理好了。${"每张发票都核对过金额和抬头，".repeat(80)}`;
    const { frontend, daemon } = await setup({
      config: APPROVALS_OFF,
      taskDoneSettleMs: 1,
      secretary: [ECHO],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了")]
          : [call(TOOL.write, { path: "invoices.csv", content: "日期,金额\n" }), call("complete_stage", { stageId: "s1", summary: "发票汇总写好了" }), say(long)],
    });
    const task = daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    daemon.tasks.writeBrief(task.id, { goal: "整理发票", acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
    let card: Card | undefined;
    await waitUntil(() => (card = cardsOf(frontend).find((c) => c.type === "plan")) !== undefined, { timeoutMs: 30_000, describe: () => "等计划卡" });
    ok(await frontend.cardAction({ cardId: card!.id, action: "confirm", expectedVersion: card!.version, input: {} }));

    await completed(frontend, task.id);
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    expect(notice).toContain(`长程任务 ${task.id}「整理发票」在后台做完了。\n它最后说（太长，这里只留了前 1000 字，原文在任务详情里）：\n${long.slice(0, 1000)}……\n交付的文件（在任务的产出区里）：invoices.csv`);
    await secretaryTurns(frontend, 1);
    expect(lastEcho(frontend)).toContain(`[user] [系统通知]\n${notice}`);
  }, 60_000);

  it("通知里的一件：没留下说明的写明；交付的文件多了只列前 10 个", () => {
    expect(taskDoneItemText("普通任务 t-1「下歌」在后台做完了。", undefined, [])).toBe("普通任务 t-1「下歌」在后台做完了。\n它没有留下结果的说明。");
    const files = Array.from({ length: 12 }, (_, i) => `f${i + 1}.txt`);
    expect(taskDoneItemText("x", "好了", files)).toBe(`x\n它最后说：\n好了\n交付的文件（在任务的产出区里）：${files.slice(0, 10).join("、")} 等 12 个`);
  });
});

/**
 * 本地时间 2026 年 1 月 d 日 hh:mm（2026-01-05 是周一）。手动拨的时钟下事件的时间是拨到的时刻、文件的修改时间是真的时间，
 * 对不上：交付的文件在用系统时钟的用例里测
 */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 0, d, hh, mm);

describe("定时触发的任务每次运行完", () => {
  it("每运行成功一次秘书收到一条（第几次运行、怎么触发的、最后说的话），失败的那次不发", async () => {
    const clock = new ManualClock(at(5, 8));
    const { frontend } = await setup({
      clock,
      secretary: [say("今天的简报写好了，要我念给你听吗？"), say("第三份简报也好了，要念吗？")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [say("简报写好了：brief.md，今天三条要闻")]
          : spawn === 2
            ? [call("fail_job_run", { reason: "新闻源连不上" }), say("这次没做成")]
            : [say("第三份简报写好了，两条要闻")],
    });
    const trigger = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };
    ok(await frontend.startTask("每天早上出简报\n汇总昨天的新闻，写一份简报 brief.md", "k-brief", [], "plain", trigger));
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "registered"), { timeoutMs: 30_000, describe: () => "等登记" });

    const runEnded = (n: number) =>
      waitUntil(() => jobsOf(frontend).filter((e) => e.change === "run_finished").length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 次运行结束` });
    clock.advanceTo(at(5, 9));
    await runEnded(1);
    // 安静的那段按时钟算：拨过去才交
    expect(doneNotices(frontend)).toEqual([]);
    clock.advance(1000);
    await noticesArrived(frontend, 1);
    expect(doneTexts(frontend)[0]).toBe(
      [
        `${TASK_DONE_TAG}后台有一件事做完了（运行时发来的，不是用户说的）：`,
        "定时触发的普通任务 t-1「每天早上出简报」的第 1 次运行做完了（触发：1 月 5 日（周一）09:00 到点）。\n它最后说：\n简报写好了：brief.md，今天三条要闻",
        ASK_ONE,
      ].join("\n\n"),
    );
    // 115 号票：会话里折成一行时的一句话总结（运行时拼的）
    expect(doneNotices(frontend)[0]!.message.summary).toBe("t-1「每天早上出简报」第 1 次运行做完了");
    await secretaryTurns(frontend, 1);
    expect(secretarySaid(frontend)).toEqual(["今天的简报写好了，要我念给你听吗？"]);

    // 第 2 次失败了：不发（失败照旧走待我处理的规矩）
    clock.advanceTo(at(6, 9));
    await runEnded(2);
    expect(jobsOf(frontend).filter((e) => e.change === "run_finished").at(-1)?.run?.state).toBe("failed");
    clock.advance(1000);
    await pause(500);
    expect(doneNotices(frontend)).toHaveLength(1);

    clock.advanceTo(at(7, 9));
    await runEnded(3);
    clock.advance(1000);
    await noticesArrived(frontend, 2);
    expect(doneTexts(frontend)[1]).toContain("定时触发的普通任务 t-1「每天早上出简报」的第 3 次运行做完了（触发：1 月 7 日（周三）09:00 到点）。\n它最后说：\n第三份简报写好了，两条要闻");
    await secretaryTurns(frontend, 2);
    expect(secretarySaid(frontend)).toEqual(["今天的简报写好了，要我念给你听吗？", "第三份简报也好了，要念吗？"]);
  }, 90_000);
});

describe("改成某个时间做一次的定时任务（98 号票）", () => {
  it("那一次做成了、任务从运营中随之完成：秘书只收到一件（按那次运行说，写明任务随之完成），不另报任务做完", async () => {
    const clock = new ManualClock(at(5, 8));
    const { frontend } = await setup({ clock, secretary: [say("航班查好了，要我念给你听吗？")], maintainer: [say("查好了：两班直飞")] });
    ok(await frontend.startTask("查航班\n查一下飞新加坡的直飞航班", "k-flight", [], "plain", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "registered"), { timeoutMs: 30_000, describe: () => "等登记" });
    const once = { kind: "once" as const, at: nowIso(at(5, 10)) };
    ok(await frontend.rescheduleJob({ jobId: "j-1", schedule: once }));
    clock.advanceTo(at(5, 10));
    await completed(frontend, "t-1");
    expect(tasksOf(frontend).find((e) => e.change === "completed")).toMatchObject({ from: "operating", by: "system" });
    clock.advance(1000);
    await noticesArrived(frontend, 1);
    expect(doneTexts(frontend)).toEqual([
      [
        `${TASK_DONE_TAG}后台有一件事做完了（运行时发来的，不是用户说的）：`,
        "定时触发的普通任务 t-1「查航班」的第 1 次运行做完了（触发：1 月 5 日（周一）10:00 到点）。这是定在那个时间做的一次，做成了，任务随之完成。\n它最后说：\n查好了：两班直飞",
        ASK_ONE,
      ].join("\n\n"),
    ]);
    await secretaryTurns(frontend, 1);
    expect(secretarySaid(frontend)).toEqual(["航班查好了，要我念给你听吗？"]);
    clock.advance(1000);
    await pause(300);
    expect(doneNotices(frontend)).toHaveLength(1);
  }, 60_000);
});

describe("运行的结果只算这一次运行", () => {
  it("属于项目的旧定时作业要等工单写回才算运行结束：最后说的话是收工那一轮的，不是之后催写回那几轮的", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
    const clock = new ManualClock(at(5, 8));
    const writeBack = [
      call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: "做到哪了、下一步做什么：每段工作结束时写回。", newText: "汇总了今天的资讯。" }] }),
      call("write_segment_summary", { summary: "汇总了今天的资讯" }),
      say("写回了"),
    ];
    const { daemon, frontend } = await setup({ clock, reuse: { dataDir, homeDir }, secretary: [ECHO], maintainer: (id) => (id === "pm-1" ? [say("今天的资讯汇总好了：三条要闻"), ...writeBack] : []) });
    seedProject(daemon, "资讯站", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    // 76 号票之前长程任务计划里登记的、属于项目「资讯站」的定时作业（不是项目内部的）：由项目的维护者在一张工单里做
    const time = nowIso(at(5, 8));
    const creator: Task = { id: "t-1", title: "准备每天的资讯", summary: "准备每天的资讯", state: "done", origin: "request", kind: "long_running", maintainerId: "tm-1", projects: ["资讯站"], projectIds: ["p-1"], projectScope: "single", createdAt: time, updatedAt: time };
    const legacy: ScheduledJob = {
      id: "j-1",
      title: "每天汇总资讯",
      schedule: { kind: "daily", time: "09:00" },
      each: "汇总今天的资讯",
      projectId: "p-1",
      projectName: "资讯站",
      maintainerId: "pm-1",
      taskId: "t-1",
      taskTitle: "准备每天的资讯",
      grants: [],
      temporalRules: [],
      grantInfo: {},
      state: "active",
      nextAt: nowIso(at(5, 9)),
      lastFailed: false,
      consecutiveFailures: 0,
      runCount: 0,
      createdAt: time,
      updatedAt: time,
    };
    daemon.store.appendBatch([
      { channel: BOARD, type: EVENT_TYPES.task, payload: { task: creator, change: "created", from: null, by: "secretary" } satisfies TaskEventPayload },
      { channel: BOARD, type: EVENT_TYPES.scheduledJob, payload: { job: legacy, change: "registered", by: "user" } satisfies ScheduledJobEventPayload, idempotencyKey: "job-register:t-1-p1:0" },
    ]);
    clock.advanceTo(at(5, 9));
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "run_finished"), { timeoutMs: 60_000, describe: () => "等这次运行结束（工单写回之后）" });
    expect(jobsOf(frontend).find((e) => e.change === "run_finished")?.run?.state).toBe("done");
    // 写回那一轮确实在运行结束之前
    expect(daemon.store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message).some((e) => (e.payload as MessageEventPayload).message.parts.some((p) => p.type === "text" && p.text === "写回了"))).toBe(true);
    clock.advance(1000);
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    expect(notice).toContain("定时作业 j-1「每天汇总资讯」的第 1 次运行做完了（触发：1 月 5 日（周一）09:00 到点）。\n它最后说：\n今天的资讯汇总好了：三条要闻\n\n");
    expect(notice).not.toContain("写回了");
  }, 90_000);

  it("同一个任务的两次运行并在一条里：交付的文件各列各的（前一次不算上后一次写的）", async () => {
    const { daemon, frontend } = await setup({
      config: APPROVALS_OFF,
      taskDoneSettleMs: 8000,
      secretary: [ECHO],
      maintainer: (_id, spawn) =>
        spawn === 1 ? [call(TOOL.write, { path: "a.md", content: "第一份" }), say("第一份写好了")] : [call(TOOL.write, { path: "b.md", content: "第二份" }), say("第二份写好了")],
    });
    ok(await frontend.startTask("每天出简报\n写一份简报", "k-brief", [], "plain", { kind: "schedule", schedule: { kind: "daily", time: "03:00" } }));
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "registered"), { timeoutMs: 30_000, describe: () => "等登记" });
    const runEnded = (n: number) => waitUntil(() => jobsOf(frontend).filter((e) => e.change === "run_finished").length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 次运行结束` });
    daemon.scheduledJobs.fire("t-1", { source: "time", at: nowIso(), summary: "手动触发第一次" }, "k-fire-1");
    await runEnded(1);
    daemon.scheduledJobs.fire("t-1", { source: "time", at: nowIso(), summary: "手动触发第二次" }, "k-fire-2");
    await runEnded(2);
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    expect(notice).toContain("1. 定时触发的普通任务 t-1「每天出简报」的第 1 次运行做完了（触发：手动触发第一次）。\n它最后说：\n第一份写好了\n交付的文件（在任务的产出区里）：a.md\n\n");
    expect(notice).toContain("2. 定时触发的普通任务 t-1「每天出简报」的第 2 次运行做完了（触发：手动触发第二次）。\n它最后说：\n第二份写好了\n交付的文件（在任务的产出区里）：b.md\n\n");
  }, 60_000);
});

/** 秘书会话里各条输入的结局（按先后） */
const outcomes = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as TurnEndEventPayload).outcome);
/** 秘书会话里给人看的系统说明 */
const notes = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true).map(textOf);

describe("秘书处理到一半被打断：起来后重新交一次", () => {

  it("秘书子进程崩溃：这条标成中断、不出“请重发”，重新拉起后同一段话再交一次，秘书说一声；只说一遍", async () => {
    const gate = testGate();
    const lookUp = defineHostTool({ name: "look_up", title: "查一查", description: "查点东西（测试里等测试放行）", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: async () => (await gate.promise, { text: "查到了" }) });
    const { daemon, frontend } = await setup({
      secretaryTools: [lookUp],
      secretary: [call("look_up", {}), say("整理照片做完了，要我念给你听吗？")],
      maintainer: [say("照片按月份分好了")],
    });
    ok(await frontend.startTask("整理照片", "k-photos", [], "plain"));
    await noticesArrived(frontend, 1);
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理通知" });
    await pause(500);
    const pid = daemon.secretary.pid!;
    process.kill(pid);
    gate.open();

    await noticesArrived(frontend, 2);
    const [first, again] = doneTexts(frontend);
    expect(again).toBe(first);
    await waitUntil(() => secretarySaid(frontend).includes("整理照片做完了，要我念给你听吗？"), { timeoutMs: 30_000, describe: () => `等秘书说一声（现在：${JSON.stringify(secretarySaid(frontend))}）` });
    await waitUntil(() => outcomes(frontend).length >= 2, { timeoutMs: 30_000, describe: () => "等第二次处理完" });
    expect(daemon.secretary.pid).not.toBe(pid);
    expect(outcomes(frontend)).toEqual(["interrupted", "completed"]);
    expect(notes(frontend).filter((t) => t.includes("处理时中断了"))).toEqual([]);
    await pause(500);
    expect(doneNotices(frontend)).toHaveLength(2);
  }, 60_000);

  it("守护进程停掉再起：停机时处理到一半的那条起来后重新交，秘书说一声；不出“请重发”", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    // 秘书说得很慢：停机的时候它还在说
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [say("整理照片做完了，".repeat(60))], secretaryTokensPerSecond: 3, maintainer: [say("照片按月份分好了")] });
    const before = await connect(first.url, [BOARD, SECRETARY]);
    ok(await before.startTask("整理照片", "k-photos", [], "plain"));
    await noticesArrived(before, 1);
    await waitUntil(() => before.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理通知" });
    const told = doneTexts(before)[0]!;
    await before.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [say("刚才没说完：整理照片做完了，要我念给你听吗？")] });
    const after = await connect(second.url, [SECRETARY]);
    await noticesArrived(after, 2);
    expect(doneTexts(after)).toEqual([told, told]);
    await waitUntil(() => secretarySaid(after).includes("刚才没说完：整理照片做完了，要我念给你听吗？"), { timeoutMs: 30_000, describe: () => `等秘书说一声（现在：${JSON.stringify(secretarySaid(after))}）` });
    await waitUntil(() => outcomes(after).length >= 2, { timeoutMs: 30_000, describe: () => "等第二次处理完" });
    expect(outcomes(after)).toEqual(["interrupted", "completed"]);
    expect(notes(after).filter((t) => t.includes("处理时中断了"))).toEqual([]);
  }, 90_000);
});

describe("并成一条、排在后面、起来后补", () => {
  it("几件差不多同时做完的并成一条", async () => {
    const clock = new ManualClock(new Date(2026, 0, 5, 8));
    const { frontend } = await setup({ clock, secretary: [ECHO], maintainer: (id) => [say(`${id} 做完了`)] });
    ok(await frontend.startTask("第一件", "k-1", [], "plain"));
    ok(await frontend.startTask("第二件", "k-2", [], "plain"));
    await completed(frontend, "t-1");
    await completed(frontend, "t-2");
    expect(doneNotices(frontend)).toEqual([]);
    clock.advance(1000);
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    // 两个普通任务并行跑，谁先做完不一定：开头、结尾逐字比；中间两件编号按 1、2 排，内容按集合比
    const parts = notice!.split("\n\n");
    expect(parts).toHaveLength(4);
    const [head, first, second, ask] = parts as [string, string, string, string];
    expect(head).toBe(`${TASK_DONE_TAG}后台有 2 件事差不多同时做完了，并在这一条里（运行时发来的，不是用户说的）：`);
    expect(ask).toBe("在主线里主动跟用户说一声：用一两句话说这几件做完了、结果大概是什么，然后问“要我念给你听吗？”。他说要，就用 send_voice 把结果的口语稿念给他听；说不用就算了。");
    expect([first.slice(0, 3), second.slice(0, 3)]).toEqual(["1. ", "2. "]);
    const item = (id: string, title: string) => {
      const maintainer = tasksOf(frontend).find((e) => e.task.id === id)!.task.maintainerId;
      return `普通任务 ${id}「${title}」在后台做完了。\n它最后说：\n${maintainer} 做完了`;
    };
    expect([first.slice(3), second.slice(3)].toSorted()).toEqual([item("t-1", "第一件"), item("t-2", "第二件")].toSorted());
    // 115 号票：并成一条的总结写几件、各是哪件（先后和通知里的一样）
    const names = [first, second].map((part) => /普通任务 (t-\d+「[^」]+」)/.exec(part)![1]!);
    expect(doneNotices(frontend)[0]!.message.summary).toBe(`2 件事做完了：${names.join("、")}`);
    await secretaryTurns(frontend, 1);
    await pause(300);
    expect(doneNotices(frontend)).toHaveLength(1);
  }, 60_000);

  it("普通任务做完了用户马上接着说、还没交就又做完：并成一条，两轮各写各的话和文件", async () => {
    // 系统时钟（文件的修改时间和事件的时间要对得上）：安静 3 秒，第二轮在这之内做完
    const { frontend } = await setup({
      taskDoneSettleMs: 3000,
      config: APPROVALS_OFF,
      secretary: [ECHO],
      maintainer: [call(TOOL.write, { path: "qingtian.mp3", content: "mp3" }), say("第一轮：下好了 mp3"), call(TOOL.write, { path: "qingtian.flac", content: "flac" }), say("第二轮：转成 flac 了")],
    });
    ok(await frontend.startTask("把《晴天》下成 mp3", "k-cont", [], "plain"));
    await completed(frontend, "t-1");
    await frontend.sendText("再转成 flac", { conversation: TM1 });
    await completed(frontend, "t-1", 2);
    await noticesArrived(frontend, 1);
    const [notice] = doneTexts(frontend);
    expect(notice).toContain("1. 普通任务 t-1「把《晴天》下成 mp3」在后台做完了。\n它最后说：\n第一轮：下好了 mp3\n交付的文件（在任务的产出区里）：qingtian.mp3\n\n");
    expect(notice).toContain("2. 普通任务 t-1「把《晴天》下成 mp3」在后台做完了。\n它最后说：\n第二轮：转成 flac 了\n交付的文件（在任务的产出区里）：qingtian.flac\n\n");
  }, 60_000);

  it("秘书正在和用户说话：通知排在这一轮后面，这一轮完了再交，秘书接着说一声", async () => {
    const gate = testGate();
    const lookUp = defineHostTool({ name: "look_up", title: "查一查", description: "查点东西（测试里等测试放行）", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: async () => (await gate.promise, { text: "查到了" }) });
    const clock = new ManualClock(new Date(2026, 0, 5, 8));
    const { frontend } = await setup({
      clock,
      secretaryTools: [lookUp],
      secretary: [call("look_up", {}), say("查到了，明天晴"), say("顺便说一声：整理照片做完了，要我念给你听吗？")],
      maintainer: [say("照片按月份分好了")],
    });
    await frontend.sendText("明天天气怎么样");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理" });
    ok(await frontend.startTask("整理照片", "k-photos", [], "plain"));
    await completed(frontend, "t-1");
    clock.advance(1000);
    await pause(500);
    // 秘书还在这一轮里：不交
    expect(doneNotices(frontend)).toEqual([]);

    gate.open();
    await noticesArrived(frontend, 1);
    const turnEnds = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd });
    const noticeEvent = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).find((f) => textOf(f.payload as MessageEventPayload).startsWith(TASK_DONE_TAG))!;
    expect(noticeEvent.seq).toBeGreaterThan(turnEnds[0]!.seq);
    expect(textOf(noticeEvent.payload as MessageEventPayload)).toContain("普通任务 t-1「整理照片」在后台做完了。\n它最后说：\n照片按月份分好了");
    await secretaryTurns(frontend, 2);
    expect(secretarySaid(frontend)).toEqual(["查到了，明天晴", "顺便说一声：整理照片做完了，要我念给你听吗？"]);
  }, 60_000);

  it("停机前攒着没交的：守护进程重启、秘书起来之后补上；交过的不重交", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const firstClock = new ManualClock(new Date(2026, 0, 5, 8));
    const first = await startTestDaemon({ clock: firstClock, reuse: { dataDir, homeDir }, secretary: [say("第一件做完了")], maintainer: (id) => [say(`${id} 做完了`)] });
    const before = await connect(first.url);
    ok(await before.startTask("第一件", "k-1", [], "plain"));
    await completed(before, "t-1");
    firstClock.advance(1000);
    await noticesArrived(before, 1);
    await secretaryTurns(before, 1);
    // 第二件做完了，还没安静够（时钟没拨）就停机
    ok(await before.startTask("第二件", "k-2", [], "plain"));
    await completed(before, "t-2");
    await pause(300);
    expect(doneNotices(before)).toHaveLength(1);
    await before.close();
    await first.daemon.stop();

    const secondClock = new ManualClock(new Date(2026, 0, 5, 9));
    const second = await startTestDaemon({ clock: secondClock, reuse: { dataDir, homeDir }, secretary: [ECHO] });
    const after = await connect(second.url, [SECRETARY]);
    secondClock.advance(1000);
    await noticesArrived(after, 2);
    const texts = doneTexts(after);
    expect(texts[1]).toContain("普通任务 t-2「第二件」在后台做完了。");
    expect(texts[1]).not.toContain("t-1");
    await secretaryTurns(after, 2);
    expect(lastEcho(after)).toContain("普通任务 t-2「第二件」在后台做完了。");
  }, 90_000);
});

describe("用户说要念", () => {
  it("秘书问要不要念，用户说要：秘书用 send_voice 把结果的口语稿念成语音气泡", async () => {
    const tts = await startFakeSpeechService();
    const spoken = "晴天下好了，是 mp3 格式，放在任务的产出区里。";
    const { url, frontend } = await setup({
      config: APPROVALS_OFF,
      speechUrl: tts.url,
      secretary: [
        say("《晴天》的音频下好了，放在任务的产出区里。要我念给你听吗？"),
        { kind: "reply", toolCalls: [{ name: "send_voice", arguments: { text: spoken } }] },
        say("念给你听了。"),
      ],
      maintainer: [say("下好了：工作目录里的 qingtian.mp3（https://example.com/qingtian）")],
    });
    await importReferenceVoice(url);
    ok(await frontend.startTask("去把《晴天》的音频下下来", "k-song", [], "plain"));
    await noticesArrived(frontend, 1);
    await secretaryTurns(frontend, 1);
    expect(secretarySaid(frontend)).toEqual(["《晴天》的音频下好了，放在任务的产出区里。要我念给你听吗？"]);

    await frontend.sendText("要");
    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice).toMatchObject({ conversation: SECRETARY, mode: "tool", text: spoken, status: "done" });
    // 送进 TTS 的就是这段口语稿（按句切成几段合成）
    expect(tts.requests.map((r) => r.input).join("")).toBe(spoken);
    // 聊天里多了一个语音气泡（合成好的音频）
    const bubble = messagesOf(frontend, SECRETARY).find((m) => m.message.id === voice.messageId)!;
    expect(bubble.message.parts).toEqual([{ type: "tts_audio", voiceId: voice.id, mediaId: voice.mediaId, mime: "audio/wav", durationMs: voice.durationMs, waveform: voice.waveform }]);
  }, 60_000);
});

/** 秘书会话里运行时放的附件（115 号票）：给人看的系统消息（不排进秘书的输入队列），只有文件 part */
const attachmentMessages = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true && m.message.parts.length > 0 && m.message.parts.every((p) => p.type === "file"));
const WEEKLY = "# 第 41 周周报\n\n- 九月账单核对完了\n- 训练记录：三次\n\n| 事项 | 进度 |\n|---|---|\n| 家庭账本 | 完成 |\n";

describe("会话里折成一行、交付的文件作为附件（115 号票）", () => {
  it("交付的文件里能预览的（Markdown、纯文本）由运行时作为附件放进秘书会话，紧跟在通知后面、点得开预览；不能预览的、超过附件上限的只在全文里写路径；模型看到的照旧是全文", async () => {
    const big = `# 很大的报告\n${"这一行凑字数。".repeat(40)}\n`;
    const { url, frontend } = await setup({
      // 附件的上限调小：big.md 超过它
      config: { ...APPROVALS_OFF, media: { maxUploadBytes: 200 } },
      secretary: [ECHO],
      maintainer: [
        call(TOOL.write, { path: "weekly.md", content: WEEKLY }),
        call(TOOL.write, { path: "notes/todo.txt", content: "周一交周报\n" }),
        call(TOOL.write, { path: "big.md", content: big }),
        call(TOOL.write, { path: "song.mp3", content: "假的音频" }),
        call(TOOL.write, { path: "page.html", content: "<h1>预览</h1>" }),
        say("周报写好了：weekly.md"),
      ],
    });
    ok(await frontend.startTask("出一份周报\n写成 weekly.md", "k-weekly", [], "plain"));
    await noticesArrived(frontend, 1);
    await secretaryTurns(frontend, 1);

    const [notice] = doneNotices(frontend);
    expect(notice!.message.summary).toBe("t-1「出一份周报」做完了，交了 5 个文件");
    expect(textOf(notice!)).toContain("交付的文件（在任务的产出区里）：big.md、notes/todo.txt、page.html、song.mp3、weekly.md");
    // 紧跟在通知后面的一条：只有能预览、没超上限的两个附件（和通知同一事务追加）；不进秘书的输入队列
    const all = messagesOf(frontend, SECRETARY);
    expect(all.map((m) => [m.message.speaker, m.agentInput === true])).toEqual([
      ["system", true],
      ["system", false],
      ["agent", false],
    ]);
    expect(all[1]!.message.parts).toEqual([
      { type: "file", mediaId: expect.stringMatching(/^[0-9a-f]{64}$/), name: "todo.txt", mime: "text/plain", size: Buffer.byteLength("周一交周报\n") },
      { type: "file", mediaId: expect.stringMatching(/^[0-9a-f]{64}$/), name: "weekly.md", mime: "text/markdown", size: Buffer.byteLength(WEEKLY) },
    ]);
    // 点"预览"去报告页：内容接口取得到（113 号票）
    const weekly = all[1]!.message.parts[1] as { mediaId: string };
    expect((await media.text(url, weekly.mediaId)).body).toMatchObject({ name: "weekly.md", mime: "text/markdown", text: WEEKLY, truncated: false });
    // 交给秘书的照旧是通知的全文，附件不在它的输入里
    const echo = lastEcho(frontend);
    expect(echo).toContain(`[user] [系统通知]\n${textOf(notice!)}`);
    expect(echo).not.toContain("附件引用");
  }, 60_000);

  it("秘书处理到一半守护进程停了：起来后通知重新交一次（总结照旧），附件不再放一遍、媒体库里只存一份", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    // 秘书说得很慢：停机的时候它还在说
    const first = await startTestDaemon({
      config: APPROVALS_OFF,
      reuse: { dataDir, homeDir },
      secretary: [say("周报写好了，".repeat(60))],
      secretaryTokensPerSecond: 3,
      maintainer: [call(TOOL.write, { path: "weekly.md", content: WEEKLY }), say("周报写好了：weekly.md")],
    });
    const before = await connect(first.url, [BOARD, SECRETARY]);
    ok(await before.startTask("出一份周报", "k-weekly", [], "plain"));
    await noticesArrived(before, 1);
    await waitUntil(() => before.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理通知" });
    expect(attachmentMessages(before)).toHaveLength(1);
    await before.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [say("刚才没说完：周报写好了，要我念给你听吗？")] });
    const after = await connect(second.url, [SECRETARY]);
    await noticesArrived(after, 2);
    await waitUntil(() => outcomes(after).length >= 2, { timeoutMs: 30_000, describe: () => "等第二次处理完" });
    expect(doneNotices(after).map((m) => m.message.summary)).toEqual(["t-1「出一份周报」做完了，交了 1 个文件", "t-1「出一份周报」做完了，交了 1 个文件"]);
    expect(attachmentMessages(after)).toHaveLength(1);
    // 内容寻址：媒体库里这一份只有一个文件
    const mediaDir = path.join(dataDir, "materials", "media");
    expect(fs.readdirSync(mediaDir)).toEqual([(attachmentMessages(after)[0]!.message.parts[0] as { mediaId: string }).mediaId]);
  }, 90_000);
});
