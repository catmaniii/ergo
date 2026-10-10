// 主切面：普通任务（75 号票，ADR 0025）。真的守护进程，秘书、维护者都接 faux 剧本，测试扮演前端：
// - 发起对话框里选"普通任务"：不经助理，建出就排队、有名额就开始，agent 在后台一轮轮直接做，这一轮做完任务自动完成，助理收到结果在对话里转告；
// - 助理自己交出去（delegate_task）：用户没点明要发起任务也行，建出的是普通任务；工具说明写清什么时候该交、什么时候自己做、
//   和别的发起工具的界线；用户点明了要发起流程或长程任务时它被拒，指向该用的工具；
// - 做完了用户在任务详情里接着说：任务回到执行中，接着做；出错的一轮转等我（卡住求助），回一句就接着做；
// - 只涉及一个项目的建成这个项目的内部任务：项目的维护者在执行的工单段里做，做完这一段照常写回；在它的详情里接着说（带着任务编号）再派一张工单，
//   续派的工单写的是用户这次说的话（原来交代的只留摘要、连同上一轮的结果作为背景，写明不要重做）；
// - 守护进程重启时补记完成：agent 这一轮做完了、还没来得及算完成的（项目内部的也算）；
// - 守卫按普通对话判：对话审批关着时"先问我"的操作不出审批卡，硬拒绝照旧；开着时照原样出审批卡，事后批准了它接着做；
// - 照样占全局执行名额。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type Project,
  type ResponseFrame,
  type TaskEventPayload,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { taskTools } from "../../src/tasks/secretary-tools.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const toolPartsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
/** 某个任务在看板上的变化（按先后） */
const changesOf = (frontend: TestFrontend, taskId: string) => tasksOf(frontend).filter((e) => e.task.id === taskId).map((e) => e.change);
/** 交给 agent 的通知（运行时发的、排进它的输入队列的系统消息） */
const noticesIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true).map(textOf);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what: string) => eventually(() => tasksOf(frontend), match, what);
/** 某个会话处理完第 n 条输入 */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
/** 秘书最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);
/** 对话审批的开关写进配置（测试底座默认开着） */
const approvals = (value: "off" | "on", extra: Record<string, unknown> = {}) => ({ guard: { conversationApprovals: value }, ...extra });

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const td = await startTestDaemon(options);
  return { ...td, frontend: await connect(td.url, channels) };
}

/** 等一个任务做完（看板上的 completed） */
const done = (frontend: TestFrontend, taskId: string, nth = 1) =>
  waitUntil(() => changesOf(frontend, taskId).filter((c) => c === "completed").length >= nth, { timeoutMs: 30_000, describe: () => `等任务 ${taskId} 第 ${nth} 次做完（现在：${changesOf(frontend, taskId).join("、")}）` });

