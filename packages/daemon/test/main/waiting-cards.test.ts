// 主切面：标题上的"等你……"。说明带上要处理的那张卡和一共几张（网页点了跳过去）；标题说在等你的卡，待办里一定有一条；
// 提问卡放久了（materials.staleCardDays）标题不再说、待办不再算要紧，卡照样能答；负责人出的提问卡算到负责人头上。
import { type ActivityEventPayload, CHANNELS, EVENT_TYPES, type InboxItem, type QuestionsCardPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createSecretaryQuestions } from "../../src/tasks/cards.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const DAY = 86_400_000;
const { activity: ACTIVITY, inbox: INBOX, cards: CARDS } = CHANNELS;

const question = (text: string, extra: Partial<QuestionsCardPayload> = {}): QuestionsCardPayload => ({ questions: [{ id: "q1", question: text, options: ["甲", "乙"], recommended: "甲" }], ...extra });
const ANSWER = { answers: [{ questionId: "q1", answer: "甲" }] };

/** 活动状态视图里某个 agent 现在的样子 */
const now = (td: TestDaemon, agentId: string): Pick<ActivityEventPayload, "state" | "detail"> | undefined => {
  const last = td.daemon.store
    .read(ACTIVITY, 0, EVENT_TYPES.activity)
    .map((e) => e.payload as ActivityEventPayload)
    .findLast((a) => a.agentId === agentId);
  return last && { state: last.state, ...(last.detail === undefined ? {} : { detail: last.detail }) };
};
const itemOf = (td: TestDaemon, cardId: string): InboxItem | undefined => td.daemon.inbox.itemsForCard(cardId)[0];
/** 秘书照新的走法出一张提问卡（卡和事项同一事务，工具 ask_questions 走的就是它） */
const ask = (td: TestDaemon, payload: QuestionsCardPayload) => createSecretaryQuestions(td.daemon, payload);

describe("提问卡放久了", () => {
  it("回放 10-17 那张：这一版之前出的、没进过待办；守护进程 11-01 起来：秘书不再是等你，不补事项，卡还在、照样能答", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, clock: new ManualClock(new Date(2026, 9, 17, 15, 7)) });
    // 老的走法：只建卡，不进待办
    const card = first.daemon.cards.create({ type: "questions", payload: question("调研给谁看？") });
    await expect.poll(() => now(first, "secretary")).toEqual({ state: "waiting_for_user", detail: { kind: "clarification", cardId: card.id } });
    expect(first.daemon.inbox.itemsForCard(card.id)).toEqual([]);
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, clock: new ManualClock(new Date(2026, 10, 1, 9, 0)) });
    await expect.poll(() => now(second, "secretary")?.state).toBe("sleeping");
    expect(second.daemon.inbox.itemsForCard(card.id)).toEqual([]);
    expect(second.daemon.cards.get(card.id)?.status).toBe("pending");

    const frontend = await TestFrontend.connect(second.url);
    expect((await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: card.version, input: ANSWER })).ok).toBe(true);
    expect(second.daemon.cards.get(card.id)?.status).toBe("handled");
    expect(now(second, "secretary")?.state).toBe("sleeping");
  }, 60_000);

  it("这一版之前出的、还没放久的：起来时补一条事项，说明带上编号；用户删了的不再补回来", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const start = new Date(2026, 9, 25, 10, 0);
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, clock: new ManualClock(start) });
    const card = first.daemon.cards.create({ type: "questions", payload: question("调研给谁看？") });
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, clock: new ManualClock(start.getTime() + DAY) });
    const item = itemOf(second, card.id);
    expect(item).toMatchObject({ kind: "card", cardId: card.id, urgency: "non_blocking", origin: { conversation: CHANNELS.secretary } });
    expect(item?.title).toContain("调研给谁看？");
    expect(now(second, "secretary")).toEqual({ state: "waiting_for_user", detail: { kind: "clarification", cardId: card.id } });
    second.daemon.inbox.act({ itemIds: [item!.id], action: "delete", idempotencyKey: "del" });
    await second.daemon.stop();

    const third = await startTestDaemon({ reuse: { dataDir, homeDir }, clock: new ManualClock(start.getTime() + 2 * DAY) });
    expect(third.daemon.inbox.itemsForCard(card.id)).toEqual([]);
  }, 60_000);

  it("到点那一刻：标题不再说等你，待办里降到不卡任务、算看过、标上放久了；前端都收得到；卡照样能答，答完两边都没了", async () => {
    const clock = new ManualClock(new Date(2026, 9, 25, 10, 0));
    const td = await startTestDaemon({ clock });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0, [INBOX]: 0, [CARDS]: 0 });
    const card = ask(td, question("去几天？"));
    const item = itemOf(td, card.id)!;
    expect(item).toMatchObject({ read: false, origin: { conversation: CHANNELS.secretary } });
    expect(item.stale).toBeUndefined();

    clock.advance(7 * DAY - 1);
    expect(now(td, "secretary")?.state).toBe("waiting_for_user");
    clock.advance(1);
    await expect.poll(() => now(td, "secretary")?.state).toBe("sleeping");
    expect(itemOf(td, card.id)).toMatchObject({ urgency: "non_blocking", read: true, stale: true });
    await frontend.next(INBOX, EVENT_TYPES.inboxItem);
    expect(() => td.daemon.inbox.act({ itemIds: [item.id], action: "archive", idempotencyKey: "a2" })).not.toThrow();
    expect(td.daemon.inbox.act({ itemIds: [item.id], action: "unarchive", idempotencyKey: "a3" }).items).toHaveLength(1);

    // 卡还在，照样能答；再拨也不多记一笔
    const pending = td.daemon.cards.get(card.id)!;
    expect(pending.status).toBe("pending");
    expect((await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: pending.version, input: ANSWER })).ok).toBe(true);
    expect(td.daemon.inbox.isProcessed(itemOf(td, card.id)!)).toBe(true);
    const versions = itemOf(td, card.id)!.version;
    clock.advance(30 * DAY);
    expect(itemOf(td, card.id)!.version).toBe(versions);
    expect(now(td, "secretary")?.state).toBe("sleeping");
  }, 60_000);

  it("审批卡放多久都还是等你（不批，那次调用就做不了）；记忆插件在时回避信号照常记一条", async () => {
    const clock = new ManualClock(new Date(2026, 9, 25, 10, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true });
    const card = ask(td, question("去几天？"));
    const approval = td.daemon.approvals.request({
      origin: { agentId: "pm-9", conversation: null, taskId: null, stageId: null, source: "项目「X」" },
      toolCallId: "call-1",
      tool: "read",
      toolTitle: "读文件",
      args: {},
      argsSummary: "a.txt",
      fingerprint: "fp",
      categories: [],
      reason: "越出项目目录",
    });
    await expect.poll(() => now(td, "pm-9")).toEqual({ state: "waiting_for_user", detail: { kind: "approval", tool: "读文件", cardId: approval.cardId } });

    clock.advance(7 * DAY);
    await expect.poll(() => now(td, "secretary")?.state).toBe("sleeping");
    expect(now(td, "pm-9")).toEqual({ state: "waiting_for_user", detail: { kind: "approval", tool: "读文件", cardId: approval.cardId } });
    expect(td.daemon.store.read(CARDS, 0, EVENT_TYPES.cardStale).map((e) => (e.payload as { cardId: string }).cardId)).toEqual([card.id]);
  }, 60_000);
});

