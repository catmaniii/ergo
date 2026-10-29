// 主切面（260 号票；268 号票照用户 2026-10-13 的设计草稿补齐）：秘书的 project_ops——列出、查看说明、调用使用中的项目的操作。
// 真的守护进程，秘书接 faux 剧本，LSM 用替身（helpers/lsm-stand-in.ts 的 owned），"项目的服务"是起在随机端口上的假记账本服务
// （helpers/fake-ops-app.ts，首页 + 本机调用口 POST /ops，回能念的 say），项目走真的流程转入使用（建设期间交带服务的运营方案、
// "首版做完了"卡上确认），运营接口清单 ops.json 写在项目档案里、建设期间就交。
// - 清单验收（照 112 号票的自动验收）：转运营检查清单那一项先"正在验收"，后台验完刷新卡（建设期间服务正好在跑：项目服务上的操作也测了，
//   测试调用带测试标记、没真记账）；验收不过时清单上标缺、写明哪里不对；转入使用时登记成第 1 版；
// - list、describe、call：通用操作开头列一次、项目自己的操作写着第几版；参数不对不发、退回说明；能念的 say；四种实现方式各一条
//   （http 假服务、工作目录里的假脚本、二狗自带动作绑参数、转给维护者当工单）；通用操作（状态、跟维护者说一句）；不出卡、不进待我处理；
//   记录里带版本号；工具清单里只有 project_ops、系统提示里写着；
// - 使用中改了清单：秘书用到时重新验收，没过的照旧用上一版、告诉维护者；维护者用 check_ops 验收全过登记成第 2 版，秘书马上用；
// - 操作不存在、服务关着（257 的"关闭"）、项目不是使用中的：回原因，一个请求都不发到服务。
import fs from "node:fs";
import path from "node:path";
import { type Card, CHANNELS, EVENT_TYPES, type GoLiveChecklistItem, maintainerChannel, METHODS, nowIso, type Project, type TaskEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import { type OpsManifestRegisteredPayload, PROJECT_OPS_EVENTS, type ProjectOpCalledPayload } from "../../src/project-ops/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { type FakeOpsApp, LEDGER_OPS, startFakeOpsApp } from "../helpers/fake-ops-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { call, cardsOf, messagesOf, recordsOf, say, textOf, toolCallsOf, turnsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");
const START = new Date(2026, 9, 24, 9, 0);
/** echo_context：回的是秘书看到的上下文（系统提示、工具清单、工具结果都在里面） */
const ECHO: FauxStep = { kind: "echo_context" };
const ops = (args: Record<string, unknown>) => call("project_ops", args);

/** 记账本的服务：网页和本机调用口在同一个服务上（端口是假服务的） */
const ledgerService = (port: number) => ({
  key: "ledger",
  name: "记账本网页",
  means: "service",
  instructions: "记账本的网页和给秘书调的本机调用口",
  capabilities: {},
  service: { name: "ledger", command: "node server.mjs", cwd: "ledger", port, health: { path: "/" }, web: { home: "/" } },
});

/** 工作目录里的月报脚本（script 实现方式：JSON 进出，测试调用有 ERGO_OPS_TEST） */
const MONTH_SCRIPT = [
  'let input = "";',
  'process.stdin.on("data", (c) => (input += c));',
  'process.stdin.on("end", () => {',
  "  const req = JSON.parse(input);",
  '  const test = process.env.ERGO_OPS_TEST === "1";',
  '  process.stdout.write(JSON.stringify({ say: (test ? "测试：" : "") + req.arguments.month + " 月花了 320 元", detail: { by: "script", args: req.arguments } }));',
  "});",
].join("\n");

/** 一份照草稿写全了的清单：http 的两个（记账本服务）、script、ergo（绑"状态"）、maintainer */
const FULL_OPS = {
  ...LEDGER_OPS,
  tools: [
    ...LEDGER_OPS.tools,
    {
      name: "month_report",
      title: "月报",
      description: "算一个月花了多少。用户问某个月的开销时用。",
      userSays: ["九月花了多少"],
      kind: "query",
      inputSchema: { type: "object", properties: { month: { type: "string", default: "10", description: "几月" } } },
      impl: { type: "script", file: "scripts/month.mjs" },
      test: { args: { month: "9" }, sayIncludes: "测试" },
    },
    {
      name: "ledger_status",
      title: "记账本怎么样",
      description: "记账本整体的状态（服务、定时任务）。",
      userSays: ["记账本还好吗"],
      kind: "query",
      impl: { type: "ergo", action: "status" },
      test: { args: {} },
    },
    {
      name: "add_category",
      title: "加一个分类",
      description: "给记账本加一个新的支出分类（要改代码，交给维护者做）。",
      userSays: ["加一个宠物分类"],
      kind: "action",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "分类名" } }, required: ["name"] },
      impl: { type: "maintainer", instructions: "给记账本加一个支出分类「{{name}}」，网页和接口都要能用" },
      test: { args: { name: "测试分类" } },
    },
  ],
};