describe("从发起对话框发起", () => {
  it("建出就排队、有名额就开始（不经助理）；agent 在后台做完，任务自动完成，助理收到结果在对话里转告", async () => {
    const { frontend, daemon } = await setup({ secretary: [ECHO], maintainer: [say("下好了：工作目录里的 qingtian.mp3")] });
    expect(ok(await frontend.startTask("去把《晴天》的音频下下来\n要 mp3", "k-plain", [], "plain"))).toEqual({ taskId: "t-1" });

    const created = await taskWhere(frontend, (e) => e.change === "created", "建出的任务");
    expect(created).toMatchObject({ from: null, by: "user", task: { id: "t-1", title: "去把《晴天》的音频下下来", state: "queued", kind: "plain", origin: "button", maintainerId: "tm-1", projects: [] } });
    expect(created.task.planCardId).toBeUndefined();
    await done(frontend, "t-1");
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "completed"]);
    expect(tasksOf(frontend).at(-1)).toMatchObject({ by: "system", from: "running", task: { state: "done" } });
    // 没有计划、阶段、步骤：任务书就是用户写的那段话，交给 agent 的第一条输入
    expect(daemon.tasks.get("t-1")).not.toHaveProperty("stages");
    expect(daemon.tasks.latestPlan("t-1")).toBeUndefined();
    const [brief] = noticesIn(frontend, TM1);
    expect(brief).toContain("普通任务 t-1「去把《晴天》的音频下下来」：要做的事——");
    expect(brief).toContain("去把《晴天》的音频下下来\n要 mp3");
    expect(messagesOf(frontend, TM1).map(textOf)).toContain("这一轮做完了，任务自动完成。要它接着做，在这里接着说。");

    // 助理建卡时没收到通知（不用澄清、写任务书）；做完时收到一句结果，在对话里转告
    await turnsOf(frontend, SECRETARY, 1);
    const relayed = noticesIn(frontend, SECRETARY);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toContain("普通任务 t-1「去把《晴天》的音频下下来」在后台做完了。它最后说：下好了：工作目录里的 qingtian.mp3");
    expect(lastEcho(frontend, SECRETARY)).toContain("用一两句话把结果转告用户");
    // 没有计划卡、审批卡，待我处理里什么都没有
    expect(cardsOf(frontend)).toEqual([]);
    expect(inboxOf(frontend)).toEqual([]);
  });

  it("agent 的装配：普通任务的系统提示；读写文件、bash、联网搜索和读网页都有；没有推进任务、交计划的工具", async () => {
    const { frontend } = await setup({ secretary: [say("好")], maintainer: [ECHO] });
    ok(await frontend.startTask("整理一下下载目录里的截图", "k-tools", [], "plain"));
    await done(frontend, "t-1");
    const seen = lastEcho(frontend, TM1);
    expect(seen).toContain("你是「二狗」里一个普通任务的 agent");
    const tools = seen.split("\n").filter((l) => l.startsWith("[tool] ")).map((l) => l.slice("[tool] ".length));
    expect(tools).toEqual(expect.arrayContaining(["read", "write", "edit", "ls", "grep", "find", "bash", "web_search", "web_fetch", "git_status_diff"]));
    for (const absent of ["submit_plan", "propose_plan", "start_stage", "complete_stage", "report_step", "fail_task", "wait_for_user"]) expect(tools).not.toContain(absent);
  });
});

