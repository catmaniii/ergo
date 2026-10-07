// 主切面：简单提醒（规格第 7、13 节）。秘书接 faux 剧本，用只产生卡片的工具建、改、取消提醒；
// 用户也能在提醒卡上改、取消。调度器的时钟换成手动拨的（ManualClock），到点不靠真等：
// 到点时前端收到通知，待我处理里出现一条置顶的提醒事项，期间不拉起任何 agent 子进程。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  type MessageEventPayload,
  nowIso,
  type NotifyEventPayload,
  type ReminderEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 };

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

const createCall = (args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "create_reminder", arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

/** 起一个守护进程（时钟停在 START），连上一个订阅全部相关频道的前端 */
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

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const lastCard = (frontend: TestFrontend): Card => cardsOf(frontend).at(-1)!;
const remindersOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload);

describe("秘书建提醒", () => {
  it("\"明早 9 点提醒我交报告\" → 秘书调用建提醒的工具 → 聊天里出现提醒卡（时间和内容，可以改、取消）；秘书看到的结果写明落到了哪天几点", async () => {
    const { frontend } = await setup([createCall({ text: "交报告", inDays: 1, time: "09:00" }), { kind: "echo_context" }]);
    await tell(frontend, "明早 9 点提醒我交报告");

    // 聊天：用户消息、只有卡片引用的一条、秘书的回复
    const messages = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
    expect(messages.map((m) => `${m.speaker}:${m.parts.map((p) => p.type).join(",")}`)).toEqual(["user:text", "agent:card_ref", "agent:text"]);
    const card = lastCard(frontend);
    expect(messages[1]!.parts).toEqual([{ type: "card_ref", cardId: card.id }]);
    expect(card).toMatchObject({
      type: "reminder",
      version: 1,
      status: "pending",
      payload: { reminderId: "r-1", text: "交报告", schedule: { kind: "once", at: nowIso(at(10, 8, 9)) }, status: "pending", nextAt: nowIso(at(10, 8, 9)) },
      text: "简单提醒：交报告 · 10 月 8 日（周四）09:00",
      createdAt: nowIso(START),
    });
    // 提醒在任务看板频道上：待触发，秘书建的
    expect(remindersOf(frontend)).toEqual([
      {
        change: "created",
        by: "agent",
        reminder: { id: "r-1", text: "交报告", schedule: { kind: "once", at: nowIso(at(10, 8, 9)) }, status: "pending", nextAt: nowIso(at(10, 8, 9)), cardId: card.id, createdAt: nowIso(START), updatedAt: nowIso(START) },
      },
    ]);

    // 秘书的工具只有建、改、取消提醒这三个（没有任何对卡片做动作的工具）；工具结果写明落到了哪天几点
    const seen = messages[2]!.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen.split("\n").filter((l) => l.startsWith("[tool]"))).toEqual(["[tool] create_reminder", "[tool] update_reminder", "[tool] cancel_reminder"]);
    expect(seen).toContain("[toolResult] create_reminder: 已建好提醒 r-1「交报告」：10 月 8 日（周四）09:00");
  });

  it("时间不对（已经过去了）：工具结果说明原因，秘书改了再试；不产生提醒和卡片", async () => {
    const { frontend, daemon } = await setup([createCall({ text: "开会", date: "2026-10-01", time: "09:00" }), { kind: "echo_context" }]);
    await tell(frontend, "10 月 1 号 9 点提醒我开会");
    const reply = (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message;
    expect(reply.parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toMatch(/\[toolResult\] create_reminder: 这个时间已经过去了/);
    expect(daemon.reminders.pending()).toEqual([]);
    expect(cardsOf(frontend)).toEqual([]);
  });
});

describe("到点", () => {
  it("一次性提醒：拨到点 → 前端收到通知，待我处理里一条置顶的提醒事项，提醒卡变成已触发；期间不拉起任何 agent", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "交报告", inDays: 1, time: "09:00" }), say("好，明早 9 点提醒你交报告。")]);
    await tell(frontend, "明早 9 点提醒我交报告");
    const card = lastCard(frontend);
    const spawned = daemon.agents.spawnCount;
    const secretaryPid = daemon.secretary.pid;

    clock.advanceTo(at(10, 8, 8, 59));
    expect(daemon.reminders.get("r-1")?.status).toBe("pending");
    clock.advanceTo(at(10, 8, 9, 0));

    const item = ((await frontend.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({
      kind: "notice",
      notice: "reminder_due",
      title: "提醒：交报告",
      body: "10 月 8 日（周四）09:00 的提醒。",
      source: "简单提醒",
      urgency: "non_blocking",
      pinned: true,
      actions: ["知道了"],
      cardId: card.id,
      read: false,
      createdAt: nowIso(at(10, 8, 9)),
    });
    const notify = (await frontend.next(INBOX, EVENT_TYPES.notify)).payload as NotifyEventPayload;
    expect(notify).toMatchObject({ title: "提醒：交报告", itemId: item.id });

    expect(lastCard(frontend)).toMatchObject({ id: card.id, version: 2, status: "expired", payload: { status: "fired", lastFiredAt: nowIso(at(10, 8, 9)) }, text: "简单提醒：交报告 · 10 月 8 日（周四）09:00 · 已触发" });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "fired", by: "system", reminder: { status: "fired", lastFiredAt: nowIso(at(10, 8, 9)) } });
    expect(remindersOf(frontend).at(-1)!.reminder.nextAt).toBeUndefined();
    expect(daemon.agents.spawnCount).toBe(spawned);
    expect(daemon.secretary.pid).toBe(secretaryPid);

    // 再往后拨：一次性的不会再响
    clock.advanceTo(at(10, 9, 9, 0));
    expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem })).toHaveLength(1);
    saveOrCheckRecording("reminder-due", frontend.recording);
  });

  it("每天：到点响一次，提醒仍待触发，第二天同一时刻再响", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "吃药", time: "08:00", repeat: { kind: "daily" } }), say("好。")]);
    await tell(frontend, "每天早上 8 点提醒我吃药");
    expect(daemon.reminders.get("r-1")?.nextAt).toBe(nowIso(at(10, 8, 8)));
    await expectFiresAt(frontend, clock, [at(10, 8, 8), at(10, 9, 8)]);
    expect(daemon.reminders.get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(10, 10, 8)), lastFiredAt: nowIso(at(10, 9, 8)) });
    expect(lastCard(frontend)).toMatchObject({ status: "pending", payload: { nextAt: nowIso(at(10, 10, 8)) } });
  });

  it("每周几：周一、五 19:00 → 先在周五响，再在下周一响", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "跑步", time: "19:00", repeat: { kind: "weekly", weekdays: [1, 5] } }), say("好。")]);
    await tell(frontend, "每周一和周五晚上 7 点提醒我跑步");
    await expectFiresAt(frontend, clock, [at(10, 9, 19), at(10, 12, 19)]);
    expect(daemon.reminders.get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(10, 16, 19)) });
  });

  it("每月几号：每月 8 号 09:00 → 10 月 8 日响，再在 11 月 8 日响", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "交房租", time: "09:00", repeat: { kind: "monthly", days: [8] } }), say("好。")]);
    await tell(frontend, "每月 8 号早上 9 点提醒我交房租");
    await expectFiresAt(frontend, clock, [at(10, 8, 9), at(11, 8, 9)]);
    expect(daemon.reminders.get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(12, 8, 9)) });
  });

  it("守护进程正常重启后，还没到点的提醒照常触发", async () => {
    const first = await setup([createCall({ text: "交报告", inDays: 1, time: "09:00" }), say("好。")]);
    await tell(first.frontend, "明早 9 点提醒我交报告");
    await first.frontend.close();
    await first.daemon.stop();

    const clock = new ManualClock(at(10, 7, 23, 0));
    const second = await startTestDaemon({ secretary: [], clock, reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const frontend = await TestFrontend.connect(second.url);
    await frontend.subscribe(ALL);
    clock.advanceTo(at(10, 8, 9, 0));
    expect(((await frontend.next(INBOX, EVENT_TYPES.notify)).payload as NotifyEventPayload).title).toBe("提醒：交报告");
  });
});

