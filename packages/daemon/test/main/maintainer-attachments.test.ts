// 主切面：任务和项目的维护者也能发附件（117 号票）。真的守护进程，秘书、维护者接 faux 剧本，测试扮演前端：
// - 普通任务的 agent、长程任务的维护者、项目的维护者（对话段）调 send_attachment：工作目录里的文件复制进媒体库，作为它的一条消息
//   出现在它自己的会话里（带上任务、阶段、项目的归属），前端看到的是附件卡片；工作目录外的发不了，原因交回模型；
// - 工具包里"发附件"关掉了（计划里的、项目的）维护者没有这个工具，在任务详情里打开、重新装配后有了；子 agent、评审没有；
// - tell_secretary 带附件：工作目录里的文件照任务做完交付的文件那样（115 号票），作为一条只有文件的系统消息紧跟在那条维护者来信的
//   通知后面（不进秘书的输入），通知的全文写着附件引用，秘书按引用读得到，不用再复制；同一次交的任务做完又交了同一份的不再放一张；
//   有一个发不了整封信不发；秘书处理到一半崩溃，重新交的只有文字，附件卡片不再放一遍。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
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
import { READ_ATTACHMENT_TOOL, SEND_ATTACHMENT_TOOL } from "../../src/media/tool-names.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createSecretaryLetters, reviewerSender, subAgentSender } from "../../src/secretary/letters.ts";
import { LETTER_ATTACHMENTS_NOTE, TELL_SECRETARY_TOOL } from "../../src/secretary/letter-texts.ts";
import { MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../../src/secretary/notice-tags.ts";
import { MAINTAINER_ONLY_TOOLS, subAgentAssembly } from "../../src/sub-agents/assembly.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openMediaStore } from "../../src/media/media-store.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { onePlan, runningTask } from "../helpers/running-task.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
type FilePart = Extract<MessagePart, { type: "file" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const send = (args: { path: string; name?: string }) => call(SEND_ATTACHMENT_TOOL, args);
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
/** 某个会话里 agent 发出的附件消息（只有附件的那种） */
const attachmentMessages = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent" && m.message.parts.length > 0 && m.message.parts.every((p) => p.type === "file" || p.type === "image"));
/** 秘书会话里维护者来信的通知 */
const letterNotices = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && textOf(m).startsWith(MAINTAINER_LETTER_TAG));
/** 秘书会话里运行时放的附件（只有文件的系统消息，不排进秘书的输入） */
const runtimeFiles = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true && m.message.parts.length > 0 && m.message.parts.every((p) => p.type === "file"));
/** 某个会话里 agent 最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend, channel: string) => {
  const said = messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent")
    .map(textOf)
    .filter((t) => t.includes("[user]") || t.includes("[tool]"));
  return stripTimeMarkers(said.at(-1) ?? "");
};
/** 回显里此刻有的工具（换了工具包接着会话时 "[tool-removed] 名字" 去掉） */
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
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]): Promise<TestDaemon & { frontend: TestFrontend }> {
  const td = await startTestDaemon(options);
  return { ...td, frontend: await connect(td.url, channels) };
}

/** 长程任务的维护者：第一次唤起交计划，确认后（按计划重新装配）照 run 做 */
const longTask = (run: FauxStep[], plan: Plan = onePlan()) => (_id: string, spawn: number) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : run);

const DAILY_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>AI 日报</title></head><body><h1>10 月 13 日 AI 日报</h1><button onclick="this.textContent=\'看过了\'">标成看过</button></body></html>';
const DAILY_MD = "# 10 月 13 日 AI 日报\n\n- 开源模型：本周有两个新的小模型发布\n- 评测：长上下文的新基准出来了\n";
const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><polyline fill="none" stroke="#36c" points="0,50 40,30 80,35 120,10"/></svg>';