/** 数据目录、主目录、项目档案（服务的工作目录先建好：要存在；工作目录里放月报脚本） */
function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  const realData = fs.realpathSync.native(dataDir);
  const records = (projectId: string) => path.join(realData, "projects", projectId);
  fs.mkdirSync(path.join(records("p-1"), "workdir", "ledger"), { recursive: true });
  fs.mkdirSync(path.join(records("p-1"), "workdir", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(records("p-1"), "workdir", "scripts", "month.mjs"), MONTH_SCRIPT);
  return { dataDir, homeDir: makeTempDir("ergo-home-"), records };
}

const writeOps = (records: string, content: unknown) => {
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, "ops.json"), typeof content === "string" ? content : JSON.stringify(content, null, 2));
};

async function connect(td: TestDaemon) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries([SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1].map((c) => [c, 0])));
  return frontend;
}

const opsItem = (card: Card) => ((card.payload as { checklist?: GoLiveChecklistItem[] }).checklist ?? []).find((i) => i.id === "ops");

/** 建设中的记账本（立项书确认过的开发类），建设任务 t-1；建设期间交带服务的运营方案，建设做完出"首版做完了"卡 */
async function ledgerBuilt(td: TestDaemon, frontend: TestFrontend, port: number): Promise<Project> {
  const project = seedProject(td.daemon, "记账本", { state: "building", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: true }, buildTaskId: "t-1" });
  internalTask(td.daemon, "记账本", "建设「记账本」首版");
  const proposed = await td.daemon.operations.tool("p-1", "pm-1").run({ items: [ledgerService(port)], why: "记账本要一直开着，秘书能帮用户记账" } as never, { toolCallId: "call-propose" });
  expect(proposed.isError ? proposed.text : true).toBe(true);
  const task = td.daemon.tasks.get("t-1")!;
  const done: TaskEventPayload = { task: { ...task, state: "done", updatedAt: nowIso() }, change: "finished" as TaskEventPayload["change"], from: task.state, by: "maintainer" };
  td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload: done });
  td.daemon.projects.taskCompleted(done.task);
  await eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");
  return project;
}

/** 在"首版做完了"卡上转入使用，等服务上线、在线 */
async function putInUse(td: TestDaemon, frontend: TestFrontend, card: Card) {
  ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: card.version }, "k-put"));
  await waitUntil(() => td.daemon.projects.get("p-1")?.state === "in_use", { describe: () => "记账本转入使用" });
  await waitUntil(() => serviceNow(td)?.rollout === "live" && serviceNow(td)?.status === "online", { timeoutMs: 20_000, describe: () => `记账本的服务上线、在线：${JSON.stringify(serviceNow(td))}` });
}

const serviceNow = (td: TestDaemon) => td.daemon.projectServices.view().find((v) => v.app === "p-1-ledger");

/** 秘书最后一条回复（echo_context 回的是它看到的上下文） */
const lastReply = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf)
    .at(-1) ?? "";

