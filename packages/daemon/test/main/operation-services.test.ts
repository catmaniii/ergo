// 主切面：运营手段"服务"（133 号票）。真的守护进程，项目的维护者和秘书接 faux 剧本，LSM 用替身（helpers/lsm-stand-in.ts：owned 打开时
// 扮演支持名下服务的新管理器，不起真进程），"上线的服务"是起在随机端口上的假服务（helpers/fake-app.ts），测试扮演前端。
// - 建设期间交带服务的运营方案（维护者经 agent 宿主真的调 propose_operations）：卡上写"上线服务「X」（端口 …，开机自启）"；
//   确认并转入使用后经 LSM 登记（命令、工作目录、端口、开机自启、密钥的引用换成密钥区里的文件、注入 ERGO_BASE_PATH）、启动，
//   转发登记 /apps/<项目>-<服务>/；项目的服务（在线、入口）经临时事件推给前端，新连上的前端订阅时就拿到；秘书给出入口卡，查看板看得到；
// - 启动失败：这一条标失败（原因来自 LSM），通知维护者，项目照常使用中、别的照常；维护者照旧再交一份，确认后重新开起来；
// - 挂了自动重启照维护者写的登记、卡上写明；上线后又挂了：不在线持续一段时间才通知维护者（LSM 给的原因），重启一下不报，
//   同一次故障只报一次，好了再说一声；用户那边不额外打扰；
// - LSM 版本不支持名下的服务：标"要你手动"，一条 services.* 都不发；
// - 使用中改方案（更新登记、重启）、停用（撤下、撤掉转发）、重新启用（重新登记、启动）、归档、取消归档、方案里去掉；
// - 交方案时的校验：工作目录出界、密钥、二狗自己的端口、同名同端口、不守前缀约定（服务正好在跑时自检）整份退回；
// - 257 号票：使用中的项目在项目卡片、项目页上"启动""关闭"——关闭全部停、取消开机自启，重启守护进程后仍关着；启动重新登记、
//   恢复开机自启；做到一半又点照最新的来；秘书照用户说的启停（同一个入口）；LSM 没连上、项目停用了的被拒。
// - 269 号票：二狗接上 LSM 时兜底——电脑重启后 LSM 没拉（替身的 owned.reboot）、LSM 重启后重新接上（替身的 drop），上线了、用户没关的
//   服务停着就整份登记、启动，记上线的结果（带 revive）；在跑的不动；接上之后又挂了不自动拉（照 133 通知维护者）；关着的不拉；
//   拉不起来记上线失败和原因、通知维护者。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type BuildDoneCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  nowIso,
  type OperationsChangeCardPayload,
  type Project,
  type ProjectEventPayload,
  type ProjectServicesEventPayload,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import { PROJECT_SERVICE_EVENTS } from "../../src/project-services/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeApp } from "../helpers/fake-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { type LsmStandIn, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { freePort } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 7, 30);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
const summary = (text: string) => call("write_segment_summary", { summary: text });
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 每天 08:00 出日报 */
const DAILY = { key: "daily-report", name: "日报", means: "schedule", schedule: { kind: "daily", time: "08:00" }, instructions: "汇总昨天的 AI 新闻，写一期日报", capabilities: { network: true } };

/** 简报站网页：要上线的服务（端口是假服务的） */
const site = (port: number, service: Record<string, unknown> = {}) => ({
  key: "site",
  name: "简报站",
  means: "service",
  instructions: "简报站的网页：每天的日报、周报给手机看",
  capabilities: {},
  service: {
    name: "site",
    command: "node server.mjs",
    cwd: "site",
    port,
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "INTEL_API_KEY", secret: "intel-key.txt" },
      { name: "HF_HOME", userEnv: true, optional: true },
    ],
    health: { path: "/" },
    web: { home: "/" },
    ...service,
  },
});

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const servicesFramesOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.projectServices }).map((f) => (f.payload as ProjectServicesEventPayload).services);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const latest = (frontend: TestFrontend, cardId: string) => cardsOf(frontend).filter((c) => c.id === cardId).at(-1)!;

async function connect(td: TestDaemon, channels: string[] = [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 数据目录、主目录、项目档案和工作目录里服务的目录（先建好：工作目录要存在） */
function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  const realData = fs.realpathSync.native(dataDir);
  const records = path.join(realData, "projects", "p-1");
  const siteDir = path.join(records, "workdir", "site");
  fs.mkdirSync(siteDir, { recursive: true });
  return { dataDir, realData, homeDir: makeTempDir("ergo-home-"), records, siteDir };
}

/** 建设中的项目（立项书已确认，能联网），建设任务 t-1 */
function buildingProject(td: TestDaemon): Project {
  const project = seedProject(td.daemon, "AI 简报站", { state: "building", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true }, buildTaskId: "t-1" });
  internalTask(td.daemon, "AI 简报站", "建设「AI 简报站」首版");
  return project;
}

function finishBuild(td: TestDaemon, taskId = "t-1") {
  const task = td.daemon.tasks.get(taskId)!;
  const payload: TaskEventPayload = { task: { ...task, state: "done", updatedAt: nowIso() }, change: "finished" as TaskEventPayload["change"], from: task.state, by: "maintainer" };
  td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload });
  td.daemon.projects.taskCompleted(payload.task);
}

