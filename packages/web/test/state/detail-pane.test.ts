// 详情页的开合和返回栈（56 号票）：纯函数，宽屏、窄屏各走一遍。
import { describe, expect, test } from "vitest";
import {
  closeDetail,
  DETAIL_WIDTH_INITIAL,
  detailKey,
  detailTitle,
  detailColumnWidth,
  type DetailNav,
  detailShown,
  dragDetailWidth,
  drillDetail,
  layoutChanged,
  NO_DETAIL,
  openDetail,
  revealFromDetail,
  systemBack,
} from "../../src/state/index.ts";

const item = (id: string) => ({ type: "item", id }) as const;

describe("从会话里点开一条", () => {
  test("按条目 id 存；宽屏右栏出现，窄屏滑到详情页", () => {
    const wide = openDetail(NO_DETAIL, item("m-1"), true);
    expect(wide.detail).toEqual(item("m-1"));
    expect(detailShown(wide, true)).toBe(true);
    const narrow = openDetail(NO_DETAIL, item("m-1"), false);
    expect([narrow.page, detailShown(narrow, false)]).toEqual(["detail", true]);
    expect([detailShown(NO_DETAIL, true), detailShown(NO_DETAIL, false)]).toEqual([false, false]);
  });
});

describe("任务详情“⋯”里的计划、工单、工具包、消耗、运行（90 号票：页签收进菜单）", () => {
  test("宽屏在右边的详情栏打开、‹ 关掉；手机整页打开、‹ 回到会话；标题写是哪一样，换一样从头看", () => {
    const plan = { type: "panel", taskId: "t-1", panel: "plan" } as const;
    const wide = openDetail(openDetail(NO_DETAIL, item("m-1"), true), plan, true);
    expect([wide.detail, wide.back, detailShown(wide, true)]).toEqual([plan, [], true]);
    expect(detailShown(closeDetail(wide, true), true)).toBe(false);
    const narrow = openDetail(NO_DETAIL, plan, false);
    expect([narrow.page, closeDetail(narrow, false).page]).toEqual(["detail", "chat"]);
    expect(detailTitle(plan)).toBe("计划");
    expect(detailTitle({ type: "panel", taskId: "t-1", panel: "runs" })).toBe("运行");
    expect(detailTitle(item("m-1"))).toBe("详情");
    expect(detailKey(plan)).not.toBe(detailKey({ type: "panel", taskId: "t-1", panel: "usage" }));
  });
});

/** 打开一组调用，点进第二次调用，再点进挂在卡片上的内部调用 */
const deep = (wide: boolean): DetailNav => drillDetail(drillDetail(openDetail(NO_DETAIL, item("group:a#0"), wide), item("b#0")), item("c#1"));

describe("详情里一层层点进去，返回一层层退", () => {
  test("点进去时把来处压栈；从会话里再打开一条清空返回栈", () => {
    const nav = deep(true);
    expect([nav.detail, nav.back]).toEqual([item("c#1"), [item("group:a#0"), item("b#0")]]);
    expect(openDetail(nav, item("m-9"), true)).toMatchObject({ detail: item("m-9"), back: [] });
  });

  test("宽屏：标题栏的 ‹ 先一层层退，退到底关掉右栏", () => {
    const once = closeDetail(deep(true), true);
    expect([once.detail, once.back]).toEqual([item("b#0"), [item("group:a#0")]]);
    const twice = closeDetail(once, true);
    expect([twice.detail, twice.back]).toEqual([item("group:a#0"), []]);
    const closed = closeDetail(twice, true);
    expect([closed.detail, detailShown(closed, true)]).toEqual([undefined, false]);
  });

  test("窄屏：‹ 先一层层退，退到底滑回会话（详情页留着，下次从会话里打开另一条再换）", () => {
    const nav = closeDetail(closeDetail(deep(false), false), false);
    expect([nav.detail, nav.page]).toEqual([item("group:a#0"), "detail"]);
    const back = closeDetail(nav, false);
    expect([back.page, detailShown(back, false)]).toEqual(["chat", false]);
  });
});

describe("在对话中定位", () => {
  test("宽屏：详情栏不动，定位到这一条；窄屏：先滑回会话再定位，详情和返回栈留着", () => {
    const opened = drillDetail(openDetail(NO_DETAIL, item("group:a#0"), false), item("a#2"));
    expect(revealFromDetail(drillDetail(openDetail(NO_DETAIL, item("group:a#0"), true), item("a#2")), true)).toEqual({
      nav: drillDetail(openDetail(NO_DETAIL, item("group:a#0"), true), item("a#2")),
      reveal: "a#2",
    });
    const narrow = revealFromDetail(opened, false);
    expect([narrow.reveal, narrow.nav.page, narrow.nav.detail, narrow.nav.back]).toEqual(["a#2", "chat", item("a#2"), [item("group:a#0")]]);
    expect(revealFromDetail(NO_DETAIL, true).reveal).toBeUndefined();
  });
});

describe("宽屏右栏的宽度", () => {
  test("初值 288；往左拖变宽、往右拖变窄，拖动范围 260 到窗宽的 60%", () => {
    expect(DETAIL_WIDTH_INITIAL).toBe(288);
    expect(dragDetailWidth(288, -100, 1000)).toBe(388);
    expect(dragDetailWidth(288, -500, 1000)).toBe(600);
    expect(dragDetailWidth(288, 100, 1000)).toBe(260);
  });

  test("显示宽度封顶在窗宽的 32%，但不少于 240", () => {
    expect(detailColumnWidth(600, 1000)).toBe(320);
    expect(detailColumnWidth(288, 1000)).toBe(288);
    expect(detailColumnWidth(288, 700)).toBe(240);
    expect(detailColumnWidth(260, 2000)).toBe(260);
  });
});

describe("系统返回手势（鸿蒙）和宽窄切换", () => {
  test("返回：详情先一层层退，窄屏再滑回会话；都退完了交给外面（undefined）", () => {
    const narrow = drillDetail(openDetail(NO_DETAIL, item("m-1"), false), item("m-2"));
    const once = systemBack(narrow, false)!;
    expect([once.detail, once.page]).toEqual([item("m-1"), "detail"]);
    const twice = systemBack(once, false)!;
    expect(twice.page).toBe("chat");
    expect(systemBack(twice, false)).toBeUndefined();
    // 宽屏：栈空了就不管（系统返回不关右栏，交给外面）
    expect(systemBack(openDetail(NO_DETAIL, item("m-1"), true), true)).toBeUndefined();
  });

  test("宽屏变窄屏：回到会话页；窄屏变宽屏：有详情就出现在右栏", () => {
    const wideOpen = openDetail(NO_DETAIL, item("m-1"), true);
    const narrowed = layoutChanged(wideOpen, true, false);
    expect([narrowed.page, detailShown(narrowed, false)]).toEqual(["chat", false]);
    const widened = layoutChanged(closeDetail(openDetail(NO_DETAIL, item("m-1"), false), false), false, true);
    expect(detailShown(widened, true)).toBe(true);
    expect(layoutChanged(wideOpen, true, true)).toBe(wideOpen);
  });
});
