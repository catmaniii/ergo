// 主切面：简单提醒能归档、删除，取消照旧（185 号票）。用户 2026-10-20："打个电话这种简单提醒没办法归档和删除和取消"。
// - 归档：已经结束的（一次性的已触发、已取消）才能归档，进看板的"已归档"；还没结束的先取消；任务没有取消归档，提醒也没有；
// - 删除：任何提醒都能删——还没触发的先停掉时间表（到点不再响），删了看板、日历、待办都不再出现；事件日志里追加一条"删了"
//   （原来的事件不改写）；聊天里原来那张提醒卡写"已删除"；
// - 取消：还没触发的照旧能取消；
// - 哪里能做：看板菜单、提醒卡上的按钮、看板多选都交 reminder_action（卡片动作只收待处理的卡，已触发、已取消的提醒卡已经不是），
//   各自成败、逐条回报；秘书有归档的工具（照取消的工具，直接做），删除走快速动作 delete_reminder，总会先在聊天里出一张卡请用户确认。
// 调度器的时钟换成手动拨的（ManualClock），假模型。
import {
  type Card,
  CHANNELS,
  EVENT_TYPES,
  type QuickActionCardPayload,
  type ReminderActionResult,
  type ReminderEventPayload,
  type ResponseFrame,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { reminderService, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { call, cardWhere, cardsOf, latestCards, ok, say, toolCallsOf } from "../helpers/task-flow.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 };

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

const create = (text: string, args: Record<string, unknown>) => call("create_reminder", { text, ...args });

async function setup(secretary: FauxStep[]) {
  const clock = new ManualClock(START);
  const test = await startTestDaemon({ secretary, clock });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe(ALL);
  return { ...test, clock, frontend };
}

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const remindersOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload);
const reminderCard = (frontend: TestFrontend, cardId: string): Card => latestCards(frontend).find((c) => c.id === cardId)!;
const resultsOf = (r: ResponseFrame) => (ok(r) as ReminderActionResult).results;
const act = (frontend: TestFrontend, reminderIds: string[], action: "cancel" | "archive" | "delete", key?: string) => frontend.reminderAction({ reminderIds, action }, key);

describe("归档", () => {
  it("一次性提醒响过以后能归档：进已归档，提醒卡写已归档；还没结束的不能归档（先取消），归档过的不能再归档", async () => {
    const { frontend, clock, daemon } = await setup([create("打个电话", { inDays: 1, time: "20:00" }), say("好。"), create("交房租", { time: "09:00", repeat: { kind: "monthly", days: [8] } }), say("好。")]);
    await tell(frontend, "明晚 8 点提醒我打个电话");
    await tell(frontend, "每月 8 号提醒我交房租");
    const card = cardsOf(frontend)[0]!;

    // 还没响：不能归档，原因写明先取消
    expect(resultsOf(await act(frontend, ["r-1", "r-2"], "archive"))).toEqual([
      { reminderId: "r-1", ok: false, code: "not_allowed", message: "提醒 r-1「打个电话」还没结束（待触发）：先取消再归档" },
      { reminderId: "r-2", ok: false, code: "not_allowed", message: "提醒 r-2「交房租」还没结束（待触发）：先取消再归档" },
    ]);

    clock.advanceTo(at(10, 8, 20, 0));
    await frontend.next(INBOX, EVENT_TYPES.notify);
    expect(resultsOf(await act(frontend, ["r-1"], "archive"))).toEqual([{ reminderId: "r-1", ok: true, status: "fired", archived: true }]);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "archived", by: "user", reminder: { id: "r-1", status: "fired", archived: true } });
    await cardWhere(frontend, (c) => c.id === card.id && c.version === 3);
    expect(reminderCard(frontend, card.id)).toMatchObject({ status: "expired", payload: { status: "fired", archived: true }, text: "简单提醒：打个电话 · 10 月 8 日（周四）20:00 · 已触发 · 已归档" });
    expect(reminderService(daemon).get("r-1")).toMatchObject({ status: "fired", archived: true });
    // 归档不动待我处理里那一条到点的事项（交房租 10-08 09:00 也响过了）
    expect(daemon.inbox.list().map((i) => i.title)).toEqual(["提醒：交房租", "提醒：打个电话"]);

    expect(resultsOf(await act(frontend, ["r-1"], "archive"))).toEqual([{ reminderId: "r-1", ok: false, code: "not_allowed", message: "提醒 r-1「打个电话」已经归档了" }]);
  });

  it("已取消的能归档；同一幂等键重发拿到同一个结果，不多追加事件", async () => {
    const { frontend } = await setup([create("交报告", { inDays: 1, time: "09:00" }), say("好。")]);
    await tell(frontend, "明早 9 点提醒我交报告");
    expect(resultsOf(await act(frontend, ["r-1"], "cancel"))).toEqual([{ reminderId: "r-1", ok: true, status: "cancelled" }]);
    const first = resultsOf(await act(frontend, ["r-1"], "archive", "k-archive"));
    expect(first).toEqual([{ reminderId: "r-1", ok: true, status: "cancelled", archived: true }]);
    const before = remindersOf(frontend).length;
    expect(resultsOf(await act(frontend, ["r-1"], "archive", "k-archive"))).toEqual(first);
    expect(remindersOf(frontend)).toHaveLength(before);
  });
});

