// 主切面：给秘书发消息（102 号票，规格第 12 节"星形通信"、第 7 节；用户 2026-10-12 定：除了秘书，所有 agent 默认都有）。
// 真的守护进程，秘书、维护者、子 agent、评审接 faux 剧本，测试扮演前端：
// - 长程任务的维护者执行时、普通任务的 agent 做到一半、定时触发的任务每次运行里、项目的维护者在项目内部任务的工单里、
//   维护者派的子 agent、阶段验收的评审子 agent 调 tell_secretary：秘书收到一条"维护者来信"的通知（剧本里 echo_context 回显它收到的），
//   写明谁（哪个项目或任务的谁、在做什么时）和原话，接着在主线里转告、问要不要念；发的那边是一条工具调用；
// - 秘书没有这个工具；工具包里"给秘书发消息"关掉（计划里的、项目的，在任务详情里直接关）维护者、评审、子 agent 都没有；
//   维护者自行调整计划不写这一项是沿用现在的，写明要打开算扩大；项目的维护者起草计划时也跟着项目的开关；
// - 和任务做完同一套交法：秘书正在和用户说话时排在这一轮后面；处理到一半子进程崩溃，起来后重新交一次、只说一遍、不出"请重发"；
//   停机前还没交的起来后补，交过的不重交；和差不多同时到的任务做完的通知一起交，各是各的；
// - 防刷屏：每个发信人各算（评审按这个任务这个阶段的评审），10 分钟里最多 3 条，超了回"发得太频繁，攒一攒一起说"；
//   和上一条一字不差的不再发；同一次调用只记一次。
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_NAME_MARK,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type Plan,
  type ResponseFrame,
  type TurnEndEventPayload,
  Type,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { LETTER_ALREADY_SENT, LETTER_DUPLICATE, LETTER_SENT, TELL_SECRETARY_TOOL } from "../../src/secretary/letter-texts.ts";
import { createSecretaryLetters, LETTER_EVENT, LETTERS_CHANNEL, reviewerSender } from "../../src/secretary/letters.ts";
import { MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../../src/secretary/notice-tags.ts";
import { MAINTAINER_ONLY_TOOLS, subAgentAssembly } from "../../src/sub-agents/assembly.ts";
import type { TestDaemon } from "../helpers/daemon.ts";
import { ManualClock } from "../helpers/clock.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { projectTask, seedProject } from "../helpers/projects.ts";
import { onePlan, runningTask } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const tell = (text: string) => call(TELL_SECRETARY_TOOL, { text });
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
/** 秘书会话里运行时交的通知（排进它输入队列的系统消息），按先后 */
const noticesOf = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true).map(textOf);
/** 其中维护者来信的 */
const letterTexts = (frontend: TestFrontend) => noticesOf(frontend).filter((t) => t.startsWith(MAINTAINER_LETTER_TAG));
/** 秘书在主线里说的话（有文字的） */
const secretarySaid = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY)
    .filter((m) => m.message.speaker === "agent")
    .map((m) => m.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .filter((t) => t !== "");
/** 某个会话里 agent 最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend, channel: string) => {
  const said = messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").map(textOf).filter((t) => t.includes("[user]") || t.includes("[tool]"));
  return stripTimeMarkers(said.at(-1) ?? "");
};
/** 回显里此刻有的工具："[tool] 名字" 加上，换了工具包接着会话时 "[tool-removed] 名字" 去掉（27 号票） */
const toolsIn = (echo: string) => {
  const tools = new Set<string>();
  for (const line of echo.split("\n")) {
    if (line.startsWith("[tool] ")) tools.add(line.slice("[tool] ".length).trim());
    else if (line.startsWith("[tool-removed] ")) tools.delete(line.slice("[tool-removed] ".length).trim());
  }
  return [...tools];
};
const toolPartsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const outcomes = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as TurnEndEventPayload).outcome);
/** 秘书会话里给人看的系统说明 */
const notes = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true).map(textOf);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const td = await startTestDaemon(options);
  return { ...td, frontend: await connect(td.url, channels) };
}

