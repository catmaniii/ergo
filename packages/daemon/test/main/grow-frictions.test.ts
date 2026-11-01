// 主切面：在二狗内部长服务这条路上的摩擦（362 号票，真模型试验 live-closed-loop-2026-11-01 查出来的）。真的守护进程，agent 接 faux 剧本，LSM 用替身：
// - 立项：秘书出卡时用户的话原样带上；点"立项"后负责人没等用户说话就开口，手里有用户的原话；
// - 服务没上线、挂了的通知不打断正在跑的报警工单：报警做完才开对话段处理，通知里写着服务管家的依据和先自己连一下核实；
// - 已登记的 MCP 进负责人的系统提示，任务书里的数据源真写进去；
// - 联网关着：真的子进程连得上本机、连不上外面（代理挡着），Python 用 UTF-8。
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type OperationsChangeCardPayload,
  type ProjectEventPayload,
  type ScheduledJobEventPayload,
  type SuggestProjectCardPayload,
} from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { registeredMcpText } from "../../src/mcp/texts.ts";
import { buildChildEnv, OFFLINE_SHELL_ENV, SCRIPT_UTF8_ENV } from "../../src/process/child-env.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { fixedContextText } from "../../src/work-orders/fixed-context.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { freePort } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);

async function connect(td: TestDaemon) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries([SECRETARY, CARDS, BOARD, PROJECTS, PM1].map((c) => [c, 0])));
  return frontend;
}

describe("立项：用户的话不丢，负责人先开口", () => {
  it("卡上带着用户那句话的原文和秘书抄的前面几句；点“立项”后负责人没等用户说话就开口，手里有用户的原话", async () => {
    const PATH = "C:\\Users\\假的\\drama\\retention.json";
    const td = await startTestDaemon({
      kickoffOpening: true,
      secretary: [call("suggest_project", { name: "留存盯盘", goal: "盯短剧留存，掉一半就报警", userWords: "前面说的：每分钟看一次" }), say("给你一张建议立项卡"), say("建好了")],
      maintainer: () => [ECHO],
    });
    const frontend = await connect(td);
    await frontend.sendText(`帮我做一个盯短剧数据的小服务。数据在 ${PATH}，平时不要用大模型。`);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "suggest_project", "建议立项卡");
    const payload = card.payload as SuggestProjectCardPayload;
    expect(payload.userWords).toContain(PATH);
    expect(payload.userWords).toContain("平时不要用大模型");
    expect(payload.userWords).toContain("前面说的：每分钟看一次");

    ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
    // 用户一句话都没对负责人说，它开口了：第一轮看到的输入里有用户的原话
    const replies = () => messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").map(textOf);
    await waitUntil(() => replies().length > 0, { timeoutMs: 30_000, describe: () => `负责人开口：${JSON.stringify(messagesOf(frontend, PM1).map(textOf))}` });
    expect(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "user")).toEqual([]);
    const opening = replies().join("\n");
    // 系统提示开头写明它是这个项目的负责人（用户说的负责人就是它）
    expect(opening).toContain("的负责人：这个项目由你长期维护");
    expect(opening).toContain("不用等用户开口");
    expect(opening).toContain(PATH);
    // 通知上写着项目，开了一个对话段（有 submit_charter 的那一段）
    expect(td.daemon.projects.get("p-1")?.state).toBe("preparing");
    expect(td.daemon.workOrders.current("pm-1")).toMatchObject({ kind: "chat", projectId: "p-1" });
  }, 60_000);

  it("默认不开的测试档（kickoffOpening 关着）照旧：只放一条说明，负责人休眠", async () => {
    const td = await startTestDaemon({ secretary: [], maintainer: () => [] });
    const frontend = await connect(td);
    const card = td.daemon.cards.create({ type: "suggest_project", payload: { name: "记账本", goal: "把账管起来" } });
    ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "created", "项目诞生");
    await waitUntil(() => messagesOf(frontend, PM1).length > 0, { describe: () => "说明" });
    expect(messagesOf(frontend, PM1).every((m) => m.agentInput !== true)).toBe(true);
    expect(td.daemon.workOrders.current("pm-1")).toBeUndefined();
  }, 30_000);
});