describe("助理自己交出去", () => {
  it("用户没点明要发起任务：助理用 delegate_task 建一个普通任务（不被拒），告诉用户一声；做完收到结果", async () => {
    const delegate = call("delegate_task", { title: "下载《晴天》音频", instructions: "搜一下周杰伦《晴天》，把音频下载成 mp3，放进工作目录" });
    const { frontend, daemon } = await setup({ secretary: [delegate, ECHO, ECHO], maintainer: [say("下好了：qingtian.mp3")] });
    await frontend.sendText("去搜一下晴天这首歌，把音频下下来");

    const created = await taskWhere(frontend, (e) => e.change === "created", "交出去的任务");
    expect(created).toMatchObject({ by: "secretary", task: { id: "t-1", title: "下载《晴天》音频", kind: "plain", origin: "delegated", state: "queued", summary: "搜一下周杰伦《晴天》，把音频下载成 mp3，放进工作目录" } });
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastEcho(frontend, SECRETARY);
    expect(seen).toContain("[toolResult] delegate_task: 已交给后台：普通任务 t-1「下载《晴天》音频」");
    expect(seen).toContain("告诉用户一声“已交给后台去做，做完告诉你”");
    expect(noticesIn(frontend, TM1)[0]).toContain("普通任务 t-1「下载《晴天》音频」（助理交给你的）：要做的事——\n搜一下周杰伦《晴天》");

    await done(frontend, "t-1");
    await turnsOf(frontend, SECRETARY, 2);
    expect(lastEcho(frontend, SECRETARY)).toContain("它最后说：下好了：qingtian.mp3");
    expect(daemon.tasks.get("t-1")?.state).toBe("done");
  });

  it("工具说明写清什么时候该交出去、什么时候在对话里自己做、和别的发起工具的界线、任务书只带这件事要用的；助理的工具里有它", async () => {
    const { frontend, daemon } = await setup({ secretary: [ECHO] });
    await frontend.sendText("在吗");
    await turnsOf(frontend, SECRETARY, 1);
    expect(lastEcho(frontend, SECRETARY)).toContain("[tool] delegate_task");
    const tool = taskTools(daemon.tasks, daemon.cards, () => ({ texts: [], voices: [] }) as never).find((t) => t.spec.name === "delegate_task");
    expect(tool?.descriptor.title).toBe("交给后台（普通任务）");
    const description = tool?.spec.description ?? "";
    expect(description).toContain("不用等用户点明");
    expect(description).toContain("该交出去的：要几分钟以上才做得完的——要下载东西、要批量处理很多文件、要跑很多步");
    expect(description).toContain("在对话里自己做、不要交出去的：几句话就能回答的");
    expect(description).toContain("和别的发起工具的界线：用户点明了要发起流程或长程任务");
    expect(description).toContain("用 start_workflow、create_task（运行时会拒绝）");
    expect(description).toContain("用 suggest_task 给建议卡，也不用它");
    expect(description).toContain("只带完成这件事需要的信息");
    expect(description).toContain("不带无关的私人内容");
  });

  it("用户点明了要发起流程或长程任务（说了、或者输入了斜杠命令）：delegate_task 被拒，工具结果指向 start_workflow / create_task，不建任务", async () => {
    const delegate = call("delegate_task", { title: "整理截图", instructions: "把下载目录里的截图按月份分到文件夹里" });
    const { frontend, daemon } = await setup({ secretary: [delegate, ECHO, delegate, ECHO] });
    await frontend.sendText("按流程做：把下载目录里的截图按月份分好");
    await turnsOf(frontend, SECRETARY, 1);
    expect(lastEcho(frontend, SECRETARY)).toContain("[toolResult] delegate_task: 用户这一轮点明了要发起流程，不能交给后台做成普通任务：用 start_workflow 发起。");
    await frontend.sendText("/任务 把下载目录里的截图按月份分好");
    await turnsOf(frontend, SECRETARY, 2);
    expect(lastEcho(frontend, SECRETARY)).toContain("[toolResult] delegate_task: 用户这一轮点明了要发起长程任务，不能交给后台做成普通任务：用 create_task 发起。");
    expect(daemon.tasks.list()).toEqual([]);
  });
});

describe("做完之后接着说、出错之后回一句", () => {
  it("用户在做完了的普通任务里接着说：任务回到执行中（continued），接着做，做完又自动完成", async () => {
    const { frontend } = await setup({ secretary: [say("好"), say("好")], maintainer: [say("第一轮：下好了 mp3"), say("第二轮：转成 flac 了")] });
    ok(await frontend.startTask("把《晴天》下成 mp3", "k-cont", [], "plain"));
    await done(frontend, "t-1");
    await frontend.sendText("再转成 flac", { conversation: TM1 });
    await done(frontend, "t-1", 2);
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "completed", "continued", "completed"]);
    expect(tasksOf(frontend).find((e) => e.change === "continued")).toMatchObject({ by: "user", from: "done", task: { state: "running" } });
    // 第二轮的结果同样转告助理
    await turnsOf(frontend, SECRETARY, 2);
    expect(noticesIn(frontend, SECRETARY)[1]).toContain("它最后说：第二轮：转成 flac 了");
  });

  it("出错的一轮不算做完：任务转等我（卡住求助，待我处理里一条）；用户回一句就接着做", async () => {
    const { frontend, daemon } = await setup({
      secretary: [say("好")],
      // 第一次唤起剧本是空的：一调用模型就出错；闲置退出后再唤起是新的剧本
      maintainer: (_id, n) => (n === 1 ? [] : [say("接着做完了")]),
      config: { agents: { idleMinutes: 0.01 } },
    });
    ok(await frontend.startTask("整理照片", "k-err", [], "plain"));
    const stuck = await taskWhere(frontend, (e) => e.change === "waiting", "转等我");
    expect(stuck.task).toMatchObject({ state: "waiting_for_user", waitReason: "stuck" });
    expect(stuck.task.waitNote).toMatch(/^这一轮出错了/);
    const help = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "stuck_help", "卡住求助");
    expect(help).toMatchObject({ urgency: "blocking", data: { taskId: "t-1" } });

    await waitUntil(() => !daemon.agents.live().some((a) => a.agentId === "tm-1"), { describe: () => "等 tm-1 闲置退出" });
    await frontend.sendText("接着做", { conversation: TM1 });
    await done(frontend, "t-1");
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "waiting", "resumed", "completed"]);
    // 卡住求助的那一条随之记成处理过
    await eventually(() => inboxOf(frontend), (i) => i.id === help.id && i.kind === "notice" && i.handled !== undefined, "卡住求助记成处理过");
  });
});