/** 等秘书会话里有 n 条维护者来信的通知 */
const lettersArrived = (frontend: TestFrontend, n: number) =>
  waitUntil(() => letterTexts(frontend).length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 条维护者来信（现在：${JSON.stringify(noticesOf(frontend))}）` });
/** 等秘书处理完第 n 条输入 */
const secretaryTurns = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等秘书处理完 ${n} 条输入` });
/** 等某个会话处理完第 n 条输入 */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
/** 由测试放行的闸门：秘书的工具等着它，秘书就一直"在这一轮里" */
function testGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
const lookUpTool = (gate: { promise: Promise<void> }) =>
  defineHostTool({ name: "look_up", title: "查一查", description: "查点东西（测试里等测试放行）", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: async () => (await gate.promise, { text: "查到了" }) });
/** 真等一会儿（确认某件事没有发生） */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 通知最后那句：要秘书在主线里转告、问要不要念 */
const ASK_ONE =
  "在主线里主动用你自己的话转告用户：是哪个项目或任务的谁（维护者、子 agent、评审）、说了什么；要用户做什么就说清楚。项目内部的细节只到它写的这些，不要追问。然后问“要我念给你听吗？”。他说要，就用 send_voice 把口语稿念给他听；说不用就算了。";
const letterNotice = (item: string) => [`${MAINTAINER_LETTER_TAG}后台的一个 agent 让你转告用户一件事（运行时转交的，不是用户说的）：`, item, ASK_ONE].join("\n\n");

/** 长程任务的维护者：第一次唤起交计划，确认后（按计划重新装配）照 run 做 */
const longTask = (run: FauxStep[], plan: Plan = onePlan()) => (_id: string, spawn: number) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : run);

const INVOICES = "发票里有 3 张抬头写错了，我先挪到 wrong/ 目录里了。\n等你看一眼，确认要不要重开。";

