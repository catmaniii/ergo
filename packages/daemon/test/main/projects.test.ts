// 主切面：项目立项与项目档案（规格第 11 节，15 号票）。真的守护进程，秘书和维护者都接 faux 剧本，测试扮演前端。
// - 立项的三个入口：秘书的"建议立项"卡（点"立项"项目诞生、维护者随之产生）、点"新建项目"（秘书不判断，直接收口出卡）、
//   任务转为项目（不新建维护者，原任务的维护者在同一会话里接着做立项问答）；
// - 立项问答：用户说话唤起休眠的维护者，它把规格、术语表、ADR 写进项目档案（写到外面被拒），交出立项书卡；
// - 立项书卡："确认并开工"（建设中 + 首个建设任务）、"只确认，稍后开工"（筹备中，立项书已确认），类型和外部工作目录立即生效；
// - 项目状态机：建设任务做完出"首版做完了"卡（112 号票：转入使用、继续建设、放弃并归档，不选停在建设中），停用 ⇄ 重新启用，
//   放弃、归档、取消归档，删除要二次确认，非法迁移被拒；
// - 已归档的维护者会话只读；删除项目删掉项目档案和维护者会话，用户说过的话作为素材保留；
// - 项目档案里的文件被整体重写前运行时自动留旧版本。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BOARD_GROUP_OF_TASK_STATE,
  type BuildDoneCardPayload,
  type Card,
  type CardEventPayload,
  type CharterCardPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  PURGED_TEXT,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  nowIso,
  type Project,
  type ProjectEventPayload,
  type ResponseFrame,
  type Task,
  type TaskEventPayload,
  type WorkOrderEventPayload,
  workOrderTaskId,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { snapshotRels } from "../helpers/snapshots.ts";
import { type PlanRevisedPayload, TASK_EVENTS, TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { twoStagePlan } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const calls = (...list: Array<[string, Record<string, unknown>]>): FauxStep => ({ kind: "reply", toolCalls: list.map(([name, args]) => ({ name, arguments: args as never })) });
const suggest = (name: string, goal: string) => call("suggest_project", { name, goal });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function connect(url: string, channels: string[] = [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 等到收到过满足条件的东西（不管和别的频道谁先谁后），返回最新的那个 */
async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs: 20_000, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const projectWhere = (frontend: TestFrontend, match: (e: ProjectEventPayload) => boolean, what = "项目列表上的变化") => eventually(() => projectEventsOf(frontend), match, what);
const ofType = (type: string) => (card: Card) => card.type === type;
/** 等维护者处理完 n 条输入 */
const turns = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 20_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 进展文档一开始的那句（项目档案的最小文档集） */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 项目页上的动作 */
const act = (frontend: TestFrontend, projectId: string, action: string, key?: string) => frontend.request(METHODS.projectAction, { projectId, action }, key ?? `${projectId}-${action}-${Math.random()}`);

/** 用户在聊天里点"立项"：直接放一张建议立项卡再点（不走秘书的剧本） */
async function kickoff(test: TestDaemon, frontend: TestFrontend, name = "记账本", goal = "把家里的账管起来"): Promise<Project> {
  const card = test.daemon.cards.create({ type: "suggest_project", payload: { name, goal } });
  ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
  return (await projectWhere(frontend, (e) => e.change === "created" && e.project.name === name, `项目「${name}」诞生`)).project;
}

describe("立项的入口", () => {
  it("秘书的“建议立项”工具只产生一张卡；用户点“立项”后项目以筹备中出现在项目列表，维护者随之产生（休眠），项目档案建好最小文档集；关掉的建议卡是回避信号", async () => {
    const test = await startTestDaemon({
      secretary: [suggest("记账本", "把家里的账管起来"), say("给你一张建议立项卡"), say("项目建好了"), suggest("家电档案", "记下家电的保修"), say("再给你一张")],
    });
    const { daemon, dataDir, url } = test;
    const frontend = await connect(url);
    await frontend.sendText("我每个月都要手动对账，好麻烦");
    const card = await cardWhere(frontend, ofType("suggest_project"), "建议立项卡");
    expect(card).toMatchObject({ status: "pending", payload: { name: "记账本", goal: "把家里的账管起来" }, text: "建议立项：记账本（把家里的账管起来）" });
    // 卡片出现在聊天里
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))).toBe(true);
    // 只是一张卡：项目还没诞生
    expect(projectEventsOf(frontend)).toEqual([]);
    expect(daemon.projects.list()).toEqual([]);

    ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
    const created = (await frontend.next(PROJECTS, EVENT_TYPES.project)).payload as ProjectEventPayload;
    expect(created).toMatchObject({
      change: "created",
      from: null,
      by: "user",
      project: { id: "p-1", name: "记账本", goal: "把家里的账管起来", state: "preparing", origin: "suggestion", maintainerId: "pm-1", charterConfirmed: false, workdir: { external: false } },
    });
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled")).toMatchObject({ outcome: { action: "kickoff" }, payload: { projectId: "p-1" } });

    // 维护者随之产生：它的会话里有一条说明（带所属的项目），不交给它处理，它还在休眠
    const note = (await frontend.next(PM1, EVENT_TYPES.message)).payload as MessageEventPayload;
    expect(note).toMatchObject({ projectId: "p-1", message: { speaker: "system", conversation: PM1 } });
    expect(note.agentInput).toBeUndefined();
    expect(textOf(note)).toContain("项目「记账本」立项了（筹备中）");
    // 秘书收到通知（立项问答不归它）
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(textOf(messagesOf(frontend, SECRETARY).find((m) => m.agentInput)!)).toContain("项目 p-1「记账本」已诞生（筹备中）");
    expect(daemon.agents.live().map((a) => a.agentId)).toEqual(["secretary"]);

    // 项目档案：数据目录项目区里的最小文档集，工作目录默认在项目档案里
    const root = path.join(dataDir, "projects", "p-1");
    expect(fs.readdirSync(root).toSorted()).toEqual(["adr", "charter.md", "glossary.md", "manifest.md", "progress.md", "scope-records.md", "spec.md", "workdir"]);
    // 258 号票起规格、进展、决策记录照项目规范的模板（开头写清这份写什么、什么时候更新），辅助的几份照旧带项目的一句话目标
    expect(fs.readFileSync(path.join(root, "spec.md"), "utf8")).toContain("# 规格\n\n> **这份写什么**");
    expect(fs.readFileSync(path.join(root, "glossary.md"), "utf8")).toContain("# 术语表\n\n项目「记账本」（p-1）：把家里的账管起来");
    expect(fs.readdirSync(path.join(root, "adr"))).toEqual(["README.md"]);

    // 同名的项目不能再立
    const twin = daemon.cards.create({ type: "suggest_project", payload: { name: "记账本", goal: "另一个" } });
    expect(await frontend.cardAction({ cardId: twin.id, action: "kickoff", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "conflict" } });

    // 另一张建议卡被关掉：回避信号
    await frontend.sendText("家电的保修单老找不到");
    const second = await cardWhere(frontend, (c) => c.type === "suggest_project" && c.id !== card.id && c.id !== twin.id, "第二张建议立项卡");
    ok(await frontend.cardAction({ cardId: second.id, action: "dismiss", expectedVersion: 1 }));
    await waitUntil(() => daemon.materials.list({ kind: "avoidance_signal" }).length > 0);
    expect(daemon.materials.list({ kind: "avoidance_signal" })).toEqual([
      expect.objectContaining({ source: "self", ref: expect.objectContaining({ cardId: second.id }), segments: [expect.objectContaining({ label: "建议立项：家电档案（记下家电的保修）" })] }),
    ]);
  }, 60_000);

  it("点“新建项目”：不经“是不是项目”的判断，秘书收到通知直接收口出建议立项卡；同一个幂等键重发不多发", async () => {
    const { url } = await startTestDaemon({ secretary: [suggest("家电档案", "记下家电的保修和说明书"), say("给你一张建议立项卡")] });
    const frontend = await connect(url);
    const first = ok(await frontend.request(METHODS.newProject, { request: "做一个家电档案" }, "k-new")) as { messageId: string };
    expect(ok(await frontend.request(METHODS.newProject, { request: "做一个家电档案" }, "k-new"))).toEqual(first);
    const card = await cardWhere(frontend, ofType("suggest_project"), "建议立项卡");
    expect(card.payload).toEqual({ name: "家电档案", goal: "记下家电的保修和说明书" });
    const notices = messagesOf(frontend, SECRETARY).filter((m) => m.agentInput);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.id).toBe(first.messageId);
    expect(textOf(notices[0]!)).toBe("用户点「新建项目」要立项：做一个家电档案\n不用判断这是不是项目：直接用 suggest_project 出一张建议立项卡（名字、一句话目标），用户点“立项”后项目就诞生，维护者接着和用户做立项问答。");
  }, 60_000);
});

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程；外部工作目录是数据目录之外的一个临时目录 */
function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
  return {
    dataDir,
    homeDir: makeTempDir("ergo-home-"),
    records,
    external: path.join(fs.realpathSync.native(makeTempDir("ergo-repo-")), "ledger"),
    outside: fs.realpathSync.native(makeTempDir("ergo-elsewhere-")),
  };
}

