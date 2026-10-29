// 主切面：任务控制快速动作（规格第 14 节、第 9 节"快速动作的确认"、第 8 节"谁能改"，22 号票）。
// 用户在对话里说暂停、继续、取消某个任务，秘书（faux）用"提议快速动作"提出 pause_task / resume_task / cancel_task：
// - 用户这条消息里原样出现了那个任务（编号或名称）和动作：直接执行，聊天里留"已执行"卡；
// - 秘书推断出来的（用户没原样说出是哪个任务）一律先问：卡片带确认按钮、同时进待我处理，点确认才执行，不论关注类别设置如何；
// - 执行走任务执行控制器：迁移记为用户发起、按"谁能改"表里用户那一行校验（执行中 → 已暂停、已暂停 → 执行中，
//   名额满了回到排队中，未结束的 → 已取消），不合法的被拒、任务状态不变；取消照常产生"任务结局：取消"的素材。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  type MessageEventPayload,
  type QuickActionExecutedEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { eventually, maintainerScript, ok, runningTask, tasksOf } from "../helpers/running-task.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;

const propose = (type: string, task: string): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type, params: { task } } as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const ECHO: FauxStep = { kind: "echo_context" };

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 });
  return frontend;
}

const userMessages = (frontend: TestFrontend) =>
  frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).filter((f) => (f.payload as MessageEventPayload).message.speaker === "user").length;

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  const n = userMessages(frontend);
  await eventually(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }), () => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= n, `秘书处理完「${text}」`);
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const quickCards = (frontend: TestFrontend) => [...new Map(cardsOf(frontend).filter((c) => c.type === "quick_action").map((c) => [c.id, c])).values()];
const executions = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload as QuickActionExecutedEventPayload);
const inboxItems = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
/** 秘书看到的最后一个工具结果 */
const lastToolResult = (frontend: TestFrontend) =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message.parts)
    .flat()
    .filter((p) => p.type === "tool_call")
    .at(-1) as { tool: string; outcome: string; resultSummary?: string } | undefined;

describe("用户点明了是哪个任务", () => {
  it("暂停、继续、取消直接执行：聊天里留\"已执行\"卡，任务按状态机迁移、记为用户发起；取消产生\"任务结局：取消\"的素材", async () => {
    const td = await startTestDaemon({
      secretary: [propose("pause_task", "t-1"), say("暂停了"), propose("resume_task", "整理发票"), say("继续了"), propose("cancel_task", "t-1"), say("取消了")],
      maintainer: maintainerScript(),
    });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    expect(taskId).toBe("t-1");

    await tell(frontend, "把任务 t-1 暂停");
    const paused = await eventually(() => tasksOf(frontend), (e) => e.change === "paused", "任务暂停");
    expect(paused).toMatchObject({ from: "running", by: "user", task: { id: taskId, state: "paused" } });
    const [pauseCard] = quickCards(frontend);
    expect(pauseCard).toMatchObject({
      status: "handled",
      outcome: { action: "execute" },
      payload: { action: { type: "pause_task", params: { taskId } }, name: "暂停任务", explicit: true, disposition: "do" },
    });
    // 卡片出现在聊天里
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).some((f) => (f.payload as MessageEventPayload).message.parts.some((p) => p.type === "card_ref" && p.cardId === pauseCard!.id))).toBe(true);

    await tell(frontend, "继续整理发票");
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "resumed", "任务继续")).toMatchObject({ from: "paused", by: "user", task: { state: "running" } });

    await tell(frontend, "取消任务 t-1。");
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "cancelled", "任务取消")).toMatchObject({ from: "running", by: "user", task: { state: "cancelled" } });

    // 三张"已执行"卡、三条操作记录，都不进待我处理
    expect(quickCards(frontend).map((c) => [(c.payload as { action: { type: string } }).action.type, c.status, (c.payload as { explicit: boolean }).explicit])).toEqual([
      ["pause_task", "handled", true],
      ["resume_task", "handled", true],
      ["cancel_task", "handled", true],
    ]);
    expect(executions(frontend).map((e) => [e.action.type, e.explicit, e.result.ok])).toEqual([
      ["pause_task", true, true],
      ["resume_task", true, true],
      ["cancel_task", true, true],
    ]);
    expect(inboxItems(frontend).filter((i) => i.kind === "card" && quickCards(frontend).some((c) => c.id === i.cardId))).toEqual([]);
    // 任务结局素材（13 号票的采集规则）
    await eventually(() => td.daemon.materials.list({ kind: "task_outcome" }), (m) => m.task === taskId, "任务结局素材");
    expect(td.daemon.materials.list({ kind: "task_outcome" })).toMatchObject([{ task: taskId, context: ["outcome:cancelled", "by:user"] }]);
  }, 90_000);

  it("执行名额满了：继续时回到排队中；不合法的迁移（暂停已取消的、继续执行中的）被拒，不出卡，任务状态不变", async () => {
    const td = await startTestDaemon({
      config: { tasks: { maxRunning: 1 } },
      secretary: [propose("pause_task", "t-1"), say("好"), propose("resume_task", "t-1"), say("好"), propose("cancel_task", "t-2"), say("好"), propose("pause_task", "t-2"), say("好"), propose("resume_task", "t-1"), say("好")],
      maintainer: maintainerScript(),
    });
    const frontend = await connect(td.url);
    const t1 = await runningTask(td, frontend, "整理发票");
    // 第二个任务确认后排队（名额只有一个）
    const t2 = td.daemon.tasks.createByRequest({ title: "写周报", summary: "写周报" });
    td.daemon.tasks.writeBrief(t2.id, { goal: "写周报", acceptanceCriteria: ["写完"], constraints: [], projects: [], memoryScope: "" });
    const plan = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as { taskId: string }).taskId === t2.id, "第二个任务的计划卡");
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: plan.version, input: {} }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === t2.id && e.task.state === "queued", "第二个任务排队");

    // 暂停 t-1：名额空出，t-2 开始；继续 t-1：名额满了，回到排队中
    await tell(frontend, "暂停 t-1");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === t2.id && e.change === "started", "第二个任务开始");
    await tell(frontend, "继续 t-1");
    expect(await eventually(() => tasksOf(frontend), (e) => e.task.id === t1 && e.change === "requeued", "t-1 回到排队")).toMatchObject({ from: "paused", by: "user", task: { state: "queued" } });

    // 取消 t-2（执行中 → 已取消），名额空出，t-1 接着执行
    await tell(frontend, "取消 t-2");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === t2.id && e.change === "cancelled", "t-2 取消");
    await eventually(() => tasksOf(frontend), (e) => e.task.id === t1 && e.task.state === "running", "t-1 接着执行");
    const cardsBefore = quickCards(frontend).length;
    const boardBefore = tasksOf(frontend).length;

    // 不合法：暂停已取消的 t-2、继续执行中的 t-1
    await tell(frontend, "暂停 t-2");
    expect(lastToolResult(frontend)).toMatchObject({ tool: "propose_quick_action", outcome: "error" });
    expect(lastToolResult(frontend)!.resultSummary).toContain("不能暂停");
    await tell(frontend, "继续 t-1");
    expect(lastToolResult(frontend)!.resultSummary).toContain("不能继续");
    expect(quickCards(frontend)).toHaveLength(cardsBefore);
    expect(tasksOf(frontend)).toHaveLength(boardBefore);
    expect([td.daemon.tasks.get(t1)!.state, td.daemon.tasks.get(t2.id)!.state]).toEqual(["running", "cancelled"]);
  }, 120_000);
});