describe("维护者给秘书发消息，秘书在主线里转告", () => {
  it("长程任务的维护者执行时调 tell_secretary：秘书收到维护者来信（谁、原话），模型看到的就是它，接着在主线里转告；维护者那边是一条工具调用", async () => {
    const td = await startTestDaemon({ secretary: [ECHO], maintainer: longTask([tell(INVOICES), ECHO]) });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    await lettersArrived(frontend, 1);
    const [notice] = letterTexts(frontend);
    expect(notice).toBe(letterNotice(`长程任务 ${taskId}「整理发票」的维护者说：\n${INVOICES}`));
    // 交给秘书的就是它（开头标着系统通知），不是用户说的；秘书没等用户开口就在主线里回了一条；秘书没有这个工具
    await secretaryTurns(frontend, 1);
    const seen = lastEcho(frontend, SECRETARY);
    expect(seen).toContain(`[user] [系统通知]\n${notice}`);
    expect(toolsIn(seen)).not.toContain(TELL_SECRETARY_TOOL);
    expect(messagesOf(frontend, SECRETARY).map((m) => m.message.speaker)).toEqual(["system", "agent"]);

    // 维护者那边：装配里有它，调用照常记一条（结果是交给秘书了），工具结果交回模型
    await turnsOf(frontend, TM1, 2);
    const own = lastEcho(frontend, TM1);
    expect(toolsIn(own)).toContain(TELL_SECRETARY_TOOL);
    // 交给 agent 的话里名字占位换成"秘书"（43 号票）；调用记录里照存占位，界面上显示用户起的名字
    expect(own).toContain(`[toolResult] ${TELL_SECRETARY_TOOL}: ${LETTER_SENT.replaceAll(ASSISTANT_NAME_MARK, "秘书")}`);
    const part = toolPartsOf(frontend, TM1).find((p) => p.tool === TELL_SECRETARY_TOOL)!;
    // 调用记录的结果摘要是交给 agent 的那份（名字占位已经换成"秘书"）
    expect(part).toMatchObject({ outcome: "done", resultSummary: LETTER_SENT.replaceAll(ASSISTANT_NAME_MARK, "秘书") });
    expect(part.argsSummary).toBe(`text=${INVOICES.replace("\n", " ")}`);
    // 记在守护进程内部的频道上：谁、原话
    expect(td.daemon.store.read(LETTERS_CHANNEL, 0, LETTER_EVENT).map((e) => e.payload)).toEqual([
      expect.objectContaining({ to: "secretary", agentId: "tm-1", conversation: TM1, from: `长程任务 ${taskId}「整理发票」的维护者`, text: INVOICES }),
    ]);
  }, 60_000);

  it("普通任务的 agent 做到一半发一条、接着做完：信和任务做完的通知都交，信在前、各是各的", async () => {
    const { frontend } = await setup({
      secretary: [say("它说先下了 mp3，问你要不要 flac。要我念给你听吗？"), say("《晴天》下好了，要我念给你听吗？")],
      maintainer: [tell("先下了 mp3；要 flac 的话在任务里跟我说一声。"), say("下好了：工作目录里的 qingtian.mp3")],
    });
    ok(await frontend.startTask("去把《晴天》的音频下下来", "k-plain", [], "plain"));
    await waitUntil(() => noticesOf(frontend).length >= 2, { timeoutMs: 30_000, describe: () => `等两条通知（现在：${JSON.stringify(noticesOf(frontend))}）` });
    const [letter, done] = noticesOf(frontend);
    expect(letter).toBe(letterNotice("普通任务 t-1「去把《晴天》的音频下下来」的维护者说：\n先下了 mp3；要 flac 的话在任务里跟我说一声。"));
    expect(done!.startsWith(TASK_DONE_TAG)).toBe(true);
    expect(done).toContain("普通任务 t-1「去把《晴天》的音频下下来」在后台做完了。");
    await secretaryTurns(frontend, 2);
    expect(secretarySaid(frontend)).toEqual(["它说先下了 mp3，问你要不要 flac。要我念给你听吗？", "《晴天》下好了，要我念给你听吗？"]);
  }, 60_000);

  it("定时触发的任务每次运行里发：信上写第几次运行时", async () => {
    const clock = new ManualClock(new Date(2026, 0, 5, 8));
    const { frontend } = await setup({ clock, secretary: [ECHO, ECHO], maintainer: [tell("今天的新闻源少了一个（连不上），简报只汇总了两家。"), say("简报写好了：brief.md")] });
    const trigger = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };
    ok(await frontend.startTask("每天早上出简报\n汇总昨天的新闻，写一份简报 brief.md", "k-brief", [], "plain", trigger));
    await waitUntil(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).length > 0, { timeoutMs: 30_000, describe: () => "等登记" });
    clock.advanceTo(new Date(2026, 0, 5, 9));
    await turnsOf(frontend, TM1, 1);
    // 安静的那段按时钟算：拨过去才交（和这次运行做完的通知一起交，各是各的）
    expect(letterTexts(frontend)).toEqual([]);
    clock.advance(1000);
    await lettersArrived(frontend, 1);
    expect(letterTexts(frontend)[0]).toBe(letterNotice("普通任务 t-1「每天早上出简报」的维护者（第 1 次运行时）说：\n今天的新闻源少了一个（连不上），简报只汇总了两家。"));
  }, 60_000);

  it("项目的维护者在项目内部的普通任务的工单里发：信上写项目的维护者在做项目内部的一件事时，不写是哪件", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir: makeTempDir("ergou-home-") },
      secretary: [ECHO, ECHO],
      maintainer: (id) =>
        id !== "pm-1"
          ? []
          : [
              tell("10 月的账单里有一笔 3200 元的转账没有备注，我先归到“其他”，你回头看一眼。"),
              say("10 月的账单导出好了：exports/2026-10.csv"),
              call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: "做到哪了、下一步做什么：每段工作结束时写回。", newText: "导出了 10 月账单。" }] }),
              call("write_segment_summary", { summary: "导出了 10 月的账单" }),
              say("写回了"),
            ],
    });
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    const frontend = await connect(td.url, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
    ok(await frontend.startTask("导出 10 月的账单", "k-internal", ["记账本"], "plain"));
    await lettersArrived(frontend, 1);
    expect(letterTexts(frontend)[0]).toBe(letterNotice("项目「记账本」的维护者（在做项目内部的一件事时）说：\n10 月的账单里有一笔 3200 元的转账没有备注，我先归到“其他”，你回头看一眼。"));
    expect(letterTexts(frontend)[0]).not.toContain("t-1");
  }, 60_000);
});