describe("删除", () => {
  it("还没触发的删了：时间表停掉，到点不响；提醒卡写已删除（再点旧按钮回这句）；日历上没有；事件日志追加一条删了，原来的不改写", async () => {
    const { frontend, clock, daemon } = await setup([create("打个电话", { inDays: 1, time: "20:00" }), say("好。")]);
    await tell(frontend, "明晚 8 点提醒我打个电话");
    const card = cardsOf(frontend)[0]!;
    expect((await frontend.calendarMonth("2026-10")).days.find((d) => d.date === "2026-10-08")?.reminders.map((r) => r.text)).toEqual(["打个电话"]);

    expect(resultsOf(await act(frontend, ["r-1"], "delete"))).toEqual([{ reminderId: "r-1", ok: true, status: "deleted" }]);
    expect(remindersOf(frontend).map((e) => e.change)).toEqual(["created", "deleted"]);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", by: "user", reminder: { id: "r-1", status: "deleted" } });
    expect(remindersOf(frontend).at(-1)!.reminder.nextAt).toBeUndefined();
    // 原来那条"建了"的事件照旧在日志里
    expect(daemon.store.read(BOARD, 0, EVENT_TYPES.reminder).map((e) => (e.payload as ReminderEventPayload).change)).toEqual(["created", "deleted"]);

    await cardWhere(frontend, (c) => c.id === card.id && c.version === 2);
    expect(reminderCard(frontend, card.id)).toMatchObject({ status: "expired", expiredNote: "提醒已经删了", payload: { status: "deleted" }, text: "简单提醒：打个电话 · 10 月 8 日（周四）20:00 · 已删除" });
    expect(await frontend.cardAction({ cardId: card.id, action: "cancel_reminder", expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "conflict", message: "提醒已经删了" } });

    expect((await frontend.calendarMonth("2026-10")).days.flatMap((d) => d.reminders)).toEqual([]);
    clock.advanceTo(at(10, 9, 0, 0));
    expect(frontend.events({ channel: INBOX })).toEqual([]);
    expect(reminderService(daemon).pending()).toEqual([]);
  });

  it("响过的、重复的、归档了的都能删；响过的那条到点事项从待我处理里删掉；删了的不能再取消、归档、删", async () => {
    const { frontend, clock, daemon } = await setup([
      create("打个电话", { inDays: 1, time: "08:00" }),
      say("好。"),
      create("吃药", { time: "09:00", repeat: { kind: "daily" } }),
      say("好。"),
      create("交报告", { inDays: 1, time: "10:00" }),
      say("好。"),
    ]);
    await tell(frontend, "明早 8 点提醒我打个电话");
    await tell(frontend, "每天 9 点提醒我吃药");
    await tell(frontend, "明早 10 点提醒我交报告");
    clock.advanceTo(at(10, 8, 10, 0));
    expect(daemon.inbox.list().map((i) => i.title)).toEqual(["提醒：打个电话", "提醒：吃药", "提醒：交报告"]);
    ok(await act(frontend, ["r-3"], "archive"));

    expect(resultsOf(await act(frontend, ["r-1", "r-2", "r-3"], "delete"))).toEqual([
      { reminderId: "r-1", ok: true, status: "deleted" },
      { reminderId: "r-2", ok: true, status: "deleted" },
      { reminderId: "r-3", ok: true, status: "deleted", archived: true },
    ]);
    expect(daemon.inbox.list()).toEqual([]);
    clock.advanceTo(at(10, 10, 0, 0));
    expect(daemon.inbox.list()).toEqual([]);
    expect((await frontend.calendarMonth("2026-10")).days.flatMap((d) => d.reminders)).toEqual([]);

    expect(resultsOf(await act(frontend, ["r-2"], "cancel"))).toEqual([{ reminderId: "r-2", ok: false, code: "not_allowed", message: "提醒 r-2「吃药」已经删了" }]);
    expect(resultsOf(await act(frontend, ["r-2"], "archive"))).toEqual([{ reminderId: "r-2", ok: false, code: "not_allowed", message: "提醒 r-2「吃药」已经删了" }]);
    expect(resultsOf(await act(frontend, ["r-2", "r-9"], "delete"))).toEqual([
      { reminderId: "r-2", ok: false, code: "not_allowed", message: "提醒 r-2「吃药」已经删了" },
      { reminderId: "r-9", ok: false, code: "not_found", message: "没有编号为 r-9 的提醒。现在一条提醒都没有" },
    ]);
  });

  it("删了以后新建的提醒编号接着往下排（不收回）", async () => {
    const { frontend } = await setup([create("打个电话", { inDays: 1, time: "08:00" }), say("好。"), create("交报告", { inDays: 1, time: "10:00" }), say("好。")]);
    await tell(frontend, "明早 8 点提醒我打个电话");
    ok(await act(frontend, ["r-1"], "delete"));
    await tell(frontend, "明早 10 点提醒我交报告");
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "created", reminder: { id: "r-2", text: "交报告" } });
  });
});

