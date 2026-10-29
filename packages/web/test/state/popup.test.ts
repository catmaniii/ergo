// 弹出菜单放在哪（语音气泡的长按菜单这类，ui/popup.tsx）：贴着按住的那个元素，下方放不下翻到上方，不出屏幕。纯函数，按屏幕坐标算。
import { describe, expect, test } from "vitest";
import { POPUP_GAP, POPUP_MARGIN, type PopupRect, popupPlacement } from "../../src/state/index.ts";

/** 手机竖屏 390×844 */
const PHONE: PopupRect = { left: 0, top: 0, right: 390, bottom: 844 };
/** 菜单的大小（复制文字、详情 › 两项） */
const MENU = { width: 134, height: 40 };

const rect = (left: number, top: number, right: number, bottom: number): PopupRect => ({ left, top, right, bottom });

describe("上下：默认在下方，下方放不下翻到上方", () => {
  test("下方放得下：紧贴在按住的东西下面（隔 4px），和原来一样", () => {
    const p = popupPlacement(rect(63, 300, 378, 397), MENU, PHONE, "start");
    expect(p).toMatchObject({ side: "below", top: 397 + POPUP_GAP });
  });

  test("会话最底下那条：下方到屏幕底还放得下就照样放在下方（浮在输入栏上面，不让开）", () => {
    // 气泡底边 717，输入栏 733–796，底部导航到 844：菜单 721–761 盖在输入栏上
    const p = popupPlacement(rect(63, 620, 378, 717), MENU, PHONE, "end");
    expect(p).toMatchObject({ side: "below", top: 721 });
  });

  test("下方放不下（离屏幕底太近）：翻到上方，紧贴在上面", () => {
    const p = popupPlacement(rect(63, 700, 378, 810), MENU, PHONE, "start");
    expect(p).toMatchObject({ side: "above", top: 700 - POPUP_GAP - MENU.height });
  });

  test("刚好放得下：下方留够屏幕边的空就还在下方", () => {
    const bottom = PHONE.bottom - POPUP_MARGIN - MENU.height - POPUP_GAP;
    expect(popupPlacement(rect(63, bottom - 50, 378, bottom), MENU, PHONE, "start").side).toBe("below");
    expect(popupPlacement(rect(63, bottom - 50, 378, bottom + 1), MENU, PHONE, "start").side).toBe("above");
  });

  test("上下都放不下（气泡比屏幕还高）：放在空多的那一边，整个推回屏幕里", () => {
    const tall = rect(10, -200, 380, 900);
    const p = popupPlacement(tall, MENU, PHONE, "start");
    expect(p.top).toBeGreaterThanOrEqual(POPUP_MARGIN);
    expect(p.top + MENU.height).toBeLessThanOrEqual(PHONE.bottom - POPUP_MARGIN);
  });

  test("上下都放不下、上方空多：放上方，推到屏幕顶的边距处", () => {
    const short: PopupRect = { left: 0, top: 0, right: 390, bottom: 120 };
    const p = popupPlacement(rect(10, 50, 380, 100), MENU, short, "start");
    expect(p).toEqual({ side: "above", top: POPUP_MARGIN, left: 10 });
  });

  test("菜单比屏幕还高：顶在屏幕顶的边距处", () => {
    const p = popupPlacement(rect(10, 400, 380, 450), { width: 100, height: 900 }, PHONE, "start");
    expect(p.top).toBe(POPUP_MARGIN);
  });
});

describe("左右：和按住的东西对齐，不出屏幕", () => {
  test("agent 的语音（start）：左边对齐", () => {
    expect(popupPlacement(rect(16, 300, 200, 360), MENU, PHONE, "start").left).toBe(16);
  });

  test("自己发的语音（end）：右边对齐", () => {
    expect(popupPlacement(rect(63, 300, 378, 360), MENU, PHONE, "end").left).toBe(378 - MENU.width);
  });

  test("左边对齐会出右边屏幕：往左推，留出边距", () => {
    const p = popupPlacement(rect(330, 300, 380, 360), MENU, PHONE, "start");
    expect(p.left).toBe(PHONE.right - POPUP_MARGIN - MENU.width);
  });

  test("右边对齐会出左边屏幕：往右推，留出边距", () => {
    const p = popupPlacement(rect(0, 300, 60, 360), MENU, PHONE, "end");
    expect(p.left).toBe(POPUP_MARGIN);
  });

  test("菜单比屏幕还宽：贴左边距", () => {
    expect(popupPlacement(rect(100, 300, 200, 360), { width: 500, height: 40 }, PHONE, "end").left).toBe(POPUP_MARGIN);
  });

  test("宽屏：按住的东西在右栏旁边，菜单照样按它对齐（详情栏也盖得住，层级由界面保证）", () => {
    const wide: PopupRect = { left: 0, top: 0, right: 1280, bottom: 800 };
    expect(popupPlacement(rect(878, 645, 1268, 721), MENU, wide, "end")).toEqual({ side: "below", top: 725, left: 1268 - MENU.width });
  });
});