describe("谁有这个工具", () => {
  it("计划里的工具包关掉了给秘书发消息：执行时维护者的装配里没有它；在任务详情里打开，按新工具包重新装配后有了；再关掉又没了", async () => {
    const plan: Plan = { ...onePlan(), toolkit: { ...onePlan().toolkit, tellSecretary: false } };
    const td = await startTestDaemon({ secretary: [], maintainer: longTask([ECHO, ECHO, ECHO], plan) });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    await turnsOf(frontend, TM1, 2);
    expect(toolsIn(lastEcho(frontend, TM1))).not.toContain(TELL_SECRETARY_TOOL);

    const toolkit = { ...plan.toolkit, tellSecretary: true };
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit }, "k-on"))).toMatchObject({ changed: true });
    // 维护者闲着：停掉子进程，"工具包已变更"跟在下一条输入后面交给它
    await frontend.sendText("接着做", { conversation: TM1 });
    await turnsOf(frontend, TM1, 3);
    const opened = lastEcho(frontend, TM1);
    expect(opened).toContain("工具包已变更（任务的工具包改了）：加上 给秘书发消息。");
    expect(toolsIn(opened)).toContain(TELL_SECRETARY_TOOL);

    const { tellSecretary: _on, ...rest } = toolkit;
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: { ...rest, tellSecretary: false } }, "k-off"));
    await frontend.sendText("再接着做", { conversation: TM1 });
    await turnsOf(frontend, TM1, 4);
    const closed = lastEcho(frontend, TM1);
    expect(closed).toContain("去掉 给秘书发消息。现在的工具包：bash 开、联网开、给秘书发消息关；");
    expect(toolsIn(closed)).not.toContain(TELL_SECRETARY_TOOL);
  }, 90_000);

  it("用户在任务详情里关掉之后：维护者自行调整计划没写这一项，仍是关；写明要打开算扩大，自行调整被拒（要走计划变更等用户确认）", async () => {
    const narrowed = { ...onePlan().toolkit, network: false };
    const td = await startTestDaemon({
      secretary: [],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(onePlan()), say("计划交上去了")]
          : spawn === 2
            ? [say("开始做了")]
            : [
                call("revise_plan", { plan: draftOf({ ...onePlan(), toolkit: narrowed }), why: "这次用不着联网" }),
                call("revise_plan", { plan: draftOf({ ...onePlan(), toolkit: { ...narrowed, tellSecretary: true } }), why: "还是想能给秘书发消息" }),
                say("改完了"),
              ],
    });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    await turnsOf(frontend, TM1, 2);
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: { ...onePlan().toolkit, tellSecretary: false } }, "k-off"));
    await frontend.sendText("接着做", { conversation: TM1 });
    // 第一次自行调整（关联网）之后工具包变了，维护者按新工具包重新拉起、剧本从头再来一遍（再交同一份是"没有要改的"）
    const revisions = () => toolPartsOf(frontend, TM1).filter((p) => p.tool === "revise_plan");
    await waitUntil(() => revisions().some((p) => p.resultSummary?.includes("扩大了授权")), {
      timeoutMs: 30_000,
      describe: () => `等维护者写明要打开（现在：${JSON.stringify(revisions().map((p) => [p.outcome, p.resultSummary]))}）`,
    });
    // 没写这一项的那次：只关了联网，给秘书发消息仍是关
    expect(revisions()[0]).toMatchObject({ outcome: "done" });
    expect(revisions()[0]!.resultSummary).toContain("去掉 联网");
    expect(revisions()[0]!.resultSummary).not.toContain("加上 给秘书发消息");
    // 写明要打开的那次：算扩大，自行调整被拒
    const opening = revisions().find((p) => p.resultSummary?.includes("扩大了授权"))!;
    expect(opening.outcome).toBe("error");
    expect(opening.resultSummary).toContain("加上 给秘书发消息");
    expect(td.daemon.tasks.confirmedPlan(taskId)!.plan.toolkit).toEqual({ ...narrowed, tellSecretary: false });
  }, 90_000);

  it("项目里关掉了给秘书发消息：项目的维护者正在起草计划（这一段的工具包固定）也跟着变，按新工具包重新装配后没有它", async () => {
    const td = await startTestDaemon({ secretary: [], maintainer: (id) => (id === "pm-1" ? [ECHO, say("好"), say("好")] : []) });
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    const frontend = await connect(td.url, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
    projectTask(td.daemon, "记账本", "给记账本加周报", { goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: [], memoryScope: "" });
    await waitUntil(() => lastEcho(frontend, PM1).includes("起草计划"), { timeoutMs: 30_000, describe: () => "等项目的维护者开始起草计划" });
    expect(toolsIn(lastEcho(frontend, PM1))).toContain(TELL_SECRETARY_TOOL);

    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: "p-1" }, toolkit: { skills: [], mcp: [], bash: true, network: true, tellSecretary: false } }, "k-off"));
    await frontend.sendText("周报用表格", { conversation: PM1 });
    await waitUntil(() => lastEcho(frontend, PM1).includes("周报用表格"), { timeoutMs: 30_000, describe: () => "等维护者按新工具包接着起草" });
    const after = lastEcho(frontend, PM1);
    expect(after).toContain("工具包已变更（这一段的工具包改了）：去掉 给秘书发消息。");
    expect(toolsIn(after)).not.toContain(TELL_SECRETARY_TOOL);
  }, 90_000);

  it("项目的工具包关掉了给秘书发消息：项目的维护者在工单里看不到它", async () => {
    const td = await startTestDaemon({ secretary: [ECHO], maintainer: (id) => (id === "pm-1" ? [ECHO, call("write_segment_summary", { summary: "看了一眼" }), say("写回了")] : []) });
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true, tellSecretary: false } });
    const frontend = await connect(td.url, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
    ok(await frontend.startTask("看看 10 月的账单", "k-off", ["记账本"], "plain"));
    await turnsOf(frontend, PM1, 1);
    const tools = toolsIn(lastEcho(frontend, PM1));
    expect(tools).toContain("write_segment_summary");
    expect(tools).not.toContain(TELL_SECRETARY_TOOL);
  }, 60_000);

  it("子 agent 的工具包不超过派它的维护者：维护者有（工具包里开着）它才有，维护者关了它也没有", () => {
    expect(MAINTAINER_ONLY_TOOLS).not.toContain(TELL_SECRETARY_TOOL);
    const candidates = { agentId: "sa-1", cwd: "C:\\w", hostTools: [TELL_SECRETARY_TOOL, "web_search"] };
    expect(subAgentAssembly(maintainerWith([TELL_SECRETARY_TOOL, "web_search"]), candidates).hostTools).toEqual([TELL_SECRETARY_TOOL, "web_search"]);
    expect(subAgentAssembly(maintainerWith(["web_search"]), candidates).hostTools).toEqual(["web_search"]);
  });

  it("评审子 agent：任务的工具包里开着就有，关掉了没有（拉起请求里代为执行的工具）", async () => {
    for (const off of [false, true]) {
      const td = await startTestDaemon({
        secretary: [],
        maintainer: longTask([call("write", { path: "notes.md", content: "# 笔记\n" }), call("complete_stage", { stageId: "s1", summary: "笔记写好了" }), say("交了")], reviewPlan(off ? false : undefined)),
        reviewer: () => [call("submit_review", { results: [{ index: 1, passed: true, reason: "写清楚了" }] }), say("评审完了")],
      });
      const requests = spawnRequests(td);
      const frontend = await connect(td.url);
      await runningTask(td, frontend, "整理笔记");
      await waitUntil(() => requests().some((r) => r.agentId.startsWith("review-")), { timeoutMs: 30_000, describe: () => "等评审子 agent 拉起" });
      expect(requests().find((r) => r.agentId.startsWith("review-"))!.hostTools).toEqual(off ? ["submit_review"] : ["submit_review", TELL_SECRETARY_TOOL]);
    }
  }, 120_000);
});