/** 上下文里某个工具倒数第 n 次的结果 */
const toolResult = (context: string, nth = 1, tool = "project_ops") => {
  const marker = `[toolResult] ${tool}: `;
  let at = context.length;
  for (let i = 0; i < nth; i += 1) at = context.lastIndexOf(marker, at - 1);
  return context.slice(at).split("\n[")[0]!;
};

const calledEvents = (td: TestDaemon) => td.daemon.store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.called).map((e) => e.payload as ProjectOpCalledPayload);
const registeredEvents = (td: TestDaemon) => td.daemon.store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.registered).map((e) => e.payload as OpsManifestRegisteredPayload);
/** 真的调用（不是验收的测试调用） */
const realCalls = (app: FakeOpsApp) => app.calls().filter((c) => c["_meta"] === undefined);

describe("秘书的 project_ops：照草稿补齐（268 号票）", () => {
  it("清单建设期间验收（测试调用带测试标记、不真记）、转入使用时登记第 1 版；list、describe、call：参数不对退回、say 必有、四种实现方式各一条、通用操作，不出卡；记录带版本号", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeOpsApp();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [
        ops({ action: "list" }),
        ECHO,
        ops({ action: "describe", project: "记账本", op: "add_expense" }),
        ops({ action: "call", project: "记账本", op: "add_expense", args: { amount: "三十二" } }),
        ops({ action: "call", project: "记账本", op: "add_expense", args: { amount: 32, category: "吃饭", note: "午饭" }, why: "用户说记一笔午饭 32 块" }),
        ECHO,
        ops({ action: "call", project: "记账本", op: "month_report", args: { month: "9" } }),
        ops({ action: "call", project: "记账本", op: "ledger_status" }),
        ops({ action: "call", project: "记账本", op: "add_category", args: { name: "宠物" }, why: "用户要加宠物分类" }),
        ops({ action: "call", project: "p-1", op: "tell_maintainer", args: { message: "以后记账默认分类改成吃饭" } }),
        ECHO,
      ],
      maintainer: () => Array.from({ length: 40 }, () => say("好")),
    });
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    // 建设期间就交了清单（服务这会儿正在跑：维护者建设时起着它）
    writeOps(d.records("p-1"), FULL_OPS);
    await ledgerBuilt(td, frontend, app.port);
    // "首版做完了"卡上的清单：后台验完了刷新成"验收通过"
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done" && opsItem(c)?.done === true, "清单验收通过");
    expect(opsItem(card)).toMatchObject({ label: "运营接口清单验收通过（ops.json）", done: true, detail: "验收通过：5 个操作的测试都跑通，只读的没写东西" });
    // 测试调用带测试标记：有副作用的没真记账
    expect(app.calls().map((c) => [c.name, c["_meta"]])).toEqual([
      // 312 号票：测试标记另带一份旧名字的（早先做的服务照样认得出）
      ["add_expense", { "ergo/test": true, "ergou/test": true }],
      ["list_expenses", { "ergo/test": true, "ergou/test": true }],
    ]);
    expect(app.expenses()).toEqual([]);
    // 转入使用：同一事务登记成第 1 版
    await putInUse(td, frontend, card);
    expect(registeredEvents(td)).toMatchObject([{ projectId: "p-1", version: 1, via: "go_live", ops: [{ name: "add_expense" }, { name: "list_expenses" }, { name: "month_report" }, { name: "ledger_status" }, { name: "add_category" }] }]);
    const cardsBefore = cardsOf(frontend).length;
    const inboxBefore = td.daemon.inbox.list().length;

    // list：通用操作开头列一次；项目自己的操作写着第几版、种类、风险标记
    await frontend.sendText("记账本现在能帮我做什么");
    await turnsOf(frontend, SECRETARY, 1);
    const first = lastReply(frontend);
    const listed = toolResult(first);
    expect(listed).toContain("每个使用中的项目都有的通用操作（op 照写）：status「状态」");
    expect(listed).toContain(`项目 p-1「记账本」（运营接口清单第 1 版；调用口在服务「记账本网页」（p-1 · p-1-ledger · 端口 ${app.port}）：在线，入口 /apps/p-1-ledger/）：`);
    expect(listed).toContain("- add_expense「记一笔支出」（有副作用的动作 · 直接做）");
    expect(listed).toContain("- month_report「月报」（只读查询）");
    // 秘书知道有这个工具：工具清单里只有这一个（各项目的操作不注册成单独的工具），系统提示里写着什么时候用、能念的那句
    expect(first).toContain("[tool] project_ops");
    expect(first).not.toContain("[tool] add_expense");
    expect(first).toContain("用户要用的时候用 project_ops");
    expect(first).toContain("能念的一句");

    // describe + 参数不对（不发、退回说明）+ 改对了再调（中文名换成值、补默认值）
    await frontend.sendText("记一笔午饭 32 块");
    await turnsOf(frontend, SECRETARY, 2);
    const second = lastReply(frontend);
    expect(toolResult(second, 3)).toContain('- category（只能写 "food"（吃饭）、"transport"（交通）、"other"（其他），默认 "other"）');
    expect(toolResult(second, 2)).toContain("项目「记账本」的操作 add_expense 参数不对，没发出去：");
    expect(toolResult(second, 1)).toContain("项目「记账本」的操作 add_expense（运营接口清单第 1 版）做好了。\n能念的一句：记好了：午饭 32 元");
    expect(realCalls(app)).toEqual([{ name: "add_expense", arguments: { amount: 32, category: "food", note: "午饭" } }]);
    expect(app.expenses()).toEqual([{ amount: 32, note: "午饭", category: "food" }]);

    // 另外三种实现方式、通用操作
    await frontend.sendText("九月花了多少？记账本还好吗？加一个宠物分类；跟维护者说以后记账默认分类改成吃饭");
    await turnsOf(frontend, SECRETARY, 3);
    const third = lastReply(frontend);
    expect(toolResult(third, 4)).toContain("能念的一句：9 月花了 320 元");
    expect(toolResult(third, 3)).toContain("能念的一句：「记账本」使用中；服务在线");
    expect(toolResult(third, 3)).toContain("运营接口清单：第 1 版（项目自己的操作 5 个）");
    expect(toolResult(third, 2)).toContain("能念的一句：「加一个分类」转给「记账本」的维护者当工单了");
    expect(toolResult(third, 1)).toContain("能念的一句：转给「记账本」的维护者了。");
    // maintainer：建了一个项目内部的普通任务（派一张执行的工单给维护者），任务书写清操作、参数、为什么
    const handed = td.daemon.tasks.list().find((t) => t.origin === "delegated" && t.internal?.projectId === "p-1");
    expect(handed).toMatchObject({ kind: "plain", title: "加一个分类" });
    expect(handed!.summary).toContain("给记账本加一个支出分类「宠物」");
    expect(handed!.summary).toContain("为什么：用户要加宠物分类");
    // 跟维护者说一句：插进维护者的会话，标着秘书转达
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => textOf(m).includes("以后记账默认分类改成吃饭") && m.message.relayedBy === "secretary"), { describe: () => "维护者会话里的转达" });

    // 不用确认：没有新卡、没有新的待我处理
    expect(cardsOf(frontend).slice(cardsBefore)).toEqual([]);
    expect(td.daemon.inbox.list().length).toBe(inboxBefore);
    // 记录：带版本号（通用操作没有）、种类、实现方式、能念的那句
    expect(calledEvents(td).map((c) => [c.op, c.version, c.kind, c.impl, c.say, c.sayFilled])).toEqual([
      ["add_expense", 1, "action", "http", "记好了：午饭 32 元", false],
      ["month_report", 1, "query", "script", "9 月花了 320 元", false],
      ["ledger_status", 1, "query", "ergo", expect.stringContaining("「记账本」使用中"), false],
      ["add_category", 1, "action", "maintainer", expect.stringContaining("转给「记账本」的维护者当工单了"), false],
      ["tell_maintainer", null, "action", "ergo", "转给「记账本」的维护者了。", false],
    ]);
    const records = recordsOf(frontend, SECRETARY)
      .map((r) => r.record)
      .filter((r) => r.kind === "project_op");
    expect(records).toHaveLength(5);
    expect(records[0]!.summary).toBe("秘书调了项目「记账本」的操作 add_expense（记好了：午饭 32 元）");
    expect(records[0]!.detail).toContain("运营接口清单第 1 版");
    expect(records[0]!.detail).toContain("用户说记一笔午饭 32 块");
    const calls = toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "project_ops");
    expect(calls.map((c) => c.outcome)).toEqual(["done", "done", "error", "done", "done", "done", "done", "done"]);
    await frontend.close();
  }, 240_000);

  it("验收不过时转运营清单上标缺；补齐后刷新；使用中改了清单：没过的照旧用上一版、告诉维护者，check_ops 全过登记成第 2 版、秘书马上用", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeOpsApp();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [ops({ action: "list" }), ECHO, ops({ action: "call", project: "记账本", op: "add_expense", args: { amount: 18 } }), ECHO],
      maintainer: () => Array.from({ length: 40 }, () => say("好")),
    });
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    // 交的清单没写测试、枚举没中文名：清单上马上标缺、写明哪里不对
    const sloppy = { ...LEDGER_OPS, tools: LEDGER_OPS.tools.map(({ test: _test, ...rest }) => rest) };
    writeOps(d.records("p-1"), sloppy);
    await ledgerBuilt(td, frontend, app.port);
    const missing = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");
    expect(opsItem(missing)).toMatchObject({ done: false, detail: "验收没过（2 处）：操作 add_expense 没写测试（test：{ \"args\": {…} }）" });
    expect(app.calls()).toEqual([]);
    // 补齐了，在项目页再点"转入使用…"：用还在等的那张卡、清单刷新（后台验完再刷新一次）
    writeOps(d.records("p-1"), LEDGER_OPS);
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live"));
    const fixed = await eventually(() => cardsOf(frontend), (c) => c.id === missing.id && opsItem(c)?.done === true, "补齐后清单打勾");
    expect(opsItem(fixed)!.detail).toBe("验收通过：2 个操作的测试都跑通，只读的没写东西");
    await putInUse(td, frontend, fixed);
    expect(registeredEvents(td).map((r) => r.version)).toEqual([1]);

    // 使用中加了一个不回 say 的操作：秘书用到时重新验收没过，照旧用第 1 版，告诉维护者
    writeOps(d.records("p-1"), { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools, { ...LEDGER_OPS.tools[1]!, name: "legacy_list", title: "老写法" }] });
    await frontend.sendText("记账本能做什么");
    await turnsOf(frontend, SECRETARY, 1);
    const listed = toolResult(lastReply(frontend));
    expect(listed).toContain("运营接口清单第 1 版");
    expect(listed).toContain("档案里的运营接口清单改过了，验收没过：操作 legacy_list 的测试回的没有能念的 say");
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "system" && textOf(m).includes("秘书用到时验收没过") && textOf(m).includes("check_ops")), {
      describe: () => "告诉维护者验收没过",
    });
    expect(registeredEvents(td).map((r) => r.version)).toEqual([1]);

    // 维护者改对了、用 check_ops 验收：全过，登记成第 2 版
    writeOps(d.records("p-1"), { ...LEDGER_OPS, tools: [{ ...LEDGER_OPS.tools[0]!, usage: "金额不清楚的先问用户" }, LEDGER_OPS.tools[1]!] });
    const checked = await td.daemon.projectOps.checkTool({ projectId: "p-1", maintainerId: "pm-1" }).run({} as never, { toolCallId: "call-check" });
    expect(checked.isError).toBeFalsy();
    expect(checked.text).toContain("验收全过：2 个操作的测试都跑通了");
    expect(checked.text).toContain("登记成第 2 版，秘书马上用它");
    expect(registeredEvents(td).map((r) => [r.version, r.via])).toEqual([
      [1, "go_live"],
      [2, "changed"],
    ]);
    // 秘书马上用第 2 版，记录里是 2
    await frontend.sendText("记一笔 18 块");
    await turnsOf(frontend, SECRETARY, 2);
    expect(toolResult(lastReply(frontend))).toContain("（运营接口清单第 2 版）做好了");
    expect(calledEvents(td).map((c) => [c.op, c.version])).toEqual([["add_expense", 2]]);
    await frontend.close();
  }, 240_000);

  it("操作不存在、服务关着（257 的“关闭”）、项目不是使用中的：回原因，一个请求都不发到服务；档案里的清单改坏了照旧用登记着的版本", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeOpsApp();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [
        ops({ action: "call", project: "记账本", op: "delete_all" }),
        ECHO,
        ops({ action: "call", project: "记账本", op: "list_expenses" }),
        ECHO,
        ops({ action: "call", project: "记账本", op: "list_expenses" }),
        ECHO,
        ops({ action: "call", project: "菜谱", op: "add_expense", args: { amount: 1 } }),
        ECHO,
      ],
      maintainer: () => Array.from({ length: 20 }, () => say("好")),
    });
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    writeOps(d.records("p-1"), LEDGER_OPS);
    await ledgerBuilt(td, frontend, app.port);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done" && opsItem(c)?.done === true, "清单验收通过");
    await putInUse(td, frontend, card);
    const testCalls = app.calls().length;

    // 操作不存在：列出有哪些（通用操作也在里面）
    await frontend.sendText("把记账本的记录全删了");
    await turnsOf(frontend, SECRETARY, 1);
    expect(toolResult(lastReply(frontend))).toContain("项目「记账本」没有操作「delete_all」。它有：add_expense、list_expenses、status");

    // 档案里的清单改坏了：照旧用登记着的第 1 版
    writeOps(d.records("p-1"), '{ "tools": [ { "name": "add_expense" }, ');
    await frontend.sendText("最近花了多少");
    await turnsOf(frontend, SECRETARY, 2);
    expect(toolResult(lastReply(frontend))).toContain("项目「记账本」的操作 list_expenses（运营接口清单第 1 版）做好了。");

    // 服务关着（用户在项目卡上点了“关闭”）：告诉用户它关着、要用先启动
    ok(await frontend.request(METHODS.projectServicesAction, { projectId: "p-1", action: "stop" }, "k-stop"));
    await waitUntil(() => serviceNow(td)?.paused === true && serviceNow(td)?.power === undefined, { timeoutMs: 20_000, describe: () => `记账本的服务关着：${JSON.stringify(serviceNow(td))}` });
    await frontend.sendText("最近花了多少");
    await turnsOf(frontend, SECRETARY, 3);
    const closed = toolResult(lastReply(frontend));
    expect(closed).toContain("项目「记账本」的服务关着");
    expect(closed).toContain("switch_project_services");

    // 不在使用中的项目（建设中，档案里有清单也不调）
    const recipes = seedProject(td.daemon, "菜谱", { state: "building", charterConfirmed: true, kind: "dev" });
    writeOps(d.records(recipes.id), LEDGER_OPS);
    await frontend.sendText("菜谱那边记一笔");
    await turnsOf(frontend, SECRETARY, 4);
    expect(toolResult(lastReply(frontend))).toContain("项目「菜谱」现在是建设中，不是使用中的");

    // 只发了那一次查支出（档案改坏了照旧用第 1 版的那次），别的一个请求都没到调用口
    expect(app.calls().slice(testCalls).map((c) => c.name)).toEqual(["list_expenses"]);
    expect(calledEvents(td).map((c) => c.op)).toEqual(["list_expenses"]);
    expect(toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "project_ops").map((c) => c.outcome)).toEqual(["error", "done", "error", "error"]);
    await frontend.close();
  }, 240_000);
});