describe("取消照旧", () => {
  it("还没触发的一次性、重复的能取消（提醒卡已处理），到点不响；响过的一次性不能取消", async () => {
    const { frontend, clock, daemon } = await setup([
      create("交报告", { inDays: 1, time: "09:00" }),
      say("好。"),
      create("吃药", { time: "08:00", repeat: { kind: "daily" } }),
      say("好。"),
      create("打个电话", { inMinutes: 30 }),
      say("好。"),
    ]);
    await tell(frontend, "明早 9 点提醒我交报告");
    await tell(frontend, "每天 8 点提醒我吃药");
    await tell(frontend, "半小时后提醒我打个电话");
    clock.advanceTo(at(10, 7, 21, 30));
    await frontend.next(INBOX, EVENT_TYPES.notify);

    expect(resultsOf(await act(frontend, ["r-1", "r-2", "r-3"], "cancel"))).toEqual([
      { reminderId: "r-1", ok: true, status: "cancelled" },
      { reminderId: "r-2", ok: true, status: "cancelled" },
      { reminderId: "r-3", ok: false, code: "not_allowed", message: "提醒 r-3「打个电话」已经响过了；要再提醒就建一条新的" },
    ]);
    const first = cardsOf(frontend)[0]!;
    await cardWhere(frontend, (c) => c.id === first.id && c.status === "handled");
    expect(reminderCard(frontend, first.id)).toMatchObject({ status: "handled", outcome: { action: "cancel_reminder" }, payload: { status: "cancelled" } });
    clock.advanceTo(at(10, 9, 0, 0));
    expect(daemon.inbox.list().map((i) => i.title)).toEqual(["提醒：打个电话"]);
  });
});