const devCharter = (external: string) => ({
  goal: "把家里的账管起来：导入银行流水，按月出报表",
  scope: ["导入两家银行的流水", "不做投资记账"],
  firstVersion: "能导入招行的 CSV，出一张月度报表",
  kind: "dev",
  bindExternal: true,
  externalPath: external,
});
const otherCharter = { goal: "记下家电的保修和说明书", scope: ["保修期", "说明书"], firstVersion: "列出家里所有家电和保修期", kind: "other", bindExternal: false };

type Dirs = ReturnType<typeof dirs>;

/** 一个已有路径的 8.3 短名（Windows 的 cmd 给出；卷上关了短名时就是原样） */
function shortNameOf(p: string): string {
  return spawnSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${p}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
}

/**
 * 立项问答一路到立项书卡：立项（p-1，维护者 pm-1）→ 用户在维护者会话里说话唤起它 → 它往项目档案里写 ADR、补规格、
 * 想往外面写（被拒）→ 交出立项书。later 是维护者之后几次被唤起的剧本
 */
async function untilCharter(charter: (d: Dirs) => Record<string, unknown>, later: (spawn: number, d: Dirs) => FauxStep[] = () => [], d = dirs()) {
  const test = await startTestDaemon({
    reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
    secretary: [say("好的"), say("好的")],
    maintainer: (_id, spawn) =>
      spawn === 1
        ? [
            calls(
              ["write", { path: path.join(d.records, "adr", "0001-csv-first.md"), content: "# 先只导 CSV\n\n银行的接口不稳定，首版只导 CSV。\n" }],
              ["edit", { path: path.join(d.records, "spec.md"), edits: [{ oldText: "这个项目要做成什么样：立项问答时由维护者写。", newText: "导入银行流水，按月出报表。" }] }],
              ["write", { path: path.join(d.outside, "notes.md"), content: "写到外面去" }],
            ),
            call("submit_charter", charter(d)),
            say("立项书交上去了，等你确认"),
          ]
        : later(spawn, d),
  });
  const frontend = await connect(test.url);
  await kickoff(test, frontend);
  await frontend.sendText("开始立项问答吧", { conversation: PM1 });
  const card = await cardWhere(frontend, ofType("charter"), "立项书卡");
  await turns(frontend, PM1, 1);
  return { ...test, ...d, frontend, card };
}

describe("立项问答", () => {
  it("用户在维护者会话里说话唤起休眠的维护者：它把 ADR、规格写进项目档案，写到外面被拒；交出的立项书生成立项书卡放进待我处理，开发类提议的工具包默认带 bash", async () => {
    const { frontend, card, daemon, records, outside, external } = await untilCharter((d) => devCharter(d.external));
    // 写进项目档案：新的 ADR、补了规格
    expect(fs.readFileSync(path.join(records, "adr", "0001-csv-first.md"), "utf8")).toContain("首版只导 CSV");
    expect(fs.readFileSync(path.join(records, "spec.md"), "utf8")).toContain("导入银行流水，按月出报表。");
    // 写到项目档案和工作目录之外：守卫直接拒绝（不问用户）
    expect(fs.existsSync(path.join(outside, "notes.md"))).toBe(false);
    // 工具调用记录在每次调用结束时追加（同一步里的几次调用谁先结束不一定）
    const toolCalls = messagesOf(frontend, PM1).flatMap((m) => m.message.parts.filter((p) => p.type === "tool_call"));
    expect(toolCalls.map((p) => `${p.tool} ${p.outcome} ${p.blockedBy ?? ""}`.trim()).toSorted()).toEqual(["edit done", "submit_charter done", "write blocked hard_refusal", "write done"]);

    // 立项书卡：由结构化数据生成；开发类、没写工具包时提议的工具包带 bash
    const payload = card.payload as CharterCardPayload;
    expect(payload).toEqual({ projectId: "p-1", projectName: "记账本", revision: 1, charter: devCharter(external), toolkit: { skills: [], mcp: [], bash: true, network: false } });
    expect(card).toMatchObject({ status: "pending", urgency: "non_blocking" });
    expect(card.text).toBe(`立项书：记账本（第 1 版，开发类，工作目录绑定 ${external}，工具包带 bash）`);
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "待我处理里的立项书卡");
    expect(item).toMatchObject({ title: "立项书等你确认：记账本", source: "项目「记账本」", urgency: "non_blocking" });
    // 立项书卡也出现在维护者的会话里；项目记下最新的立项书卡，还在筹备中，类型还没生效
    expect(messagesOf(frontend, PM1).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))).toBe(true);
    expect(await projectWhere(frontend, (e) => e.change === "charter_submitted")).toMatchObject({ by: "maintainer", project: { state: "preparing", charterCardId: card.id, charterConfirmed: false } });
    expect(daemon.projects.get("p-1")?.kind).toBeUndefined();

    // 维护者会话里的消息都带着所属的项目；用户在里面说的话记成"用户发言"素材
    expect(messagesOf(frontend, PM1).every((m) => m.projectId === "p-1" && m.taskId === undefined)).toBe(true);
    await waitUntil(() => daemon.materials.list({ kind: "user_utterance" }).length > 0);
    expect(daemon.materials.list({ kind: "user_utterance" })).toEqual([expect.objectContaining({ conversation: PM1, project: "p-1", segments: [expect.objectContaining({ text: "开始立项问答吧" })] })]);
  }, 60_000);

  it("立项书不合格（其他类的项目要绑定外部路径、外部路径不是绝对路径）：原因交回维护者，不出卡；维护者的系统提示写着它是哪个项目的维护者", async () => {
    const d = dirs();
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: [call("submit_charter", { ...otherCharter, bindExternal: true, externalPath: d.external }), call("submit_charter", devCharter("ledger")), { kind: "echo_context" }],
    });
    const frontend = await connect(test.url);
    await kickoff(test, frontend);
    await frontend.sendText("交立项书吧", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    const seen = textOf(messagesOf(frontend, PM1).at(-1)!);
    expect(seen).toContain("[toolResult] submit_charter: 只有开发类项目能把工作目录绑定到外部路径");
    expect(seen).toContain("[toolResult] submit_charter: 外部工作目录要写绝对路径（比如 D:\\code\\ledger），不是「ledger」");
    expect(seen).toContain("[system] 你是「二狗」里项目「记账本」（p-1）的维护者");
    expect(cardsOf(frontend).filter(ofType("charter"))).toEqual([]);
  }, 60_000);

  it("外部工作目录按真实路径核对，两个方向都拒：数据目录本身、它的 8.3 短名、它里面、它的上级目录；程序目录里面、程序目录的上级目录（围栏不能盖住它们）", async () => {
    const d = dirs();
    const realData = fs.realpathSync.native(d.dataDir);
    const programDir = path.join(fs.realpathSync.native(makeTempDir("ergo-app-")), "app");
    fs.mkdirSync(programDir);
    const refused = [
      ["数据目录", realData],
      ["数据目录", shortNameOf(realData)],
      ["数据目录", path.join(realData, "projects", "p-1", "workdir")],
      ["数据目录", path.dirname(realData)],
      ["程序目录", path.join(programDir, "packages")],
      ["程序目录", path.dirname(programDir)],
    ] as const;
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      programDir,
      secretary: [say("好的")],
      maintainer: [...refused.map(([, p]) => call("submit_charter", devCharter(p))), { kind: "echo_context" }],
    });
    const frontend = await connect(test.url);
    await kickoff(test, frontend);
    await frontend.sendText("交立项书吧", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    const results = textOf(messagesOf(frontend, PM1).at(-1)!)
      .split("\n")
      .filter((l) => l.startsWith("[toolResult] submit_charter: "));
    expect(results).toEqual(refused.map(([what, p]) => `[toolResult] submit_charter: 外部工作目录不能在二狗的${what}里，也不能包含它：${p}`));
    expect(cardsOf(frontend).filter(ofType("charter"))).toEqual([]);
  }, 60_000);
});

/**
 * 造一条"任务完成"的事件（任务的执行和完成在 13 号票，这里直接造出来）；stages：做完时各阶段的样子（"首版做完了"卡上
 * 每个阶段一行验收结果，112 号票），不给就没有
 */
function finishTask(test: TestDaemon, taskId: string, state: "done" | "failed" | "cancelled" = "done", stages?: NonNullable<Task["stages"]>) {
  const task = test.daemon.tasks.get(taskId)!;
  const payload: TaskEventPayload = {
    task: { ...task, state, updatedAt: nowIso(), ...(stages ? { stages } : {}) },
    change: "finished" as TaskEventPayload["change"],
    from: task.state,
    by: "maintainer",
  };
  test.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload });
  // 做完了：执行控制器的"任务完成后"回调交给项目模块（真实的执行路径见 task-execution.test.ts 的"项目的首个建设任务"）
  if (state === "done") test.daemon.projects.taskCompleted(payload.task);
}

