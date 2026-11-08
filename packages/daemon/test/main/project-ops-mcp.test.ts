// 主切面：项目转入使用，运营接口清单验收过的操作自动转成一个真的 MCP（ADR-0045）。真的守护进程走组合根；LSM 用替身、"项目的服务"是假记账本服务（helpers/fake-ops-app.ts），
// 模型是 faux，MCP 的转发程序是真的子进程、真的走 stdio、真的经本机端口问守护进程。
// - 转入使用：卡上写明几个操作会转成 MCP；MCP 清单里有它、标明是项目自动转的；mcp.json 不被写；不多一张卡；后台自检写进负责人时间线；
// - 另一个任务的负责人配进工具包，四种实现方式都调到；能念的 say；时间线、project_op_called 写明是谁调的；测试标记没带；凭证不外露；
// - 项目自己的负责人工具包里自动有它（项目的工具包不变）；别的项目走 request_toolkit_change；
// - 服务关着回和 project_ops 一样的说明、不崩；改清单 check_ops 过了登记新版，工具跟着变，不用重启；项目归档后没有了，转发程序也收了；
// - 凭证错、走外网端口；用户写了同名登记；手改、手删、抢名字被拒；秘书不变（mcp_call 指回 project_ops）；
// - 跑在 Claude Code 上的负责人也拿得到（假 SDK）。
import fs from "node:fs";
import path from "node:path";
import { type Card, CHANNELS, EVENT_TYPES, type GoLiveChecklistItem, HTTP_PATHS, maintainerChannel, METHODS, nowIso, type Plan, type Project, type TaskEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { REDACTED_SECRET } from "../../src/guard/index.ts";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import { PROJECT_OPS_EVENTS, type ProjectOpCalledPayload } from "../../src/project-ops/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { toolsNow } from "../helpers/echo.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { type FakeOpsApp, LEDGER_OPS, startFakeOpsApp } from "../helpers/fake-ops-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { onePlan } from "../helpers/running-task.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { call, cardsOf, cardWhere, eventually, messagesOf, ok, recordsOf, say, tasksOf, textOf, toolCallsOf, turnsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { seedToolkitProject, toolkit } from "../helpers/toolkit.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");
const START = new Date(2026, 10, 2, 9, 0);
const ECHO: FauxStep = { kind: "echo_context" };
const MCP = "project-p-1";
const tool = (op: string) => `mcp__${MCP}__${op}`;

/** 工作目录里的月报脚本（script：JSON 进出，测试调用有 ERGO_OPS_TEST） */
const MONTH_SCRIPT = [
  'let input = "";',
  'process.stdin.on("data", (c) => (input += c));',
  'process.stdin.on("end", () => {',
  "  const req = JSON.parse(input);",
  '  const test = process.env.ERGO_OPS_TEST === "1";',
  '  process.stdout.write(JSON.stringify({ say: (test ? "测试：" : "") + req.arguments.month + " 月花了 320 元", detail: { by: "script" } }));',
  "});",
].join("\n");

const monthOp = {
  name: "month_report",
  title: "月报",
  description: "算一个月花了多少。用户问某个月的开销时用。",
  userSays: ["九月花了多少"],
  kind: "query",
  risk: "direct",
  returns: "say 说花了多少",
  inputSchema: { type: "object", properties: { month: { type: "string", default: "10", description: "几月" } } },
  impl: { type: "script", file: "scripts/month.mjs" },
  test: { args: { month: "9" }, sayIncludes: "测试" },
};
const statusOp = { name: "ledger_status", title: "记账本怎么样", description: "记账本整体的状态。", userSays: ["记账本还好吗"], kind: "query", impl: { type: "ergo", action: "status" }, test: { args: {} } };
const categoryOp = {
  name: "add_category",
  title: "加一个分类",
  description: "加一个新的支出分类（要改代码，交给负责人做）。",
  userSays: ["加一个宠物分类"],
  kind: "action",
  risk: "confirm",
  inputSchema: { type: "object", properties: { name: { type: "string", description: "分类名" } }, required: ["name"] },
  impl: { type: "maintainer", instructions: "给记账本加一个支出分类「{{name}}」" },
  test: { args: { name: "测试分类" } },
};

/** 四种实现方式都有的清单 */
const FULL_OPS = { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools, monthOp, statusOp, categoryOp] };
/** 不要服务的清单（不用 LSM）：script、ergo */
const LOCAL_OPS = { tools: [monthOp, statusOp] };