describe("秘书", () => {
  it("\"把打个电话那条提醒归档\"：秘书用归档的工具直接归档，聊天里再出现这张提醒卡", async () => {
    const { frontend, clock } = await setup([create("打个电话", { inMinutes: 30 }), say("好。"), call("archive_reminder", { reminderId: "r-1" }), { kind: "echo_context" }]);
    await tell(frontend, "半小时后提醒我打个电话");
    const card = cardsOf(frontend)[0]!;
    clock.advanceTo(at(10, 7, 21, 30));
    await frontend.next(INBOX, EVENT_TYPES.notify);

    await tell(frontend, "把打个电话那条提醒归档");
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "archived", by: "agent", reminder: { id: "r-1", archived: true } });
    const calls = toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "archive_reminder");
    expect(calls).toEqual([expect.objectContaining({ disposition: "do", outcome: "done", resultSummary: "已归档提醒 r-1「打个电话」：看板上挪进了“已归档”。" })]);
    const refs = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => (f.payload as { message: { parts: { type: string; cardId?: string }[] } }).message.parts.filter((p) => p.type === "card_ref"));
    expect(refs).toEqual([{ type: "card_ref", cardId: card.id }, { type: "card_ref", cardId: card.id }]);
  });

  it("\"把打个电话那条提醒删了\"：秘书提议快速动作 delete_reminder，点明了也先在聊天里出卡请用户确认；点了执行才删", async () => {
    const { frontend, clock, daemon } = await setup([
      create("打个电话", { inDays: 1, time: "20:00" }),
      say("好。"),
      call("propose_quick_action", { type: "delete_reminder", params: { reminderId: "r-1" } }),
      say("请你在卡上确认。"),
    ]);
    await tell(frontend, "明晚 8 点提醒我打个电话");
    const reminder = cardsOf(frontend)[0]!;
    await tell(frontend, "把 r-1 那条提醒删了");

    const pending = await cardWhere(frontend, (c) => c.type === "quick_action" && c.status === "pending");
    expect(pending.payload).toMatchObject({ action: { type: "delete_reminder", params: { reminderId: "r-1" } }, name: "删除简单提醒", title: "删除提醒 r-1「打个电话」" } satisfies Partial<QuickActionCardPayload>);
    expect(toolCallsOf(frontend, SECRETARY).at(-1)?.resultSummary).toContain("等用户确认");
    expect(reminderService(daemon).get("r-1")?.status).toBe("pending");

    ok(await frontend.cardAction({ cardId: pending.id, action: "execute", expectedVersion: pending.version }));
    const done = await cardWhere(frontend, (c) => c.id === pending.id && c.status === "handled");
    expect((done.payload as QuickActionCardPayload).result).toBe("已删除提醒 r-1「打个电话」：看板、日历、待办里都不再有它");
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", by: "user", reminder: { id: "r-1", status: "deleted" } });
    await cardWhere(frontend, (c) => c.id === reminder.id && c.status === "expired");
    clock.advanceTo(at(10, 9, 0, 0));
    expect(daemon.inbox.list().filter((i) => i.kind === "notice")).toEqual([]);
  });

  it("删除的提议写错了编号、删过的：不出卡，原因交回秘书", async () => {
    const { frontend } = await setup([
      create("打个电话", { inDays: 1, time: "20:00" }),
      say("好。"),
      call("propose_quick_action", { type: "delete_reminder", params: { reminderId: "r-9" } }),
      say("没找到。"),
    ]);
    await tell(frontend, "明晚 8 点提醒我打个电话");
    await tell(frontend, "把 r-9 删了");
    expect(latestCards(frontend).filter((c) => c.type === "quick_action")).toEqual([]);
    expect(toolCallsOf(frontend, SECRETARY).at(-1)?.resultSummary).toContain("不能这样做：没有编号为 r-9 的提醒。现在的提醒：r-1「打个电话」");
  });
});
