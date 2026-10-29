// 106 号票：页面顶上的通知只有一个框，几条在框里轮播——每隔 ALERT_SLIDE_MS 换下一条、标"第几条 / 共几条"；
// 每条都露完过一段、且总共露了不少于 8 秒之后收起，新来一条排进去、8 秒从头算；手指、鼠标停在上面时不换不收，离开后接着。
// 收起只是不在顶上显示：待办里那一项和红点照旧（105 号票起）。
import { describe, expect, test } from "vitest";
import {
  ALERT_AUTO_HIDE_MS,
  ALERT_CAROUSEL_IDLE,
  ALERT_SLIDE_MS,
  type AlertCarousel,
  type AlertCarouselInput,
  alertCarousel,
  alertCountText,
  alertShown,
  alertsChanged,
  alertWait,
  inboxBadge,
  type NotifyEventPayload,
  replay,
} from "../../src/state/index.ts";
import { frame, inboxItem } from "./events.ts";

const alert = (id: string): NotifyEventPayload => ({ id, title: `提醒 ${id}`, itemId: `i-${id}` });

/** 一串事件之后的轮播 */
const run = (inputs: AlertCarouselInput[], from: AlertCarousel = ALERT_CAROUSEL_IDLE): AlertCarousel => inputs.reduce(alertCarousel, from);
/** 顶上的几条变成 ids（新来的、拿掉的） */
const alerts = (at: number, ...ids: string[]): AlertCarouselInput => ({ kind: "alerts", ids, at });
/** 页面上的计时器到了：在 alertWait 给的那一刻送 due */
const tick = (state: AlertCarousel): AlertCarousel => {
  const wait = alertWait(state);
  expect(wait).toBeDefined();
  return alertCarousel(state, { kind: "due", at: state.since! + wait! });
};
/** 框里露的：收起了是"收起" */
const showing = (state: AlertCarousel): string | undefined => (state.hidden ? "收起" : state.shownId);

test("每条露 3–4 秒换下一条，总共至少露 8 秒", () => {
  expect(ALERT_SLIDE_MS).toBeGreaterThanOrEqual(3000);
  expect(ALERT_SLIDE_MS).toBeLessThanOrEqual(4000);
  expect(ALERT_AUTO_HIDE_MS).toBe(8000);
});

describe("框里露哪一条、标第几条", () => {
  test("没有通知：什么都不露，不计时", () => {
    expect(alertShown(ALERT_CAROUSEL_IDLE, [])).toBeUndefined();
    expect(alertWait(ALERT_CAROUSEL_IDLE)).toBeUndefined();
  });

  test("露的是框里此刻那一条（\"查看\"去它），标第几条、共几条", () => {
    const list = [alert("a"), alert("b"), alert("c")];
    const t = tick(run([alerts(0, "a", "b", "c")]));
    expect(alertShown(t, list)).toEqual({ alert: alert("b"), index: 1, total: 3 });
    expect(alertCountText(1, 3)).toBe("2/3");
  });

  test("只有一条：不标几条", () => {
    expect(alertCountText(0, 1)).toBeUndefined();
  });

  test("该收起了：什么都不露", () => {
    const t = tick(tick(run([alerts(0, "a")])));
    expect(t.hidden).toBe(true);
    expect(alertShown(t, [alert("a")])).toBeUndefined();
  });

  test("顶上的几条变了才要重新排（同样几条再报一次不算）", () => {
    const t = run([alerts(0, "a", "b")]);
    expect(alertsChanged(t, [alert("a"), alert("b")])).toBe(false);
    expect(alertsChanged(t, [alert("a"), alert("b"), alert("c")])).toBe(true);
    expect(alertsChanged(t, [alert("b")])).toBe(true);
    expect(alertsChanged(ALERT_CAROUSEL_IDLE, [])).toBe(false);
  });
});