describe("秘书推断出来的", () => {
  it("问句不算点明，任务不在动作词后面那一段里也不算：\"t-1 取消了吗？\"\"取消提醒 r-1，t-1 怎么样了\"都先问，任务照旧执行", async () => {
    const td = await startTestDaemon({
      secretary: [propose("cancel_task", "t-1"), say("要取消吗"), propose("cancel_task", "t-1"), say("要取消吗")],
      maintainer: maintainerScript(),
    });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");

    await tell(frontend, "t-1 取消了吗？");
    await tell(frontend, "取消提醒 r-1，t-1 怎么样了");
    const cards = quickCards(frontend);
    expect(cards.map((c) => [c.status, (c.payload as { explicit: boolean; disposition: string }).explicit, (c.payload as { disposition: string }).disposition])).toEqual([
      ["pending", false, "ask_first"],
      ["pending", false, "ask_first"],
    ]);
    expect(cards.every((c) => inboxItems(frontend).some((i) => i.kind === "card" && i.cardId === c.id))).toBe(true);
    expect(executions(frontend)).toEqual([]);
    expect(td.daemon.tasks.get(taskId)!.state).toBe("running");
  }, 90_000);

  it("用户没原样说出是哪个任务：一律先问（卡片带确认按钮、进待我处理），自定义类别说直接做也一样；点确认后才执行", async () => {
    const td = await startTestDaemon({ secretary: [propose("pause_task", "t-1"), say("要我暂停吗"), ECHO], maintainer: maintainerScript() });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    // 用户自己加的类别：对暂停任务的快速动作"直接做"
    const created = await frontend.updateWatchCategories({ op: "create_custom", category: { title: "暂停任务随便做", match: { tools: ["quick_action:pause_task"] }, chat: "do", task: "do" } });
    expect(created.ok).toBe(true);

    await tell(frontend, "发票那个活先停一下");
    const [card] = quickCards(frontend);
    expect(card).toMatchObject({ status: "pending", payload: { action: { type: "pause_task", params: { taskId } }, explicit: false, disposition: "ask_first" } });
    expect(inboxItems(frontend)).toContainEqual(expect.objectContaining({ kind: "card", cardId: card!.id, urgency: "non_blocking" }));
    expect(td.daemon.tasks.get(taskId)!.state).toBe("running");

    ok(await frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: card!.version }));
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "paused", "任务暂停")).toMatchObject({ from: "running", by: "user", task: { state: "paused" } });
    expect(await eventually(() => quickCards(frontend), (c) => c.id === card!.id && c.status === "handled", "卡片已执行")).toMatchObject({ outcome: { action: "execute" } });
    expect(executions(frontend)).toMatchObject([{ action: { type: "pause_task", params: { taskId } }, explicit: false, cardId: card!.id }]);
  }, 90_000);
});