/** 项目的维护者交运营方案（直接调它的工具：和维护者调的是同一个） */
async function propose(td: TestDaemon, items: readonly object[], why = "要长期运转") {
  return td.daemon.operations.tool("p-1", "pm-1").run({ items, why } as never, { toolCallId: `call-${Math.random()}` });
}

/** 交方案的工具收下了（没收下时把原因带出来，断言失败时看得到） */
const accepted = (r: { text: string; isError?: boolean }): true | string => (r.isError ? r.text : true);

/** 建设期间交了方案、建设做完、在"首版做完了"卡上确认并转入使用 */
async function putInUse(td: TestDaemon, frontend: TestFrontend, items: readonly object[]) {
  const proposed = await propose(td, items);
  expect(accepted(proposed)).toBe(true);
  finishBuild(td);
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");
  ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: card.version }, "k-put"));
  await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
  return card;
}

/** 等项目的服务到某个样子 */
const serviceNow = (td: TestDaemon, app = "p-1-site") => td.daemon.projectServices.view().find((v) => v.app === app);
async function untilService(td: TestDaemon, match: (v: NonNullable<ReturnType<typeof serviceNow>>) => boolean, what: string) {
  await waitUntil(() => {
    const v = serviceNow(td);
    return v !== undefined && match(v);
  }, { timeoutMs: 20_000, describe: () => `等服务${what}：现在 ${JSON.stringify(serviceNow(td))}` });
  return serviceNow(td)!;
}

/** 经守护进程转发打开服务的首页 */
const openApp = (td: TestDaemon, app = "p-1-site") => fetch(new URL(`/apps/${app}/`, td.url));

/** 用到的 services.* 请求的种类（按先后） */
const requestTypes = (lsm: LsmStandIn, from = 0) => lsm.serviceRequests().slice(from).map((m) => m.type);