describe("服务没上线、挂了的通知不打断正在跑的报警", () => {
  it("报警工单跑着时服务被判挂了：通知排着，报警做完才开对话段处理；通知写着服务管家的依据、提示先连一下核实", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const realData = fs.realpathSync.native(dataDir);
    fs.mkdirSync(path.join(realData, "projects", "p-1", "workdir", "watcher"), { recursive: true });
    const records = path.join(realData, "projects", "p-1");
    const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";
    const progress = (text: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: PROGRESS_INTRO, newText: `${PROGRESS_INTRO}\n${text}` }] });
    const stub = () => Array.from({ length: 30 }, () => say("好"));
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const port = await freePort();
    const clock = new ManualClock(new Date(2026, 9, 8, 7, 30));
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      env: lsm.env,
      secretary: [say("好的")],
      // 报警那一次说得慢：通知来的时候它还在跑
      maintainerTokensPerSecond: (_id, spawn) => (spawn === 2 ? 40 : undefined),
      maintainer: (_id, spawn) =>
        spawn === 1
          ? stub()
          : spawn === 2
            ? [say("报警这一轮：".padEnd(800, "看")), progress("报警查完了"), call("write_segment_summary", { summary: "报警" }), say("报警做完了"), ...stub()]
            : [ECHO, ...stub()],
    });
    seedProject(td.daemon, "评论监控", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    const items = [
      {
        key: "watcher",
        name: "评论监控",
        means: "service",
        instructions: "一直盯着评论，有异常就报事件",
        capabilities: {},
        service: { name: "watcher", command: "node watch.js", port, cwd: "watcher", health: { path: "/health" } },
      },
      { key: "alert", name: "评论异常时处理", means: "event", event: { kind: "event", source: "service", events: ["reported"], filter: { name: "评论异常" } }, instructions: "看看报来的是什么", capabilities: {} },
    ];
    const proposed = await td.daemon.operations.tool("p-1", "pm-1").run({ items, why: "盯着评论" } as never, { toolCallId: "call-plan" });
    expect(proposed.isError ? proposed.text : true).toBe(true);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change" && (c.payload as OperationsChangeCardPayload).projectId === "p-1", "运营方案变更卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const live = () => td.daemon.projectServices.view().find((v) => v.app === "p-1-watcher");
    await waitUntil(() => live()?.rollout === "live", { timeoutMs: 20_000, describe: () => `上线：${JSON.stringify(live())}` });
    await waitUntil(() => td.daemon.eventTriggers.subscriptions().length > 0, { describe: () => "订阅跟上" });
    await waitUntil(() => td.daemon.workOrders.current("pm-1") === undefined, { timeoutMs: 20_000, describe: () => `对话段收尾：${JSON.stringify(td.daemon.workOrders.current("pm-1"))}` }).catch(() => {});

    const token = fs.readFileSync(path.join(realData, "secrets", "service-tokens", "p-1-watcher.token"), "utf8");
    const reported = await fetch(new URL("/api/service-events", td.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ event: "评论异常" }) });
    expect(reported.status).toBe(202);
    const started = await eventually(() => jobsOf(frontend), (e) => e.change === "run_started", "报警运行开始", 60_000);

    // 服务管家把它判成挂了（照 LSM 报的状态），持续够久：通知来了，标着只在对话段处理
    lsm.owned.setState("p-1-watcher", "FAILED", "端口没人在听");
    await waitUntil(() => live()?.status === "failed", { describe: () => `状态：${JSON.stringify(live())}` });
    clock.advance(31_000);
    const isDown = (m: MessageEventPayload) => textOf(m).includes("上线后挂了");
    await waitUntil(() => messagesOf(frontend, PM1).some(isDown), { timeoutMs: 20_000, describe: () => "挂了的通知" });
    const notice = messagesOf(frontend, PM1).find(isDown)!;
    expect(notice).toMatchObject({ agentInput: true, chatOnly: true, projectId: "p-1" });
    expect(notice.scheduledJobId).toBeUndefined();
    expect(textOf(notice)).toContain("服务管家（LSM）判断的依据：端口没人在听");
    expect(textOf(notice)).toContain(`http://127.0.0.1:${port}/health`);
    expect(textOf(notice)).toContain("先自己连一下");
    // 这时报警那一段还在跑，手上是它的工单
    expect(td.daemon.workOrders.current("pm-1")).toMatchObject({ kind: "work_order" });

    // 报警做完了才开对话段，通知在对话段里处理（这一段有交方案的工具）
    await eventually(() => jobsOf(frontend), (e) => e.change === "run_finished" && e.run?.runId === started.run?.runId, "报警运行结束", 120_000);
    const replies = () => messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").map(textOf);
    await waitUntil(() => replies().some((t) => t.includes("上线后挂了")), { timeoutMs: 30_000, describe: () => "对话段里处理通知" });
    expect(td.daemon.workOrders.current("pm-1")).toMatchObject({ kind: "chat" });
    // 报警那一轮的回复里没有通知的内容：没被打断
    const alarm = replies().find((t) => t.startsWith("报警这一轮："))!;
    expect(alarm).not.toContain("上线后挂了");
    expect(replies()).toContain("报警做完了");

  }, 240_000);
});