/** 项目内部的普通任务交代得长一点：续派的工单里原来交代的只留摘要（末尾这句不在里面） */
const REQUEST_TAIL = "最后把导出的文件名写进进展文档的末尾";
const LONG_REQUEST = `导出 10 月的账单\n${"每家银行一个 sheet，金额保留两位小数，日期统一写成年月日；".repeat(8)}${REQUEST_TAIL}`;

/** 一个已在使用中的项目（立项书已确认，工具包能跑 bash、能联网） */
const inUseProject = (td: TestDaemon, name: string): Project =>
  seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 先定下数据目录（剧本里要写项目档案的路径，交给 maintainer），再起守护进程，放一个使用中的项目 */
async function withProject(maintainer: (records: string) => StartTestDaemonOptions["maintainer"], secretary: FauxStep[]) {
  const dataDir = makeTempDir("ergou-data-");
  const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
  const td = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergou-home-") }, secretary, maintainer: maintainer(records) });
  inUseProject(td, "记账本");
  const frontend = await connect(td.url, [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1]);
  return { ...td, frontend, records };
}

describe("只涉及一个项目的：建成这个项目的内部任务", () => {
  it("对话框里只选了一个项目：项目的维护者在执行的工单段里直接做，做完任务自动完成、这一段照常写回；助理只知道做完了；在它的详情里接着说再派一张工单接着做", async () => {
    const { frontend, daemon, records } = await withProject(
      (dir) => (id, n) =>
        id !== "pm-1"
          ? []
          : n === 1
            ? [say("10 月的账单导出好了：exports/2026-10.csv"), progressEdit(dir, PROGRESS_INTRO, "导出了 10 月账单。"), call("write_segment_summary", { summary: "导出了 10 月的账单" }), say("写回了")]
            : [say("9 月的也导出了：exports/2026-09.csv"), progressEdit(dir, "导出了 10 月账单。", "导出了 9、10 月账单。"), call("write_segment_summary", { summary: "又导出了 9 月的" }), say("写回了")],
      [ECHO, ECHO],
    );
    ok(await frontend.startTask(LONG_REQUEST, "k-internal", ["记账本"], "plain"));

    const created = await taskWhere(frontend, (e) => e.change === "created", "建出的任务");
    expect(created.task).toMatchObject({ id: "t-1", kind: "plain", state: "queued", maintainerId: "pm-1", projectScope: "single", internal: { projectId: "p-1", projectName: "记账本" } });
    const wo = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created", "执行的工单");
    expect(wo.workOrder).toMatchObject({ source: "user_task", kind: "execute", taskId: "t-1", projectId: "p-1" });
    expect((wo.workOrder as { instructions?: string }).instructions).toContain("普通任务 t-1「导出 10 月的账单」：直接做，不规划、不用计划卡。");

    await done(frontend, "t-1");
    // 交给维护者的任务书只有交代的那段话（怎么做、做完怎么写回在系统提示里，不另抄一份）
    expect(noticesIn(frontend, PM1).find((t) => t.startsWith("普通任务 t-1"))).toBe(`普通任务 t-1「导出 10 月的账单」：要做的事——\n${LONG_REQUEST}`);
    // 这一段收尾（催写回、写回）之后工单才结束
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.workOrder.id, "工单结束");
    expect(workOrdersOf(frontend).find((e) => e.change === "ended")?.workOrder).toMatchObject({ outcome: "done" });
    expect(fs.readFileSync(path.join(records, "progress.md"), "utf8")).toContain("导出了 10 月账单。");
    // 助理只收到"做完了"，看不到结果
    await turnsOf(frontend, SECRETARY, 1);
    expect(noticesIn(frontend, SECRETARY)[0]).toContain("项目「记账本」里交出去的一件事（项目内部的普通任务）做完了");
    expect(noticesIn(frontend, SECRETARY)[0]).not.toContain("2026-10.csv");

    // 在它的详情里接着说（带着任务编号）：消息属于这个任务，任务回到执行中，再派一张执行的工单
    const sent = await frontend.sendText("再导出 9 月的", { conversation: PM1, taskId: "t-1" });
    expect(await eventually(() => messagesOf(frontend, PM1), (m) => m.message.id === sent.messageId, "用户的话")).toMatchObject({ taskId: "t-1", projectId: "p-1" });
    await done(frontend, "t-1", 2);
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "completed", "continued", "completed"]);
    await waitUntil(() => workOrdersOf(frontend).filter((e) => e.change === "ended").length >= 2, { timeoutMs: 30_000, describe: () => "等第二张工单结束" });
    expect(new Set(workOrdersOf(frontend).map((e) => e.workOrder.id)).size).toBe(2);
    // 续派的工单（新的一段是新会话，任务书不再交一遍）：写的是用户这次说的，原来交代的只留摘要，连同上一轮的结果作为背景，写明不要重做
    const again = workOrdersOf(frontend).filter((e) => e.change === "created")[1]!.workOrder as { instructions?: string };
    expect(again.instructions).toContain("接着做普通任务 t-1「导出 10 月的账单」：用户在任务详情里说的——\n「再导出 9 月的」");
    expect(again.instructions).toContain("只做他这次说的。上一轮已经做完的不要重做");
    expect(again.instructions).toContain("- 上一轮的结果：10 月的账单导出好了：exports/2026-10.csv");
    expect(again.instructions).toContain("- 原来交代的：导出 10 月的账单");
    expect(again.instructions).not.toContain("直接做，不规划、不用计划卡。要做的事");
    expect(again.instructions).not.toContain(REQUEST_TAIL);
    expect(daemon.tasks.get("t-1")?.state).toBe("done");
  });

  it("守护进程重启时补记完成：项目的维护者这一轮做完了、执行控制器还没来得及算完成的，重启后补上（项目内部的也看）", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    // 维护者说得慢一点：执行控制器停下的时候它这一轮还没做完
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer: (id) => (id === "pm-1" ? [say("10 月的账单导出好了")] : []), maintainerTokensPerSecond: 5 });
    inUseProject(first, "记账本");
    const frontend = await connect(first.url, [BOARD, PM1]);
    const task = first.daemon.tasks.delegate({ title: "导出账单", instructions: "导出 10 月的账单", projects: ["记账本"] });
    await waitUntil(() => first.daemon.tasks.get(task.id)?.state === "running", { describe: () => "等它开始" });
    expect(first.daemon.tasks.get(task.id)?.maintainerId).toBe("pm-1");
    // 模拟"这一轮刚做完就停机了"：执行控制器先停下，维护者这一轮照样做完
    first.daemon.taskExecution.stop();
    await turnsOf(frontend, PM1, 1);
    expect(frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).at(-1)?.payload).toMatchObject({ outcome: "completed" });
    expect(first.daemon.tasks.get(task.id)?.state).toBe("running");
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer: () => [say("写回了")] });
    expect(second.daemon.tasks.get(task.id)?.state).toBe("done");
    await second.daemon.stop();
  });

  it("助理交出去时写了一个项目：建成这个项目的内部任务，交回助理的话不带细节", async () => {
    const { frontend } = await withProject(() => [], [call("delegate_task", { title: "导出账单", instructions: "导出 10 月的账单", projects: ["记账本"] }), ECHO]);
    await frontend.sendText("把记账本里 10 月的账单导出来");
    const created = await taskWhere(frontend, (e) => e.change === "created", "交出去的任务");
    expect(created).toMatchObject({ by: "secretary", task: { kind: "plain", origin: "delegated", maintainerId: "pm-1", internal: { projectId: "p-1" } } });
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastEcho(frontend, SECRETARY);
    expect(seen).toContain("[toolResult] delegate_task: 已交给项目「记账本」的维护者在后台做");
    expect(seen).not.toContain("t-1");
  });
});

