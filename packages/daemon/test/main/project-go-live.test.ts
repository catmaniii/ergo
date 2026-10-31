// 主切面：项目状态流程和转运营检查清单（259 号票；issue 19 第 2、3、8 条）。真的守护进程，秘书、项目的维护者接 faux 剧本，测试扮演前端。
// - 转入使用不管谁发起都要用户确认：用户在项目页点"转入使用"（project_action go_live）、维护者用 propose_go_live 提、秘书照用户说的
//   代办，都只出"转入使用"确认卡，项目一直是建设中；只有用户在卡上点确认才进入使用中（秘书、维护者都没有能对卡片做动作的工具）；
// - 卡上列建设中 → 使用中的检查清单，缺的写明差什么；补齐再提，卡上的清单刷新；缺着照样能确认，缺的记进卡上的决定和维护者会话；
//   只读接口 GET /api/projects/<id>/standard 的清单就是这一份；先不转的项目留在建设中，维护者提的收到通知；
// - "首版做完了"卡还在等的，三种发起方都用那一张（不另出卡）；一张确认了，别的转入使用卡作废；
// - 停用时反向收回（照 133：服务撤出 LSM、撤掉 /apps/ 转发）；用户 2026-10-24 定：关着服务的项目停用后重新启用，就把服务全部拉起来。
import fs from "node:fs";
import path from "node:path";
import {
  type BuildDoneCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type GoLiveCardPayload,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  nowIso,
  type Project,
  type ProjectEventPayload,
  type ProjectStandardView,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import { PROJECT_SERVICE_EVENTS } from "../../src/project-services/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeApp } from "../helpers/fake-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { type LsmStandIn, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const START = new Date(2026, 9, 24, 9, 0);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
/** 维护者的剧本：先照 steps 做，后面多垫几句"好"（会话收尾、催写回时用） */
const maintainerSteps = (steps: FauxStep[]) => () => [...steps, ...Array.from({ length: 10 }, () => say("好"))];

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latest = (frontend: TestFrontend, cardId: string) => cardsOf(frontend).filter((c) => c.id === cardId).at(-1)!;
const goLiveCards = (frontend: TestFrontend) => [...new Set(cardsOf(frontend).filter((c) => c.type === "go_live").map((c) => c.id))].map((id) => latest(frontend, id));
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}:${"cardId" in part ? part.cardId : ""}>`)).join("");
const stateOf = (td: TestDaemon) => td.daemon.projects.get("p-1")?.state;

async function connect(td: TestDaemon, channels: string[] = [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function standardOf(td: TestDaemon): Promise<ProjectStandardView> {
  const res = await requestJson<ProjectStandardView>(td.url, HTTP_PATHS.projectStandard("p-1"));
  expect(res.status).toBe(200);
  return res.body;
}

/** 建设中的开发类项目（规范 v1，档案照模板生成；能联网），建设任务 t-1 还在做 */
function buildingProject(td: TestDaemon, kind: "dev" | "other" = "dev"): Project {
  const project = seedProject(td.daemon, "记账本", {
    state: "building",
    charterConfirmed: true,
    kind,
    standardVersion: "v1",
    toolkit: { skills: [], mcp: [], bash: false, network: true },
    buildTaskId: "t-1",
  });
  internalTask(td.daemon, "记账本", "建设「记账本」首版");
  return project;
}

/** 项目档案里的位置（真实路径） */
const recordsOf = (td: TestDaemon) => path.join(fs.realpathSync.native(td.dataDir), "projects", "p-1");

/** 把架构图、ops.json、进展写好（服务名、对外接口按参数） */
function fillRecords(records: string, opts: { services?: string[]; interfaces?: string[]; ops?: boolean; progress?: boolean } = {}) {
  const services = opts.services ?? ["| 无 | | | | |"];
  const interfaces = opts.interfaces ?? ["| 无 | | |"];
  fs.writeFileSync(
    path.join(records, "architecture.md"),
    ["# 架构图", "", "## 用到的服务", "", "| 服务名 | 做什么 | 端口 | 健康检查 | 开机自启 |", "|---|---|---|---|---|", ...services, "", "## 对外接口", "", "| 接口 | 给谁用 | 走哪条路 |", "|---|---|---|", ...interfaces, ""].join("\n"),
  );
  // 268 号票起清单要验收：这里只写通用操作之外一个都没有的清单（格式对，没有测试要跑，当场就是全过）；验收本身的主切面在 project-ops.test.ts
  if (opts.ops !== false) fs.writeFileSync(path.join(records, "ops.json"), JSON.stringify({ endpoint: { path: "/ops" }, tools: [] }));
  if (opts.progress !== false) fs.writeFileSync(path.join(records, "progress.md"), "# 进展\n\n首版做完了，能导入招行的 CSV。\n");
}

const missingIds = (items: GoLiveCardPayload["checklist"]) => items.filter((i) => !i.done).map((i) => i.id);

describe("转入使用不管谁发起都要用户在确认卡上确认（259 号票）", () => {
  it("用户在项目页点“转入使用”：只出确认卡（卡上列清单、缺的写明差什么），项目还是建设中；再点用同一张；照样确认才进入使用中，缺的记进决定和维护者会话", async () => {
    const td = await startTestDaemon({ secretary: [say("好的")], maintainer: maintainerSteps([]) });
    buildingProject(td);
    const frontend = await connect(td);

    // 点"转入使用"：结果里是那张卡，项目照旧建设中
    const asked = await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live");
    const result = ok(asked) as { projectId: string; state: string; confirmCardId: string };
    expect(result).toMatchObject({ projectId: "p-1", state: "building" });
    const card = await eventually(() => goLiveCards(frontend), (c) => c.id === result.confirmCardId, "“转入使用”卡");
    expect(stateOf(td)).toBe("building");
    const payload = card.payload as GoLiveCardPayload;
    expect(payload).toMatchObject({ projectId: "p-1", projectName: "记账本", by: "user" });
    expect(payload.why).toBeUndefined();
    // 刚生成的档案：架构图、ops.json、进展还是模板原样（缺），没有服务的两项算做到
    expect(payload.checklist.map((i) => [i.id, i.done, i.detail])).toEqual([
      ["architecture", false, "architecture.md 还是模板原样"],
      ["ops", false, "ops.json 还是模板原样"],
      ["services", true, "没有服务，不用登记"],
      ["public_entry", true, "不要外网"],
      ["progress_written", false, "progress.md 还是模板原样"],
    ]);
    // 纯文本降级（秘书列待办时看开头）先写谁发起的、缺什么
    expect(card.text.startsWith("项目「记账本」转入使用（你在项目页点的）；检查清单还缺 3 项：架构图写清服务和对外接口（architecture.md 还是模板原样）")).toBe(true);
    // 进待我处理；维护者会话里一张、一句说明（给用户看）
    const items = frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as { item: { cardId?: string; title: string } }).item);
    expect(items.some((i) => i.cardId === card.id && i.title === "项目「记账本」转入使用")).toBe(true);
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m).includes(`<card_ref:${card.id}>`), "维护者会话里的卡");
    expect(messagesOf(frontend, PM1).some((m) => textOf(m) === "你在项目页点的：要把项目「记账本」转入使用，确认卡在待我处理里，你确认了才转。")).toBe(true);
    // 只读接口的清单就是这一份
    expect((await standardOf(td)).checklist).toMatchObject({ from: "building", to: "in_use", items: payload.checklist.map(({ id, done }) => ({ id, done })) });

    // 同一个幂等键重发：同一张卡；换个键再点：还是那一张（不另出卡）
    expect((ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live")) as { confirmCardId: string }).confirmCardId).toBe(card.id);
    expect((ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live-2")) as { confirmCardId: string }).confirmCardId).toBe(card.id);
    expect(goLiveCards(frontend)).toHaveLength(1);
    expect(stateOf(td)).toBe("building");

    // 照样确认：进入使用中；确认时还缺的三项记进卡上的决定，维护者会话里那句说明写明缺什么
    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: latest(frontend, card.id).version }, "k-confirm"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use" && e.by === "user", "项目进入使用中");
    expect(stateOf(td)).toBe("in_use");
    const decided = latest(frontend, card.id);
    expect(decided.status).toBe("handled");
    expect(missingIds((decided.payload as GoLiveCardPayload).decided!.missing!)).toEqual(["architecture", "ops", "progress_written"]);
    expect(decided.text).toContain("你选了确认转入使用（照样确认，清单缺 3 项）");
    const note = await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m).includes("进入使用中"), "维护者会话里的说明");
    expect(textOf(note)).toContain("你在“项目「记账本」转入使用”卡上选了确认转入使用：项目「记账本」进入使用中。确认时检查清单还缺：架构图写清服务和对外接口（architecture.md 还是模板原样）、运营接口清单验收通过（ops.json）（ops.json 还是模板原样）、进展已写回（progress.md 还是模板原样）。");
    // 使用中了：不能再点转入使用，清单换成使用中 → 已停用（只要进展写回）
    const again = await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live-3");
    expect(again).toMatchObject({ ok: false, error: { code: "not_allowed", message: "使用中的项目不能转入使用（只有建设中的能）" } });
    expect((await standardOf(td)).checklist).toMatchObject({ from: "in_use", to: "retired", items: [{ id: "progress_written" }] });
  }, 60_000);

  it("维护者提（propose_go_live）：只出确认卡、项目还是建设中；补齐再提，卡上的清单刷新；用户选先不转，项目留在建设中，维护者收到；再提再确认才转", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: maintainerSteps([
        call("propose_go_live", { why: "首版做完了：能导入招行的 CSV、出月报" }),
        ECHO,
        call("propose_go_live", { why: "架构图、ops.json、进展都补齐了" }),
        ECHO,
      ]),
    });
    buildingProject(td);
    const frontend = await connect(td);

    await frontend.sendText("可以上线了吧？", { conversation: PM1 });
    const card = await eventually(() => goLiveCards(frontend), () => true, "维护者提的“转入使用”卡");
    await settled(td, "pm-1");
    expect(stateOf(td)).toBe("building");
    expect(card.payload as GoLiveCardPayload).toMatchObject({ by: "maintainer", why: "首版做完了：能导入招行的 CSV、出月报" });
    expect(missingIds((card.payload as GoLiveCardPayload).checklist)).toEqual(["architecture", "ops", "progress_written"]);
    // 工具结果：卡出了、要用户确认、不能自己转；清单每项一行
    const echo = textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(echo).toContain(`已出“转入使用”确认卡（${card.id}），放进了用户的待我处理。`);
    expect(echo).toContain("用户在卡上确认才转入使用：你不能自己转，也不要说已经转了。");
    expect(echo).toContain("检查清单（建设中 → 使用中，5 项，缺 3 项）：");
    expect(echo).toContain("- ✗ 运营接口清单验收通过（ops.json）：ops.json 还是模板原样");
    expect(echo).toContain("- ✓ 服务按模板在 LSM 登记（写进运营方案）：没有服务，不用登记");

    // 维护者补齐了再提：同一张卡，清单刷新（都做到了），项目照旧建设中
    fillRecords(recordsOf(td));
    await frontend.sendText("补齐了再提一次", { conversation: PM1 });
    await waitUntil(() => missingIds((latest(frontend, card.id).payload as GoLiveCardPayload).checklist).length === 0, { timeoutMs: 30_000, describe: () => JSON.stringify((latest(frontend, card.id).payload as GoLiveCardPayload).checklist) });
    await settled(td, "pm-1");
    expect(goLiveCards(frontend)).toHaveLength(1);
    expect(stateOf(td)).toBe("building");
    // 卡已经在了：等维护者那句"没有另出卡、清单刷新了"出现再断言（慢一点的机器上最后一条消息可能还是 <tool_call:> 占位）
    const refreshed = await eventually(
      () => messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent"),
      (m) => textOf(m).includes(`“转入使用”确认卡（${card.id}）已经在等用户确认了`),
      "维护者回：卡已经在等确认",
    );
    expect(textOf(refreshed)).toContain(`“转入使用”确认卡（${card.id}）已经在等用户确认了，没有另出卡；卡上的检查清单照现在的刷新了。`);
    expect(latest(frontend, card.id).text).toContain("检查清单 5 项都做到了");

    // 先不转：留在建设中，维护者收到（唤起它）
    const turns = frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).length;
    ok(await frontend.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: latest(frontend, card.id).version, note: "等月报再看看" }, "k-dismiss"));
    await waitUntil(() => latest(frontend, card.id).status === "handled", { describe: () => "卡处理了" });
    expect((latest(frontend, card.id).payload as GoLiveCardPayload).decided).toEqual({ choice: "dismiss" });
    expect(stateOf(td)).toBe("building");
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m).includes("用户在“转入使用”确认卡上选了先不转，说：“等月报再看看”"), "维护者收到先不转");
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).length > turns, { timeoutMs: 30_000, describe: () => "维护者处理了通知" });
    await settled(td, "pm-1");

    // 再从项目页点：先不转过的那张不算在等，另出一张；确认了才转，清单都做到了（决定里没有缺的）
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-again")) as { confirmCardId: string };
    expect(asked.confirmCardId).not.toBe(card.id);
    const second = await eventually(() => goLiveCards(frontend), (c) => c.id === asked.confirmCardId, "第二张卡");
    expect(stateOf(td)).toBe("building");
    ok(await frontend.cardAction({ cardId: second.id, action: "put_in_use", expectedVersion: second.version }, "k-confirm-2"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    expect((latest(frontend, second.id).payload as GoLiveCardPayload).decided).toEqual({ choice: "put_in_use" });
  }, 90_000);

  it("秘书代办（propose_go_live）：卡放进秘书聊天和待我处理，项目还是建设中；用户再说“确认，转吧”秘书也转不了；用户在卡上确认才转", async () => {
    const td = await startTestDaemon({
      secretary: [
        call("propose_go_live", { project: "记账本", why: "用户说记账本可以上线了" }),
        ECHO,
        // 用户再说一遍：秘书还是只能出（用）卡
        call("propose_go_live", { project: "p-1", why: "用户说确认，转吧" }),
        ECHO,
        call("propose_go_live", { project: "简报站", why: "没有这个项目" }),
        ECHO,
      ],
      maintainer: maintainerSteps([]),
    });
    buildingProject(td);
    const frontend = await connect(td);
    const secretaryEcho = () => textOf(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent").at(-1)!);

    await frontend.sendText("记账本可以上线了");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 30_000, describe: () => "秘书处理完" });
    const card = await eventually(() => goLiveCards(frontend), () => true, "秘书代办的“转入使用”卡");
    expect(card.payload as GoLiveCardPayload).toMatchObject({ by: "secretary", why: "用户说记账本可以上线了" });
    expect(stateOf(td)).toBe("building");
    // 卡在秘书聊天里（工具产生的卡）、也在待我处理；工具结果说清用户说了也不算确认
    expect(messagesOf(frontend, SECRETARY).some((m) => textOf(m).includes(`<card_ref:${card.id}>`))).toBe(true);
    expect(secretaryEcho()).toContain("已把项目 p-1「记账本」的“转入使用”确认卡放进聊天和待我处理。");
    expect(secretaryEcho()).toContain("这一件用户说了也不算确认，你不能替他确认，也不要说已经转了。");
    expect(secretaryEcho()).toContain("检查清单（建设中 → 使用中，5 项，缺 3 项）：");

    // 用户再说"确认，转吧"：秘书没有能对卡片做动作的工具，只能把同一张卡再放进聊天，项目照旧建设中
    await frontend.sendText("确认，转吧");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 2, { timeoutMs: 30_000, describe: () => "秘书处理完第二句" });
    expect(secretaryEcho()).toContain("项目 p-1「记账本」已经有一张转入使用的确认卡在等用户（“转入使用”卡），放进了聊天");
    expect(goLiveCards(frontend)).toHaveLength(1);
    expect(stateOf(td)).toBe("building");
    expect(latest(frontend, card.id).status).toBe("pending");

    // 找不到的项目照实说
    await frontend.sendText("简报站也上线");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 3, { timeoutMs: 30_000, describe: () => "秘书处理完第三句" });
    expect(secretaryEcho()).toContain("没有叫“简报站”的项目。现在在建设中的项目：p-1「记账本」。");

    // 用户在卡上确认才转
    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: latest(frontend, card.id).version }, "k-confirm"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use" && e.by === "user", "项目进入使用中");
    expect(stateOf(td)).toBe("in_use");
  }, 90_000);

  it("“首版做完了”卡还在等时三种发起方都用那一张（清单刷新、不另出卡）；在它上面转入使用；“转入使用”卡被首版卡接替、被别的卡确认后作废", async () => {
    const td = await startTestDaemon({
      secretary: [call("propose_go_live", { project: "记账本", why: "用户说可以上线了" }), ECHO],
      maintainer: maintainerSteps([call("propose_go_live", { why: "首版做完了" }), ECHO]),
    });
    buildingProject(td);
    const frontend = await connect(td);

    // 先从项目页要一张"转入使用"卡，然后建设任务做完：首版卡接替它
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live")) as { confirmCardId: string };
    const goLive = await eventually(() => goLiveCards(frontend), (c) => c.id === asked.confirmCardId, "“转入使用”卡");
    const task = td.daemon.tasks.get("t-1")!;
    const finished: TaskEventPayload = { task: { ...task, state: "done", updatedAt: nowIso() }, change: "finished" as TaskEventPayload["change"], from: task.state, by: "maintainer" };
    td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload: finished });
    td.daemon.projects.taskCompleted(finished.task);
    const buildDone = await eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");
    expect(buildDone.typeVersion).toBe(4);
    expect(missingIds((buildDone.payload as BuildDoneCardPayload).checklist!)).toEqual(["architecture", "ops", "progress_written"]);
    expect(buildDone.text).toContain("检查清单还缺 3 项：");
    await waitUntil(() => latest(frontend, goLive.id).status === "expired", { describe: () => "“转入使用”卡作废" });
    expect(latest(frontend, goLive.id).expiredNote).toContain("“首版做完了”卡接替了这张");

    // 三种发起方都用首版卡：项目页点的结果就是它，维护者、秘书的工具结果也指着它；补齐之后清单刷新
    fillRecords(recordsOf(td));
    const byUser = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live-2")) as { confirmCardId: string };
    expect(byUser.confirmCardId).toBe(buildDone.id);
    await waitUntil(() => missingIds((latest(frontend, buildDone.id).payload as BuildDoneCardPayload).checklist!).length === 0, { describe: () => "首版卡上的清单刷新" });
    await frontend.sendText("可以上线了吗", { conversation: PM1 });
    await eventually(() => messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent"), (m) => textOf(m).includes(`“首版做完了”卡（${buildDone.id}）已经在等用户选了，它的“转入使用”就是这道确认，没有另出卡`), "维护者的工具结果");
    await settled(td, "pm-1");
    await frontend.sendText("记账本可以上线了");
    await eventually(() => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent"), (m) => textOf(m).includes("已经有一张转入使用的确认卡在等用户（“首版做完了”卡），放进了聊天"), "秘书的工具结果");
    expect(goLiveCards(frontend).filter((c) => c.status === "pending")).toHaveLength(0);
    expect(stateOf(td)).toBe("building");

    // 在首版卡上转入使用：清单都做到了，决定里没有缺的
    ok(await frontend.cardAction({ cardId: buildDone.id, action: "put_in_use", expectedVersion: latest(frontend, buildDone.id).version }, "k-put"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    expect((latest(frontend, buildDone.id).payload as BuildDoneCardPayload).decided).toEqual({ choice: "put_in_use" });
  }, 90_000);

  it("一张卡确认了，别的还在等的转入使用卡作废；放弃了的项目，还在等的“转入使用”卡作废", async () => {
    const td = await startTestDaemon({ secretary: [say("好的")], maintainer: maintainerSteps([]) });
    buildingProject(td);
    const frontend = await connect(td);
    // 两张"转入使用"卡不会同时在等（再要用同一张）：造一张旧的直接放进来，模拟升级前留下的
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-1")) as { confirmCardId: string };
    const stray = td.daemon.cards.create({ type: "go_live", payload: { ...(td.daemon.cards.get(asked.confirmCardId)!.payload as GoLiveCardPayload), by: "maintainer", why: "旧的" } });
    ok(await frontend.cardAction({ cardId: asked.confirmCardId, action: "put_in_use", expectedVersion: 1 }, "k-confirm"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    await waitUntil(() => td.daemon.cards.get(stray.id)?.status === "expired", { describe: () => "另一张作废" });
    // 作废的卡点了也不生效
    const stale = await frontend.cardAction({ cardId: stray.id, action: "put_in_use", expectedVersion: td.daemon.cards.get(stray.id)!.version }, "k-stale");
    expect(stale.ok).toBe(false);

    // 另一个建设中的项目要了卡之后放弃：卡作废
    seedProject(td.daemon, "家电档案", { state: "building", charterConfirmed: true, kind: "other", standardVersion: "v1" });
    const other = ok(await frontend.request(METHODS.projectAction, { projectId: "p-2", action: "go_live" }, "k-2")) as { confirmCardId: string };
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-2", action: "abandon" }, "k-abandon"));
    await waitUntil(() => td.daemon.cards.get(other.confirmCardId)?.status === "expired", { describe: () => "放弃后卡作废" });
    // 其他类、没有服务：清单只查进展
    expect((td.daemon.cards.get(other.confirmCardId)!.payload as GoLiveCardPayload).checklist.map((i) => i.id)).toEqual(["progress_written"]);
  }, 60_000);
});

/** 项目档案里服务的目录（工作目录要存在） */
function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  const realData = fs.realpathSync.native(dataDir);
  const records = path.join(realData, "projects", "p-1");
  fs.mkdirSync(path.join(records, "workdir", "site"), { recursive: true });
  return { dataDir, homeDir: makeTempDir("ergo-home-"), records };
}

/** 网页服务（端口是假服务的） */
const site = (port: number) => ({
  key: "site",
  name: "记账网页",
  means: "service",
  instructions: "记账本的网页：手机上看月报",
  capabilities: {},
  service: { name: "site", command: "node server.mjs", cwd: "site", port, health: { path: "/" }, web: { home: "/" } },
});

const serviceNow = (td: TestDaemon) => td.daemon.projectServices.view().find((v) => v.app === "p-1-site");
async function untilService(td: TestDaemon, match: (v: NonNullable<ReturnType<typeof serviceNow>>) => boolean, what: string) {
  await waitUntil(() => {
    const v = serviceNow(td);
    return v !== undefined && match(v);
  }, { timeoutMs: 20_000, describe: () => `等服务${what}：现在 ${JSON.stringify(serviceNow(td))}` });
}
const requestTypes = (lsm: LsmStandIn, from = 0) => lsm.serviceRequests().slice(from).map((m) => m.type);
const openApp = (td: TestDaemon) => fetch(new URL("/apps/p-1-site/", td.url));
const powerEvents = (td: TestDaemon) => td.daemon.store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.power).map((e) => e.payload as { on: boolean; by: string });

describe("停用反向收回、重新启用全部拉起（259 号票；用户 2026-10-24 改 257 号票）", () => {
  it("带服务的项目：清单查服务和 /apps/，经“转入使用”卡上线；关闭后停用——撤出 LSM、撤掉转发；重新启用——重新登记、全部拉起（不再保持关着）", async () => {
    const d = dirs();
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    const td = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, env: lsm.env, secretary: [say("好的")], maintainer: maintainerSteps([]) });
    buildingProject(td);
    const frontend = await connect(td);
    await lsm.waitFor((m) => m.type === "hello", "握手");

    // 架构图写了网页服务、对外接口走 /apps/，运营方案还没交：清单里服务、/apps/ 两项缺
    fillRecords(d.records, { services: ["| site | 记账网页 | 端口见方案 | / | 开 |"], interfaces: ["| 记账网页 | 手机 | /apps/p-1-site/ |"] });
    const before = (await standardOf(td)).checklist.items;
    expect(before.filter((i) => !i.done).map((i) => [i.id, i.detail])).toEqual([
      ["services", "还没交运营方案：架构图里的服务「site」要写进运营方案（means: service）"],
      ["public_entry", "对外接口「记账网页」要走 /apps/ 或公网，运营方案里没有对应的带网页（web）的服务"],
    ]);

    // 维护者交带网页服务的运营方案（直接调它的工具）：清单都做到了；从项目页要卡，卡上带着方案
    const proposed = await td.daemon.operations.tool("p-1", "pm-1").run({ items: [site(app.port)], why: "网页给手机看" } as never, { toolCallId: "call-ops" });
    expect(proposed.isError).toBeFalsy();
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "go_live" }, "k-go-live")) as { confirmCardId: string };
    const card = await eventually(() => goLiveCards(frontend), (c) => c.id === asked.confirmCardId, "“转入使用”卡");
    const payload = card.payload as GoLiveCardPayload;
    expect(payload.operations?.items.map((i) => i.key)).toEqual(["site"]);
    expect(payload.checklist.map((i) => [i.id, i.done, i.detail])).toEqual([
      ["architecture", true, undefined],
      ["ops", true, "验收通过：0 个操作的测试都跑通，只读的没写东西"],
      ["services", true, "确认后交给 LSM 登记：「site」"],
      ["public_entry", true, "确认后开 /apps/p-1-site/"],
      ["progress_written", true, undefined],
    ]);
    expect(card.text).toContain("确认并转入使用");

    // 确认并转入使用：服务经 LSM 上线、转发开好
    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: card.version }, "k-confirm"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    await untilService(td, (v) => v.rollout === "live" && v.status === "online", "上线、在线");
    expect((latest(frontend, card.id).payload as GoLiveCardPayload).decided?.operations?.map((r) => [r.key, r.outcome])).toEqual([["site", "created"]]);
    expect((await openApp(td)).status).toBe(200);

    // 关闭（257）：全部停、取消开机自启
    ok(await frontend.request(METHODS.projectServicesAction, { projectId: "p-1", action: "stop" }, "k-stop"));
    await untilService(td, (v) => v.paused === true && v.power === undefined && v.status === "offline", "关着");

    // 停用：反向收回——撤出 LSM、撤掉转发
    let from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "k-retire"));
    await untilService(td, (v) => v.rollout === "withdrawn", "撤下");
    expect(requestTypes(lsm, from)).toEqual(["services.remove"]);
    expect(lsm.owned.services.has("p-1-site")).toBe(false);
    expect((await openApp(td)).status).toBe(404);

    // 重新启用：关着的也全部拉起——重新登记（开机自启开着）、启动，转发回来；记一条"全部启动"
    from = lsm.serviceRequests().length;
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "reactivate" }, "k-reactivate"));
    await untilService(td, (v) => v.rollout === "live" && v.status === "online" && v.paused === undefined, "重新启用后全部拉起");
    expect(requestTypes(lsm, from)).toEqual(["services.put", "services.start"]);
    expect(lsm.serviceRequests()[from]!.service).toMatchObject({ name: "p-1-site", autostart: true });
    expect(lsm.owned.services.get("p-1-site")).toMatchObject({ state: "RUNNING", autostart: true });
    expect(powerEvents(td).map((p) => [p.on, p.by])).toEqual([
      [false, "user"],
      [true, "user"],
    ]);
    expect((await openApp(td)).status).toBe(200);
  }, 180_000);
});