describe("运营手段“服务”：确认后经 LSM 上线，项目卡片上有入口", () => {
  it("建设期间交带服务的方案、卡上写明；确认并转入使用：LSM 登记（密钥只写引用、注入前缀）、启动、开机自启，转发登记；在线状态推给前端；秘书给出入口、查看板看得到", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [call("open_service", { service: "简报站" }), call("view_board", {}), ECHO],
      maintainer: () => [
        call("propose_operations", { items: [DAILY, site(app.port)], why: "日报每天出，网页给手机看" }),
        progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了日报和简报站网页。"),
        summary("交了运营方案（日报、简报站网页）"),
        ECHO,
      ],
    });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    // 握手声明会用名下的服务
    expect(lsm.messages.find((m) => m.message.type === "hello")?.message.features).toEqual(["services"]);

    // 维护者交方案：服务那一条收下（服务正好在跑：顺手做了前缀下自检）
    await frontend.sendText("做完以后每天 8 点出日报，网页也上线，手机上能打开", { conversation: PM1 });
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 30_000, describe: () => "维护者处理完" });
    await settled(td, "pm-1");
    const echo = textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!);
    // 工具说明里列着"服务"这种手段、要写哪几项
    expect(td.daemon.operations.tool("p-1", "pm-1").spec.description).toContain("service（项目自己的服务（登记到 LSM））：项目做成一个要常驻的服务");
    expect(echo).toContain("运营方案（第 1 份，2 条）收下了");
    expect(echo).toContain("服务「简报站」的首页前缀下自检过了");

    // 建设任务做完：卡上写"上线服务「简报站」（端口 …，开机自启）"，服务的定义补齐了（工作目录是绝对路径）
    finishBuild(td);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");
    expect(card.typeVersion).toBe(4);
    const item = (card.payload as BuildDoneCardPayload).operations!.items.find((i) => i.key === "site")!;
    expect(item).toMatchObject({
      means: "service",
      automatic: true,
      triggerText: `上线服务「简报站」（端口 ${app.port}，开机自启）`,
      service: { name: "site", app: "p-1-site", cwd: d.siteDir, port: app.port, autostart: true, web: { home: "/", prefix: "strip" } },
    });
    expect(card.text).toContain(`上线服务「简报站」（端口 ${app.port}，开机自启）`);

    // 确认并转入使用：服务那一条交给 LSM（不建任务），日报建成内部任务
    const before = lsm.serviceRequests().length;
    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: card.version }, "k-put"));
    const inUse = await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    expect(inUse.project.operations?.items.map((i) => [i.key, i.taskId])).toEqual([
      ["daily-report", "t-2"],
      ["site", undefined],
    ]);
    const live = await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");
    expect(live).toMatchObject({ projectId: "p-1", key: "site", title: "简报站", name: "site", app: "p-1-site", port: app.port, autostart: true, url: "/apps/p-1-site/" });
    expect(requestTypes(lsm, before)).toEqual(["services.put", "services.start"]);
    // 登记的定义：名字是 <项目>-<服务>、密钥换成密钥区里的文件、注入 ERGO_BASE_PATH、开机自启
    expect(lsm.serviceRequests()[before]!.service).toEqual({
      name: "p-1-site",
      title: "AI 简报站 · 简报站",
      project: "二狗 · AI 简报站",
      command: `"${process.execPath}" server.mjs`, // 324：命令开头的 node 换成二狗自己那份 Node
      cwd: d.siteDir,
      port: app.port,
      env: [
        { name: "NODE_ENV", from: "literal", value: "production" },
        { name: "INTEL_API_KEY", from: "file", path: path.join(d.realData, "secrets", "intel-key.txt") },
        { name: "HF_HOME", from: "userEnv", optional: true },
        { name: "ERGO_BASE_PATH", from: "literal", value: "/apps/p-1-site" },
        // 312 号票：另带一份旧名字的（早先做的服务读的是它）
        { name: "ERGOU_BASE_PATH", from: "literal", value: "/apps/p-1-site" },
      ],
      health: { path: "/" },
      autostart: true,
      autoRestart: false,
    });
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "RUNNING", autostart: true });

    // 经二狗转发打开得到服务的首页
    const page = await openApp(td);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("简报站首页");
    // 在线状态和入口推给了前端；新连上的前端订阅项目列表频道时就拿到
    await eventually(() => servicesFramesOf(frontend), (s) => s.some((v) => v.app === "p-1-site" && v.status === "online"), "前端收到在线的服务");
    const fresh = await connect(td, [PROJECTS]);
    await eventually(() => servicesFramesOf(fresh), (s) => s.some((v) => v.app === "p-1-site" && v.rollout === "live" && v.url === "/apps/p-1-site/"), "新连上的前端拿到服务");

    // LSM 推来服务挂了：状态跟着变（入口还在，点开是"现在没在运行"的说明）
    lsm.owned.setState("p-1-site", "FAILED", "进程退出了（退出码 1）");
    await untilService(td, (v) => v.status === "failed", "失败");
    expect(serviceNow(td)).toMatchObject({ rollout: "live", detail: "进程退出了（退出码 1）" });
    lsm.owned.setState("p-1-site", "RUNNING");
    await untilService(td, (v) => v.status === "online", "又在线了");

    // 秘书：用户说"打开简报站"，秘书把入口放进聊天（服务入口卡，出来就是已处理）；查看板看得到服务在线
    await frontend.sendText("打开简报站");
    const entry = await eventually(() => cardsOf(frontend), (c) => c.type === "service_entry", "服务入口卡");
    expect(entry).toMatchObject({ status: "handled", payload: { projectId: "p-1", projectName: "AI 简报站", key: "site", title: "简报站", app: "p-1-site", url: "/apps/p-1-site/" } });
    await waitUntil(() => messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === entry.id)), { describe: () => "入口卡出在秘书的聊天里" });
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 30_000, describe: () => "秘书处理完" });
    const board = textOf(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(board).toContain("项目的服务（运营方案里上线到 LSM 的；用户要打开时用 open_service 把入口放进聊天）：");
    expect(board).toContain(`服务「简报站」（p-1 · p-1-site · 端口 ${app.port}）：在线，入口 /apps/p-1-site/`);
    expect(board).toContain("已把入口放进聊天：用户点卡上的“打开「简报站」”就在内置浏览器里打开");
  }, 180_000);

  it("启动失败：这一条标失败（原因来自 LSM）、通知维护者，项目照常使用中、日报照常；照旧再交一份，确认后重新开起来", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const td = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => [say("收到，我看看"), say("好")] });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    lsm.owned.failNextStart("p-1-site", `端口 ${app.port} 已被 node.exe (4321) 占着`);

    await putInUse(td, frontend, [DAILY, site(app.port)]);
    const failed = await untilService(td, (v) => v.rollout === "failed", "上线失败");
    expect(failed.reason).toBe(`端口 ${app.port} 已被 node.exe (4321) 占着`);
    // 项目照常使用中，日报照常建成；转发没有登记（打开是"没有这个应用"）
    expect(td.daemon.projects.get("p-1")).toMatchObject({ state: "in_use" });
    expect(td.daemon.tasks.get("t-2")).toMatchObject({ title: "日报", state: "operating" });
    expect((await openApp(td)).status).toBe(404);
    // 维护者收到通知（写明原因、怎么办）
    await waitUntil(
      () => messagesOf(frontend, PM1).some((m) => textOf(m).includes("运营方案里的服务「简报站」（p-1-site，端口") && textOf(m).includes(`没上线：端口 ${app.port} 已被 node.exe (4321) 占着`)),
      { describe: () => "维护者收到上线失败的通知" },
    );
    await settled(td, "pm-1");

    // 照旧再交一份：上线失败的那一条算"重新开起来"，出变更卡，确认后再登记、启动
    const again = await propose(td, [DAILY, site(app.port)], "端口腾出来了，重新开起来");
    expect(accepted(again)).toBe(true);
    const change = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change", "运营方案变更卡");
    expect(change.typeVersion).toBe(2);
    expect((change.payload as OperationsChangeCardPayload).restored.map((i) => i.key)).toEqual(["site"]);
    const from = lsm.serviceRequests().length;
    ok(await frontend.cardAction({ cardId: change.id, action: "confirm", expectedVersion: change.version }, "k-again"));
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "重新开起来");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect((await openApp(td)).status).toBe(200);
  }, 120_000);

  it("挂了自动重启照维护者写的登记、卡上写明；上线后又挂了：不在线持续一段时间才通知维护者（LSM 给的原因），重启一下不报，同一次故障只报一次，好了再说一声", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ clock, reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 10 }, () => say("好")) });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");

    // 维护者写了挂了自动重启：卡上那一条写明，登记时照它
    const card = await putInUse(td, frontend, [site(app.port, { autoRestart: true })]);
    const item = (card.payload as BuildDoneCardPayload).operations!.items[0]!;
    expect(item.triggerText).toBe(`上线服务「简报站」（端口 ${app.port}，开机自启，挂了自动重启）`);
    expect(item.service).toMatchObject({ autostart: true, autoRestart: true });
    expect(card.text).toContain("挂了自动重启");
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");
    expect(lsm.serviceRequests().find((m) => m.type === "services.put")?.service).toMatchObject({ autostart: true, autoRestart: true });
    await settled(td, "pm-1");

    const notices = () => messagesOf(frontend, PM1).map(textOf).filter((t) => t.includes("上线后挂了") || t.includes("又在线了"));
    const inboxBefore = frontend.events({ channel: INBOX }).length;

    // 重启一下（停止中、启动中、又在线）：不报
    lsm.owned.setState("p-1-site", "STOPPING");
    await untilService(td, (v) => v.status === "stopping", "停止中");
    lsm.owned.setState("p-1-site", "STARTING");
    lsm.owned.setState("p-1-site", "RUNNING");
    await untilService(td, (v) => v.status === "online", "又在线");
    clock.advance(60_000);
    expect(notices()).toEqual([]);

    // 挂了：持续 30 秒才通知维护者，写明 LSM 给的原因
    lsm.owned.setState("p-1-site", "FAILED", "进程退出了（退出码 1）");
    await untilService(td, (v) => v.status === "failed", "失败");
    clock.advance(10_000);
    expect(notices()).toEqual([]);
    clock.advance(21_000);
    await waitUntil(() => notices().length === 1, { describe: () => `维护者收到挂了的通知：${JSON.stringify(notices())}` });
    expect(notices()[0]).toContain(`服务「简报站」（p-1-site，端口 ${app.port}）上线后挂了，现在不在线：进程退出了（退出码 1）。它开着挂了自动重启`);
    await settled(td, "pm-1");
    // 同一次故障只报一次
    lsm.owned.setState("p-1-site", "STARTING");
    lsm.owned.setState("p-1-site", "FAILED", "进程退出了（退出码 1）");
    clock.advance(60_000);
    expect(notices()).toHaveLength(1);

    // 好了：又在线持续 30 秒说一声
    lsm.owned.setState("p-1-site", "RUNNING");
    await untilService(td, (v) => v.status === "online", "又在线");
    clock.advance(31_000);
    await waitUntil(() => notices().length === 2, { describe: () => `维护者收到好了的通知：${JSON.stringify(notices())}` });
    expect(notices()[1]).toContain("服务「简报站」（p-1-site）又在线了");
    await settled(td, "pm-1");
    // 用户这边不额外打扰：没有新的待办，秘书那边什么都没说
    expect(frontend.events({ channel: INBOX }).length).toBe(inboxBefore);
    expect(messagesOf(frontend, SECRETARY).filter((m) => textOf(m).includes("挂了"))).toEqual([]);
  }, 120_000);

  it("LSM 版本不支持名下的服务：这一条标“要你手动”（不假装生效），一条 services.* 都不发；转发不登记", async () => {
    const d = dirs();
    // 老管理器：welcome 里没有 features
    const lsm = await startLsmStandIn({ heartbeatIntervalMs: 60_000 });
    const td = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => [say("知道了")] });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [site(18999)]);
    const manual = await untilService(td, (v) => v.rollout === "manual", "要你手动");
    expect(manual.reason).toBe("LSM 版本不支持名下的服务，需要手动在 LSM 里登记（LSM 升级、重启后二狗会自动补上）");
    expect(lsm.serviceRequests()).toEqual([]);
    expect((await openApp(td)).status).toBe(404);
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => textOf(m).includes("现在没法替用户上线：LSM 版本不支持名下的服务")), { describe: () => "维护者知道要手动" });
    await eventually(() => servicesFramesOf(frontend), (s) => s.some((v) => v.app === "p-1-site" && v.rollout === "manual"), "前端看到要你手动");
  }, 120_000);
});