describe("算到谁头上、一共几张", () => {
  it("正卡着工作的提问放多久都算在等：为任务问的、负责人为工单问的", async () => {
    const clock = new ManualClock(new Date(2026, 9, 25, 10, 0));
    const td = await startTestDaemon({ clock });
    const forTask = ask(td, question("去几天？", { taskId: "t-1" }));
    const forOrder = td.daemon.cards.create({ type: "questions", urgency: "blocking", payload: question("这个接口要鉴权吗？", { askedBy: { maintainerId: "pm-1", projectId: "p-1", workOrderId: "wo-1" } }) });
    await expect.poll(() => now(td, "pm-1")?.state).toBe("waiting_for_user");
    clock.advance(30 * DAY);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(now(td, "secretary")).toEqual({ state: "waiting_for_user", detail: { kind: "clarification", cardId: forTask.id } });
    expect(now(td, "pm-1")).toEqual({ state: "waiting_for_user", detail: { kind: "clarification", cardId: forOrder.id } });
    const item = itemOf(td, forTask.id)!;
    expect(item).toMatchObject({ urgency: "blocking" });
    expect(item.stale).toBeUndefined();
    expect(() => td.daemon.inbox.act({ itemIds: [item.id], action: "archive", idempotencyKey: "a1" })).toThrow(/归档/);
  }, 60_000);

  it("负责人为工单问的：负责人是等你，秘书不受影响", async () => {
    const td = await startTestDaemon({ clock: new ManualClock(new Date(2026, 9, 25, 10, 0)) });
    const card = td.daemon.cards.create({ type: "questions", urgency: "blocking", payload: question("这个接口要鉴权吗？", { askedBy: { maintainerId: "pm-1", projectId: "p-1", workOrderId: "wo-1" } }) });
    await expect.poll(() => now(td, "pm-1")).toEqual({ state: "waiting_for_user", detail: { kind: "clarification", cardId: card.id } });
    expect(now(td, "secretary")?.state).not.toBe("waiting_for_user");
  }, 60_000);

  it("几张在等：说明是最近一张的编号，写一共几张；放久了、答掉的不算", async () => {
    const clock = new ManualClock(new Date(2026, 9, 25, 10, 0));
    const td = await startTestDaemon({ clock });
    const frontend = await TestFrontend.connect(td.url);
    const older = ask(td, question("第一问"));
    clock.advance(DAY);
    const newer = ask(td, question("第二问"));
    await expect.poll(() => now(td, "secretary")?.detail).toEqual({ kind: "clarification", cardId: newer.id, cardCount: 2 });

    // 第一张先放久了：只剩一张，不再写张数
    clock.advance(6 * DAY);
    await expect.poll(() => now(td, "secretary")?.detail).toEqual({ kind: "clarification", cardId: newer.id });
    expect(itemOf(td, older.id)).toMatchObject({ stale: true });
    expect(itemOf(td, newer.id)?.stale).toBeUndefined();

    expect((await frontend.cardAction({ cardId: newer.id, action: "answer", expectedVersion: newer.version, input: ANSWER })).ok).toBe(true);
    expect(now(td, "secretary")?.state).toBe("sleeping");
  }, 60_000);
});