describe("轮播和自动收起（界面在 alertWait 给的时候送 due）", () => {
  test("一条：露出来就数，8 秒收起", () => {
    const t0 = run([alerts(0, "a")]);
    expect(showing(t0)).toBe("a");
    expect(alertWait(t0)).toBe(ALERT_SLIDE_MS);
    // 露完一段还不够 8 秒：接着露它
    const t1 = tick(t0);
    expect(showing(t1)).toBe("a");
    expect(t1.since).toBe(ALERT_SLIDE_MS);
    expect(alertWait(t1)).toBe(ALERT_AUTO_HIDE_MS - ALERT_SLIDE_MS);
    const t2 = tick(t1);
    expect(showing(t2)).toBe("收起");
    expect(alertWait(t2)).toBeUndefined();
  });

  test("三条：从先到的那条起，每段换下一条；每条都露完过一段、总共不少于 8 秒才收起", () => {
    const t0 = run([alerts(0, "a", "b", "c")]);
    const t1 = tick(t0);
    const t2 = tick(t1);
    const t3 = tick(t2);
    expect([t0, t1, t2, t3].map(showing)).toEqual(["a", "b", "c", "收起"]);
    // 到 8 秒时 c 才露了一会儿：等它露完这一段
    expect(t3.since).toBe(3 * ALERT_SLIDE_MS);
  });

  test("两条：都露过了还不够 8 秒，停在最后一条等够了再收", () => {
    const t1 = tick(run([alerts(0, "a", "b")]));
    const t2 = tick(t1);
    expect(showing(t2)).toBe("b");
    expect(alertWait(t2)).toBe(ALERT_AUTO_HIDE_MS - 2 * ALERT_SLIDE_MS);
    const t3 = tick(t2);
    expect(showing(t3)).toBe("收起");
    expect(t3.since).toBe(ALERT_AUTO_HIDE_MS);
  });

  test("陆续到：新来的排在后面，不打断正在露的那条；8 秒从新来的那一刻重新数", () => {
    const t0 = run([alerts(0, "a"), alerts(1000, "a", "b")]);
    expect(showing(t0)).toBe("a");
    expect(alertWait(t0)).toBe(ALERT_SLIDE_MS - 1000);
    const t1 = tick(t0);
    expect(showing(t1)).toBe("b");
    const t2 = tick(t1);
    expect(showing(t2)).toBe("b");
    // b 是 1000 到的：数到 9000
    const t3 = tick(t2);
    expect(showing(t3)).toBe("收起");
    expect(t3.since).toBe(1000 + ALERT_AUTO_HIDE_MS);
  });

  test("停在最后一条等够 8 秒的时候新来一条：马上换到新的，8 秒从头数", () => {
    const waiting = tick(run([alerts(0, "a")]));
    const t0 = alertCarousel(waiting, alerts(5000, "a", "b"));
    expect(alertWait(t0)).toBe(0);
    const t1 = tick(t0);
    expect(showing(t1)).toBe("b");
    expect(alertWait(t1)).toBe(ALERT_SLIDE_MS);
    const t2 = tick(t1);
    expect(showing(t2)).toBe("b");
    const t3 = tick(t2);
    expect(showing(t3)).toBe("收起");
    expect(t3.since).toBe(5000 + ALERT_AUTO_HIDE_MS);
  });

  test("收起之后顶上拿掉了：回到空的，再来一条照样露、照样数", () => {
    const hidden = tick(tick(run([alerts(0, "a")])));
    const empty = alertCarousel(hidden, alerts(8100));
    expect(empty).toMatchObject({ shownId: undefined, hidden: false, held: false });
    const t = alertCarousel(empty, alerts(20_000, "c"));
    expect(showing(t)).toBe("c");
    expect(alertWait(t)).toBe(ALERT_SLIDE_MS);
  });

  test("钟不是整数时照样换、照样收（浮点相减剩一点点不能卡在一条上）", () => {
    // 评审复现的那组数：since=6389.8，在 since+3500 送 due，相减后这一段还剩 9e-13 毫秒
    const t0 = run([alerts(6389.8, "a", "b", "c")]);
    const t1 = tick(t0);
    expect(showing(t1)).toBe("b");
    const t2 = tick(t1);
    expect(showing(t2)).toBe("c");
    expect(showing(tick(t2))).toBe("收起");
    // 一条：停着等够 8 秒的那一下也一样
    const one = tick(run([alerts(6389.8, "a")]));
    expect(showing(one)).toBe("a");
    expect(showing(tick(one))).toBe("收起");
  });

  test("剩不到 1 毫秒的算到点", () => {
    const t = run([alerts(0, "a", "b")]);
    expect(showing(alertCarousel(t, { kind: "due", at: ALERT_SLIDE_MS - 0.5 }))).toBe("b");
    expect(showing(alertCarousel(t, { kind: "due", at: ALERT_SLIDE_MS - 5 }))).toBe("a");
    const waiting = tick(run([alerts(0, "a")]));
    expect(showing(alertCarousel(waiting, { kind: "due", at: ALERT_AUTO_HIDE_MS - 0.5 }))).toBe("收起");
    // 还剩不到 1 毫秒时也不再让界面等那一点点
    expect(alertWait(alertCarousel(t, { kind: "hold", at: ALERT_SLIDE_MS - 0.5 }))).toBeUndefined();
    expect(alertWait(alertCarousel(t, { kind: "release", at: ALERT_SLIDE_MS - 0.5 }))).toBe(0);
  });

  test("露着的那条被拿掉了（比如在浏览器通知上点开了）：换后面没露过的那条，从头露一段", () => {
    const t1 = tick(run([alerts(0, "a", "b", "c")]));
    expect(showing(t1)).toBe("b");
    const t2 = alertCarousel(t1, alerts(4000, "a", "c"));
    expect(showing(t2)).toBe("c");
    expect(alertWait(t2)).toBe(ALERT_SLIDE_MS);
    // 拿掉不算新来：8 秒照旧从 0 数，c 露完这一段（7500）还差一点，接着露它到 8 秒
    const t3 = tick(t2);
    expect(showing(t3)).toBe("c");
    expect(alertWait(t3)).toBe(ALERT_AUTO_HIDE_MS - 4000 - ALERT_SLIDE_MS);
    const t4 = tick(t3);
    expect(showing(t4)).toBe("收起");
    expect(t4.since).toBe(ALERT_AUTO_HIDE_MS);
  });
});