describe("使用中改方案、停用、重新启用、归档时，服务的登记、启停和转发跟着变", () => {
  it("改了的更新登记、重启；停用撤下、撤掉转发；重新启用重新登记、启动；归档同停用，取消归档恢复；方案里去掉的撤下", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const td = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 10 }, () => say("好")) });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [DAILY, site(app.port)]);
    await untilService(td, (v) => v.rollout === "live", "上线");
    const done = new Set<string>();
    const confirmChange = async (items: readonly object[], key: string) => {
      const r = await propose(td, items, key);
      expect(accepted(r)).toBe(true);
      const card = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change" && !done.has(c.id), `变更卡（${key}）`);
      done.add(card.id);
      ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }, key));
      await waitUntil(() => latest(frontend, card.id).status === "handled", { describe: () => `变更卡（${key}）处理了` });
      return card;
    };

    // 改了启动命令：更新登记（整份替换）、在跑的重启（强制：没有停机命令）；同一个任务编号都不占
    let from = lsm.serviceRequests().length;
    const changed = await confirmChange([DAILY, site(app.port, { command: "node server.mjs --quiet" })], "改命令");
    expect((changed.payload as OperationsChangeCardPayload).changed.map((c) => [c.after.key, c.inPlace])).toEqual([["site", false]]);
    await waitUntil(() => requestTypes(lsm, from).includes("services.restart"), { describe: () => `更新登记、重启：${JSON.stringify(requestTypes(lsm, from))}` });
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.restart"]);
    expect(lsm.serviceRequests().at(-1)).toMatchObject({ name: "p-1-site", force: true });
    expect(lsm.owned.services.get("p-1-site")?.definition.command).toBe(`"${process.execPath}" server.mjs --quiet`);
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "改好了照常在线");
    expect((latest(frontend, changed.id).payload as OperationsChangeCardPayload).decided?.results?.find((r) => r.key === "site")).toMatchObject({ outcome: "recreated" });

    // 停用：撤下（LSM 里撤销）、撤掉转发
    from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "retire"));
    await untilService(td, (v) => v.rollout === "withdrawn", "撤下");
    expect(requestTypes(lsm, from)).toEqual(["services.remove"]);
    expect(lsm.owned.services.has("p-1-site")).toBe(false);
    expect((await openApp(td)).status).toBe(404);

    // 重新启用：重新登记、启动，转发回来
    from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "reactivate" }, "reactivate"));
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "重新上线");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(lsm.owned.services.get("p-1-site")?.definition.command).toBe(`"${process.execPath}" server.mjs --quiet`);
    expect((await openApp(td)).status).toBe(200);

    // 归档：同停用
    from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "archive"));
    await untilService(td, (v) => v.rollout === "withdrawn", "归档时撤下");
    expect(requestTypes(lsm, from)).toEqual(["services.remove"]);
    expect((await openApp(td)).status).toBe(404);
    // 取消归档回到使用中：重新上线
    from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "unarchive"));
    await untilService(td, (v) => v.rollout === "live", "取消归档后重新上线");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);

    // 方案里去掉：撤下、撤掉转发（日报照旧）
    from = lsm.serviceRequests().length;
    const removed = await confirmChange([DAILY], "去掉网页");
    expect((removed.payload as OperationsChangeCardPayload).removed.map((i) => i.key)).toEqual(["site"]);
    await untilService(td, (v) => v.rollout === "withdrawn", "去掉后撤下");
    expect(requestTypes(lsm, from)).toEqual(["services.remove"]);
    expect((await openApp(td)).status).toBe(404);
    expect(td.daemon.tasks.get("t-2")).toMatchObject({ state: "operating" });
  }, 180_000);
});

