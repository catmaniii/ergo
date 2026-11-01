// 输入框里的回车：电脑上回车发送，选好的键 + 回车换行；触屏上不变；候选开着时回车选中。
import { describe, expect, test } from "vitest";
import { composerEnterAction, type EnterEnv, newlineKeyOf } from "../../src/state/index.ts";

const press = (keys: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) => ({
  shiftKey: keys.shift ?? false,
  ctrlKey: keys.ctrl ?? false,
  metaKey: keys.meta ?? false,
  altKey: keys.alt ?? false,
});
const pc = (newlineKey: EnterEnv["newlineKey"], picking = false): EnterEnv => ({ touch: false, newlineKey, picking });
const touch = (picking = false): EnterEnv => ({ touch: true, newlineKey: "ctrl", picking });

describe("电脑上", () => {
  test("默认：回车发送，Ctrl（⌘）+ 回车换行，Shift + 回车也发送", () => {
    expect(composerEnterAction(press(), pc("ctrl"))).toBe("send");
    expect(composerEnterAction(press({ ctrl: true }), pc("ctrl"))).toBe("newline");
    expect(composerEnterAction(press({ meta: true }), pc("ctrl"))).toBe("newline");
    expect(composerEnterAction(press({ shift: true }), pc("ctrl"))).toBe("send");
  });

  test("换成 Shift：回车发送，Shift + 回车换行，Ctrl + 回车也发送", () => {
    expect(composerEnterAction(press(), pc("shift"))).toBe("send");
    expect(composerEnterAction(press({ shift: true }), pc("shift"))).toBe("newline");
    expect(composerEnterAction(press({ ctrl: true }), pc("shift"))).toBe("send");
  });

  test("候选开着：本来要发送的回车是选中，换行键照样换行", () => {
    expect(composerEnterAction(press(), pc("ctrl", true))).toBe("pick");
    expect(composerEnterAction(press({ ctrl: true }), pc("ctrl", true))).toBe("newline");
    expect(composerEnterAction(press({ shift: true }), pc("shift", true))).toBe("newline");
  });

  test("Alt + 回车不管", () => {
    expect(composerEnterAction(press({ alt: true }), pc("ctrl"))).toBe("default");
  });
});

describe("触屏上不变", () => {
  test("回车交给输入框换行，外接键盘的 Ctrl + 回车发送", () => {
    expect(composerEnterAction(press(), touch())).toBe("default");
    expect(composerEnterAction(press({ shift: true }), touch())).toBe("default");
    expect(composerEnterAction(press({ ctrl: true }), touch())).toBe("send");
  });

  test("候选开着：回车选中，Shift + 回车换行", () => {
    expect(composerEnterAction(press(), touch(true))).toBe("pick");
    expect(composerEnterAction(press({ shift: true }), touch(true))).toBe("default");
  });
});

test("记住的值：只认 shift，别的都按默认", () => {
  expect(newlineKeyOf("shift")).toBe("shift");
  expect(newlineKeyOf(null)).toBe("ctrl");
  expect(newlineKeyOf("别的")).toBe("ctrl");
});