describe("负责人知道库里有哪些 MCP；任务书里的数据源真写进去", () => {
  const SERVERS = [{ name: "retention-board", title: "短剧看板", tools: [{ name: "list_episodes", title: "列出各集", description: "按剧名列出每集的留存曲线\n第二行不要" }, { name: "get_alerts", title: "最近报警" }] }];

  it("清单写名字、说明、工具；一个都没登记时不写", () => {
    const text = registeredMcpText(SERVERS)!;
    expect(text).toContain("retention-board（短剧看板）");
    expect(text).toContain("list_episodes（列出各集：按剧名列出每集的留存曲线）");
    expect(text).toContain("get_alerts（最近报警）");
    expect(text).toContain("toolkit.mcp");
    expect(text).not.toContain("第二行不要");
    expect(registeredMcpText([])).toBeUndefined();
  });

  it("项目负责人每一段的固定上下文里有清单", () => {
    const text = fixedContextText({
      segment: { segmentId: "pm-1-s1", maintainerId: "pm-1", projectId: "p-1", kind: "chat", session: "pm-1-s1", reset: false, state: "open", progressHash: "x", openedAt: "2026-11-01T00:00:00+08:00" },
      standard: "规范",
      toolkit: { skills: [], mcp: [], bash: true, network: false },
      tools: ["read"],
      registeredMcp: registeredMcpText(SERVERS),
      records: { spec: "", progress: "", glossary: "" },
      previous: undefined,
      workOrder: undefined,
    });
    expect(text).toContain("已登记的 MCP");
    expect(text).toContain("retention-board");
  });

  it("任务的负责人系统提示里有清单（起草计划时就看得到）；任务书的数据源写进交给它的那条", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const config = path.join(fs.realpathSync.native(dataDir), "config");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "mcp.json"), JSON.stringify({ servers: { "retention-board": { title: "短剧看板", command: "node", args: ["-e", "0"], tools: { list_episodes: { title: "列出各集", readOnlyOrIdempotent: true, network: false } } } } }));
    const td = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, secretary: [], maintainer: () => [ECHO, say("好")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [maintainerChannel("tm-1")]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "写周报", summary: "写周报" });
    td.daemon.tasks.writeBrief(task.id, { goal: "写周报", acceptanceCriteria: ["有 weekly.md"], constraints: [], projects: [], memoryScope: "", dataSources: ["MCP retention-board", "D:\\数据\\retention.json"] });
    const channel = maintainerChannel(task.maintainerId);
    await frontend.subscribe({ [channel]: 0 });
    const seen = () => messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").map(textOf).join("\n");
    await waitUntil(() => seen().includes("[system]"), { timeoutMs: 30_000, describe: () => `负责人起草：${seen()}` });
    // 系统提示里有清单，还没配进工具包也看得到；任务书里写着数据源
    expect(seen()).toContain("已登记的 MCP");
    expect(seen()).toContain("retention-board（短剧看板）：list_episodes（列出各集）");
    expect(seen()).toContain("数据源：");
    expect(seen()).toContain("MCP retention-board");
    expect(seen()).toContain("D:\\数据\\retention.json");
    // 系统提示开头写明它是这个任务的负责人（用户说的负责人就是它）
    expect(seen()).toContain("一个任务的负责人：");
  }, 60_000);
});