describe("维护者把工作目录里的文件作为附件发出", () => {
  it("普通任务的 agent：写好报告发出，进它自己的会话（带任务的归属），能在沙箱里预览；工作目录外的发不了，原因交回模型", async () => {
    const td = await setup({
      secretary: [say("日报做好了，要我念给你听吗？")],
      maintainer: [
        call("write", { path: "out/daily.html", content: DAILY_HTML }),
        send({ path: "out/daily.html", name: "AI 日报.html" }),
        send({ path: "../t-9/偷看.txt" }),
        ECHO,
      ],
    });
    const { frontend } = td;
    ok(await frontend.startTask("把今天的 AI 日报做成网页", "k-plain", [], "plain"));
    await waitUntil(() => attachmentMessages(frontend, TM1).length > 0 && lastEcho(frontend, TM1).includes("[toolResult]"), {
      timeoutMs: 30_000,
      describe: () => "等 agent 发出附件、看完工具结果",
    });
    const [sent] = attachmentMessages(frontend, TM1);
    const part = sent!.message.parts[0] as FilePart;
    expect(part).toEqual({ type: "file", mediaId: expect.stringMatching(/^[0-9a-f]{64}$/), name: "AI 日报.html", mime: "text/html", size: Buffer.byteLength(DAILY_HTML) });
    // 归属：任务 t-1（素材、时间线按它归）
    expect(sent!.taskId).toBe("t-1");

    const echo = lastEcho(frontend, TM1);
    expect(toolsIn(echo)).toContain(SEND_ATTACHMENT_TOOL);
    expect(echo).toContain(`[toolResult] ${SEND_ATTACHMENT_TOOL}: 已把「AI 日报.html」（`);
    expect(echo).toContain(`附件引用 ${part.mediaId}`);
    expect(echo).toMatch(/\[toolResult\] send_attachment: 发不了「\.\.\/t-9\/偷看\.txt」：只能发工作目录里的文件。/);
    const calls = toolPartsOf(frontend, TM1).filter((p) => p.tool === SEND_ATTACHMENT_TOOL);
    expect(calls.map((p) => p.outcome)).toEqual(["done", "error"]);

    // 前端点"预览"：报告页按媒体 id 取到这一份，在沙箱里打开
    const view = await httpRequest(td.url, HTTP_PATHS.mediaText(part.mediaId));
    expect(view.json()).toMatchObject({ name: "AI 日报.html", frame: "html" });
    const page = await httpRequest(td.url, HTTP_PATHS.mediaHtml(part.mediaId));
    expect(page.status).toBe(200);
    expect(page.body.startsWith(DAILY_HTML)).toBe(true);
    // 改了、删了工作目录里的文件，已经发出的照样在
    fs.rmSync(path.join(td.dataDir, "outputs", "t-1", "out"), { recursive: true, force: true });
    expect((await httpRequest(td.url, HTTP_PATHS.mediaHtml(part.mediaId))).status).toBe(200);
  }, 60_000);

  it("长程任务的维护者执行时发：消息带任务和当前阶段的归属", async () => {
    const td = await setup({ secretary: [], maintainer: longTask([call("write", { path: "chart.svg", content: CHART_SVG }), send({ path: "chart.svg", name: "走势图.svg" }), say("图发给你了")]) });
    const { frontend } = td;
    const taskId = await runningTask(td, frontend, "画本周走势图");
    await waitUntil(() => attachmentMessages(frontend, TM1).length > 0, { timeoutMs: 30_000, describe: () => "等维护者发出附件" });
    const [sent] = attachmentMessages(frontend, TM1);
    expect(sent!.message.parts).toEqual([{ type: "file", mediaId: expect.any(String), name: "走势图.svg", mime: "image/svg+xml", size: Buffer.byteLength(CHART_SVG) }]);
    expect(sent).toMatchObject({ taskId, stageId: "s1" });
  }, 60_000);

  it("项目的维护者在项目页上发：项目工作目录里的文件，进项目的会话（带项目的归属）", async () => {
    const td = await setup({ secretary: [], maintainer: (id) => (id === "pm-1" ? [send({ path: "docs/README.md" }), say("发给你了"), ECHO] : []) }, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    const workdir = td.daemon.projects.workdir(project);
    fs.mkdirSync(path.join(workdir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "docs", "README.md"), DAILY_MD);
    await td.frontend.sendText("把项目的 README 发给我看看", { conversation: PM1 });
    await waitUntil(() => attachmentMessages(td.frontend, PM1).length > 0, { timeoutMs: 30_000, describe: () => "等项目的维护者发出附件" });
    const [sent] = attachmentMessages(td.frontend, PM1);
    expect(sent!.message.parts).toEqual([{ type: "file", mediaId: expect.any(String), name: "README.md", mime: "text/markdown", size: Buffer.byteLength(DAILY_MD) }]);
    expect(sent!.projectId).toBe(project.id);
  }, 60_000);
});

describe("工具包里的开关", () => {
  it("计划里关掉了发附件：维护者没有 send_attachment，tell_secretary 也不带附件参数；在任务详情里打开，重新装配后有了", async () => {
    const plan: Plan = { ...onePlan(), toolkit: { ...onePlan().toolkit, sendAttachment: false } };
    const td = await startTestDaemon({ secretary: [], maintainer: longTask([ECHO, ECHO, ECHO], plan) });
    const requests = spawnRequests(td);
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    await turnsOf(frontend, TM1, 2);
    expect(toolsIn(lastEcho(frontend, TM1))).not.toContain(SEND_ATTACHMENT_TOOL);
    const closed = requests().at(-1)!;
    expect(closed.hostTools).not.toContain(SEND_ATTACHMENT_TOOL);
    expect(closed.letterParams).toEqual(["summary", "text"]);

    const { sendAttachment: _off, ...on } = plan.toolkit;
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: on }, "k-on"))).toMatchObject({ changed: true });
    await frontend.sendText("接着做", { conversation: TM1 });
    await turnsOf(frontend, TM1, 3);
    const opened = lastEcho(frontend, TM1);
    expect(opened).toContain("工具包已变更（任务的工具包改了）：加上 发附件。");
    expect(toolsIn(opened)).toContain(SEND_ATTACHMENT_TOOL);
    expect(requests().at(-1)!.letterParams).toEqual(["summary", "text", "attachments"]);
  }, 90_000);

  it("项目的工具包关掉了发附件：项目的维护者在对话段里没有它；工具包写成一句话时写明关着", async () => {
    const td = await setup({ secretary: [], maintainer: (id) => (id === "pm-1" ? [ECHO] : []) }, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true, sendAttachment: false } });
    await td.frontend.sendText("在吗", { conversation: PM1 });
    await turnsOf(td.frontend, PM1, 1);
    const tools = toolsIn(lastEcho(td.frontend, PM1));
    expect(tools).toContain(TELL_SECRETARY_TOOL);
    expect(tools).not.toContain(SEND_ATTACHMENT_TOOL);
  }, 60_000);

  it("子 agent 一律没有（结果交回维护者）；评审的 tell_secretary 不带附件参数，维护者的带", () => {
    expect(MAINTAINER_ONLY_TOOLS).toContain(SEND_ATTACHMENT_TOOL);
    const maintainer = { cwd: "C:\\w", toolkit: { bash: true, network: true }, skillPaths: [], piTools: ["read"], hostTools: [SEND_ATTACHMENT_TOOL, TELL_SECRETARY_TOOL], projectRecords: [], workingDirs: ["C:\\w"], development: false };
    expect(subAgentAssembly(maintainer, { agentId: "sa-1", cwd: "C:\\w", hostTools: [SEND_ATTACHMENT_TOOL, TELL_SECRETARY_TOOL] }).hostTools).toEqual([TELL_SECRETARY_TOOL]);

    const dir = makeTempDir("ergou-letters-");
    const clock = new ManualClock(new Date(2026, 9, 13, 9));
    const store = openEventStore({ file: path.join(dir, "events.db"), views: conversationViews, now: () => clockIso(clock) });
    try {
      const media = openMediaStore({ mediaDir: path.join(dir, "media"), uploadsDir: path.join(dir, "uploads"), maxUploadBytes: 1024 * 1024 });
      const letters = createSecretaryLetters({ store, clock, media });
      const task = { id: "t-3", title: "整理笔记" };
      expect(params(letters.tool(reviewerSender(task, "long_running", "review-1", { stageId: "s1", title: "整理" })))).toEqual(["summary", "text"]);
      expect(params(letters.tool(subAgentSender(task, "long_running", "sa-1", TM1, { stageId: "s1", title: "整理" })))).toEqual(["summary", "text"]);
      expect(params(letters.tool({ agentId: "tm-1", conversation: TM1, from: "长程任务 t-3「整理笔记」的维护者" }, dir))).toEqual(["summary", "text", "attachments"]);
    } finally {
      store.close();
    }
  });
});

