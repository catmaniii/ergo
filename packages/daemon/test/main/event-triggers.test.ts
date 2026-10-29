// 主切面：事件触发（77 号票，ADR 0025）。真的守护进程，秘书、维护者接 faux 剧本，调度器的时钟换成手动拨的（ManualClock），
// 文件夹监视是真的（Node 自带的 fs.watch，监视测试建的临时目录），测试扮演前端：
// - 监视一个临时文件夹，放进一个对得上模式的文件：事件触发的普通任务跑一次，agent 拿到文件路径（结构化的这一批事件）；对不上的不触发；
// - 某个任务完成时触发另一个普通任务（二狗内部事件，按任务过滤）；
// - 事件触发的流程：步骤参数写事件的占位，计划卡上照写；执行时代入、按代入后的值核对和授权；放进两个文件时一次运行里各走一遍；
//   通用 bash 的步骤：值不拼进命令（环境变量），文件名里有引号、$、反引号、{{ 也照样只是一个文件名；
// - 同一个文件连续快速变化合成一次；运行中又来的事件排队合并（只多跑一次，这一批一起交给它）；一次运行最多照几步，多的另起一次；
// - 不能监视数据目录、密钥区、受保护区域（含子文件夹时里面有的也不行）；
// - 简单提醒也能挂事件：事件发生时发一条通知；
// - 守护进程停着时的变化，开机比对补发；重启后接着监视；补过的再重启不重复。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_PLACEHOLDER_NOTE,
  EVENT_TYPES,
  EVENT_WORKFLOW_GRANT_TEXT,
  type EventTrigger,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type ReminderEventPayload,
  type ResponseFrame,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { ManualClock } from "../helpers/clock.ts";