describe("改和取消", () => {
  it("用户在提醒卡上改时间：提醒按新时间响，旧时间不响", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "交报告", inDays: 1, time: "09:00" }), say("好。")]);
    await tell(frontend, "明早 9 点提醒我交报告");
    const card = lastCard(frontend);

    const tooEarly = await frontend.cardAction({ cardId: card.id, action: "save", expectedVersion: 1, input: { schedule: { kind: "once", at: nowIso(at(10, 1, 9)) } } });
    expect(tooEarly).toMatchObject({ ok: false, error: { code: "bad_params", message: expect.stringContaining("已经过去了") } });

    const ack = await frontend.cardAction({ cardId: card.id, action: "save", expectedVersion: 1, input: { schedule: { kind: "once", at: nowIso(at(10, 8, 10)) } } });
    expect(ack).toMatchObject({ ok: true, result: { cardId: card.id, version: 2 } });
    // 提醒卡的第一版在秘书这一轮结束之前就推过了，这里等到的是动作之后的那一版
    await frontend.next(CARDS, EVENT_TYPES.card);
    expect(lastCard(frontend)).toMatchObject({ version: 2, status: "pending", payload: { schedule: { kind: "once", at: nowIso(at(10, 8, 10)) }, nextAt: nowIso(at(10, 8, 10)) } });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "updated", by: "user" });

    clock.advanceTo(at(10, 8, 9, 30));
    expect(daemon.reminders.get("r-1")?.status).toBe("pending");
    clock.advanceTo(at(10, 8, 10, 0));
    expect(((await frontend.next(INBOX, EVENT_TYPES.notify)).payload as NotifyEventPayload).title).toBe("提醒：交报告");
  });

  it("用户在提醒卡上改成重复的（每天）", async () => {
    const { frontend, daemon } = await setup([createCall({ text: "喝水", inMinutes: 30 }), say("好。")]);
    await tell(frontend, "半小时后提醒我喝水");
    expect(daemon.reminders.get("r-1")?.nextAt).toBe(nowIso(at(10, 7, 21, 30)));
    const card = lastCard(frontend);
    await frontend.cardAction({ cardId: card.id, action: "save", expectedVersion: 1, input: { schedule: { kind: "daily", time: "15:00" } } });
    expect(daemon.reminders.get("r-1")).toMatchObject({ schedule: { kind: "daily", time: "15:00" }, nextAt: nowIso(at(10, 8, 15)) });
  });

  it("用户在提醒卡上取消：卡片已处理，提醒取消，到点不响", async () => {
    const { frontend, clock, daemon } = await setup([createCall({ text: "交报告", inDays: 1, time: "09:00" }), say("好。")]);
    await tell(frontend, "明早 9 点提醒我交报告");
    const card = lastCard(frontend);
    expect(await frontend.cardAction({ cardId: card.id, action: "cancel_reminder", expectedVersion: 1 })).toMatchObject({ ok: true });
    // 提醒卡的第一版在秘书这一轮结束之前就推过了，这里等到的是动作之后的那一版
    await frontend.next(CARDS, EVENT_TYPES.card);
    expect(lastCard(frontend)).toMatchObject({ status: "handled", outcome: { action: "cancel_reminder" }, payload: { status: "cancelled" }, text: expect.stringContaining("已取消") });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "cancelled", by: "user", reminder: { status: "cancelled" } });

    clock.advanceTo(at(10, 9, 0, 0));
    expect(daemon.reminders.pending()).toEqual([]);
    expect(frontend.events({ channel: INBOX })).toEqual([]);
  });

  it("秘书按用户的话改时间、再取消：卡片跟着变，聊天里再出现这张卡", async () => {
    const { frontend, clock } = await setup([
      createCall({ text: "交报告", inDays: 1, time: "09:00" }),
      say("好，明早 9 点。"),
      { kind: "reply", toolCalls: [{ name: "update_reminder", arguments: { reminderId: "r-1", time: "10:00" } }] },
      say("改到 10 点了。"),
      { kind: "reply", toolCalls: [{ name: "cancel_reminder", arguments: { reminderId: "r-1" } }] },
      say("取消了。"),
    ]);
    await tell(frontend, "明早 9 点提醒我交报告");
    const card = lastCard(frontend);

    await tell(frontend, "改到 10 点吧");
    expect(lastCard(frontend)).toMatchObject({ id: card.id, version: 2, status: "pending", payload: { schedule: { kind: "once", at: nowIso(at(10, 8, 10)) } } });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "updated", by: "agent" });

    await tell(frontend, "算了，不用提醒了");
    expect(lastCard(frontend)).toMatchObject({ id: card.id, version: 3, status: "handled", outcome: { action: "cancel_reminder", note: "秘书按你的话取消了" } });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "cancelled", by: "agent" });

    const refs = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => (f.payload as MessageEventPayload).message.parts.filter((p) => p.type === "card_ref"));
    expect(refs).toEqual([1, 2, 3].map(() => ({ type: "card_ref", cardId: card.id })));
    clock.advanceTo(at(10, 9, 0, 0));
    expect(frontend.events({ channel: INBOX })).toEqual([]);
  });

  it("秘书给错了提醒编号：工具结果说明没有这条，并列出现在待触发的提醒", async () => {
    const { frontend } = await setup([
      createCall({ text: "交报告", inDays: 1, time: "09:00" }),
      say("好。"),
      { kind: "reply", toolCalls: [{ name: "cancel_reminder", arguments: { reminderId: "r-9" } }] },
      { kind: "echo_context" },
    ]);
    await tell(frontend, "明早 9 点提醒我交报告");
    await tell(frontend, "取消那个提醒");
    const seen = (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen).toContain("[toolResult] cancel_reminder: 没有编号为 r-9 的提醒。现在待触发的提醒：r-1「交报告」10 月 8 日（周四）09:00");
  });
});

/** 依次拨到每个时刻：每次都收到一条提醒通知和一条置顶的提醒事项，时间对得上 */
async function expectFiresAt(frontend: TestFrontend, clock: ManualClock, times: Date[]): Promise<void> {
  for (const time of times) {
    clock.advanceTo(new Date(time.getTime() - 60_000));
    clock.advanceTo(time);
    const item = ((await frontend.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ notice: "reminder_due", pinned: true, createdAt: nowIso(time) });
    await frontend.next(INBOX, EVENT_TYPES.notify);
  }
  expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem })).toHaveLength(times.length);
}