describe("交带服务的运营方案时的校验", () => {
  it("工作目录出界、不存在，环境变量里写了密钥、自己写 LSM_ / ERGO_BASE_PATH，二狗自己的端口，同名同端口，都整份退回；有网页的服务正好在跑、不守前缀约定的也退回", async () => {
    const d = dirs();
    const td = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, secretary: [say("好的")], maintainer: () => [say("好")] });
    buildingProject(td);
    const outside = makeTempDir("ergo-outside-");

    const bad = await propose(td, [
      site(18001, { cwd: outside }),
      { ...site(18002, { name: "api", cwd: "nope", env: [{ name: "OPENAI_API_KEY", value: "abc" }, { name: "GREETING", value: fakeSecret("sk-", "abcdefghijklmnopqrstuvwxyz") }, { name: "LSM_TOKEN", userEnv: true }, { name: "ERGO_BASE_PATH", value: "/x" }] }), key: "api", name: "接口" },
      { ...site(td.daemon.localPort, { name: "own" }), key: "own", name: "占二狗的端口" },
      { ...site(18001, { name: "site" }), key: "dup", name: "重名" },
      { ...site(18003), schedule: { kind: "daily", time: "08:00" }, key: "timed", name: "带时间表", service: { ...site(18003).service, name: "timed" } },
    ]);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain(`第 1 条「简报站」：工作目录 ${outside} 出界了：要在项目的工作目录（${path.join(d.records, "workdir")}）或项目档案（${d.records}）里面`);
    expect(bad.text).toContain(`第 2 条「接口」：工作目录 ${path.join(d.records, "workdir", "nope")} 不存在（或者不是目录）`);
    expect(bad.text).toContain("第 2 条「接口」：环境变量 OPENAI_API_KEY 看名字是密钥，方案里不能写值");
    expect(bad.text).toContain("第 2 条「接口」：环境变量 GREETING 的值看着像密钥");
    expect(bad.text).toContain("第 2 条「接口」：环境变量 LSM_TOKEN：LSM_ 开头的是 LSM 注入的接入身份，不能自己写");
    expect(bad.text).toContain("第 2 条「接口」：环境变量 ERGO_BASE_PATH 由运行时注入");
    expect(bad.text).toContain(`第 3 条「占二狗的端口」：端口 ${td.daemon.localPort} 已经是二狗的本机端口的了：换一个`);
    expect(bad.text).toContain("「简报站」和「重名」的服务名都是 site：一个项目里的服务名不能重");
    expect(bad.text).toContain("「简报站」和「重名」都用端口 18001：换一个");
    expect(bad.text).toContain("第 5 条「带时间表」：服务那一条不写 schedule、event");
    expect(td.daemon.operations.pendingBuildPlan("p-1")).toBeUndefined();

    // 有网页的服务正好在跑，首页里有以 / 开头的地址：前缀下自检不过，退回并列出来
    const root = http.createServer((_req, res) => res.end('<!doctype html><html><head><script src="/assets/app.js"></script></head><body><a href="detail">x</a></body></html>'));
    await new Promise<void>((resolve) => root.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => root.close(() => resolve())));
    const port = (root.address() as AddressInfo).port;
    const offPrefix = await propose(td, [site(port)]);
    expect(offPrefix.isError).toBe(true);
    expect(offPrefix.text).toContain("第 1 条「简报站」：网页没守前缀约定");
    expect(offPrefix.text).toContain("- src: /assets/app.js  以 / 开头、不在前缀下");

    // 没在跑的：收下，写明上线后再查
    const idle = await freePort();
    const later = await propose(td, [site(idle)]);
    expect(accepted(later)).toBe(true);
    expect(later.text).toContain(`服务「简报站」现在没在跑（本机端口 ${idle} 没有响应），没做前缀下自检`);
    expect(td.daemon.operations.pendingBuildPlan("p-1")?.items[0]).toMatchObject({ key: "site", service: { cwd: d.siteDir, autostart: true } });
  }, 60_000);
});