describe("子 agent、评审子 agent 也能给秘书发消息", () => {
  it("维护者派的子 agent 做到一半发一条：秘书收到，信上写哪个任务的子 agent、在做哪个阶段；结果照常交回维护者", async () => {
    const plan: Plan = {
      ...onePlan(),
      stages: [fileStage("s1", "a.txt"), fileStage("s2", "b.txt")],
      toolkit: { ...onePlan().toolkit, bash: false, network: false },
      stops: { count: 0, where: [] },
    };
    const td = await startTestDaemon({
      secretary: [ECHO],
      maintainer: longTask([call("propose_parallel", { reason: "两个阶段互不依赖", agents: [{ stageId: "s2", instructions: "写 b.txt，内容是 B" }] }), say("等你确认"), say("好"), say("收到"), say("好")], plan),
      subAgent: () => [tell("b.txt 要写的内容和 a.txt 重了一半，我照写了，你回头看看要不要合并。"), call("write", { path: "b.txt", content: "B" }), say("b.txt 写好了")],
    });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "两个文件");
    let card: { id: string } | undefined;
    await waitUntil(() => (card = frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as { card: { id: string; type: string } }).card).find((c) => c.type === "parallel")) !== undefined, {
      timeoutMs: 30_000,
      describe: () => "等并行确认卡",
    });
    ok(await frontend.cardAction({ cardId: card!.id, action: "parallel", expectedVersion: 1 }));
    await lettersArrived(frontend, 1);
    expect(letterTexts(frontend)[0]).toBe(letterNotice(`长程任务 ${taskId}「两个文件」的子 agent sa-1（在做阶段 s2「做 b.txt」时）说：\nb.txt 要写的内容和 a.txt 重了一半，我照写了，你回头看看要不要合并。`));
    // 结果照常交回维护者（不经秘书）；它的调用记在维护者的会话里，归到子 agent
    await waitUntil(() => messagesOf(frontend, TM1).some((m) => m.agentId === "sa-1" && m.message.speaker === "system"), { timeoutMs: 30_000, describe: () => "等 sa-1 交回结果" });
    expect(toolPartsOf(frontend, TM1).find((p) => p.tool === TELL_SECRETARY_TOOL)).toMatchObject({ outcome: "done" });
    expect(messagesOf(frontend, TM1).find((m) => m.message.parts.some((p) => p.type === "tool_call" && p.tool === TELL_SECRETARY_TOOL))).toMatchObject({ agentId: "sa-1", stageId: "s2" });
  }, 120_000);

  it("评审子 agent 验收时发一条：秘书收到，信上写哪个任务的评审、在验收哪个阶段；结论照常交", async () => {
    const plan: Plan = { ...onePlan(), stages: [{ ...onePlan().stages[0]!, acceptance: [{ criterion: "笔记写清楚了", method: "review" }] }], stops: { count: 0, where: [] } };
    const td = await startTestDaemon({
      secretary: [ECHO],
      maintainer: longTask([call("write", { path: "notes.md", content: "# 笔记\n" }), call("complete_stage", { stageId: "s1", summary: "笔记写好了" }), say("交了"), say("好")], plan),
      reviewer: () => [tell("笔记写清楚了，不过第二节引用的数据是去年的，建议用户确认一下。"), call("submit_review", { results: [{ index: 1, passed: true, reason: "写清楚了" }] }), say("评审完了")],
    });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理笔记");
    await lettersArrived(frontend, 1);
    expect(letterTexts(frontend)[0]).toBe(letterNotice(`长程任务 ${taskId}「整理笔记」的评审子 agent（在验收阶段 s1「动手做」时）说：\n笔记写清楚了，不过第二节引用的数据是去年的，建议用户确认一下。`));
    // 评审的调用不进会话：信上没有会话
    expect(td.daemon.store.read(LETTERS_CHANNEL, 0, LETTER_EVENT).map((e) => e.payload)).toEqual([expect.not.objectContaining({ conversation: expect.anything() })]);
    // 结论照常交（阶段验收通过）
    await waitUntil(() => td.daemon.tasks.get(taskId)?.state === "done", { timeoutMs: 30_000, describe: () => "等验收通过、任务完成" });
  }, 120_000);
});