const lastText = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).at(-1)!);

/** 起草建设任务计划的工单段（16 号票）：写回进展、写这一段的摘要（第几次唤起写进进展，每段都改了它）；建设任务做完时这一段马上结束 */
const draftingMaintainer = (_id: string, spawn: number): FauxStep[] => [
  call("write_progress", { content: `第 ${spawn} 轮建设：在起草计划。` }),
  call("write_segment_summary", { summary: `开始起草第 ${spawn} 轮建设的计划` }),
  say("收到建设任务"),
];

/** 等建设任务做完出的"首版做完了"卡（112 号票） */
const buildDoneCard = (frontend: TestFrontend, buildTaskId: string) =>
  cardWhere(frontend, (c) => c.type === "build_done" && (c.payload as BuildDoneCardPayload).buildTaskId === buildTaskId, `${buildTaskId} 做完出的"首版做完了"卡`);

const ok1 = (at: string) => ({ passed: true, at });

/**
 * 建设任务做完时的样子（112 号票：卡上每个阶段一行验收结果、最后的总结、交付件）：确认过的计划（两个阶段，交付件）
 * 记成一版计划，阶段都验收了（s1 脚本 + 评审，s2 评审），最后验收的 s2 宣布完成时写了"月度报表在 report.md"
 */
function builtStages(test: TestDaemon, taskId: string): NonNullable<Task["stages"]> {
  const plan = twoStagePlan();
  const revised: PlanRevisedPayload = { taskId, planId: `${taskId}-p1`, revision: 1, basePlanId: `${taskId}-p0`, plan, changes: [], why: "测试里直接记一版", grantTimes: {}, maintainerId: "pm-1", time: nowIso() };
  test.daemon.store.append({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload: revised });
  return {
    total: 2,
    current: 2,
    list: [
      {
        stageId: "s1",
        title: "收集资料",
        state: "accepted",
        dependsOn: [],
        acceptance: [
          { criterion: "资料清单存在", method: "script", result: ok1("2026-10-13T09:00:00+08:00") },
          { criterion: "来源都是公开的", method: "review", result: ok1("2026-10-13T09:00:00+08:00") },
        ],
        attempts: 1,
        summary: "清单在 sources.md",
        code: "1",
      },
      { stageId: "s2", title: "写报告", state: "accepted", dependsOn: ["s1"], acceptance: [{ criterion: "报告写清楚了", method: "review", result: ok1("2026-10-13T10:00:00+08:00") }], attempts: 2, summary: "月度报表在 report.md", code: "2" },
    ],
  };
}

describe("立项书卡", () => {
  it("确认并开工：项目转建设中，建出属于本项目的首个建设任务（规划中，看板上），提议的工具包成为项目的工具包，类型和外部工作目录立即生效；维护者按新的装配重新拉起，围栏覆盖外部路径；备份不包含外部路径", async () => {
    const t = await untilCharter(
      (d) => devCharter(d.external),
      (spawn, d) =>
        spawn === 2
          ? // 立项问答的对话段收尾（首个建设任务的工单在等）：在工作目录里写 README，写回进展、写摘要，看一眼新的装配
            [
              call("write", { path: path.join(d.external, "README.md"), content: "# 记账本\n" }),
              call("edit", { path: path.join(d.records, "progress.md"), edits: [{ oldText: PROGRESS_INTRO, newText: "立项书确认了，开工：先起草首个建设任务的计划。" }] }),
              call("write_segment_summary", { summary: "立项问答：首版只导招行 CSV、出月度报表；工作目录绑定外部路径" }),
              { kind: "echo_context" },
            ]
          : [say("收到首个建设任务，先读立项书")],
    );
    const { frontend, card, external, records } = t;
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm_start", expectedVersion: 1 }));
    const started = await projectWhere(frontend, (e) => e.change === "building_started");
    expect(started).toMatchObject({
      from: "preparing",
      by: "user",
      project: { state: "building", kind: "dev", workdir: { external: true, path: external }, toolkit: { skills: [], mcp: [], bash: true, network: false }, charterConfirmed: true, buildTaskId: "t-1" },
    });
    const built = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "首个建设任务");
    expect(built).toMatchObject({ by: "user", task: { id: "t-1", title: "建设「记账本」首版", state: "planning", origin: "project_build", projects: ["记账本"], projectIds: ["p-1"], maintainerId: "pm-1" } });
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled")).toMatchObject({
      outcome: { action: "confirm_start", note: "首个建设任务 t-1「建设「记账本」首版」" },
      payload: { confirmed: { start: true, buildTaskId: "t-1" } },
    });
    // 立项书和绑定关系写进项目档案（外部路径不随二狗备份），外部路径建好了
    await waitUntil(() => fs.readFileSync(path.join(records, "charter.md"), "utf8").includes("确认并开工"));
    expect(fs.readFileSync(path.join(records, "charter.md"), "utf8")).toContain(`绑定外部路径：${external}`);
    expect(JSON.parse(fs.readFileSync(path.join(records, "binding.json"), "utf8"))).toMatchObject({ external: true, path: external });
    expect(fs.statSync(external).isDirectory()).toBe(true);
    // 立项书卡上的确认是"用户对产出的反应"素材
    await waitUntil(() => t.daemon.materials.list({ kind: "output_reaction" }).length > 0);
    expect(t.daemon.materials.list({ kind: "output_reaction" })).toEqual([
      expect.objectContaining({
        source: "self",
        project: "p-1",
        context: ["card:charter", "decision:confirm_start", "kind:dev", "workdir:external"],
        ref: expect.objectContaining({ cardId: card.id }),
        segments: [expect.objectContaining({ form: "choice", notes: ["agent_proposed"], text: `确认并开工：项目「记账本」的立项书（第 1 版，开发类，工作目录绑定 ${external}，工具包带 bash）` })],
      }),
    ]);

    // 首个建设任务派成起草计划的工单（16 号票）：立项问答的对话段先收尾——运行时催维护者写回项目档案、写这一段的摘要；
    // 维护者按新的装配重新拉起：文件工具的围栏覆盖外部路径，工具包带 bash，系统提示里是新的工作目录
    await turns(frontend, PM1, 2);
    expect(fs.readFileSync(path.join(external, "README.md"), "utf8")).toBe("# 记账本\n");
    const seen = textOf(messagesOf(frontend, PM1).findLast((m) => m.message.speaker === "agent" && textOf(m).includes("[tool] "))!);
    expect(seen).toContain(`工作目录是 ${external}（绑定的外部路径）`);
    expect(seen).toContain("立项书已确认：开发类项目，工具包带 bash、不能联网。");
    expect(seen.split("\n").filter((l) => l.startsWith("[tool]"))).toEqual(
      expect.arrayContaining(["[tool] bash", "[tool] edit", "[tool] ls", "[tool] read", "[tool] submit_charter", "[tool] write", "[tool] write_segment_summary", "[tool] git_status_diff"]),
    );
    // 写回之后对话段结束，起草首个建设任务计划的工单开始
    await waitUntil(() => workOrdersOf(frontend).some((e) => e.change === "started" && workOrderTaskId(e.workOrder) === "t-1" && e.workOrder.kind === "plan"));

    // 备份：项目档案在快照里，外部工作目录不在
    const backup = await t.daemon.backup.backupNow();
    const rels = snapshotRels(path.join(t.dataDir, "backups"), backup.date);
    expect(rels).toEqual(expect.arrayContaining(["projects/p-1/charter.md", "projects/p-1/adr/0001-csv-first.md", "projects/p-1/binding.json"]));
    // 外部工作目录里的 README.md 不在；档案里的两份说明在（258 号票：开发类的规范文档多了 tickets/）
    expect(rels.filter((r) => r.endsWith("README.md")).toSorted()).toEqual(["projects/p-1/adr/README.md", "projects/p-1/tickets/README.md"]);
  }, 90_000);

  it("只确认，稍后开工：项目留在筹备中、标“立项书已确认”，类型立即生效，不建任务；同一张卡不能再确认", async () => {
    const { frontend, card, records } = await untilCharter(() => otherCharter);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm_later", expectedVersion: 1 }));
    const confirmed = await projectWhere(frontend, (e) => e.change === "charter_confirmed");
    expect(confirmed).toMatchObject({ from: "preparing", by: "user", project: { state: "preparing", charterConfirmed: true, kind: "other", workdir: { external: false }, toolkit: { bash: false } } });
    expect(confirmed.project.buildTaskId).toBeUndefined();
    const handled = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");
    expect(handled).toMatchObject({ outcome: { action: "confirm_later", note: "稍后开工" }, payload: { confirmed: { start: false } } });
    expect(await frontend.cardAction({ cardId: card.id, action: "confirm_start", expectedVersion: handled.version })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tasksOf(frontend)).toEqual([]);
    await waitUntil(() => fs.readFileSync(path.join(records, "charter.md"), "utf8").includes("只确认，稍后开工"));
    expect(fs.readFileSync(path.join(records, "charter.md"), "utf8")).toContain("项目档案里的 workdir/");
    // 维护者会话里有一条说明（不交给维护者处理）
    expect(lastText(frontend, PM1)).toBe("立项书已确认（只确认，稍后开工）：其他项目，工作目录是项目档案里的 workdir，工具包不带 bash。");
  }, 60_000);

  // 311 号票（294 号票端到端小测第 3 条）：项目在新建时就定了外部工作文件夹（305 号票选的、290 号票接管来的），立项问答时维护者不知道，
  // 还问"绑不绑外部仓库"、交 bindExternal: false，立项书卡写"项目档案里（默认）"，档案里写成没绑定、还多建一个空的 workdir/
  it("新建时就定了工作文件夹的项目：维护者立项问答时知道文件夹已经定了；交的立项书照它写成已绑定（其他类也一样，交的路径不算），档案里写成已绑定，不多建空的 workdir/", async () => {
    const d = dirs();
    fs.mkdirSync(d.external, { recursive: true });
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      maintainer: [call("submit_charter", otherCharter), call("submit_charter", devCharter(path.join(d.outside, "ledger"))), { kind: "echo_context" }],
    });
    seedProject(test.daemon, "记账本", { workdir: { external: true, path: d.external } });
    const frontend = await connect(test.url);
    await frontend.sendText("交立项书吧", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    // 系统提示：工作目录已经定了，不再问绑不绑外部路径
    const seen = textOf(messagesOf(frontend, PM1).at(-1)!);
    expect(seen).toContain(`工作目录是 ${d.external}（绑定的外部路径）`);
    expect(seen).toContain("工作目录在立项之前就定了");
    expect(seen).not.toContain("要不要把工作目录绑定到一个外部路径");
    // 交的两版都照已定的写成已绑定：其他类的也是（文件夹是新建时定的，不是维护者提议绑定）；交的另一条路径不算。工具结果里写明
    const charters = cardsOf(frontend).filter((c) => c.type === "charter" && c.status === "pending");
    expect(charters.map((c) => (c.payload as CharterCardPayload).charter)).toEqual([
      { ...otherCharter, bindExternal: true, externalPath: d.external },
      devCharter(d.external),
    ]);
    expect(charters.at(-1)!.text).toBe(`立项书：记账本（第 2 版，开发类，工作目录绑定 ${d.external}，工具包带 bash）`);
    expect(seen.split("\n").filter((l) => l.startsWith("[toolResult] submit_charter: ")).every((l) => l.includes(`工作目录在立项之前就定了，立项书里照它写成绑定 ${d.external}`))).toBe(true);

    // 确认：档案里的立项书、绑定关系写成已绑定那个文件夹，项目档案里没有空的 workdir/
    const latest = await cardWhere(frontend, (c) => c.type === "charter" && (c.payload as CharterCardPayload).revision === 2 && c.status === "pending");
    ok(await frontend.cardAction({ cardId: latest.id, action: "confirm_later", expectedVersion: latest.version }));
    await waitUntil(() => fs.existsSync(path.join(d.records, "binding.json")) && fs.readFileSync(path.join(d.records, "charter.md"), "utf8").includes("只确认，稍后开工"));
    expect(fs.readFileSync(path.join(d.records, "charter.md"), "utf8")).toContain(`绑定外部路径：${d.external}`);
    expect(JSON.parse(fs.readFileSync(path.join(d.records, "binding.json"), "utf8"))).toMatchObject({ external: true, path: d.external });
    expect(fs.existsSync(path.join(d.records, "workdir"))).toBe(false);
    expect(test.daemon.projects.get("p-1")).toMatchObject({ kind: "dev", charterConfirmed: true, workdir: { external: true, path: d.external } });
    expect(lastText(frontend, PM1)).toBe(`立项书已确认（只确认，稍后开工）：开发类项目，工作目录是外部路径 ${d.external}，工具包带 bash。`);
  }, 60_000);

  it("维护者重新交立项书：上一张没确认的立项书卡过期，确认的总是最新的一版", async () => {
    const d = dirs();
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: [call("submit_charter", otherCharter), say("交了"), call("submit_charter", { ...otherCharter, firstVersion: "列出家电，提醒保修到期" }), say("改好再交了")],
    });
    const frontend = await connect(test.url);
    await kickoff(test, frontend, "家电档案");
    await frontend.sendText("交立项书吧", { conversation: PM1 });
    const first = await cardWhere(frontend, ofType("charter"), "第一张立项书卡");
    await turns(frontend, PM1, 1);
    await frontend.sendText("首版再加个保修到期提醒", { conversation: PM1 });
    const second = await cardWhere(frontend, (c) => c.type === "charter" && c.id !== first.id, "第二张立项书卡");
    expect(second.payload).toMatchObject({ revision: 2, charter: { firstVersion: "列出家电，提醒保修到期" } });
    expect(await cardWhere(frontend, (c) => c.id === first.id && c.status === "expired")).toMatchObject({ status: "expired" });
    expect(await frontend.cardAction({ cardId: first.id, action: "confirm_start", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    ok(await frontend.cardAction({ cardId: second.id, action: "confirm_start", expectedVersion: 1 }));
    expect(await projectWhere(frontend, (e) => e.change === "building_started")).toMatchObject({ project: { charterCardId: second.id, state: "building" } });
  }, 60_000);
});