describe("守卫按普通对话判", () => {
  it("对话审批关着：读工作目录外的文件直接做（照常标关注类别），不出审批卡；写受保护区域、读密钥区照旧硬拒绝", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记");
    const dataDir = makeTempDir("ergou-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    fs.mkdirSync(layout.secrets, { recursive: true });
    fs.writeFileSync(path.join(layout.secrets, "deepseek-api-key.txt"), "sk-secret-in-secrets-area");
    const { frontend, daemon } = await setup({
      reuse: { dataDir, homeDir: makeTempDir("ergou-home-") },
      secretary: [say("好")],
      maintainer: [
        call("read", { path: path.join(outside, "notes.txt") }),
        call("write", { path: path.join(layout.db, "x.db"), content: "x" }),
        call("read", { path: path.join(layout.secrets, "deepseek-api-key.txt") }),
        say("看完了"),
      ],
      config: approvals("off"),
    });
    ok(await frontend.startTask("看看那份笔记", "k-guard", [], "plain"));
    await done(frontend, "t-1");
    expect(toolPartsOf(frontend, TM1).map((p) => [p.tool, p.categoryTitles, p.disposition, p.blockedBy ?? null, p.outcome])).toEqual([
      ["read", ["越出项目目录"], "do", null, "done"],
      ["write", expect.anything(), expect.anything(), "hard_refusal", "blocked"],
      ["read", expect.anything(), expect.anything(), "hard_refusal", "blocked"],
    ]);
    expect(fs.existsSync(path.join(layout.db, "x.db"))).toBe(false);
    expect(messagesOf(frontend, TM1).map(textOf).join("\n")).not.toContain("sk-secret-in-secrets-area");
    expect(cardsOf(frontend)).toEqual([]);
    expect(daemon.approvals.list()).toEqual([]);
  });

  it("对话审批开着：同一次调用照原样出审批卡（等不到批准就挂起，这一轮照样做完）；事后批准了，它接着做（任务回到执行中）", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记");
    const notes = path.join(outside, "notes.txt");
    const { frontend, daemon } = await setup({
      secretary: [say("好"), say("好")],
      maintainer: [call("read", { path: notes }), say("在等你批准读那份笔记"), call("read", { path: notes }), say("读到了：外面的笔记")],
      config: approvals("on", { approvals: { waitMinutes: 0.02 } }),
    });
    ok(await frontend.startTask("看看那份笔记", "k-guard-on", [], "plain"));
    await done(frontend, "t-1");
    expect(toolPartsOf(frontend, TM1)[0]).toMatchObject({ tool: "read", categoryTitles: ["越出项目目录"], disposition: "ask_first", outcome: "blocked" });
    expect(daemon.approvals.list().map((a) => a.status)).toEqual(["pending"]);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval", "审批卡");
    // 调用不属于任务：审批卡不卡着任务（任务照样做完了），来源写明是哪个普通任务
    expect(inboxOf(frontend).find((i) => i.kind === "card" && i.cardId === card.id)).toMatchObject({ source: "普通任务「看看那份笔记」" });

    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    await done(frontend, "t-1", 2);
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "completed", "continued", "completed"]);
    expect(toolPartsOf(frontend, TM1).at(-1)).toMatchObject({ tool: "read", outcome: "done" });
  });
});

describe("名额", () => {
  it("普通任务照样占全局执行名额：满了就排队，前一个做完再开始", async () => {
    const { frontend } = await setup({ secretary: [say("好"), say("好")], maintainer: (id) => [say(`${id} 做完了`)], config: { tasks: { maxRunning: 1 } } }, [BOARD, SECRETARY]);
    ok(await frontend.startTask("第一件", "k-1", [], "plain"));
    ok(await frontend.startTask("第二件", "k-2", [], "plain"));
    await done(frontend, "t-2");
    const order = tasksOf(frontend).map((e) => `${e.task.id}:${e.change}`);
    expect(order.indexOf("t-2:started")).toBeGreaterThan(order.indexOf("t-1:completed"));
  });
});
