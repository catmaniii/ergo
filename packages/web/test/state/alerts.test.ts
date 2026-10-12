// 105 号票：页面顶上的通知不堆着——只露最新一条加"还有 N 条，在待办里"；露出来 8 秒自动收起，新来一条从头算，
// 手指或鼠标停在上面时不收、离开后从头算。收起只是不在顶上显示：待办里那一项和红点照旧。
import { describe, expect, test } from "vitest";
import {
  ALERT_AUTO_HIDE_MS,
  ALERT_TIMER_IDLE,
  alertBanner,
  alertCounting,
  alertMoreText,
  alertTimer,
  type AlertTimer,
  type AlertTimerInput,
  inboxBadge,
  type NotifyEventPayload,
  replay,
} from "../../src/state/index.ts";
import { frame, inboxItem } from "./events.ts";

const alert = (id: string): NotifyEventPayload => ({ id, title: `提醒 ${id}`, itemId: `i-${id}` });

/** 一串事件之后的计时 */
const run = (inputs: AlertTimerInput[]): AlertTimer => inputs.reduce(alertTimer, ALERT_TIMER_IDLE);

describe("多条只露最新一条", () => {
  test("没有通知：什么都不露", () => {
    expect(alertBanner([])).toBeUndefined();
  });

  test("一条：露它，不说还有几条", () => {
    expect(alertBanner([alert("a")])).toEqual({ latest: alert("a"), more: 0 });
    expect(alertMoreText(0)).toBeUndefined();
  });

  test("三条：露最后到的那条，其余两条说一句在待办里", () => {
    expect(alertBanner([alert("a"), alert("b"), alert("c")])).toEqual({ latest: alert("c"), more: 2 });
    expect(alertMoreText(2)).toBe("还有 2 条，在待办里");
  });
});

describe("自动收起的计时（界面按轮次数 8 秒）", () => {
  test("露出来就开始数，数 8 秒", () => {
    expect(ALERT_AUTO_HIDE_MS).toBe(8000);
    const t = run([{ kind: "shown", id: "a" }]);
    expect(alertCounting(t)).toBe(true);
    expect(t.round).toBe(1);
  });

  test("新来一条从头数；同一条再报一次不算", () => {
    const t = run([
      { kind: "shown", id: "a" },
      { kind: "shown", id: "a" },
    ]);
    expect(t.round).toBe(1);
    expect(alertTimer(t, { kind: "shown", id: "b" }).round).toBe(2);
  });

  test("停在上面不数，离开后从头数", () => {
    const held = run([{ kind: "shown", id: "a" }, { kind: "hold" }]);
    expect(alertCounting(held)).toBe(false);
    const released = alertTimer(held, { kind: "release" });
    expect(alertCounting(released)).toBe(true);
    expect(released.round).toBe(held.round + 1);
  });

  test("停在上面时新来一条：照样不数，离开后才开始", () => {
    const t = run([{ kind: "shown", id: "a" }, { kind: "hold" }, { kind: "shown", id: "b" }]);
    expect(t).toMatchObject({ shownId: "b", held: true });
    expect(alertCounting(t)).toBe(false);
    expect(alertCounting(alertTimer(t, { kind: "release" }))).toBe(true);
  });

  test("停在上面时点了关闭（提示条拿掉了，离开的事件不来）：下一条照样数", () => {
    const t = run([{ kind: "shown", id: "a" }, { kind: "hold" }, { kind: "shown", id: undefined }, { kind: "shown", id: "b" }]);
    expect(alertCounting(t)).toBe(true);
  });

  test("顶上没有了：不再数；没停在上面时离开不算", () => {
    const t = run([{ kind: "shown", id: "a" }, { kind: "shown", id: undefined }]);
    expect(alertCounting(t)).toBe(false);
    expect(alertTimer(t, { kind: "release" })).toBe(t);
  });
});

test("收起只是不在顶上显示：待办里那一项和红点照旧", () => {
  const shown = replay([frame("inbox", 1, "inbox_item", { item: inboxItem("i-a", { notice: "reminder_due", pinned: true }) }), frame("inbox", 1, "notify", alert("a"))]);
  expect(shown.alerts).toHaveLength(1);
  const collapsed = replay([{ kind: "alert_seen", id: "a" }], shown);
  expect(collapsed.alerts).toEqual([]);
  expect(collapsed.inbox["i-a"]).toBeDefined();
  expect(inboxBadge(collapsed)).toEqual({ unread: 1, seenPending: 0 });
});