describe("项目状态", () => {
  it("首个建设任务做完时出“首版做完了”卡（进待办，来源是项目；写明做成了什么），项目停在建设中，点“转入使用”才进入使用中；别的任务（包括之后的）完成不改项目状态；使用中 ⇄ 已停用，已停用的维护者照常对话；非法迁移被拒", async () => {
    const d = dirs();
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的"), say("好的"), say("好的")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? // 起草首个建设任务计划的工单（16 号票）：这一段只读，进展用 write_progress 写回，再写这一段的摘要
            [
              call("write_progress", { content: "首个建设任务：在起草计划。" }),
              call("write_segment_summary", { summary: "开始起草首个建设任务的计划" }),
              say("收到首个建设任务"),
            ]
          : [say("在的，项目停用了也照常聊")],
    });
    const frontend = await connect(test.url);
    const project = await kickoff(test, frontend);
    // 立项书直接从守护进程交、在卡上确认并开工（立项问答见上面）
    const { cardId } = test.daemon.projects.submitCharter(project.id, project.maintainerId, { charter: otherCharter as never });
    ok(await frontend.cardAction({ cardId, action: "confirm_start", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "building_started");
    // 维护者接了起草首个建设任务计划的工单（16 号票），写回了进展和摘要
    await turns(frontend, PM1, 1);
    // 另一个涉及这个项目的任务（64 号票起是这个项目的内部任务）完成了：项目状态不变
    internalTask(test.daemon, "记账本", "给记账本加个导出");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2", "另一个任务");
    finishTask(test, "t-2");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2" && e.task.state === "done", "另一个任务完成");
    expect(test.daemon.projects.get("p-1")?.state).toBe("building");
    // 建设中还不能停用、归档、删除；首个建设任务没结束不能再开工
    for (const action of ["retire", "archive", "delete", "start_build", "reactivate", "unarchive"]) {
      expect(await act(frontend, "p-1", action)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    }
    expect(await act(frontend, "p-1", "retire")).toMatchObject({ error: { message: "建设中的项目不能停用（只有使用中的能）" } });

    // 首个建设任务做完：不再自动进入使用中，出"首版做完了"卡（112 号票）
    finishTask(test, "t-1", "done", builtStages(test, "t-1"));
    const done = await buildDoneCard(frontend, "t-1");
    const records = path.join(fs.realpathSync.native(d.dataDir), "projects", "p-1");
    expect(done).toMatchObject({
      status: "pending",
      payload: {
        projectId: "p-1",
        projectName: "记账本",
        buildTaskId: "t-1",
        buildTaskTitle: "建设「记账本」首版",
        round: 1,
        summary: "月度报表在 report.md",
        stages: [
          { code: "1", title: "收集资料", result: "验收通过：脚本检查 1 条、评审判定 1 条", deliverables: ["资料清单 sources.md"] },
          { code: "2", title: "写报告", result: "验收通过：评审判定 1 条", deliverables: ["调研报告 report.md"] },
        ],
        workdir: path.join(records, "workdir"),
      } satisfies BuildDoneCardPayload,
    });
    // 纯文本降级（秘书列待我处理时看到的就是它）：先写做成了什么
    expect(done.text).toBe(
      `项目「记账本」首版做完了（建设任务 t-1「建设「记账本」首版」）：月度报表在 report.md；第 1 阶段「收集资料」验收通过：脚本检查 1 条、评审判定 1 条；第 2 阶段「写报告」验收通过：评审判定 1 条；检查清单 1 项都做到了；交付件在 ${path.join(records, "workdir")}。等你选：转入使用、继续建设、放弃并归档`,
    );
    // 进待办（来源是项目，"去项目 ›"能跳；不卡任务，秘书看得到）；维护者的会话里也有这张卡
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === done.id, "待办里的“首版做完了”卡");
    expect(item).toMatchObject({ title: "项目「记账本」首版做完了", source: "项目「记账本」", origin: { projectId: "p-1" }, urgency: "non_blocking" });
    expect(item.internal).toBeUndefined();
    await eventually(() => messagesOf(frontend, PM1), (m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === done.id), "维护者会话里的卡");
    // 不选就停在建设中
    expect(test.daemon.projects.get("p-1")?.state).toBe("building");
    expect(projectEventsOf(frontend).filter((e) => e.change === "in_use")).toEqual([]);
    // 同一个任务再报一次做完（重启时补的也是这条路）：不重复出卡
    test.daemon.projects.taskCompleted(test.daemon.tasks.get("t-1")!);
    expect(cardsOf(frontend).filter((c) => c.type === "build_done" && c.version === 1)).toHaveLength(1);

    // 转入使用：项目进入使用中（用户改的），卡记成已处理
    ok(await frontend.cardAction({ cardId: done.id, action: "put_in_use", expectedVersion: 1 }));
    const inUse = await projectWhere(frontend, (e) => e.change === "in_use");
    expect(inUse).toMatchObject({ from: "building", by: "user", project: { state: "in_use", buildTaskId: "t-1" } });
    expect(await cardWhere(frontend, (c) => c.id === done.id && c.status === "handled")).toMatchObject({ outcome: { action: "put_in_use" }, payload: { decided: { choice: "put_in_use" } } });
    expect(await frontend.cardAction({ cardId: done.id, action: "abandon", expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 之后的任务完成不再推动项目状态
    internalTask(test.daemon, "记账本", "记账本再加个预算");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-3", "之后的任务");
    finishTask(test, "t-3");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-3" && e.task.state === "done", "之后的任务完成");
    expect(projectEventsOf(frontend).filter((e) => e.change === "in_use")).toHaveLength(1);
    // 使用中不能放弃（只能归档），也不能取消归档、重新启用
    expect(await act(frontend, "p-1", "abandon")).toMatchObject({ ok: false, error: { code: "not_allowed", message: "使用中的项目不能放弃（归档）（只有筹备中、建设中的能）" } });

    expect(ok(await act(frontend, "p-1", "retire", "k-retire"))).toEqual({ projectId: "p-1", state: "retired" });
    // 同一个幂等键重发不再做一次
    expect(ok(await act(frontend, "p-1", "retire", "k-retire"))).toEqual({ projectId: "p-1", state: "retired" });
    expect(await projectWhere(frontend, (e) => e.change === "retired")).toMatchObject({ from: "in_use", by: "user", project: { state: "retired" } });
    expect(projectEventsOf(frontend).filter((e) => e.change === "retired")).toHaveLength(1);
    // 已停用的项目，维护者照常对话（首个建设任务那张工单的一段之后，开一个对话段）
    await frontend.sendText("停用了还在吗", { conversation: PM1 });
    await turns(frontend, PM1, 2);
    expect(lastText(frontend, PM1)).toBe("在的，项目停用了也照常聊");

    expect(ok(await act(frontend, "p-1", "reactivate"))).toEqual({ projectId: "p-1", state: "in_use" });
    expect(await projectWhere(frontend, (e) => e.change === "reactivated")).toMatchObject({ from: "retired", project: { state: "in_use" } });
    // 使用中 → （用户手动）归档 → 取消归档回到使用中
    ok(await act(frontend, "p-1", "archive"));
    expect(await projectWhere(frontend, (e) => e.change === "archived")).toMatchObject({ from: "in_use", project: { state: "archived", archivedFrom: "in_use" } });
    ok(await act(frontend, "p-1", "unarchive"));
    const back = await projectWhere(frontend, (e) => e.change === "unarchived");
    expect(back).toMatchObject({ from: "archived", project: { state: "in_use" } });
    expect(back.project.archivedFrom).toBeUndefined();
  }, 60_000);

  it("首个建设任务失败：项目留在建设中，可以再开工一次（新的建设任务接替它），它做完时出“首版做完了”卡，转入使用后进入使用中", async () => {
    const test = await startTestDaemon({ secretary: [say("好的"), say("好的")] });
    const frontend = await connect(test.url);
    const project = await kickoff(test, frontend);
    const { cardId } = test.daemon.projects.submitCharter(project.id, project.maintainerId, { charter: otherCharter as never });
    ok(await frontend.cardAction({ cardId, action: "confirm_start", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "building_started");
    finishTask(test, "t-1", "failed");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.state === "failed", "首个建设任务失败");
    expect(test.daemon.projects.get("p-1")?.state).toBe("building");
    expect(ok(await act(frontend, "p-1", "start_build"))).toEqual({ projectId: "p-1", state: "building" });
    expect(await projectWhere(frontend, (e) => e.change === "building_started" && e.project.buildTaskId === "t-2")).toMatchObject({ from: "building" });
    finishTask(test, "t-2");
    const done = await buildDoneCard(frontend, "t-2");
    expect(done.payload).toMatchObject({ buildTaskId: "t-2", round: 1, stages: [] });
    ok(await frontend.cardAction({ cardId: done.id, action: "put_in_use", expectedVersion: 1 }));
    expect(await projectWhere(frontend, (e) => e.change === "in_use")).toMatchObject({ by: "user", project: { buildTaskId: "t-2" } });
  }, 60_000);

  it("“首版做完了”卡上继续建设：要写一句这一轮要做什么；项目留在建设中，建出下一轮建设任务（项目内部的长程任务）、派起草计划的工单给维护者；它做完再出一张（第 2 轮），放弃并归档", async () => {
    const test = await startTestDaemon({ secretary: [say("好的"), say("好的")], maintainer: draftingMaintainer });
    const frontend = await connect(test.url);
    const project = await kickoff(test, frontend);
    const { cardId } = test.daemon.projects.submitCharter(project.id, project.maintainerId, { charter: otherCharter as never });
    ok(await frontend.cardAction({ cardId, action: "confirm_start", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "building_started");
    await turns(frontend, PM1, 1);
    finishTask(test, "t-1");
    const first = await buildDoneCard(frontend, "t-1");
    // 继续建设要写一句话
    expect(await frontend.cardAction({ cardId: first.id, action: "keep_building", expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "bad_params", message: "继续建设要写一句这一轮要做什么：维护者照它起草下一轮建设任务的计划" },
    });
    ok(await frontend.cardAction({ cardId: first.id, action: "keep_building", note: "再加上按月导出 Excel", expectedVersion: 1 }));
    const continued = await projectWhere(frontend, (e) => e.change === "build_continued");
    expect(continued).toMatchObject({ from: "building", by: "user", project: { state: "building", buildTaskId: "t-2" } });
    const next = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-2" && e.change === "created", "下一轮建设任务");
    expect(next.task).toMatchObject({ title: "建设「记账本」第 2 轮", summary: "再加上按月导出 Excel", kind: "long_running", origin: "project_build", state: "planning", maintainerId: "pm-1", internal: { projectId: "p-1" } });
    // 起草计划的工单派给项目的维护者：任务书里写着用户这句话
    const order = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && workOrderTaskId(e.workOrder) === "t-2", "起草计划的工单");
    expect(order.workOrder).toMatchObject({ kind: "plan" });
    expect(order.workOrder.instructions).toContain("再加上按月导出 Excel");
    expect(await cardWhere(frontend, (c) => c.id === first.id && c.status === "handled")).toMatchObject({
      outcome: { action: "keep_building" },
      payload: { decided: { choice: "keep_building", request: "再加上按月导出 Excel", nextTaskId: "t-2" } },
    });
    expect(test.daemon.projects.get("p-1")?.state).toBe("building");

    // 下一轮做完：再出一张（第 2 轮），放弃并归档（照项目页上的放弃）
    await turns(frontend, PM1, 2);
    finishTask(test, "t-2");
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === "t-2", "下一轮起草计划的工单结束");
    const second = await buildDoneCard(frontend, "t-2");
    expect(second.payload).toMatchObject({ round: 2 });
    expect(second.text.startsWith("项目「记账本」第 2 轮建设做完了")).toBe(true);
    ok(await frontend.cardAction({ cardId: second.id, action: "abandon", expectedVersion: 1 }));
    expect(await projectWhere(frontend, (e) => e.change === "abandoned")).toMatchObject({ from: "building", by: "user", project: { state: "archived", archivedFrom: "building" } });
    expect(await cardWhere(frontend, (c) => c.id === second.id && c.status === "handled")).toMatchObject({ outcome: { action: "abandon" } });
  }, 60_000);

  it("项目页上放弃（没在“首版做完了”卡上选）：那张卡作废，再点卡上的按钮被拒；取消归档回到建设中（建设任务已经做完）：再出一张，能转入使用；放弃了再删除时卡一起删", async () => {
    const test = await startTestDaemon({ secretary: [say("好的"), say("好的")], maintainer: draftingMaintainer });
    const frontend = await connect(test.url);
    const project = await kickoff(test, frontend);
    const { cardId } = test.daemon.projects.submitCharter(project.id, project.maintainerId, { charter: otherCharter as never });
    ok(await frontend.cardAction({ cardId, action: "confirm_start", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "building_started");
    await turns(frontend, PM1, 1);
    finishTask(test, "t-1");
    const done = await buildDoneCard(frontend, "t-1");
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === "t-1", "起草计划的工单结束");
    ok(await act(frontend, "p-1", "abandon"));
    await projectWhere(frontend, (e) => e.change === "abandoned");
    const expired = await cardWhere(frontend, (c) => c.id === done.id && c.status === "expired", "作废的卡");
    expect(expired.expiredNote).toBe("项目已经放弃（归档）了，这张卡不再生效");
    expect(await frontend.cardAction({ cardId: done.id, action: "put_in_use", expectedVersion: expired.version })).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 取消归档：回到建设中，建设任务已经做完、卡作废了——再出一张（不然永远停在建设中：再开工只认失败、取消了的建设任务）；
    // 同一次取消归档重发不重复出
    const unarchive = await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "unarchive-p-1");
    expect(ok(unarchive)).toMatchObject({ state: "building" });
    const again = await cardWhere(frontend, (c) => c.type === "build_done" && c.id !== done.id, "取消归档后再出的卡");
    expect(again).toMatchObject({ status: "pending", payload: { projectId: "p-1", buildTaskId: "t-1", round: 1 } });
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "unarchive-p-1"));
    expect(cardsOf(frontend).filter((c) => c.type === "build_done" && c.version === 1)).toHaveLength(2);
    await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === again.id, "待办里的新卡");
    // 重启时补卡也不重复（这个建设任务出过卡了）
    test.daemon.projects.taskCompleted(test.daemon.tasks.get("t-1")!);
    expect(cardsOf(frontend).filter((c) => c.type === "build_done" && c.version === 1)).toHaveLength(2);
    // 这次在卡上选放弃并归档；删除项目：两张卡（说的是项目内部的建设任务）和待办里的项一起删掉
    ok(await frontend.cardAction({ cardId: again.id, action: "abandon", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "abandoned" && e.project.state === "archived" && projectEventsOf(frontend).filter((x) => x.change === "abandoned").length === 2);
    const { confirmItemId } = ok(await act(frontend, "p-1", "delete")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [confirmItemId], action: "handle", choice: "确认删除" }));
    await projectWhere(frontend, (e) => e.change === "deleted");
    expect(test.daemon.cards.get(done.id)).toBeUndefined();
    expect(test.daemon.cards.get(again.id)).toBeUndefined();
    expect(test.daemon.inbox.list().filter((i) => i.kind === "card" && (i.cardId === done.id || i.cardId === again.id))).toEqual([]);
  }, 60_000);

  it("放弃 → 已归档（维护者会话只读，发话被拒并说明原因）→ 取消归档回到原来的状态 → 开工 → 首个建设任务的工单在做时不能放弃（16 号票）→ 取消首个建设任务后放弃 → 删除要在待我处理里二次确认：删掉项目档案和维护者会话、立项书正文、维护者的审批和效果日志里的原话，用户在里面说过的话在素材库里仍在", async () => {
    const GLOSSARY = "# 术语表\n\n流水：银行导出的交易记录\n";
    const { frontend, card, daemon, records, dataDir, url } = await untilCharter(
      () => otherCharter,
      (spawn, d) =>
        spawn === 2
          ? // 重写术语表，顺手写回进展、写这一段的摘要（16 号票：之后首个建设任务的工单来了，这一段马上就能结束）
            [
              call("write", { path: path.join(d.records, "glossary.md"), content: GLOSSARY }),
              call("edit", { path: path.join(d.records, "progress.md"), edits: [{ oldText: PROGRESS_INTRO, newText: "术语表重写了。" }] }),
              call("write_segment_summary", { summary: "重写了术语表" }),
              say("术语表重写好了"),
            ]
          : // 起草首个建设任务计划的工单段：写回进展、写摘要
            [call("write_progress", { content: "首个建设任务：在起草计划。" }), call("write_segment_summary", { summary: "开始起草首个建设任务的计划" }), say("收到首个建设任务")],
    );
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm_later", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "charter_confirmed");
    // 维护者整体重写术语表：先问用户，批准后执行（留下审批卡、审批记录和效果日志）
    await frontend.sendText("把术语表重写一下", { conversation: PM1 });
    const approval = await cardWhere(frontend, ofType("approval"), "审批卡");
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: 1 }));
    await turns(frontend, PM1, 2);

    expect(ok(await act(frontend, "p-1", "abandon"))).toEqual({ projectId: "p-1", state: "archived" });
    expect(await projectWhere(frontend, (e) => e.change === "abandoned")).toMatchObject({ from: "preparing", project: { state: "archived", archivedFrom: "preparing" } });
    // 已归档：维护者会话只读
    expect(await frontend.request(METHODS.sendMessage, { conversation: PM1, parts: [{ type: "text", text: "还在吗" }] }, "k-ro")).toMatchObject({
      ok: false,
      error: { code: "not_allowed", message: "项目「记账本」已归档：维护者会话只读。要接着和维护者说话，先在项目页上取消归档" },
    });
    // 已归档的项目不能选进新任务
    expect(await frontend.startTask("给记账本加功能", "k-t", ["记账本"])).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    // 取消归档回到筹备中（立项书已确认），可以开工
    ok(await act(frontend, "p-1", "unarchive"));
    expect(await projectWhere(frontend, (e) => e.change === "unarchived")).toMatchObject({ project: { state: "preparing", charterConfirmed: true } });
    ok(await act(frontend, "p-1", "start_build"));
    expect(await projectWhere(frontend, (e) => e.change === "building_started")).toMatchObject({ from: "preparing", project: { state: "building", buildTaskId: "t-1" } });
    // 首个建设任务起草计划的工单在做：不能放弃（归档），说明先完成或取消哪个任务（16 号票）
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "started" && workOrderTaskId(e.workOrder) === "t-1", "起草首个建设任务计划的工单开始");
    expect(await act(frontend, "p-1", "abandon")).toMatchObject({
      ok: false,
      error: { code: "not_allowed", message: "项目还有正在做或排队的工单：先完成或取消任务 t-1「建设「记账本」首版」，再归档" },
    });
    await turns(frontend, PM1, 3);
    ok(await frontend.taskAction({ taskId: "t-1", action: "cancel" }));
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === "t-1", "工单随任务取消退回");
    ok(await act(frontend, "p-1", "abandon"));
    await projectWhere(frontend, (e) => e.change === "abandoned" && e.from === "building");

    // 删除：先在待我处理里放一条二次确认，还没删
    const asked = ok(await act(frontend, "p-1", "delete", "k-del")) as { confirmItemId: string };
    expect(asked).toMatchObject({ projectId: "p-1", state: "archived" });
    const item = await eventually(() => inboxOf(frontend), (i) => i.id === asked.confirmItemId, "删除的二次确认");
    expect(item).toMatchObject({ kind: "notice", notice: "project_delete", title: "删除项目「记账本」？", actions: ["确认删除", "不删了"], data: { projectId: "p-1" }, urgency: "non_blocking" });
    expect(ok(await act(frontend, "p-1", "delete"))).toMatchObject({ confirmItemId: asked.confirmItemId });
    expect(fs.existsSync(records)).toBe(true);
    expect(daemon.projects.get("p-1")?.state).toBe("archived");

    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    expect(await projectWhere(frontend, (e) => e.change === "deleted")).toMatchObject({ from: "archived", by: "user", project: { id: "p-1" } });
    await waitUntil(() => !fs.existsSync(records), { describe: () => "等项目档案删掉" });
    expect(fs.existsSync(path.join(dataDir, "sessions", "pm-1"))).toBe(false);
    // 维护者会话频道上的事件和彻底删除一样改写成"已删除"标记：序号还在，原话一个字不留
    const left = daemon.store.read(PM1);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(JSON.stringify(left)).not.toContain("开始立项问答吧");
    expect(daemon.projects.list()).toEqual([]);
    // 立项书正文（立项书的事件和立项书卡）、维护者的审批和效果日志里的原话、待我处理里属于项目的事项：换成删除标记，状态不变
    const log = JSON.stringify(daemon.store.readGlobal(0, 1_000_000));
    for (const text of [otherCharter.goal, ...otherCharter.scope, otherCharter.firstVersion, "首版只导 CSV", "流水：银行导出的交易记录"]) expect({ text, found: log.includes(text) }).toEqual({ text, found: false });
    // 项目的工单（16 号票）：内容（交给维护者的任务书）换成删除标记，状态留着
    const orders = daemon.store.read(PROJECTS, 0, EVENT_TYPES.workOrder).map((e) => (e.payload as WorkOrderEventPayload).workOrder);
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((w) => w.projectId === "p-1" && w.instructions === PURGED_TEXT)).toBe(true);
    expect(orders.at(-1)).toMatchObject({ state: "ended", outcome: "returned" });
    expect(daemon.cards.get(card.id)).toMatchObject({ status: "handled", outcome: { action: "confirm_later" }, payload: { charter: { goal: PURGED_TEXT, kind: "other", bindExternal: false } } });
    expect(daemon.cards.get(approval.id)).toMatchObject({ status: "handled", outcome: { action: "approve" }, payload: { argsSummary: PURGED_TEXT } });
    expect(daemon.inbox.get(asked.confirmItemId)).toMatchObject({ title: PURGED_TEXT, handled: "确认删除" });
    // 用户在维护者会话里说过的话还在素材库里，原文副本也在
    const [said] = daemon.materials.searchKeyword("开始立项问答吧");
    expect(said).toMatchObject({ kind: "user_utterance", conversation: PM1, project: "p-1" });
    expect(fs.existsSync(path.join(dataDir, "materials", said!.original!.path))).toBe(true);
    // 删掉的项目：维护者会话发不了；再订阅这个会话只拿到"已删除"标记
    expect(await frontend.request(METHODS.sendMessage, { conversation: PM1, parts: [{ type: "text", text: "在吗" }] }, "k-gone")).toMatchObject({ ok: false, error: { code: "not_found" } });
    const fresh = await connect(url, [PM1]);
    await new Promise((r) => setTimeout(r, 200));
    expect(fresh.events({ channel: PM1 }).every((f) => isDeletedEventPayload(f.payload))).toBe(true);
    expect(JSON.stringify(fresh.events({ channel: PM1 }))).not.toContain("开始立项问答吧");
  }, 60_000);
});

