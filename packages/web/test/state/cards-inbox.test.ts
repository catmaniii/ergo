// 前端状态层：卡片的纯文本降级、待我处理（排序、已读、处理状态、小红点和灰色数字）、到点的通知、被拒的请求。
// 主线流程回放主切面录下的真实事件流（recorded.test.ts）；这里是手写的边角。
import { describe, expect, test } from "vitest";
import {
  cardDisplay,
  type InboxItem,
  inboxBadge,
  inboxCounts,
  inboxEntries,
  replay,
  resumeCursors,
  selectReminder,
  type UiInput,
} from "../../src/state/index.ts";
import { card, cardInboxItem, frame, inboxItem } from "./events.ts";

describe("卡片的纯文本降级", () => {
  test("认识的类型和版本：按类型显示", () => {
    const state = replay([frame("cards", 1, "card", { card: card("c1", 1, { type: "reminder" }) })]);
    expect(cardDisplay(state, "c1")).toMatchObject({ kind: "typed", type: "reminder" });
  });

  test("不认识的类型：显示纯文本，加上去 Web 处理的链接", () => {
    const state = replay([frame("cards", 1, "card", { card: card("c1", 1, { type: "holo_card", text: "一张以后才有的卡：请确认" }) })]);
    expect(cardDisplay(state, "c1")).toEqual({ kind: "fallback", reason: "unknown_type", text: "一张以后才有的卡：请确认", webPath: "#/card/c1", state: expect.anything() });
  });

  test("认识的类型、但负载版本比这个页面新：也按不认识处理", () => {
    const state = replay([frame("cards", 1, "card", { card: card("c1", 1, { type: "reminder", typeVersion: 99, text: "简单提醒：交报告" }) })]);
    expect(cardDisplay(state, "c1")).toMatchObject({ kind: "fallback", reason: "newer_version", text: "简单提醒：交报告" });
  });

  test("还没收到的卡：undefined", () => {
    expect(cardDisplay(replay([]), "c-nope")).toBeUndefined();
  });
});

describe("待我处理", () => {
  const items: InboxItem[] = [
    inboxItem("i-old", { title: "不卡任务、早", urgency: "non_blocking", createdAt: "2026-10-07T08:00:00.000+08:00" }),
    inboxItem("i-new", { title: "不卡任务、晚", urgency: "non_blocking", createdAt: "2026-10-07T10:00:00.000+08:00", read: true }),
    cardInboxItem("i-block", "c-plan", { title: "卡住任务", urgency: "blocking", read: true }),
    inboxItem("i-deadline", { title: "卡住任务且有时限", urgency: "blocking_deadline" }),
    inboxItem("i-pin", { title: "提醒：交报告", urgency: "non_blocking", pinned: true, createdAt: "2026-10-07T07:00:00.000+08:00" }),
  ];
  const base: UiInput[] = [
    { kind: "frame", frame: frame("cards", 1, "card", { card: card("c-plan", 1, { type: "plan" }) }) },
    ...items.map((item, i): UiInput => ({ kind: "frame", frame: frame("inbox", i + 1, "inbox_item", { item }) })),
  ];

  test("置顶的排在最前，然后按紧急度三档，同一档里新的在前", () => {
    const state = replay(base);
    expect(inboxEntries(state, "open").map((e) => e.item.id)).toEqual(["i-pin", "i-deadline", "i-block", "i-new", "i-old"]);
  });

  test("tab 上：有未读亮小红点（未读数）；看过还没处理的显示灰色数字", () => {
    expect(inboxBadge(replay(base))).toEqual({ unread: 3, seenPending: 2 });
  });

  test("卡片事项处理没处理看卡片本身：在聊天里处理了，这里同步变成已处理", () => {
    const handled = replay([...base, { kind: "frame", frame: frame("cards", 2, "card", { card: card("c-plan", 2, { type: "plan", status: "handled", outcome: { action: "confirm" } }) }) }]);
    expect(inboxEntries(handled, "open").map((e) => e.item.id)).not.toContain("i-block");
    expect(inboxEntries(handled, "done")).toMatchObject([{ item: { id: "i-block" }, processed: true }]);
    expect(inboxBadge(handled)).toEqual({ unread: 3, seenPending: 1 });
  });

  test("事项的更新（已读、处理、归档、删除）：按最新状态；删掉的不再出现", () => {
    const state = replay([
      ...base,
      frame("inbox", 6, "inbox_item", { item: { ...items[0]!, version: 2, read: true, handled: "知道了" } }),
      frame("inbox", 7, "inbox_item", { item: { ...items[1]!, version: 2, archived: true } }),
      frame("inbox", 8, "inbox_item", { item: { ...items[3]!, version: 2, deleted: true } }),
    ]);
    expect(inboxCounts(state)).toEqual({ open: 2, done: 1, archived: 1 });
    expect(inboxEntries(state, "archived").map((e) => e.item.id)).toEqual(["i-new"]);
    expect(inboxEntries(state, "open").map((e) => e.item.id)).toEqual(["i-pin", "i-block"]);
  });

  test("重新同步待我处理：清掉事项，等服务端从头补发", () => {
    const state = replay([...base, { kind: "resync", channel: "inbox" }]);
    expect(inboxEntries(state, "open")).toEqual([]);
    expect(resumeCursors(state)).toEqual({ cards: 1 });
  });
});