/** 257：发一次启动 / 关闭（和项目卡片、项目页上的按钮发的一样） */
const power = (frontend: TestFrontend, action: "start" | "stop", key: string) => frontend.request(METHODS.projectServicesAction, { projectId: "p-1", action }, key);
/** 257：记下的开关 */
const powerEvents = (td: TestDaemon) => td.daemon.store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.power).map((e) => e.payload as { on: boolean; by: string });

describe("使用中的项目：项目卡片、项目页上的“启动”“关闭”，秘书也能启停（257 号票）", () => {

  it("关闭：全部停、取消开机自启（转发留着）；重启守护进程后仍关着、不去拉起；启动：重新登记（恢复开机自启）、启动；做到一半又点照最新的来", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const daemonOptions = { reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 10 }, () => say("好")) };
    const td = await startTestDaemon({ clock: new ManualClock(START), ...daemonOptions });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [DAILY, site(app.port)]);
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");

    // 关闭：先取消开机自启、再强制停；项目照旧使用中，转发留着（服务关着时打开是"没在运行"的说明页）
    let from = lsm.serviceRequests().length;
    expect(ok(await power(frontend, "stop", "k-stop"))).toEqual({ projectId: "p-1", action: "stop", services: 1 });
    await untilService(td, (v) => v.paused === true && v.power === undefined && v.status === "offline", "关着");
    expect(requestTypes(lsm, from)).toEqual(["services.autostart", "services.stop"]);
    expect(lsm.serviceRequests().slice(from)).toMatchObject([
      { name: "p-1-site", on: false },
      { name: "p-1-site", force: true },
    ]);
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "STOPPED", autostart: false });
    expect(td.daemon.projects.get("p-1")).toMatchObject({ state: "in_use" });
    expect(td.daemon.tasks.get("t-2")).toMatchObject({ state: "operating" });
    expect((await openApp(td)).status).not.toBe(404);
    await eventually(() => servicesFramesOf(frontend), (s) => s.some((v) => v.app === "p-1-site" && v.paused === true && v.status === "offline"), "前端看到关着");
    expect(powerEvents(td)).toEqual([expect.objectContaining({ on: false, by: "user" })]);

    // 重启守护进程：关着的照样关着，重新接上 LSM 后一条 services.* 都不发
    await td.daemon.stop();
    from = lsm.serviceRequests().length;
    const hellos = lsm.messages.length;
    const again = await startTestDaemon({ clock: new ManualClock(START), ...daemonOptions });
    await lsm.waitFor((m) => m.type === "hello", "重新握手", { from: hellos });
    await untilService(again, (v) => v.paused === true && v.status === "offline", "重启后仍关着");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual([]);
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "STOPPED", autostart: false });
    const front = await connect(again);

    // 做到一半又点：启动还在等就绪时点关闭——等启动回来，接着关掉
    from = lsm.serviceRequests().length;
    const release = lsm.owned.holdNextStart("p-1-site");
    const sent = lsm.messages.length;
    ok(await power(front, "start", "k-start-1"));
    await lsm.waitFor((m) => m.type === "services.start", "启动（停在启动中）", { from: sent });
    await untilService(again, (v) => v.power === "starting", "启动中");
    ok(await power(front, "stop", "k-stop-2"));
    await untilService(again, (v) => v.paused === true && v.power === "stopping", "关闭中");
    release();
    await untilService(again, (v) => v.paused === true && v.power === undefined && v.status === "offline", "照最新的关掉");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start", "services.autostart", "services.stop"]);
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "STOPPED", autostart: false });

    // 启动：照定义整份重新登记（开机自启回到开着）、启动；经转发打开得到首页
    from = lsm.serviceRequests().length;
    ok(await power(front, "start", "k-start-2"));
    await untilService(again, (v) => v.rollout === "live" && v.status === "online" && v.paused === undefined && v.power === undefined, "全部起来");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(lsm.serviceRequests()[from]!.service).toMatchObject({ name: "p-1-site", autostart: true });
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "RUNNING", autostart: true });
    expect((await openApp(again)).status).toBe(200);
    expect(powerEvents(again).map((p) => p.on)).toEqual([false, true, false, true]);
  }, 180_000);

  it("秘书照用户说的启停（和按钮同一个入口，不另出卡）；关着时打开是“没在运行”的说明页；LSM 没连上、项目停用了的被拒并说清原因", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      env: lsm.env,
      secretary: [call("switch_project_services", { project: "简报站", action: "stop" }), ECHO, call("switch_project_services", { project: "AI 简报站", action: "start" }), ECHO],
      maintainer: () => Array.from({ length: 10 }, () => say("好")),
    });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [site(app.port)]);
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");
    const cardsBefore = cardsOf(frontend).length;
    const lastReply = () => textOf(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent").at(-1)!);

    // "把简报站关了"：秘书关掉，工具结果写着关好了、现在的样子
    await frontend.sendText("把简报站关了");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 30_000, describe: () => "秘书处理完" });
    expect(lastReply()).toContain("关好了：项目「AI 简报站」的服务在 LSM 里全部停掉、取消了开机自启");
    expect(lastReply()).toContain(`服务「简报站」（p-1 · p-1-site · 端口 ${app.port}）：已关闭`);
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "STOPPED", autostart: false });
    expect(serviceNow(td)).toMatchObject({ paused: true });
    expect(powerEvents(td)).toEqual([expect.objectContaining({ on: false, by: "secretary" })]);
    // 不另出卡（用户说了就是确认）
    expect(cardsOf(frontend).length).toBe(cardsBefore);
    // 服务真的停了：经转发打开是"没在运行"的说明页
    await app.close();
    const down = await openApp(td);
    expect(down.status).toBe(502);
    expect(await down.text()).toContain("现在没在运行");

    // "把 AI 简报站开起来"：秘书拉起来
    await frontend.sendText("把 AI 简报站开起来");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 2, { timeoutMs: 30_000, describe: () => "秘书处理完第二句" });
    expect(lastReply()).toContain("做完了：项目「AI 简报站」的服务交给 LSM 全部拉起、恢复了开机自启");
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "RUNNING", autostart: true });
    expect(serviceNow(td)?.paused).toBeUndefined();

    // LSM 没连上：按钮那边被拒，说清原因，什么都不记
    await lsm.close();
    await untilService(td, (v) => v.status === "unknown", "LSM 断了");
    const refused = await power(frontend, "stop", "k-offline");
    expect(refused).toMatchObject({ ok: false, error: { code: "not_allowed", message: "LSM 没连上，等连上再试" } });
    expect(powerEvents(td)).toHaveLength(2);

    // 项目停用了：不是使用中的不能启停（停用、重新启用照原样）
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "retire"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "retired", "停用");
    expect(await power(frontend, "start", "k-retired")).toMatchObject({ ok: false, error: { code: "not_allowed", message: "项目「AI 简报站」不是使用中的，没有可以启动、关闭的服务" } });
  }, 180_000);
});