describe("删除被中止", () => {
  it("确认删除之后、停维护者的时候用户取消了归档：整个中止，什么都不删，维护者恢复成能唤起", async () => {
    const { frontend, daemon, records, dataDir } = await untilCharter(
      () => otherCharter,
      (spawn) => (spawn === 2 ? [say("我还在")] : []),
    );
    ok(await act(frontend, "p-1", "abandon"));
    await projectWhere(frontend, (e) => e.change === "abandoned");
    const { confirmItemId } = ok(await act(frontend, "p-1", "delete")) as { confirmItemId: string };
    // 同一段同步代码里：确认删除（删除开始，先停维护者），紧接着取消归档（停维护者要等，删除还没往下走）
    daemon.inbox.act({ itemIds: [confirmItemId], action: "handle", choice: "确认删除", idempotencyKey: "k-confirm" });
    daemon.projects.act({ projectId: "p-1", action: "unarchive" }, "k-unarchive");
    await projectWhere(frontend, (e) => e.change === "unarchived");
    // 维护者恢复成能唤起：在它的会话里说话，它回答
    await frontend.sendText("还在吗", { conversation: PM1 });
    await turns(frontend, PM1, 2);
    expect(lastText(frontend, PM1)).toBe("我还在");
    // 什么都没删
    expect(daemon.projects.get("p-1")).toMatchObject({ state: "preparing" });
    expect(projectEventsOf(frontend).some((e) => e.change === "deleted")).toBe(false);
    expect(fs.existsSync(records)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "sessions", "pm-1"))).toBe(true);
    expect(daemon.store.read(PM1).some((e) => isDeletedEventPayload(e.payload))).toBe(false);
    expect(messagesOf(frontend, PM1).some((m) => textOf(m) === "开始立项问答吧")).toBe(true);
  }, 60_000);
});