/** 维护者交的计划（本任务的关注类别、用户的限制、记忆范围沿用当前计划，不写） */
function draftOf(plan: Plan): Record<string, unknown> {
  const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...rest } = plan;
  return rest;
}

/** 维护者此刻的装配（子 agent 从它收窄）：代为执行的工具照给 */
const maintainerWith = (hostTools: string[]) => ({ cwd: "C:\\w", toolkit: { bash: true, network: true }, skillPaths: [], piTools: ["read"], hostTools, projectRecords: [], workingDirs: ["C:\\w"], development: false });

/** 一个阶段、评审验收的计划；off 是工具包里关掉了给秘书发消息 */
const reviewPlan = (off?: false): Plan => ({
  ...onePlan(),
  stages: [{ ...onePlan().stages[0]!, acceptance: [{ criterion: "笔记写清楚了", method: "review" }] }],
  ...(off === false ? { toolkit: { ...onePlan().toolkit, tellSecretary: false } } : {}),
  stops: { count: 0, where: [] },
});

/** 一个开放模式的阶段：写一个文件，脚本验收它在不在（预算给足） */
const fileStage = (stageId: string, file: string): Plan["stages"][number] => ({
  stageId,
  title: `做 ${file}`,
  deliverables: [file],
  acceptance: [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
  mode: "open",
  dependsOn: [],
  policy: { grants: [], temporalRules: [] },
  budget: { tokens: 1_000_000, toolCalls: 30 },
});

/** 记下 agent 管家收到的每次拉起请求（谁、代为执行的工具） */
function spawnRequests(td: TestDaemon) {
  const requests: Array<{ agentId: string; hostTools: string[] }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    requests.push({ agentId: request.agentId, hostTools: (request.hostTools ?? []).map((t) => t.name) });
    return spawn(request);
  };
  return () => [...requests];
}