describe("tell_secretary 带附件", () => {
  it("工作目录里的文件作为附件卡片紧跟在维护者来信后面（不进秘书的输入），通知里写着附件引用、秘书读得到；同一次交的任务做完不再放一张；有一个发不了整封信不发", async () => {
    const mdRef = createHash("sha256").update(DAILY_MD).digest("hex");
    const td = await setup({
      // 安静 2 秒才交：来信和紧接着的任务做完并在同一次交
      taskDoneSettleMs: 2000,
      secretary: [call(READ_ATTACHMENT_TOOL, { ref: mdRef }), ECHO, say("日报做完了")],
      maintainer: [
        call("write", { path: "daily.md", content: DAILY_MD }),
        call("write", { path: "chart.svg", content: CHART_SVG }),
        call(TELL_SECRETARY_TOOL, { summary: "AI 日报和走势图做好了", text: "今天的 AI 日报和走势图都做好了，你看一眼。", attachments: ["daily.md", "chart.svg"] }),
        call(TELL_SECRETARY_TOOL, { summary: "再附一份旧的", text: "再附一份旧的。", attachments: ["daily.md", "../t-9/旧日报.md"] }),
        ECHO,
      ],
    });
    const { frontend } = td;
    ok(await frontend.startTask("出今天的 AI 日报", "k-plain", [], "plain"));
    await waitUntil(() => letterNotices(frontend).length > 0, { timeoutMs: 30_000, describe: () => "等维护者来信" });
    // 通知只有文字（折成一行时显示总结）；附件是紧跟在后面的一条只有文件的系统消息（照 115 号票任务做完交付的文件）
    const [notice] = letterNotices(frontend);
    expect(notice!.message.parts.map((p) => p.type)).toEqual(["text"]);
    expect(notice!.message.summary).toBe("AI 日报和走势图做好了");
    const all = messagesOf(frontend, SECRETARY);
    const files = all[all.indexOf(notice!) + 1]!;
    expect(runtimeFiles(frontend)).toEqual([files]);
    expect(files.message.parts).toEqual([
      { type: "file", mediaId: mdRef, name: "daily.md", mime: "text/markdown", size: Buffer.byteLength(DAILY_MD) },
      { type: "file", mediaId: expect.any(String), name: "chart.svg", mime: "image/svg+xml", size: Buffer.byteLength(CHART_SVG) },
    ]);
    const svg = files.message.parts[1] as FilePart;
    const said = textOf(notice!);
    expect(said).toContain(`普通任务 t-1「出今天的 AI 日报」的维护者说：\n今天的 AI 日报和走势图都做好了，你看一眼。\n（附了 2 个文件：daily.md（附件引用 ${mdRef}）、chart.svg（附件引用 ${svg.mediaId}））`);
    expect(said).toContain(LETTER_ATTACHMENTS_NOTE);

    // 秘书：输入是通知的文字（附件卡片不进它的输入），按通知里的附件引用读得到日报
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastEcho(frontend, SECRETARY);
    expect(seen).toContain(`附件引用 ${mdRef}`);
    expect(seen).not.toContain("[附件：daily.md");
    expect(seen).toContain(`[toolResult] ${READ_ATTACHMENT_TOOL}: 附件「daily.md」（text/markdown，`);
    expect(seen).toContain("评测：长上下文的新基准出来了");

    // 维护者那边：第一封的结果写明附件交过去了；第二封有一个发不了，整封不发
    await waitUntil(() => lastEcho(frontend, TM1).includes("旧日报.md"), { timeoutMs: 30_000, describe: () => "等维护者看到第二封的结果" });
    const own = lastEcho(frontend, TM1);
    expect(own).toContain("附件（daily.md、chart.svg）跟着这条消息一起交过去了");
    expect(own).toMatch(/发不了「\.\.\/t-9\/旧日报\.md」：只能发工作目录里的文件。这封信没有发/);
    await pause(500);
    expect(letterNotices(frontend)).toHaveLength(1);
    // 任务做完的通知和来信同一次交，交付的 daily.md 已经跟在来信后面了，不再放一张（chart.svg 不能预览，本来就不放）
    const done = messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && textOf(m).startsWith(TASK_DONE_TAG));
    expect(done).toHaveLength(1);
    expect(textOf(done[0]!)).toContain("daily.md");
    expect(runtimeFiles(frontend)).toEqual([files]);
  }, 60_000);

  it("秘书处理带附件的来信到一半崩溃：重新交的只有文字（写着附件引用），附件卡片只放了一次", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const td = await setup({
      secretary: [call("look_up", {}), say("日报做完了，附了日报，要我念给你听吗？")],
      secretaryTools: [lookUpTool(gate)],
      maintainer: longTask([call("write", { path: "daily.md", content: DAILY_MD }), call(TELL_SECRETARY_TOOL, { summary: "日报做好了", text: "日报做好了。", attachments: ["daily.md"] }), say("告诉秘书了")]),
    });
    const { frontend } = td;
    await runningTask(td, frontend, "出日报");
    await waitUntil(() => letterNotices(frontend).length >= 1, { timeoutMs: 30_000, describe: () => "等维护者来信" });
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书开始处理来信" });
    await pause(500);
    process.kill(td.daemon.secretary.pid!);
    open();

    await waitUntil(() => letterNotices(frontend).length >= 2, { timeoutMs: 30_000, describe: () => "等重新交" });
    const [first, again] = letterNotices(frontend);
    expect(again!.message.parts).toEqual(first!.message.parts);
    expect(textOf(again!)).toContain("（附了 1 个文件：daily.md（附件引用 ");
    expect(runtimeFiles(frontend).map((m) => m.message.parts.map((p) => (p as FilePart).name))).toEqual([["daily.md"]]);
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 2, { timeoutMs: 30_000, describe: () => "等第二次处理完" });
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as TurnEndEventPayload).outcome)).toEqual(["interrupted", "completed"]);
  }, 60_000);
});

/** 秘书的一个工具：等测试放行（放行之前秘书一直"在这一轮里"，测试趁这时把秘书子进程杀掉） */
function lookUpTool(gate: Promise<void>) {
  return defineHostTool({ name: "look_up", title: "查一查", description: "查点东西（测试里等测试放行）", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: async () => (await gate, { text: "查到了" }) });
}

/** 工具声明里有哪些参数 */
const params = (tool: { spec: { parameters: unknown } }) => Object.keys((tool.spec.parameters as { properties: Record<string, unknown> }).properties);

/** 记下 agent 管家收到的每次拉起请求（谁、代为执行的工具、tell_secretary 有哪些参数） */
function spawnRequests(td: TestDaemon) {
  const requests: Array<{ agentId: string; hostTools: string[]; letterParams: string[] | undefined }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    const letter = (request.hostTools ?? []).find((t) => t.name === TELL_SECRETARY_TOOL);
    requests.push({
      agentId: request.agentId,
      hostTools: (request.hostTools ?? []).map((t) => t.name),
      letterParams: letter && Object.keys((letter.parameters as { properties: Record<string, unknown> }).properties),
    });
    return spawn(request);
  };
  return () => [...requests];
}