describe("任务转为项目", () => {
  it("用户定项目名（重名时提示换名）；不新建维护者：原任务的维护者在同一会话里接着做立项问答；原任务以“已完成 · 已转为项目”结束（看板的最近结束分组）", async () => {
    const TM1 = maintainerChannel("tm-1");
    // 任务的维护者先收到任务书；转为项目后由项目模块接过它（重新拉起，接着同一个会话）
    let wakes = 0;
    const test = await startTestDaemon({
      secretary: [
        call("create_task", { title: "记账调研", summary: "帮我调研家里记账怎么做" }),
        call("write_task_brief", { taskId: "t-1", goal: "调研家里记账的做法", acceptanceCriteria: ["覆盖三种记账方式"], constraints: [], projects: [], memoryScope: "" }),
        say("任务书交给维护者了"),
      ],
      maintainer: () => (++wakes === 1 ? [say("收到任务书")] : [{ kind: "echo_context" }]),
    });
    // 已经有一个和任务标题同名的项目
    seedProject(test.daemon, "记账调研");
    const frontend = await connect(test.url, [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, TM1]);
    await frontend.sendText("发起任务：帮我调研家里记账怎么做");
    await turns(frontend, TM1, 1);

    // 界面预填任务标题：和已有的项目重名，明确提示换名，任务不动
    expect(await frontend.request(METHODS.convertTaskToProject, { taskId: "t-1", name: "记账调研" }, "k-dup")).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "已经有叫「记账调研」的项目了：换个名字" },
    });
    expect(test.daemon.tasks.get("t-1")).toMatchObject({ state: "planning" });
    expect(ok(await frontend.request(METHODS.convertTaskToProject, { taskId: "t-1", name: "家庭记账" }, "k-conv"))).toEqual({ projectId: "p-2" });
    const ended = await eventually(() => tasksOf(frontend), (e) => e.change === "converted_to_project", "原任务结束");
    expect(ended).toMatchObject({ from: "planning", by: "user", task: { id: "t-1", state: "done", endKind: "converted_to_project", maintainerId: "tm-1" } });
    expect(BOARD_GROUP_OF_TASK_STATE[ended.task.state]).toBe("ended");
    const created = await projectWhere(frontend, (e) => e.change === "created" && e.project.id === "p-2");
    expect(created).toMatchObject({ by: "user", project: { id: "p-2", name: "家庭记账", goal: "调研家里记账的做法", state: "preparing", origin: "task", maintainerId: "tm-1", fromTaskId: "t-1" } });
    // 同一个幂等键重发拿到同一个项目；转过的任务不能再转
    expect(ok(await frontend.request(METHODS.convertTaskToProject, { taskId: "t-1", name: "家庭记账" }, "k-conv"))).toEqual({ projectId: "p-2" });
    expect(await frontend.request(METHODS.convertTaskToProject, { taskId: "t-1", name: "另一个名字" }, "k-again")).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    // 原任务的维护者收到通知，在同一个会话里接着做立项问答：上下文里还有原来的任务书，系统提示换成了项目的维护者
    await turns(frontend, TM1, 2);
    const notice = messagesOf(frontend, TM1).find((m) => m.agentInput && m.projectId === "p-2")!;
    expect(textOf(notice)).toContain("任务 t-1「记账调研」已由用户转为项目 p-2「家庭记账」（筹备中）");
    const seen = lastText(frontend, TM1);
    expect(seen).toContain("[system] 你是「二狗」里项目「家庭记账」（p-2）的维护者");
    expect(seen).toContain("覆盖三种记账方式");
    expect(seen).toContain("已由用户转为项目 p-2");
    // 不新建维护者：会话区只有这一个维护者的会话
    expect(fs.readdirSync(path.join(test.dataDir, "sessions")).toSorted()).toEqual(["secretary", "tm-1"]);
    // 用户在这个会话里说的话属于项目
    await frontend.sendText("首版先做导入", { conversation: TM1 });
    await turns(frontend, TM1, 3);
    expect(messagesOf(frontend, TM1).find((m) => m.message.speaker === "user")).toMatchObject({ projectId: "p-2" });
  }, 60_000);
});