import { reminderService, startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, secretary: SECRETARY } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const TM2 = maintainerChannel("tm-2");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const START = new Date(2026, 9, 8, 8, 0);
/** 测试里文件夹的变化安静多久算一次（毫秒，手动拨的钟） */
const SETTLE = 500;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const toolPartsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
/** 交给 agent 的通知（运行时发的、排进它的输入队列的系统消息） */
const noticesIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true).map(textOf);
const lastEcho = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const refused = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code} ${r.error.message}`;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const jobWhere = (frontend: TestFrontend, match: (e: ScheduledJobEventPayload) => boolean, what: string) => eventually(() => jobsOf(frontend), match, what);
const runEnded = (frontend: TestFrontend, runId: string) => jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.runId === runId, `${runId} 结束`);

/** 本机文件夹变化：哪个文件夹、哪几种变化、文件名模式 */
const folderTrigger = (folder: string, events: string[], pattern?: string, recursive?: boolean): EventTrigger => ({
  kind: "event",
  source: "folder",
  events,
  filter: { path: folder, ...(pattern ? { pattern } : {}), ...(recursive ? { recursive } : {}) },
});

/** 测试用的文件夹（临时目录的真实路径：Windows 的临时目录常带 8.3 短名） */
const tempFolder = (prefix: string) => realPathOf(makeTempDir(prefix))!;

/** 等守护进程看到了 n 处文件夹的变化（fs.watch 是真的），再拨时钟让它们安静下来、算成事件 */
async function settleFolder(td: TestDaemon, clock: ManualClock, n = 1): Promise<void> {
  await waitUntil(() => td.daemon.eventTriggers.pending() >= n, { timeoutMs: 30_000, describe: () => `等看到 ${n} 处文件夹的变化（现在 ${td.daemon.eventTriggers.pending()}）` });
  clock.advance(SETTLE + 1);
}

/** 订阅登记好了（文件夹已经开始监视） */
const watching = (td: TestDaemon, n = 1) =>
  waitUntil(() => td.daemon.eventTriggers.subscriptions().length >= n, { timeoutMs: 30_000, describe: () => "等订阅登记好" });

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, SECRETARY, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const clock = new ManualClock(START);
  const td = await startTestDaemon({ clock, secretary: [say("好"), say("好"), say("好"), say("好")], ...options, config: { eventSources: { folderSettleMs: SETTLE }, ...options.config } });
  return { td, clock, frontend: await connect(td.url, channels) };
}

describe("文件夹变化触发普通任务", () => {
  it("监视临时文件夹：放进对得上模式的文件，事件触发的普通任务跑一次，agent 拿到文件路径（结构化的这一批事件）；对不上的不触发；看板上写在等什么事件、最近一次触发", async () => {
    const inbox = tempFolder("ergo-inbox-");
    const { td, clock, frontend } = await setup({ maintainer: [ECHO, ECHO] });
    const trigger = folderTrigger(inbox, ["added"], "*.pdf");
    expect(ok(await frontend.startTask("收到 PDF 就登记一下\n记下文件名和大小", "k-pdf", [], "plain", trigger))).toEqual({ taskId: "t-1" });

    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created.task).toMatchObject({ id: "t-1", kind: "plain", state: "operating", trigger });
    const registered = await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    expect(registered.job).toMatchObject({ id: "j-1", ownerTaskId: "t-1", state: "active", event: trigger });
    expect(registered.job.schedule).toBeUndefined();
    expect(registered.job.nextAt).toBeUndefined();
    await watching(td);
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toContain(`事件触发：本机文件夹 ${inbox}里新增 *.pdf 文件`);

    fs.writeFileSync(path.join(inbox, "说明.txt"), "不是 PDF");
    fs.writeFileSync(path.join(inbox, "报告.pdf"), "%PDF-1.4 假的");
    await settleFolder(td, clock, 2);
    const ended = await runEnded(frontend, "j-1-r1");
    expect(ended.run).toMatchObject({ state: "done", trigger: "event", events: [{ source: "folder", event: "added", summary: `新增文件 报告.pdf（${inbox}）` }] });
    expect(ended.run!.events![0]!.data).toMatchObject({ path: path.join(inbox, "报告.pdf"), name: "报告.pdf", relativePath: "报告.pdf", folder: inbox, change: "新增", size: 15 });
    // 交给 agent 的通知：在等什么事件、这一批事件的结构化内容（键是字段的中文名），agent 的上下文里有文件路径
    const notice = noticesIn(frontend, TM1)[0]!;
    expect(notice).toContain(`事件触发的普通任务 t-1「收到 PDF 就登记一下」的第 1 次运行（j-1-r1；事件发生时：本机文件夹 ${inbox}里新增 *.pdf 文件）`);
    expect(notice).toContain(`"文件路径": ${JSON.stringify(path.join(inbox, "报告.pdf"))}`);
    expect(notice).toContain(`"事件": "新增文件"`);
    expect(lastEcho(frontend, TM1)).toContain(JSON.stringify(path.join(inbox, "报告.pdf")));
    // 对不上模式的 .txt 不触发
    expect(td.daemon.scheduledJobs.get("j-1")!.runCount).toBe(1);
    // 秘书的看板写最近一次触发
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toContain("最近一次触发：新增文件 报告.pdf");
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
  }, 120_000);
});

describe("二狗内部事件", () => {
  it("某个任务完成时触发另一个普通任务：按任务过滤，agent 拿到完成的是哪个任务；别的任务完成不触发", async () => {
    const { td, frontend } = await setup({ maintainer: (id) => (id === "tm-1" ? [ECHO, ECHO] : [say(`${id} 做完了`)]) }, [BOARD, CARDS, INBOX, SECRETARY, TM1, TM2]);
    const trigger: EventTrigger = { kind: "event", source: "ergo", events: ["task_done", "task_failed"], filter: { taskId: "t-2" } };
    ok(await frontend.startTask("备份做完了就检查一遍\n看看备份目录里的文件齐不齐", "k-after", [], "plain", trigger));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);
    // 一个不相干的任务先做完：不触发
    ok(await frontend.startTask("整理一下桌面", "k-other", [], "plain"));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2" && e.task.state === "done", "t-2 做完");
    const ended = await runEnded(frontend, "j-1-r1");
    expect(ended.run!.events).toMatchObject([{ source: "ergo", event: "task_done", summary: "任务 t-2「整理一下桌面」完成了", data: { taskId: "t-2", taskTitle: "整理一下桌面", taskKind: "普通任务" } }]);
    const notice = noticesIn(frontend, TM1)[0]!;
    expect(notice).toContain(`"任务编号": "t-2"`);
    expect(notice).toContain(`"事件": "任务完成"`);
    // 再来一个不在过滤条件里的任务：不触发
    ok(await frontend.startTask("再整理一下下载目录", "k-third", [], "plain"));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-3" && e.task.state === "done", "t-3 做完");
    await settled(td, "tm-1", "tm-3");
    expect(td.daemon.scheduledJobs.get("j-1")!.runCount).toBe(1);
  }, 120_000);
});

/** 收件箱里来了文件就读一遍、再看看工作目录：参数里写事件的值 */
const inboxDraft: WorkflowPlanDraft = {
  goal: "收件箱里来了文本文件就读一遍，再看看工作目录",
  steps: [
    { id: "s1", title: "读新来的 {{事件.文件名}}", tool: TOOL.read, args: { path: "{{事件.文件路径}}" } },
    { id: "s2", title: "看看工作目录", tool: TOOL.ls, args: { path: "." }, after: ["s1"] },
  ],
  rules: [],
};

describe("事件触发的流程", () => {
  it("步骤参数写事件的占位：计划卡上照写、写明授权管多久；执行时代入、按代入后的值核对和授权（读收件箱里的文件不用问）；放进两个文件时一次运行各走一遍", async () => {
    const inbox = tempFolder("ergo-flow-inbox-");
    const a = path.join(inbox, "a.txt");
    const b = path.join(inbox, "b.txt");
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => {
        if (spawn === 1) return [call("propose_plan", inboxDraft as unknown as Record<string, unknown>), say("计划交上去了")];
        // 这次运行：一批两个事件，各走一遍
        return [call(TOOL.read, { path: a }), call(TOOL.ls, { path: "." }), call(TOOL.read, { path: b }), call(TOOL.ls, { path: "." }), say("两个文件都读过了")];
      },
    });
    const trigger = folderTrigger(inbox, ["added"], "*.txt");
    ok(await frontend.startTask("收件箱里来了文本文件就读一遍", "k-flow", [], "workflow", trigger));
    td.daemon.tasks.writeBrief("t-1", { goal: "读新来的文本文件", acceptanceCriteria: ["每个新文件都读过"], constraints: [], projects: [], memoryScope: "" });
    // 交给维护者的任务书里写明事件发生时做、占位怎么写、能用哪些字段
    await waitUntil(() => noticesIn(frontend, TM1).some((t) => t.includes("什么时候做：事件发生时") && t.includes("{{事件.文件路径}}")), { timeoutMs: 30_000, describe: () => "等任务书" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    const payload = card.payload as WorkflowPlanCardPayload;
    // 卡上照写占位，标出代入事件的值；写明在等什么事件、授权管多久
    expect(payload.event).toEqual(trigger);
    expect(payload.plan.steps[0]).toMatchObject({ id: "s1", title: "读新来的 {{事件.文件名}}", args: { path: "{{事件.文件路径}}" }, eventValues: ["文件名", "文件路径"], marks: [] });
    expect(card.text).toContain(EVENT_WORKFLOW_GRANT_TEXT);
    expect(card.text).toContain(EVENT_PLACEHOLDER_NOTE);
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await eventually(() => tasksOf(frontend), (e) => e.change === "plan_confirmed" && e.task.state === "operating", "授权后运营中");
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);

    // 一次放进两个文件：一批两个事件，一次运行里各走一遍
    fs.writeFileSync(a, "第一份");
    fs.writeFileSync(b, "第二份");
    await settleFolder(td, clock, 2);
    const ended = await runEnded(frontend, "j-1-r1");
    expect(ended.run!.events!.map((e) => e.summary)).toEqual([`新增文件 a.txt（${inbox}）`, `新增文件 b.txt（${inbox}）`]);
    expect(ended.run).toMatchObject({ state: "done" });
    expect(ended.run!.steps!.map((s) => [s.stepId, s.title, s.state])).toEqual([
      ["s1.e1", "读新来的 a.txt（第 1 个事件）", "done"],
      ["s2.e1", "看看工作目录（第 1 个事件）", "done"],
      ["s1.e2", "读新来的 b.txt（第 2 个事件）", "done"],
      ["s2.e2", "看看工作目录（第 2 个事件）", "done"],
    ]);
    // 交给维护者的步骤是代入之后的
    const notice = noticesIn(frontend, TM1).find((t) => t.includes("j-1-r1"))!;
    expect(notice).toContain("这一批有 2 个事件，每个事件各走一遍步骤");
    expect(notice).toContain(`s1.e1. 读新来的 a.txt（第 1 个事件）（read ${JSON.stringify({ path: a })}）`);
    expect(notice).toContain(`s1.e2. 读新来的 b.txt（第 2 个事件）（read ${JSON.stringify({ path: b })}）`);
    // 读收件箱里的文件（工作目录之外）按代入后的步骤授权，照计划做都执行了、没有问用户
    const reads = toolPartsOf(frontend, TM1).filter((p) => p.tool === TOOL.read || p.tool === TOOL.ls);
    expect(reads.map((p) => [p.tool, p.outcome])).toEqual([
      ["read", "done"],
      ["ls", "done"],
      ["read", "done"],
      ["ls", "done"],
    ]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(new Set(cardsOf(frontend).filter((c) => c.type === "workflow_plan").map((c) => c.id)).size).toBe(1);
  }, 120_000);

  it("核对按代入后的值比：读的不是这次事件的文件，和代入后的步骤对不上（审批卡上写明步骤里是哪个文件），拒绝后照计划读这次的文件；一个事件的照原来的步骤编号", async () => {
    const inbox = tempFolder("ergo-flow-check-");
    const c = path.join(inbox, "c.txt");
    const other = path.join(inbox, "旧的.txt");
    fs.writeFileSync(other, "早就在了");
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => {
        if (spawn === 1) return [call("propose_plan", inboxDraft as unknown as Record<string, unknown>), say("计划交上去了")];
        return [call(TOOL.read, { path: other }), call(TOOL.read, { path: c }), call(TOOL.ls, { path: "." }), say("读过了")];
      },
    });
    ok(await frontend.startTask("收件箱里来了文本文件就读一遍", "k-flow-check", [], "workflow", folderTrigger(inbox, ["added"], "*.txt")));
    td.daemon.tasks.writeBrief("t-1", { goal: "读新来的文本文件", acceptanceCriteria: ["新文件读过"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(() => cardsOf(frontend), (x) => x.type === "workflow_plan" && x.status === "pending", "流程计划卡");
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);

    fs.writeFileSync(c, "新来的");
    await settleFolder(td, clock);
    // 读旧文件：代入后的步骤里写的是 c.txt，和计划不一致、也超出按代入后的步骤推出的授权：问用户
    const approval = await eventually(() => cardsOf(frontend), (x) => x.type === "approval" && x.status === "pending", "审批卡");
    const asked = approval.payload as { categoryTitles: string[]; reason: string };
    expect(asked.categoryTitles).toContain("与已授权的计划不一致");
    expect(asked.reason).toContain(`步骤里写的是 ${c}`);
    // 守卫眼里这次运行的步骤是代入之后的（一个事件的照原来的编号）
    expect(td.daemon.scheduledJobs.guardTask("j-1")!.plan.workflow!.steps.map((s) => [s.id, s.title, s.args])).toEqual([
      ["s1", "读新来的 c.txt", { path: c }],
      ["s2", "看看工作目录", { path: "." }],
    ]);
    ok(await frontend.cardAction({ cardId: approval.id, action: "deny", expectedVersion: approval.version, note: "读这次来的那个" }));
    const ended = await runEnded(frontend, "j-1-r1");
    expect(ended.run!.steps!.map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
    const reads = toolPartsOf(frontend, TM1).filter((p) => p.tool === TOOL.read);
    expect(reads.map((p) => [p.argsSummary, p.outcome])).toEqual([
      [other, "denied"],
      [c, "done"],
    ]);
  }, 120_000);
});

describe("事件触发的流程：通用 bash 的步骤", () => {
  it("值不拼进命令：步骤里的占位换成引用环境变量，文件名里有引号、$、反引号、{{ 也只是一个文件名；守卫按代入后的值核对、授权", async () => {
    const inbox = tempFolder("ergo-flow-bash-");
    // Windows 文件名里能有的怪字符：单引号、$( )、反引号、花括号（写成占位的样子）
    const name = "it's $(echo 坏) `echo 坏` {{事件.文件路径}}.txt";
    const command = 'cp "${ERGO_EVENT_1_PATH}" "${ERGO_EVENT_1_NAME}.bak"';
    const bashDraft: WorkflowPlanDraft = {
      goal: "收件箱里来了文本文件就备份一份到工作目录",
      steps: [{ id: "s1", title: "备份 {{事件.文件名}}", tool: TOOL.bash, args: { command: 'cp "{{事件.文件路径}}" "{{事件.文件名}}.bak"' } }],
      rules: [],
    };
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => (spawn === 1 ? [call("propose_plan", bashDraft as unknown as Record<string, unknown>), say("计划交上去了")] : [call(TOOL.bash, { command }), say("备份好了")]),
    });
    ok(await frontend.startTask("收件箱里来了文本文件就备份一份", "k-flow-bash", [], "workflow", folderTrigger(inbox, ["added"], "*.txt")));
    td.daemon.tasks.writeBrief("t-1", { goal: "备份新来的文本文件", acceptanceCriteria: ["每个新文件都备份了"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    // 卡上照写占位
    expect((card.payload as WorkflowPlanCardPayload).plan.steps[0]).toMatchObject({ args: { command: 'cp "{{事件.文件路径}}" "{{事件.文件名}}.bak"' }, eventValues: ["文件名", "文件路径"] });
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);

    const file = path.join(inbox, name);
    fs.writeFileSync(file, "要备份的内容");
    await settleFolder(td, clock);
    const ended = await runEnded(frontend, "j-1-r1");
    expect(ended.run).toMatchObject({ state: "done" });
    expect(ended.run!.steps!.map((st) => [st.stepId, st.title, st.state])).toEqual([["s1", `备份 ${name}`, "done"]]);
    // 交给维护者的命令里只有变量，没有文件名
    const notice = noticesIn(frontend, TM1).find((t) => t.includes("j-1-r1"))!;
    expect(notice).toContain(`bash ${JSON.stringify({ command })}`);
    expect(notice).toContain("ERGO_EVENT_");
    // 真的执行了：工作目录里多了一份名字原样的备份，内容一样；文件名里的命令没有执行；读收件箱（工作目录之外）按代入后的步骤授权，没有问用户
    const backup = path.join(dataDirLayout(td.dataDir).outputs, "t-1", `${name}.bak`);
    expect(fs.readFileSync(backup, "utf8")).toBe("要备份的内容");
    expect(fs.readdirSync(path.join(dataDirLayout(td.dataDir).outputs, "t-1")).filter((f) => f.includes("坏") && !f.endsWith(".bak"))).toEqual([]);
    expect(toolPartsOf(frontend, TM1).filter((pt) => pt.tool === TOOL.bash).map((pt) => pt.outcome)).toEqual(["done"]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
  }, 120_000);
});

describe("一次运行最多照几步", () => {
  it("一批事件数 × 步骤数超了上限（配置 eventSources.maxRunSteps）：排着的那一次满了，再来的事件另起一次，一次接一次跑", async () => {
    const inbox = tempFolder("ergo-flow-cap-");
    const a = path.join(inbox, "a.txt");
    const b = path.join(inbox, "b.txt");
    const c = path.join(inbox, "c.txt");
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("propose_plan", inboxDraft as unknown as Record<string, unknown>), say("计划交上去了")]
          : spawn === 2
            ? [call(TOOL.read, { path: a }), call(TOOL.ls, { path: "." }), call(TOOL.read, { path: b }), call(TOOL.ls, { path: "." }), say("前两个读过了")]
            : [call(TOOL.read, { path: c }), call(TOOL.ls, { path: "." }), say("第三个读过了")],
      // 流程两步，一次运行最多 4 步：一次最多两个事件
      config: { eventSources: { folderSettleMs: SETTLE, maxRunSteps: 4 } },
    });
    ok(await frontend.startTask("收件箱里来了文本文件就读一遍", "k-flow-cap", [], "workflow", folderTrigger(inbox, ["added"], "*.txt")));
    td.daemon.tasks.writeBrief("t-1", { goal: "读新来的文本文件", acceptanceCriteria: ["每个新文件都读过"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(() => cardsOf(frontend), (x) => x.type === "workflow_plan" && x.status === "pending", "流程计划卡");
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);

    // 一次放进三个文件（比如开机补发）：第一次两个事件（4 步），第二次一个
    fs.writeFileSync(a, "一");
    fs.writeFileSync(b, "二");
    fs.writeFileSync(c, "三");
    await settleFolder(td, clock, 3);
    const r1 = await runEnded(frontend, "j-1-r1");
    const r2 = await runEnded(frontend, "j-1-r2");
    expect(r1.run!.events!.map((e) => e.data?.name)).toEqual(["a.txt", "b.txt"]);
    expect(r1.run!.steps!.map((st) => st.stepId)).toEqual(["s1.e1", "s2.e1", "s1.e2", "s2.e2"]);
    expect(r2.run!.events!.map((e) => e.data?.name)).toEqual(["c.txt"]);
    expect(r2.run!.steps!.map((st) => [st.stepId, st.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
    expect([r1.run!.state, r2.run!.state]).toEqual(["done", "done"]);
    expect(td.daemon.scheduledJobs.get("j-1")!.runCount).toBe(2);
  }, 120_000);
});

describe("合成一次、排队合并", () => {
  it("同一个文件连着改几次只算一次；运行中又来的事件排队合并：只多跑一次，这一批一起交给它", async () => {
    const inbox = tempFolder("ergo-merge-");
    const outside = tempFolder("ergo-outside-");
    const notes = path.join(outside, "notes.txt");
    fs.writeFileSync(notes, "外面的笔记");
    const { td, clock, frontend } = await setup({
      // 第一次运行读工作目录外的文件要先问（对话审批开着）：卡在审批上，一直在跑
      maintainer: (_id, spawn) => (spawn === 1 ? [call(TOOL.read, { path: notes }), say("第一次读到了")] : [ECHO]),
      config: { guard: { conversationApprovals: "on" }, approvals: { waitMinutes: 100_000 } },
    });
    ok(await frontend.startTask("收件箱有变化就看一眼", "k-merge", [], "plain", folderTrigger(inbox, ["added", "changed"])));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(td);

    // 连着写五次：只算一次新增（不是一次新增加四次修改）
    const draft = path.join(inbox, "草稿.txt");
    for (let i = 0; i < 5; i++) fs.appendFileSync(draft, `第 ${i + 1} 段\n`);
    await settleFolder(td, clock);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval" && c.status === "pending", "审批卡");
    expect(td.daemon.scheduledJobs.get("j-1")!.lastRun).toMatchObject({ runId: "j-1-r1", state: "running", events: [{ event: "added", summary: `新增文件 草稿.txt（${inbox}）` }] });

    // 运行中又来两次：第一次新起一次排着，第二次并进它
    fs.writeFileSync(path.join(inbox, "x.txt"), "x");
    await settleFolder(td, clock);
    await jobWhere(frontend, (e) => e.change === "triggered" && e.run?.runId === "j-1-r2", "第二次排着");
    fs.writeFileSync(path.join(inbox, "y.txt"), "y");
    await settleFolder(td, clock);
    const merged = await jobWhere(frontend, (e) => e.change === "merged", "并进排着的那一次");
    expect(merged.run!.events!.map((e) => e.summary)).toEqual([`新增文件 x.txt（${inbox}）`, `新增文件 y.txt（${inbox}）`]);

    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    const r1 = await runEnded(frontend, "j-1-r1");
    await runEnded(frontend, "j-1-r2");
    await settled(td, "tm-1");
    // 草稿连写五次只算了一次新增；之后再没有别的运行（没有修改的事件）
    expect(r1.run!.events!.map((e) => [e.event, e.data?.name])).toEqual([["added", "草稿.txt"]]);
    expect(td.daemon.scheduledJobs.get("j-1")!.runCount).toBe(2);
    const batch = noticesIn(frontend, TM1).find((t) => t.includes("j-1-r2"))!;
    expect(batch).toContain("这一批事件的内容（结构化，2 个，先后照来的顺序）");
    expect(batch).toContain(`"文件名": "x.txt"`);
    expect(batch).toContain(`"文件名": "y.txt"`);
  }, 120_000);
});

describe("不能监视的地方", () => {
  it("数据目录、密钥区、受保护区域（程序目录）不能监视；含子文件夹时里面有数据目录的也不行；建任务、建提醒都查", async () => {
    const parent = tempFolder("ergo-parent-");
    const dataDir = path.join(parent, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const homeDir = makeTempDir("ergo-home-");
    const programDir = tempFolder("ergo-program-");
    const { td, frontend } = await setup({ reuse: { dataDir, homeDir }, programDir });
    const secrets = dataDirLayout(dataDir).secrets;
    fs.mkdirSync(secrets, { recursive: true });
    const sessions = dataDirLayout(dataDir).sessions;
    fs.mkdirSync(sessions, { recursive: true });

    expect(refused(await frontend.startTask("盯着数据目录", "k-1", [], "plain", folderTrigger(dataDir, ["added"])))).toMatch(/^bad_params .*不能监视 .*：它在二狗的数据目录里/);
    expect(refused(await frontend.startTask("盯着会话目录", "k-2", [], "plain", folderTrigger(sessions, ["added"])))).toContain("它在二狗的数据目录里");
    expect(refused(await frontend.startTask("盯着密钥区", "k-3", [], "plain", folderTrigger(secrets, ["added"])))).toContain("它在数据目录的密钥区里");
    expect(refused(await frontend.startTask("盯着程序目录", "k-4", [], "plain", folderTrigger(programDir, ["changed"])))).toContain("它在二狗程序目录里");
    // 含子文件夹的上一级：里面有数据目录，不行；只看这一层可以
    expect(refused(await frontend.startTask("盯着上一级", "k-5", [], "plain", folderTrigger(parent, ["added"], undefined, true)))).toContain("它里面有二狗的数据目录");
    expect(ok(await frontend.startTask("只看上一级这一层", "k-6", [], "plain", folderTrigger(parent, ["added"])))).toEqual({ taskId: "t-1" });
    // 简单提醒也查
    expect(refused(await frontend.createReminder("密钥变了", { event: folderTrigger(secrets, ["changed"]) }))).toContain("它在数据目录的密钥区里");
    // 写得不对的：相对路径、不在的文件夹、没选事件、来源不认得
    expect(refused(await frontend.startTask("相对路径", "k-7", [], "plain", folderTrigger("收件箱", ["added"])))).toContain("文件夹要写完整路径");
    expect(refused(await frontend.startTask("不在的", "k-8", [], "plain", folderTrigger(path.join(parent, "没有"), ["added"])))).toContain("文件夹不在");
    expect(refused(await frontend.startTask("没选事件", "k-9", [], "plain", { kind: "event", source: "folder", events: ["moved"], filter: { path: parent } }))).toContain("本机文件夹变化没有这种事件：moved");
    expect(refused(await frontend.startTask("邮件", "k-10", [], "plain", { kind: "event", source: "mail", events: ["received"] }))).toContain("没有这个事件来源：mail");
    // 长程任务照旧只能现在做一次
    expect(refused(await frontend.startTask("长程的", "k-11", [], "long_running", folderTrigger(parent, ["added"])))).toContain("长程任务只能现在做一次");
    expect(td.daemon.tasks.list().map((t) => t.id)).toEqual(["t-1"]);
  }, 120_000);
});

describe("简单提醒挂事件", () => {
  it("事件发生时提醒：不用 agent，事件来了发一条通知（待我处理里置顶一条），提醒一直待触发；看板写在等什么事件", async () => {
    const photos = tempFolder("ergo-photos-");
    const { td, clock, frontend } = await setup({});
    const trigger = folderTrigger(photos, ["added"], "*.jpg; *.png");
    const { reminderId } = ok(await frontend.createReminder("有新照片了，记得整理", { event: trigger })) as { reminderId: string };
    expect(reminderId).toBe("r-1");
    expect(reminderService(td.daemon).get("r-1")).toMatchObject({ status: "pending", event: trigger });
    expect(reminderService(td.daemon).get("r-1")!.schedule).toBeUndefined();
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toContain(`提醒 r-1「有新照片了，记得整理」：待触发；事件发生时：本机文件夹 ${photos}里新增 *.jpg; *.png 文件`);
    await watching(td);

    fs.writeFileSync(path.join(photos, "猫.jpg"), "jpg");
    await settleFolder(td, clock);
    const item = await eventually(
      () => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item),
      (i) => i.kind === "notice" && i.notice === "reminder_due",
      "提醒的通知",
    );
    expect(item).toMatchObject({ title: "提醒：有新照片了，记得整理", pinned: true, source: "简单提醒" });
    expect((item as { body?: string }).body).toContain(`新增文件 猫.jpg（${photos}）`);
    const fired = frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload).filter((p) => p.change === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.reminder).toMatchObject({ status: "pending", lastEvent: `新增文件 猫.jpg（${photos}）` });
    // 不用 agent：没有任务、没有维护者的会话
    expect(td.daemon.tasks.list()).toEqual([]);
  }, 120_000);
});

describe("停机期间的变化", () => {
  it("守护进程停着时文件夹里来了文件：开机比对补发；重启后接着监视；补过的再重启不重复", async () => {
    const inbox = tempFolder("ergo-restart-");
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const clock = new ManualClock(START);
    const config = { eventSources: { folderSettleMs: SETTLE } };
    const first = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, config, secretary: [say("好")], maintainer: [say("好")] });
    const frontend = await connect(first.url);
    ok(await frontend.startTask("收件箱来了文件就记一笔", "k-restart", [], "plain", folderTrigger(inbox, ["added", "removed"])));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    await watching(first);
    await frontend.close();
    await first.daemon.stop();

    // 停机期间放进来一个文件
    fs.writeFileSync(path.join(inbox, "停机时来的.txt"), "late");
    const second = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, config, secretary: [say("好")], maintainer: [ECHO, ECHO] });
    const again = await connect(second.url);
    const caught = await runEnded(again, "j-1-r1");
    expect(caught.run!.events).toMatchObject([{ source: "folder", event: "added", summary: `新增文件 停机时来的.txt（${inbox}）` }]);
    expect(noticesIn(again, TM1).find((t) => t.includes("j-1-r1"))).toContain(`"文件名": "停机时来的.txt"`);
    // 重启后接着监视
    await settled(second, "tm-1");
    fs.rmSync(path.join(inbox, "停机时来的.txt"));
    await settleFolder(second, clock);
    const removed = await runEnded(again, "j-1-r2");
    expect(removed.run!.events).toMatchObject([{ event: "removed", summary: `删除文件 停机时来的.txt（${inbox}）` }]);
    await settled(second, "tm-1");
    await again.close();
    await second.daemon.stop();

    // 补过的、看过的再重启不重复
    const third = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, config, secretary: [say("好")], maintainer: [say("不该再跑")] });
    await watching(third);
    await settled(third, "tm-1");
    expect(third.daemon.scheduledJobs.get("j-1")!.runCount).toBe(2);
  }, 120_000);
});