/** 一条到点的通知（临时事件，序号沿用待我处理频道最后一条落盘事件的） */
const notify = (id: string, seq: number) => frame("inbox", seq, "notify", { id, title: "提醒：交报告", itemId: "i-1" });

describe("到点的通知", () => {

  test("临时的 notify 事件变成一条待显示的提示（同一条只留一份）；显示过了就去掉", () => {
    const shown = replay([frame("inbox", 1, "inbox_item", { item: inboxItem("i-1") }), notify("n-1", 1), notify("n-1", 1)]);
    expect(shown.alerts).toEqual([{ id: "n-1", title: "提醒：交报告", itemId: "i-1" }]);
    // 临时事件不推进序号
    expect(resumeCursors(shown)).toEqual({ inbox: 1 });
    expect(replay([{ kind: "alert_seen", id: "n-1" }], shown).alerts).toEqual([]);
  });

  test("比已收到的落盘事件还旧的（迟到的）不再提示", () => {
    const state = replay([frame("inbox", 1, "inbox_item", { item: inboxItem("i-1") }), frame("inbox", 2, "inbox_item", { item: inboxItem("i-2") }), notify("n-1", 1)]);
    expect(state.alerts).toEqual([]);
  });
});

describe("被拒的请求", () => {
  test("和消息、卡片对不上的请求失败（比如卡着任务的事项不能删）：记下原因给界面提示，提示过就去掉", () => {
    const failed = replay([{ kind: "request_failed", idempotencyKey: "k-del", error: "「计划等你确认」卡着任务，处理之前不能删除" }]);
    expect(failed.failures).toEqual([{ idempotencyKey: "k-del", error: "「计划等你确认」卡着任务，处理之前不能删除" }]);
    expect(replay([{ kind: "failure_seen", idempotencyKey: "k-del" }], failed).failures).toEqual([]);
  });

  test("卡片按钮的失败留在卡片上，不另外提示", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c1", 1) }),
      { kind: "card_action", cardId: "c1", action: "approve", idempotencyKey: "k1" },
      { kind: "request_failed", idempotencyKey: "k1", error: "已被处理" },
    ]);
    expect(state.failures).toEqual([]);
  });
});

describe("简单提醒", () => {
  test("看板频道上的 reminder 事件：按 id 留最新状态", () => {
    const reminder = { id: "r-1", text: "交报告", schedule: { kind: "once", at: "2026-10-08T09:00:00.000+08:00" }, status: "pending", nextAt: "2026-10-08T09:00:00.000+08:00", cardId: "c1", createdAt: "x", updatedAt: "x" };
    const state = replay([
      frame("board", 1, "reminder", { reminder, change: "created", by: "agent" }),
      frame("board", 2, "reminder", { reminder: { ...reminder, status: "fired", nextAt: undefined, lastFiredAt: "2026-10-08T09:00:00.000+08:00" }, change: "fired", by: "system" }),
    ]);
    expect(selectReminder(state, "r-1")).toMatchObject({ status: "fired", lastFiredAt: "2026-10-08T09:00:00.000+08:00" });
  });
});