describe("发起任务时选的项目", () => {
  it("要在项目列表里：没有的、已归档的被拒，有的写进任务", async () => {
    const test = await startTestDaemon({ secretary: [say("好的"), say("好的"), say("好的")] });
    const frontend = await connect(test.url);
    expect(await frontend.startTask("给记账本加周报", "k-1", ["记账本"])).toMatchObject({ ok: false, error: { code: "bad_params", message: "项目列表里没有「记账本」（现在还没有项目）" } });
    await kickoff(test, frontend);
    // 只选了一个项目的是这个项目的内部任务（64 号票）：项目还在立项（立项书没确认）时不能发起
    expect(await frontend.startTask("给记账本加周报", "k-2", ["记账本"])).toMatchObject({ ok: false, error: { code: "not_allowed", message: "项目「记账本」还在立项，确认立项书后再发起" } });
    seedProject(test.daemon, "家电档案", { state: "in_use", charterConfirmed: true });
    ok(await frontend.startTask("给家电档案加提醒", "k-3", ["家电档案"]));
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务")).toMatchObject({
      task: { projects: ["家电档案"], projectIds: ["p-2"], internal: { projectId: "p-2", projectName: "家电档案" } },
    });
    expect(await frontend.startTask("给菜谱加分类", "k-4", ["菜谱"])).toMatchObject({ ok: false, error: { message: "项目列表里没有「菜谱」（现有：记账本、家电档案）" } });
  }, 60_000);
});