describe("和任务做完同一套交法", () => {
  it("秘书正在和用户说话：信排在这一轮后面，这一轮完了再交，秘书接着转告", async () => {
    const gate = testGate();
    const td = await startTestDaemon({
      secretaryTools: [lookUpTool(gate)],
      secretary: [call("look_up", {}), say("查到了，明天晴"), say("顺便说一声：整理发票那边有 3 张抬头写错了，要我念给你听吗？")],
      maintainer: longTask([tell(INVOICES), say("先告诉秘书了")]),
    });
    const frontend = await connect(td.url);
    await frontend.sendText("明天天气怎么样");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理" });
    await runningTask(td, frontend, "整理发票");
    await turnsOf(frontend, TM1, 2);
    await pause(600);
    // 秘书还在这一轮里：不交
    expect(letterTexts(frontend)).toEqual([]);

    gate.open();
    await lettersArrived(frontend, 1);
    const turnEnds = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd });
    const noticeEvent = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).find((f) => textOf(f.payload as MessageEventPayload).startsWith(MAINTAINER_LETTER_TAG))!;
    expect(noticeEvent.seq).toBeGreaterThan(turnEnds[0]!.seq);
    await secretaryTurns(frontend, 2);
    expect(secretarySaid(frontend)).toEqual(["查到了，明天晴", "顺便说一声：整理发票那边有 3 张抬头写错了，要我念给你听吗？"]);
  }, 60_000);

  it("秘书子进程崩溃：这条标成中断、不出“请重发”，重新拉起后同一段话再交一次，秘书转告；只说一遍", async () => {
    const gate = testGate();
    const td = await startTestDaemon({
      secretaryTools: [lookUpTool(gate)],
      secretary: [call("look_up", {}), say("整理发票那边有 3 张抬头写错了，要我念给你听吗？")],
      maintainer: longTask([tell(INVOICES), say("先告诉秘书了")]),
    });
    const frontend = await connect(td.url);
    await runningTask(td, frontend, "整理发票");
    await lettersArrived(frontend, 1);
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理来信" });
    await pause(500);
    const pid = td.daemon.secretary.pid!;
    process.kill(pid);
    gate.open();

    await lettersArrived(frontend, 2);
    const [first, again] = letterTexts(frontend);
    expect(again).toBe(first);
    await waitUntil(() => outcomes(frontend).length >= 2, { timeoutMs: 30_000, describe: () => "等第二次处理完" });
    expect(td.daemon.secretary.pid).not.toBe(pid);
    expect(outcomes(frontend)).toEqual(["interrupted", "completed"]);
    expect(secretarySaid(frontend)).toContain("整理发票那边有 3 张抬头写错了，要我念给你听吗？");
    expect(notes(frontend).filter((t) => t.includes("处理时中断了"))).toEqual([]);
    await pause(500);
    expect(letterTexts(frontend)).toHaveLength(2);
  }, 60_000);

  it("停机前还没交的信：守护进程重启、秘书起来之后补上；交过的不重交", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const firstClock = new ManualClock(new Date(2026, 0, 5, 8));
    const script = (id: string) => (id === "tm-1" ? [tell("第一件：先说一声"), say("第一件做完了")] : [tell("第二件：也先说一声"), say("第二件做完了")]);
    const first = await startTestDaemon({ clock: firstClock, reuse: { dataDir, homeDir }, secretary: [say("转告了第一件"), say("第一件做完了")], maintainer: script });
    const before = await connect(first.url);
    ok(await before.startTask("第一件", "k-1", [], "plain"));
    await waitUntil(() => before.events({ channel: BOARD, type: EVENT_TYPES.task }).some((f) => (f.payload as { change: string }).change === "completed"), { timeoutMs: 30_000, describe: () => "等第一件做完" });
    firstClock.advance(1000);
    await lettersArrived(before, 1);
    await secretaryTurns(before, 2);
    // 第二件发了信、做完了，还没安静够（时钟没拨）就停机
    ok(await before.startTask("第二件", "k-2", [], "plain"));
    await waitUntil(() => first.daemon.store.read(LETTERS_CHANNEL, 0, LETTER_EVENT).length >= 2, { timeoutMs: 30_000, describe: () => "等第二封信记下" });
    await pause(300);
    expect(letterTexts(before)).toHaveLength(1);
    await before.close();
    await first.daemon.stop();

    const secondClock = new ManualClock(new Date(2026, 0, 5, 9));
    const second = await startTestDaemon({ clock: secondClock, reuse: { dataDir, homeDir }, secretary: [ECHO, ECHO] });
    const after = await connect(second.url, [SECRETARY]);
    secondClock.advance(1000);
    await lettersArrived(after, 2);
    const texts = letterTexts(after);
    expect(texts[0]).toContain("第一件：先说一声");
    expect(texts[1]).toBe(letterNotice("普通任务 t-2「第二件」的维护者说：\n第二件：也先说一声"));
    await secretaryTurns(after, 4);
    await pause(300);
    expect(letterTexts(after)).toHaveLength(2);
  }, 90_000);
});