describe("联网关着：真的子进程", () => {
  const OFFLINE = () => buildChildEnv(process.env, { ...OFFLINE_SHELL_ENV, ...SCRIPT_UTF8_ENV });

  /** 本机起一个 HTTP 服务（系统挑端口，只听 127.0.0.1） */
  async function localServer() {
    const server = http.createServer((_req, res) => res.end("本机活着"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => void server.close());
    return (server.address() as AddressInfo).port;
  }
  const has = (program: string) => spawnSync(program, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
  /** 真的起一个子进程（不用同步的：本机服务就在这个进程里，同步等它就回不了话） */
  const run = (program: string, args: readonly string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(program, args, { env: OFFLINE(), encoding: "utf8", timeout: 40_000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      });
    });
  /** 外面的地址（TEST-NET：就算没被挡也到不了，这里只看走的是死代理） */
  const OUTSIDE = "http://203.0.113.1/";

  it("Node 的 fetch：连得上 127.0.0.1、localhost；外面的走死代理连不上", async () => {
    const port = await localServer();
    const script = (url: string) => `fetch(${JSON.stringify(url)}).then(async (r) => console.log("OK", await r.text()), (e) => { console.log("FAILED", e.cause?.code ?? e.message); process.exit(3); })`;
    for (const host of ["127.0.0.1", "localhost"]) {
      const local = await run(process.execPath, ["-e", script(`http://${host}:${port}/health`)]);
      expect(local.stdout).toContain("OK 本机活着");
    }
    const outside = await run(process.execPath, ["-e", script(OUTSIDE)]);
    expect(outside.status).toBe(3);
    expect(outside.stdout).toContain("ECONNREFUSED");
  }, 60_000);

  it("Python：urllib 连得上本机，外面的连不上；socket、http.server 也能跑；打印中文不乱码", async () => {
    if (!has("python")) return;
    const port = await localServer();
    const script = `
import urllib.request, socket, http.server, sys
print(sys.stdout.encoding.lower(), "中文")
print(urllib.request.urlopen("http://127.0.0.1:${port}/health", timeout=10).read().decode())
s = socket.create_connection(("127.0.0.1", ${port}), timeout=10); s.close(); print("socket 连上了")
try:
    urllib.request.urlopen("${OUTSIDE}", timeout=10)
    print("外面连上了")
except Exception as e:
    print("外面连不上", type(e).__name__)
`;
    const python = await run("python", ["-c", script]);
    expect(python.stderr).toBe("");
    expect(python.stdout).toContain("utf-8 中文");
    expect(python.stdout).toContain("本机活着");
    expect(python.stdout).toContain("socket 连上了");
    expect(python.stdout).toContain("外面连不上");
    expect(python.stdout).not.toContain("外面连上了");
  }, 60_000);

  it("curl：连得上本机，外面的连不上", async () => {
    if (!has("curl")) return;
    const port = await localServer();
    const local = await run("curl", ["-s", "--max-time", "10", `http://127.0.0.1:${port}/health`]);
    expect(local.stdout).toContain("本机活着");
    const outside = await run("curl", ["-s", "--max-time", "10", OUTSIDE]);
    expect(outside.status).not.toBe(0);
  }, 60_000);
});