describe("项目档案的旧版本", () => {
  it("维护者整体重写项目档案里的文件：在对话里先问用户（删除或覆盖），批准后执行前运行时先把旧版本留进历史区；工作目录里的不留（没提交、没备份的按 v1 模板退回）；历史区写不进（永不）", async () => {
    const d = dirs();
    const glossary = path.join(d.records, "glossary.md");
    const workNotes = path.join(d.records, "workdir", "notes.md");
    const sneaky = path.join(d.records, ".history", "sneaky.md");
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: [
        call("write", { path: glossary, content: "# 术语表\n\n流水：银行导出的交易记录\n" }),
        call("write", { path: workNotes, content: "新的笔记" }),
        call("write", { path: sneaky, content: "偷偷写进历史区" }),
        say("术语表重写好了"),
      ],
    });
    const frontend = await connect(test.url);
    // 项目开始之前就在工作目录里的文件（111 号票起项目开始之后生成的算项目的临时文件，整体重写不拦）
    fs.mkdirSync(path.dirname(workNotes), { recursive: true });
    fs.writeFileSync(workNotes, "旧的笔记");
    await new Promise((r) => setTimeout(r, 50));
    await kickoff(test, frontend);
    const before = fs.readFileSync(glossary, "utf8");
    await frontend.sendText("把术语表重写一下", { conversation: PM1 });
    const approval = await cardWhere(frontend, ofType("approval"), "审批卡");
    expect(approval.payload).toMatchObject({ tool: "write", source: "项目「记账本」" });
    expect(fs.existsSync(path.join(d.records, ".history"))).toBe(false);
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: 1 }));
    await turns(frontend, PM1, 1);
    expect(fs.readFileSync(glossary, "utf8")).toBe("# 术语表\n\n流水：银行导出的交易记录\n");
    const slots = fs.readdirSync(path.join(d.records, ".history"));
    expect(slots).toHaveLength(1);
    expect(fs.readFileSync(path.join(d.records, ".history", slots[0]!, "glossary.md"), "utf8")).toBe(before);
    // 工作目录（默认的 workdir/）里项目开始之前就有的文件：不自动留旧版本，没提交也没备份，按规则退回；历史区：永不
    expect(fs.readFileSync(workNotes, "utf8")).toBe("旧的笔记");
    expect(fs.existsSync(sneaky)).toBe(false);
    const writes = messagesOf(frontend, PM1)
      .flatMap((m) => m.message.parts)
      .filter((p) => p.type === "tool_call" && p.tool === "write");
    expect(writes.map((p) => (p.type === "tool_call" ? [p.argsSummary.endsWith("notes.md") || p.argsSummary.endsWith("sneaky.md") ? path.basename(p.argsSummary) : "glossary.md", p.outcome, p.blockedBy ?? null] : []))).toEqual([
      ["glossary.md", "done", null],
      ["notes.md", "blocked", "pull_back"],
      ["sneaky.md", "blocked", null],
    ]);
    expect(writes.at(-1)).toMatchObject({ disposition: "never" });
  }, 60_000);
});

describe("演示流程（录给前端回放）", () => {
  it("建议立项 → 立项 → 立项问答（开发类、绑定外部路径）→ 立项书卡“确认并开工” → 首个建设任务做完出“首版做完了”卡，转入使用 → 停用、重新启用；另一个项目放弃到已归档、取消归档、再归档后删除", async () => {
    const d = dirs();
    const test = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [suggest("记账本", "把家里的账管起来"), say("给你一张建议立项卡"), say("好的"), suggest("家电档案", "记下家电的保修"), say("再给你一张"), say("好的")],
      maintainer: (_id, spawn) => {
        const progress = (oldText: string, newText: string) => call("edit", { path: path.join(d.records, "progress.md"), edits: [{ oldText, newText }] });
        if (spawn === 1)
          return [call("write", { path: path.join(d.records, "adr", "0001-csv-first.md"), content: "# 先只导 CSV\n" }), call("submit_charter", devCharter(d.external)), say("立项书交上去了，等你确认")];
        // 立项问答的对话段收尾（16 号票：首个建设任务的工单在等），写回进展、写摘要
        if (spawn === 2) return [progress(PROGRESS_INTRO, "立项问答做完了：首版只导招行 CSV。"), call("write_segment_summary", { summary: "立项问答：首版只导招行 CSV" }), say("写回了")];
        // 起草首个建设任务计划的工单（这一段只读，进展用 write_progress 写回）
        return [call("write_progress", { content: "首个建设任务：在起草计划。" }), call("write_segment_summary", { summary: "开始起草首个建设任务的计划" }), say("收到首个建设任务")];
      },
    });
    const PM2 = maintainerChannel("pm-2");
    const frontend = await connect(test.url, [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1, PM2]);
    // 建议立项 → 立项
    await frontend.sendText("我每个月都要手动对账，好麻烦");
    const suggestion = await cardWhere(frontend, ofType("suggest_project"), "建议立项卡");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    ok(await frontend.cardAction({ cardId: suggestion.id, action: "kickoff", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "created");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    // 立项问答 → 立项书卡 → 确认并开工
    await frontend.sendText("开始立项问答吧", { conversation: PM1 });
    const charter = await cardWhere(frontend, ofType("charter"), "立项书卡");
    await turns(frontend, PM1, 1);
    await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === charter.id, "待我处理里的立项书卡");
    ok(await frontend.cardAction({ cardId: charter.id, action: "confirm_start", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "building_started");
    await eventually(() => tasksOf(frontend), (e) => e.change === "created", "首个建设任务");
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m).startsWith("立项书已确认"), "维护者会话里的说明");
    // 立项问答的对话段收尾（催写回），然后起草首个建设任务计划的工单开始（16 号票）
    await turns(frontend, PM1, 3);
    // 首个建设任务做完 → "首版做完了"卡（112 号票）上转入使用 → 使用中 → 停用 → 重新启用
    finishTask(test, "t-1", "done", builtStages(test, "t-1"));
    const done = await buildDoneCard(frontend, "t-1");
    await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === done.id, "待我处理里的“首版做完了”卡");
    ok(await frontend.cardAction({ cardId: done.id, action: "put_in_use", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "in_use");
    ok(await act(frontend, "p-1", "retire"));
    await projectWhere(frontend, (e) => e.change === "retired");
    ok(await act(frontend, "p-1", "reactivate"));
    await projectWhere(frontend, (e) => e.change === "reactivated");

    // 另一个项目：立项 → 放弃（已归档）→ 取消归档 → 再放弃 → 删除（二次确认）
    await frontend.sendText("家电的保修单老找不到");
    const second = await cardWhere(frontend, (c) => c.type === "suggest_project" && c.id !== suggestion.id, "第二张建议立项卡");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    ok(await frontend.cardAction({ cardId: second.id, action: "kickoff", expectedVersion: 1 }));
    await projectWhere(frontend, (e) => e.change === "created" && e.project.id === "p-2");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    await eventually(() => messagesOf(frontend, PM2), () => true, "第二个维护者会话里的说明");
    ok(await act(frontend, "p-2", "abandon"));
    await projectWhere(frontend, (e) => e.change === "abandoned");
    ok(await act(frontend, "p-2", "unarchive"));
    await projectWhere(frontend, (e) => e.change === "unarchived");
    ok(await act(frontend, "p-2", "abandon"));
    await projectWhere(frontend, (e) => e.change === "abandoned" && e.project.state === "archived" && projectEventsOf(frontend).filter((x) => x.change === "abandoned").length === 2);
    const { confirmItemId } = ok(await act(frontend, "p-2", "delete")) as { confirmItemId: string };
    await eventually(() => inboxOf(frontend), (i) => i.id === confirmItemId, "删除的二次确认");
    ok(await frontend.inboxAction({ itemIds: [confirmItemId], action: "handle", choice: "确认删除" }));
    await projectWhere(frontend, (e) => e.change === "deleted");
    await eventually(() => inboxOf(frontend), (i) => i.id === confirmItemId && i.kind === "notice" && i.handled !== undefined, "删除确认处理过");

    expect(test.daemon.projects.list().map((p) => [p.id, p.state])).toEqual([["p-1", "in_use"]]);
    saveOrCheckRecording("project-lifecycle", frontend.recording, { perChannel: true });
  }, 90_000);
});