describe("防刷屏", () => {
  it("每个 agent 10 分钟里最多 3 条，超了回“发得太频繁”；和上一条一字不差的不再发；同一次调用只记一次；一条最多 2000 字", async () => {
    const clock = new ManualClock(new Date(2026, 0, 5, 8));
    const store = openEventStore({ file: path.join(makeTempDir("ergou-letters-"), "events.db"), views: conversationViews, now: () => clockIso(clock) });
    try {
      const letters = createSecretaryLetters({ store, clock });
      const tool = (agentId: string) => letters.tool({ agentId, conversation: maintainerChannel(agentId), from: `任务 ${agentId} 的维护者` });
      const send = async (agentId: string, toolCallId: string, text: string) => tool(agentId).run({ text }, { toolCallId });

      expect(await send("tm-1", "c1", "第一条")).toEqual({ text: LETTER_SENT });
      // 同一次调用又来一次（被打断后恢复时重做）：不再记
      expect(await send("tm-1", "c1", "第一条")).toEqual({ text: LETTER_ALREADY_SENT });
      // 和上一条一字不差（前后的空白不算）
      expect(await send("tm-1", "c2", "  第一条\n")).toEqual({ text: LETTER_DUPLICATE, isError: true });
      clock.advance(60_000);
      expect(await send("tm-1", "c3", "第二条")).toEqual({ text: LETTER_SENT });
      clock.advance(60_000);
      expect(await send("tm-1", "c4", "第三条")).toEqual({ text: LETTER_SENT });
      // 10 分钟里第 4 条：拒发，说清多久之后能再发
      clock.advance(60_000);
      const tooMany = await send("tm-1", "c5", "第四条");
      expect(tooMany).toEqual({ text: "发得太频繁，攒一攒一起说：10 分钟里最多发 3 条，这一条没有发（大约 7 分钟后能再发）。", isError: true });
      // 每个 agent 各算：别的不受影响
      expect(await send("tm-2", "d1", "第四条")).toEqual({ text: LETTER_SENT });
      // 第一条过了 10 分钟：又能发了
      clock.advanceTo(new Date(2026, 0, 5, 8, 10));
      expect(await send("tm-1", "c6", "第四条")).toEqual({ text: LETTER_SENT });
      // 评审按"这个任务这个阶段的评审"算（验收做到一半重启，重新验收的评审 id 跟着次数变）：同一句话不再发一遍；别的阶段的评审各算
      const review = (agentId: string, stageId: string) => letters.tool(reviewerSender({ id: "t-1", title: "整理笔记" }, "long_running", agentId, { stageId, title: "动手做" }));
      expect(await review("review-t-1-s1-1", "s1").run({ text: "数据是去年的" }, { toolCallId: "r1" })).toEqual({ text: LETTER_SENT });
      expect(await review("review-t-1-s1-2", "s1").run({ text: "数据是去年的" }, { toolCallId: "r2" })).toEqual({ text: LETTER_DUPLICATE, isError: true });
      expect(await review("review-t-1-s2-1", "s2").run({ text: "数据是去年的" }, { toolCallId: "r3" })).toEqual({ text: LETTER_SENT });
      // 太长的照 schema 拒掉（pi 也先按它校验）
      expect(await send("tm-1", "c7", "长".repeat(2001))).toMatchObject({ isError: true });
      expect(store.read(LETTERS_CHANNEL, 0, LETTER_EVENT).map((e) => [(e.payload as { senderKey: string }).senderKey, (e.payload as { text: string }).text])).toEqual([
        ["tm-1", "第一条"],
        ["tm-1", "第二条"],
        ["tm-1", "第三条"],
        ["tm-2", "第四条"],
        ["tm-1", "第四条"],
        ["review:t-1:s1", "数据是去年的"],
        ["review:t-1:s2", "数据是去年的"],
      ]);
    } finally {
      store.close();
    }
  });
});