function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  const realData = fs.realpathSync.native(dataDir);
  const records = (projectId: string) => path.join(realData, "projects", projectId);
  const workdir = path.join(records("p-1"), "workdir");
  fs.mkdirSync(path.join(workdir, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "scripts", "month.mjs"), MONTH_SCRIPT);
  return { dataDir, homeDir: makeTempDir("ergo-home-"), records };
}

const writeOps = (records: string, content: unknown) => {
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, "ops.json"), JSON.stringify(content, null, 2));
};

const ledgerService = (port: number) => ({
  key: "ledger",
  name: "记账本网页",
  means: "service",
  instructions: "记账本的网页和本机调用口",
  capabilities: {},
  service: { name: "ledger", command: "node server.mjs", cwd: "ledger", port, health: { path: "/" }, web: { home: "/" } },
});

const opsItem = (card: Card) => ((card.payload as { checklist?: GoLiveChecklistItem[] }).checklist ?? []).find((i) => i.id === "ops");
const serviceNow = (td: TestDaemon) => td.daemon.projectServices.view().find((v) => v.app === "p-1-ledger");
const calledEvents = (td: TestDaemon) => td.daemon.store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.called).map((e) => e.payload as ProjectOpCalledPayload);
const repliesOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);
async function nthReply(frontend: TestFrontend, channel: string, n: number): Promise<string> {
  await waitUntil(() => repliesOf(frontend, channel).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 的第 ${n} 条回复；现在是：\n${repliesOf(frontend, channel).map((t) => t.slice(0, 200)).join("\n")}` });
  return repliesOf(frontend, channel)[n - 1]!;
}
const mcpToolLines = (seen: string) => toolsNow(seen).filter((name) => name.startsWith("mcp__"));
/** 上下文里某个工具最后一次的结果 */
const toolResult = (context: string, name: string) => {
  const marker = `[toolResult] ${name}: `;
  return context.slice(context.lastIndexOf(marker)).split("\n[")[0]!;
};
const post = (url: string, token: string | undefined, body: unknown) => fetch(new URL(HTTP_PATHS.projectOpsMcp, url), { method: "POST", headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const tokenOf = (td: TestDaemon) => td.daemon.mcp.injectedSecrets(MCP)[0]!.value;

/** 真的流程转入使用：建设期间交带服务的方案和清单，"首版做完了"卡上确认，等服务上线 */
async function goLive(td: TestDaemon, frontend: TestFrontend, app: FakeOpsApp, records: string): Promise<Card> {
  writeOps(records, FULL_OPS);
  seedProject(td.daemon, "记账本", { state: "building", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: false }, buildTaskId: "t-1" });
  internalTask(td.daemon, "记账本", "建设「记账本」首版");
  const proposed = await td.daemon.operations.tool("p-1", "pm-1").run({ items: [ledgerService(app.port)], why: "记账本要一直开着" } as never, { toolCallId: "call-propose" });
  expect(proposed.isError ? proposed.text : true).toBe(true);
  const task = td.daemon.tasks.get("t-1")!;
  const done: TaskEventPayload = { task: { ...task, state: "done", updatedAt: nowIso() }, change: "finished" as TaskEventPayload["change"], from: task.state, by: "maintainer" };
  td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload: done });
  td.daemon.projects.taskCompleted(done.task);
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done" && opsItem(c)?.done === true, "清单验收通过");
  ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: card.version }, "k-put"));
  await waitUntil(() => td.daemon.projects.get("p-1")?.state === "in_use", { describe: () => "记账本转入使用" });
  await waitUntil(() => serviceNow(td)?.rollout === "live" && serviceNow(td)?.status === "online", { timeoutMs: 20_000, describe: () => `服务上线、在线：${JSON.stringify(serviceNow(td))}` });
  return card;
}

/** 使用中的记账本（不走卡，不要服务）：档案里写好清单、验收登记 */
async function seededLedger(td: TestDaemon, ops: unknown = LOCAL_OPS, overrides: Partial<Project> = {}): Promise<Project> {
  const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: toolkit(), ...overrides });
  const workdir = td.daemon.projects.workdir(project);
  fs.mkdirSync(path.join(workdir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "scripts", "month.mjs"), MONTH_SCRIPT);
  writeOps(td.daemon.projects.records(project.id).root, ops);
  const check = await td.daemon.projectOps.registry.check(project, { by: "maintainer", force: true });
  expect(check?.outcome).toBe("passed");
  return project;
}

describe("项目转入使用自动转成 MCP", () => {
  it("转入使用 → 清单里有它 → 另一个任务的负责人配进工具包 → 真走 stdio、四种实现方式 → 时间线和事件写明调用者 → 服务关着照实说 → 改清单重验工具跟着变 → 项目退出使用后没有了", { timeout: 240_000 }, async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeOpsApp();
    const plan: Plan = { ...onePlan(), toolkit: toolkit({ mcp: [MCP] }) };
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [call("mcp_call", { tool: `${MCP}/month_report`, args: { month: "9" } }), ECHO, ...Array.from({ length: 10 }, () => say("好"))],
      maintainer: (id, spawn) => {
        if (id === "pm-1") return [ECHO, ...Array.from({ length: 40 }, () => say("好"))];
        if (spawn === 1) return [submitPlanStep(plan), say("计划交上去了")];
        // 执行：第一轮四种实现方式、参数不对、白送的通用操作不转；第二轮服务关着；工具变了之后（重新装配）新工具能调、旧的没有了
        if (spawn === 2) {
          return [
            call(tool("add_expense"), { amount: 32, category: "food", note: "午饭" }),
            call(tool("add_expense"), { amount: "三十二" }),
            call(tool("month_report"), { month: "9" }),
            call(tool("ledger_status"), {}),
            call(tool("add_category"), { name: "宠物" }),
            ECHO,
            call(tool("list_expenses"), {}),
            ECHO,
            ...Array.from({ length: 10 }, () => say("好")),
          ];
        }
        return [call(tool("month_report_v2"), { month: "9" }), call(tool("ledger_status"), {}), ECHO, ...Array.from({ length: 10 }, () => say("好"))];
      },
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1].map((c) => [c, 0])));
    await lsm.waitFor((m) => m.type === "hello", "握手");
    const { mcpFile } = dataDirLayout(td.dataDir);

    // 转入使用：卡上写明；转之前 MCP 清单里没有它
    const card = await goLive(td, frontend, app, d.records("p-1"));
    expect(opsItem(card)?.detail).toContain("这个项目的 5 个操作会同时转成 MCP，别的 agent 配进工具包就能用");
    const cardsAfterGoLive = cardsOf(frontend).filter((c) => c.type === "mcp_change");
    expect(cardsAfterGoLive).toEqual([]);

    // MCP 清单：标明是项目自动转的；query 只读、都不联网；通用操作不转；不写进 mcp.json
    const entry = () => td.daemon.mcp.catalog().servers.find((s) => s.name === MCP);
    expect(entry()).toMatchObject({ title: "记账本", auto: { projectId: "p-1", projectName: "记账本" } });
    expect(entry()!.tools.map((t) => [t.name, t.title, t.readOnlyOrIdempotent, t.network])).toEqual([
      ["add_expense", "记一笔支出", false, false],
      ["list_expenses", "查支出", true, false],
      ["month_report", "月报", true, false],
      ["ledger_status", "记账本怎么样", true, false],
      ["add_category", "加一个分类", false, false],
    ]);
    expect(fs.existsSync(mcpFile)).toBe(false);
    expect(td.daemon.mcp.brief().find((s) => s.name === MCP)).toMatchObject({ auto: { projectName: "记账本" } });

    // 自检：真拉了一次转发程序，结果写进负责人时间线；拉完收掉（第一次调用时再拉起）
    const check = await eventually(() => recordsOf(frontend, PM1).map((r) => r.record), (r) => r.kind === "mcp", "自检的时间线");
    expect(check.summary).toContain(`项目自动转的 MCP ${MCP} 自检通过（运营接口清单第 1 版，5 个工具）`);
    expect(check.detail).toContain("add_expense");
    await waitUntil(() => td.daemon.mcp.live().length === 0, { describe: () => "自检完收掉" });

    // 项目自己的负责人：工具包里自动有它，项目的工具包没被改；风险标记写进说明给模型看
    await frontend.sendText("看看你有什么", { conversation: PM1 });
    const own = await nthReply(frontend, PM1, 1);
    expect(mcpToolLines(own)).toEqual([tool("add_expense"), tool("list_expenses"), tool("month_report"), tool("ledger_status"), tool("add_category")]);
    expect(td.daemon.projects.get("p-1")!.toolkit!.mcp).toEqual([]);
    expect(own).toContain(`已登记的 MCP`);
    expect(own).toContain(`${MCP}（项目「记账本」的运营接口自动转的`);

    // 另一个任务：负责人交的计划里工具包配了它，确认后执行
    const task = td.daemon.tasks.createByRequest({ title: "月底对账", summary: "月底对账" });
    td.daemon.tasks.writeBrief(task.id, { goal: "月底对账", acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
    const planCard = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as { taskId: string }).taskId === task.id, "计划卡");
    ok(await frontend.cardAction({ cardId: planCard.id, action: "confirm", expectedVersion: planCard.version, input: {} }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "started", "任务开始执行");
    const owner = maintainerChannel(task.maintainerId);
    await frontend.subscribe({ [owner]: 0 });
    const said = (n: number) => nthReply(frontend, owner, n);

    // 第一轮：工具在；结果带能念的 say；真的记了账，调用没带测试标记
    const first = await said(2);
    expect(mcpToolLines(first)).toEqual([tool("add_expense"), tool("list_expenses"), tool("month_report"), tool("ledger_status"), tool("add_category")]);
    expect(first).toContain(`[toolResult] ${tool("add_expense")}: 项目「记账本」的操作 add_expense（运营接口清单第 1 版）做好了。`);
    expect(first).toContain("能念的一句：记好了：午饭 32 元");
    // 参数不对：模型这边按清单的 schema 先挡（pi 校验），不发到服务
    expect(first).toContain("amount: must be number");
    expect(first).toContain("月花了 320 元");
    expect(first).toContain("工单");
    expect(app.expenses()).toEqual([{ amount: 32, note: "午饭", category: "food" }]);
    expect(app.calls().filter((c) => c.name === "add_expense").at(-1)).toEqual({ name: "add_expense", arguments: { amount: 32, category: "food", note: "午饭" } });
    // 真的走 stdio：转发程序活着，归守护进程管
    expect(td.daemon.mcp.live().map((l) => l.server)).toContain(MCP);

    // 事件：写明是谁调的、第几版、哪种实现方式（参数不对的没发出去，不记）
    const who = `任务「月底对账」的负责人`;
    expect(calledEvents(td).map((e) => [e.op, e.impl, e.outcome, e.by, e.agentId, e.caller, e.version])).toEqual([
      ["add_expense", "http", "done", "agent", task.maintainerId, who, 1],
      ["month_report", "script", "done", "agent", task.maintainerId, who, 1],
      ["ledger_status", "ergo", "done", "agent", task.maintainerId, who, 1],
      ["add_category", "maintainer", "done", "agent", task.maintainerId, who, 1],
    ]);
    // 时间线记在调用者自己的会话上，写明是谁调的
    const records = () => recordsOf(frontend, owner).map((r) => r.record).filter((r) => r.kind === "project_op");
    await waitUntil(() => records().length === 4, { describe: () => `等时间线：${JSON.stringify(records())}` });
    expect(records()[0]!.summary).toBe(`${who}调了「记账本」add_expense：记好了：午饭 32 元`);
    // 转给负责人的工单写明是谁要的
    const order = td.daemon.tasks.list().find((t) => t.title === "加一个分类")!;
    expect(order).toBeDefined();

    // 凭证：不进事件、工具结果、agent 的环境；只在内存里
    const token = tokenOf(td);
    expect(token.length).toBeGreaterThan(20);
    const everything = JSON.stringify([calledEvents(td), recordsOf(frontend, owner), messagesOf(frontend, owner), recordsOf(frontend, PM1), messagesOf(frontend, PM1)]);
    expect(everything).not.toContain(token);
    expect(process.env.ERGO_OPS_MCP_TOKEN).toBeUndefined();
    for (const type of [EVENT_TYPES.timelineRecord, EVENT_TYPES.message, EVENT_TYPES.card, PROJECT_OPS_EVENTS.called]) expect(td.daemon.store.mentioning(type, token)).toEqual([]);

    // 服务关着：回和 project_ops 一样的说明，不崩，不发到服务
    ok(await frontend.request(METHODS.projectServicesAction, { projectId: "p-1", action: "stop" }, "k-stop"));
    await waitUntil(() => serviceNow(td)?.paused === true && serviceNow(td)?.power === undefined, { timeoutMs: 20_000, describe: () => `服务关着：${JSON.stringify(serviceNow(td))}` });
    const seenCalls = app.calls().length;
    await frontend.sendText("再查一下", { conversation: owner });
    const closed = toolResult(await said(3), tool("list_expenses"));
    expect(closed).toContain("项目「记账本」的服务关着");
    expect(app.calls().length).toBe(seenCalls);
    expect(calledEvents(td)).toHaveLength(4);

    // 秘书不变：工具列表里没有这些操作；mcp_call 指回 project_ops
    await frontend.sendText("九月花了多少");
    await turnsOf(frontend, SECRETARY, 1);
    const secretary = messagesOf(frontend, SECRETARY).map(textOf).at(-1)!;
    expect(mcpToolLines(secretary)).toEqual([]);
    expect(toolsNow(secretary)).toContain("project_ops");
    expect(toolResult(secretary, "mcp_call")).toContain("你调这个项目的操作用 project_ops");

    // 改清单：check_ops 过了登记第 2 版，工具跟着变，不用重启（用着它的负责人重新装配）；转发程序换成新的
    ok(await frontend.request(METHODS.projectServicesAction, { projectId: "p-1", action: "start" }, "k-start"));
    await waitUntil(() => serviceNow(td)?.status === "online", { timeoutMs: 20_000, describe: () => "服务又起来了" });
    writeOps(d.records("p-1"), { ...FULL_OPS, tools: [...FULL_OPS.tools.filter((t) => t.name !== "month_report"), { ...monthOp, name: "month_report_v2" }] });
    const checked = await td.daemon.projectOps.checkTool({ projectId: "p-1", maintainerId: "pm-1" }).run({}, { toolCallId: "call-check" });
    expect(checked.text).toContain("登记成第 2 版，秘书和这个项目自动转的 MCP 马上用它");
    await waitUntil(() => entry()!.tools.some((t) => t.name === "month_report_v2"), { describe: () => "工具跟着变" });
    expect(entry()!.tools.map((t) => t.name)).not.toContain("month_report");
    await eventually(() => recordsOf(frontend, PM1).map((r) => r.record), (r) => r.kind === "mcp" && r.summary.includes("第 2 版"), "第 2 版的自检");
    // 重新装配了：下一轮的工具是新的，调到新工具；旧工具名没有了
    await frontend.sendText("接着做", { conversation: owner });
    await waitUntil(() => repliesOf(frontend, owner).some((t) => t.includes(`${tool("month_report_v2")}: 项目`)), { timeoutMs: 60_000, describe: () => `等新工具的结果：\n${repliesOf(frontend, owner).at(-1)?.slice(-600)}` });
    const after = repliesOf(frontend, owner).find((t) => t.includes(`[tool] ${tool("month_report_v2")}`))!;
    expect(mcpToolLines(after)).toContain(tool("month_report_v2"));
    expect(mcpToolLines(after)).not.toContain(tool("month_report"));
    expect(calledEvents(td).at(-2)).toMatchObject({ op: "month_report_v2", version: 2, by: "agent" });

    // 项目退出使用：MCP 跟着没有，转发程序收了，凭证作废；工具包里的名字留着，按现有"找不到"处理
    await waitUntil(() => td.daemon.workOrders.currentWorkOrder("pm-1") === undefined, { timeoutMs: 60_000, describe: () => "等负责人手上的工单结束" }).catch(() => {});
    const archived = await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "k-retire");
    ok(archived);
    await waitUntil(() => entry() === undefined, { describe: () => "MCP 没有了" });
    await waitUntil(() => td.daemon.mcp.live().every((l) => l.server !== MCP), { describe: () => "转发程序收了" });
    expect(td.daemon.mcp.has(MCP)).toBe(false);
    expect((await post(td.url, token, { method: "tools/list" })).status).toBe(401);
    expect(await td.daemon.mcp.call(MCP, "ledger_status", {})).toMatchObject({ isError: true, text: expect.stringContaining("没有登记 MCP 工具") });
    expect(td.daemon.mcp.hostToolsFor({ mcp: [MCP], network: false })).toEqual([]);
    expect(td.daemon.tasks.confirmedPlan(task.id)!.plan.toolkit.mcp).toEqual([MCP]);
    await frontend.close();
  });

  it("别的项目走 request_toolkit_change 配进工具包；手改、手删、抢名字被拒；凭证错、走外网端口；结果里的凭证擦掉", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({
      maintainer: (id, spawn) => {
        if (id !== "pm-2") return [say("好")];
        if (spawn === 1) {
          return [
            call("request_mcp_change", { action: "update", name: MCP, command: "node", tools: { x: { title: "x" } } }),
            call("request_mcp_change", { action: "remove", name: MCP }),
            call("request_mcp_change", { action: "add", name: "project-p-9", command: "node", tools: { x: { title: "x" } } }),
            ECHO,
            call("request_toolkit_change", { addMcp: [MCP], why: "要查账" }),
            say("提了"),
          ];
        }
        return [ECHO, call(tool("month_report"), { month: "9" }), call("bash", { command: 'echo "agent=[$ERGO_OPS_MCP_TOKEN]"' }), ECHO, say("好")];
      },
    });
    const frontend = await TestFrontend.connect(td.url);
    const PM2 = maintainerChannel("pm-2");
    await frontend.subscribe(Object.fromEntries([CARDS, INBOX, PROJECTS, PM2].map((c) => [c, 0])));
    await seededLedger(td);
    seedToolkitProject(td.daemon, "周报", toolkit({ bash: true }));
    await frontend.sendText("把记账本接过来", { conversation: PM2 });

    const refused = await nthReply(frontend, PM2, 1);
    await frontend.sendText("申请配进工具包", { conversation: PM2 });
    expect(refused).toContain("是项目「记账本」转入使用时自动转的，不能手改、手删");
    expect(refused).toContain("project-p-9 这种名字留给项目自动转的 MCP");
    const { mcpFile } = dataDirLayout(td.dataDir);
    expect(fs.existsSync(mcpFile)).toBe(false);
    // 工具包改动的规矩不变：出卡，批准了才有
    const card = await cardWhere(frontend, (c) => c.type === "toolkit_change", "工具包变更卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    const seen = await nthReply(frontend, PM2, 3);
    expect(mcpToolLines(seen)).toEqual([tool("month_report"), tool("ledger_status")]);
    await frontend.sendText("查九月", { conversation: PM2 });
    const done = await nthReply(frontend, PM2, 4);
    expect(done).toContain("9 月花了 320 元");
    // 凭证只进转发程序：agent 和它起的 bash 碰不到
    expect(done).toContain("agent=[]");
    expect(calledEvents(td).map((e) => [e.op, e.by, e.caller])).toEqual([["month_report", "agent", "项目「周报」的负责人"]]);
    expect(recordsOf(frontend, PM2).map((r) => r.record).find((r) => r.kind === "project_op")!.summary).toContain("项目「周报」的负责人调了「记账本」month_report：");

    // 接口：没凭证、凭证错 401；外网端口 403（带对的凭证也不行）；对的凭证只认自己项目的工具；测试标记这条路带不了
    const token = tokenOf(td);
    expect((await post(td.url, undefined, { method: "tools/list" })).status).toBe(401);
    expect((await post(td.url, "wrong-token", { method: "tools/list" })).status).toBe(401);
    const external = await post(td.externalUrl, token, { method: "tools/list" });
    expect(external.status).toBe(403);
    expect(((await external.json()) as { message: string }).message).toContain("只在本机端口开");
    const listed = (await (await post(td.url, token, { method: "tools/list" })).json()) as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    expect(listed.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([["month_report", true], ["ledger_status", true]]);
    expect((await post(td.url, token, { method: "tools/call", name: "month_report", arguments: {}, _meta: { "ergo/test": true } })).status).toBe(400);
    // 通用操作不转
    const callOp = async (name: string, args: unknown) => (await (await post(td.url, token, { method: "tools/call", name, arguments: args })).json()) as { isError: boolean; content: Array<{ text: string }>; structuredContent?: { say: string } };
    const builtin = await callOp("status", {});
    expect(builtin.isError).toBe(true);
    expect(builtin.content[0]!.text).toContain("自动转的 MCP 没有工具「status」");
    // 守护进程这边照 project_ops 再校验一遍参数：不对的不发、退回说明，怎么调写的是 MCP 工具名
    const bad = await callOp("month_report", { month: 9 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("参数不对，没发出去");
    expect(bad.content[0]!.text).toContain(`调的时候：工具 ${tool("month_report")}`);
    expect(bad.content[0]!.text).not.toContain("project_ops");
    // 能念的那句带在结果里
    expect((await callOp("month_report", { month: "9" })).structuredContent).toEqual({ say: "9 月花了 320 元" });
    await frontend.close();
  });

  it("结果里出现凭证：工具结果、事件都擦掉；用户写了同名登记：用写的那条，自动的跳过并记日志", { timeout: 120_000 }, async () => {
    // 脚本把参数原样念回来：参数里带着凭证时看擦没擦
    const echoScript = 'let input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => { const req = JSON.parse(input); process.stdout.write(JSON.stringify({ say: "念回来：" + (req.arguments.text ?? ""), detail: String(req.arguments.text ?? "") })); });';
    const echoOp = { name: "say_back", title: "念回来", description: "把参数念回来。", userSays: ["念回来"], kind: "query", inputSchema: { type: "object", properties: { text: { type: "string", default: "" } } }, impl: { type: "script", file: "scripts/back.mjs" }, test: { args: {} } };
    const logs: string[] = [];
    const td = await startTestDaemon({ maintainer: () => [say("好")], log: (line) => logs.push(line) });
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: toolkit() });
    const workdir = td.daemon.projects.workdir(project);
    fs.mkdirSync(path.join(workdir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "scripts", "back.mjs"), echoScript);
    writeOps(td.daemon.projects.records(project.id).root, { tools: [echoOp] });
    expect((await td.daemon.projectOps.registry.check(project, { by: "maintainer", force: true }))?.outcome).toBe("passed");
    await waitUntil(() => td.daemon.store.read(PM1, 0, EVENT_TYPES.timelineRecord).length > 0, { describe: () => "等自检" });

    const token = tokenOf(td);
    const result = await td.daemon.mcp.call(MCP, "say_back", { text: `凭证是 ${token}` });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain(REDACTED_SECRET);
    expect(JSON.stringify(calledEvents(td))).not.toContain(token);
    // 没有调用者（不经负责人的会话）的：事件写明认不出，没有时间线
    expect(calledEvents(td)).toMatchObject([{ by: "agent", caller: "一个 MCP 调用方" }]);

    // 用户写了同名的：用写的，自动的跳过；只记一行日志；负责人的工具包不再自动带它
    const { mcpFile, config } = dataDirLayout(td.dataDir);
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({ servers: { [MCP]: { title: "我自己写的", command: process.execPath, args: ["nothing.mjs"], tools: { mine: { title: "我的工具", network: false } } } } }));
    const entry = td.daemon.mcp.catalog().servers.find((s) => s.name === MCP)!;
    expect(entry).toMatchObject({ title: "我自己写的", tools: [{ name: "mine" }] });
    expect(entry.auto).toBeUndefined();
    expect(td.daemon.mcp.registrations().auto).toBeUndefined();
    td.daemon.mcp.catalog();
    expect(logs.filter((line) => line.includes(`和项目 p-1 自动转的 MCP 同名的 ${MCP}`))).toHaveLength(1);
    expect(logs.filter((line) => line.includes(token))).toEqual([]);
    // 写坏了的文件：用户写的一个也不用，自动的还在
    fs.writeFileSync(mcpFile, "{ 坏的");
    const broken = td.daemon.mcp.catalog();
    expect(broken.problem).toBeDefined();
    expect(broken.servers.map((s) => s.name)).toEqual([MCP]);
    // 文件写坏时自动的照样能调；项目归档了转发程序照样收（凭证已经作废，留着也调不通）；取消归档是新进程、新凭证，调得通
    expect((await td.daemon.mcp.call(MCP, "say_back", { text: "还在" })).isError).toBe(false);
    expect(td.daemon.mcp.live().map((l) => l.server)).toEqual([MCP]);
    td.daemon.projects.act({ projectId: project.id, action: "archive" }, "k-archive");
    await waitUntil(() => td.daemon.mcp.live().length === 0, { describe: () => "文件写坏时转发程序也收了" });
    td.daemon.projects.act({ projectId: project.id, action: "unarchive" }, "k-unarchive");
    expect(await td.daemon.mcp.call(MCP, "say_back", { text: "回来了" })).toMatchObject({ isError: false, text: expect.stringContaining("念回来：回来了") });
  });

  it("名字不合 MCP 规矩的操作不转、自检写明；归档后没有了，恢复了又有，删除后没有了", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({ maintainer: () => [say("好")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([INBOX, PROJECTS, PM1].map((c) => [c, 0])));
    const project = await seededLedger(td, { tools: [monthOp, { ...statusOp, name: "ledger.status" }] });

    const tools = () => td.daemon.mcp.catalog().servers.find((s) => s.name === MCP)?.tools.map((t) => t.name);
    expect(tools()).toEqual(["month_report"]);
    const check = await eventually(() => recordsOf(frontend, PM1).map((r) => r.record), (r) => r.kind === "mcp", "自检的时间线");
    expect(check.summary).toContain("1 个工具");
    expect(check.detail).toContain("ledger.status");
    expect(td.daemon.projectOps.registry.checklistView(project)).toMatchObject({ state: "passed", count: 2, exported: 1 });

    // 归档：MCP 没有了、凭证作废；恢复使用又有了，名字不变（凭证是新的）
    const old = tokenOf(td);
    ok(await frontend.request(METHODS.projectAction, { projectId: project.id, action: "archive" }, "k-archive"));
    await waitUntil(() => tools() === undefined, { describe: () => "归档后没有了" });
    expect((await post(td.url, old, { method: "tools/list" })).status).toBe(401);
    ok(await frontend.request(METHODS.projectAction, { projectId: project.id, action: "unarchive" }, "k-unarchive"));
    await waitUntil(() => tools() !== undefined, { describe: () => "恢复后又有了" });
    expect(tokenOf(td)).not.toBe(old);
    expect((await post(td.url, tokenOf(td), { method: "tools/list" })).status).toBe(200);

    // 删除：先归档，再二次确认
    ok(await frontend.request(METHODS.projectAction, { projectId: project.id, action: "archive" }, "k-archive-2"));
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: project.id, action: "delete" }, "k-delete")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await waitUntil(() => td.daemon.projects.get(project.id) === undefined, { describe: () => "删掉了" });
    expect(td.daemon.mcp.has(MCP)).toBe(false);
    await frontend.close();
  });

  it("跑在 Claude Code 上的负责人也拿得到（假 SDK）：调 mcp__project-p-1__<操作> 真的走转发程序，记录写明调用者", { timeout: 180_000 }, async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: (id) => (id === "pm-1" ? [call(tool("month_report"), { month: "9" }), ECHO, say("好")] : [say("好")]),
    });
    const project = await seededLedger(td, LOCAL_OPS, { runtime: CLAUDE_CODE_RUNTIME_ID });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [PM1]: 0 });
    await frontend.sendText("九月花了多少", { conversation: maintainerChannel(project.maintainerId) });

    const done = await eventually(() => toolCallsOf(frontend, PM1), (c) => c.tool === tool("month_report") && c.outcome === "done", "Claude Code 负责人调到了", 90_000);
    expect(done.resultSummary).toContain("月花了 320 元");
    expect(calledEvents(td)).toMatchObject([{ op: "month_report", by: "agent", agentId: "pm-1", caller: "项目「记账本」的负责人", version: 1 }]);
    await waitUntil(() => recordsOf(frontend, PM1).some((r) => r.record.kind === "project_op"), { describe: () => "等时间线" });
    expect(td.daemon.mcp.live().map((l) => l.server)).toContain(MCP);
    await frontend.close();
  });
});