/** 269：接上 LSM 时兜底拉起的结果（service_rollout 带 revive） */
const revivesOf = (td: TestDaemon) =>
  td.daemon.store
    .read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.rollout)
    .map((e) => e.payload as { app: string; state: string; reason?: string; revive?: boolean })
    .filter((p) => p.revive === true);

describe("二狗接上 LSM 时兜底：该在线、用户没关的服务停着就拉起来（269 号票）", () => {

  it("电脑重启后 LSM 没拉：守护进程起来接上时停着的拉起来（整份登记、启动，记上线的结果）；接上之后又挂了不自动拉（照旧过一阵通知维护者）；LSM 重启、重新接上时还停着的再拉一次，在跑的不动", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const daemonOptions = { reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 20 }, () => say("好")) };
    const td = await startTestDaemon({ clock: new ManualClock(START), ...daemonOptions });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [DAILY, site(app.port)]);
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");
    expect(revivesOf(td)).toEqual([]);

    // 电脑重启：守护进程停了，LSM 起来后没按开机自启拉服务（名下的服务全停着）；守护进程起来接上 LSM，全量里它停着——拉起来
    await td.daemon.stop();
    lsm.owned.reboot();
    let from = lsm.serviceRequests().length;
    let hellos = lsm.messages.length;
    const clock = new ManualClock(START);
    const again = await startTestDaemon({ clock, ...daemonOptions });
    await lsm.waitFor((m) => m.type === "hello", "重新握手", { from: hellos });
    await untilService(again, (v) => v.rollout === "live" && v.status === "online", "接上后拉起来");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(lsm.serviceRequests()[from]!.service).toMatchObject({ name: "p-1-site", port: app.port, autostart: true });
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "RUNNING", autostart: true });
    expect(revivesOf(again)).toEqual([expect.objectContaining({ app: "p-1-site", state: "live", revive: true })]);
    expect((await openApp(again)).status).toBe(200);
    const front = await connect(again);
    await settled(again, "pm-1");
    const notices = () => messagesOf(front, PM1).map(textOf).filter((t) => t.includes("上线后挂了") || t.includes("又在线了") || t.includes("接上 LSM 时"));
    expect(notices()).toEqual([]);

    // 接上之后又挂了：不自动拉（免得和 LSM 的挂了自动重启打架），照 133 不在线持续 30 秒通知维护者
    from = lsm.serviceRequests().length;
    lsm.owned.setState("p-1-site", "FAILED", "进程退出了（退出码 1）");
    await untilService(again, (v) => v.status === "failed", "又挂了");
    clock.advance(31_000);
    await waitUntil(() => notices().length === 1, { describe: () => `维护者收到挂了的通知：${JSON.stringify(notices())}` });
    expect(notices()[0]).toContain("上线后挂了，现在不在线：进程退出了（退出码 1）");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual([]);
    expect(serviceNow(again)).toMatchObject({ rollout: "live", status: "failed" });
    await settled(again, "pm-1");

    // LSM 重启了（断了又接上），它还停着：重新接上时再拉一次；好了照 133 说一声又在线了
    hellos = lsm.messages.length;
    lsm.drop();
    await lsm.waitFor((m) => m.type === "hello", "LSM 重启后重新握手", { from: hellos });
    await untilService(again, (v) => v.rollout === "live" && v.status === "online", "重新接上后拉起来");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(revivesOf(again)).toHaveLength(2);
    clock.advance(31_000);
    await waitUntil(() => notices().length === 2, { describe: () => `维护者收到又在线了的通知：${JSON.stringify(notices())}` });
    expect(notices()[1]).toContain("服务「简报站」（p-1-site）又在线了");

    // 接上时在跑的不拉、不重启：再断一次又接上，只整份再登记一次（324：同一份定义 LSM 不改、不回 restartNeeded）
    from = lsm.serviceRequests().length;
    hellos = lsm.messages.length;
    lsm.drop();
    await lsm.waitFor((m) => m.type === "hello", "又一次重新握手", { from: hellos });
    await untilService(again, (v) => v.status === "online", "重新接上后在线");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual(["services.put"]);
    expect(revivesOf(again)).toHaveLength(2);
  }, 180_000);

  it("用户关着的不拉（电脑重启、LSM 重新接上都一条 services.* 不发）；拉不起来：记上线失败和 LSM 给的原因，通知维护者", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const daemonOptions = { reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 20 }, () => say("好")) };
    const td = await startTestDaemon({ clock: new ManualClock(START), ...daemonOptions });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await putInUse(td, frontend, [site(app.port)]);
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");

    // 用户关了（257）：电脑重启后守护进程接上 LSM，关着的不拉
    ok(await power(frontend, "stop", "k-stop"));
    await untilService(td, (v) => v.paused === true && v.power === undefined && v.status === "offline", "关着");
    await td.daemon.stop();
    lsm.owned.reboot();
    let from = lsm.serviceRequests().length;
    let hellos = lsm.messages.length;
    const again = await startTestDaemon({ clock: new ManualClock(START), ...daemonOptions });
    await lsm.waitFor((m) => m.type === "hello", "重新握手", { from: hellos });
    await untilService(again, (v) => v.paused === true && v.status === "offline", "重启后仍关着");
    await again.daemon.projectServices.idle();
    // LSM 断了又接上：同样不拉
    hellos = lsm.messages.length;
    lsm.drop();
    await lsm.waitFor((m) => m.type === "hello", "LSM 重启后重新握手", { from: hellos });
    await untilService(again, (v) => v.paused === true && v.status === "offline", "重新接上后仍关着");
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual([]);
    expect(revivesOf(again)).toEqual([]);
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "STOPPED", autostart: false });

    // 用户启动：全部起来
    const front = await connect(again);
    ok(await power(front, "start", "k-start"));
    await untilService(again, (v) => v.rollout === "live" && v.status === "online" && v.paused === undefined && v.power === undefined, "启动后在线");
    await settled(again, "pm-1");

    // LSM 重启了、没拉它，二狗接上去拉也起不来（端口被别的程序占着）：记上线失败和 LSM 给的原因，通知维护者
    const reason = `端口 ${app.port} 已被 node.exe (4321) 占着`;
    lsm.owned.failNextStart("p-1-site", reason);
    from = lsm.serviceRequests().length;
    hellos = lsm.messages.length;
    lsm.owned.reboot();
    lsm.drop();
    await lsm.waitFor((m) => m.type === "hello", "LSM 重启后重新握手", { from: hellos });
    const failed = await untilService(again, (v) => v.rollout === "failed", "拉不起来");
    expect(failed).toMatchObject({ reason, status: "failed" });
    await again.daemon.projectServices.idle();
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(revivesOf(again)).toEqual([expect.objectContaining({ app: "p-1-site", state: "failed", reason, revive: true })]);
    await waitUntil(() => messagesOf(front, PM1).some((m) => textOf(m).includes("二狗接上 LSM 时它没在跑")), { describe: () => "维护者收到拉不起来的通知" });
    const notice = messagesOf(front, PM1).map(textOf).find((t) => t.includes("二狗接上 LSM 时它没在跑"))!;
    expect(notice).toContain(`服务「简报站」（p-1-site，端口 ${app.port}）`);
    expect(notice).toContain(reason);
    // 拉不起来的不再看挂没挂（不另报"上线后挂了"）
    expect(messagesOf(front, PM1).some((m) => textOf(m).includes("上线后挂了"))).toBe(false);
  }, 180_000);
});