describe("停在上面不换、不收，离开后接着", () => {
  test("停住时不数；离开后接着数这一条剩下的", () => {
    const held = run([alerts(0, "a", "b"), { kind: "hold", at: 1000 }]);
    expect(held.held).toBe(true);
    expect(alertWait(held)).toBeUndefined();
    // 停多久都不换
    const still = alertCarousel(held, { kind: "due", at: 60_000 });
    expect(showing(still)).toBe("a");
    const released = alertCarousel(still, { kind: "release", at: 60_000 });
    expect(alertWait(released)).toBe(ALERT_SLIDE_MS - 1000);
    expect(showing(tick(released))).toBe("b");
  });

  test("等够 8 秒的时候停住：不收，离开后把剩下的数完", () => {
    const waiting = tick(run([alerts(0, "a")]));
    const held = alertCarousel(waiting, { kind: "hold", at: 5000 });
    const released = alertCarousel(held, { kind: "release", at: 30_000 });
    expect(showing(released)).toBe("a");
    expect(alertWait(released)).toBe(ALERT_AUTO_HIDE_MS - 5000);
    expect(showing(tick(released))).toBe("收起");
  });

  test("停在上面时新来一条：照样不换、不收，离开后才换过去", () => {
    const waiting = tick(run([alerts(0, "a")]));
    const t = run([{ kind: "hold", at: 4000 }, alerts(5000, "a", "b")], waiting);
    expect(showing(t)).toBe("a");
    expect(alertWait(t)).toBeUndefined();
    const released = alertCarousel(t, { kind: "release", at: 9000 });
    expect(alertWait(released)).toBe(0);
    expect(showing(tick(released))).toBe("b");
  });

  test("停在上面时点了关闭（框拿掉了，离开的事件不来）：下一条照样换、照样数", () => {
    const t = run([alerts(0, "a", "b"), { kind: "hold", at: 1000 }, alerts(2000), alerts(30_000, "c", "d")]);
    expect(t.held).toBe(false);
    expect(showing(t)).toBe("c");
    expect(alertWait(t)).toBe(ALERT_SLIDE_MS);
    expect(showing(tick(t))).toBe("d");
  });

  test("没停在上面时离开不算：还是在原来那一刻换", () => {
    const t = alertCarousel(run([alerts(0, "a", "b")]), { kind: "release", at: 1000 });
    expect(t.held).toBe(false);
    expect(t.since! + alertWait(t)!).toBe(ALERT_SLIDE_MS);
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
