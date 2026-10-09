// 前端状态层：视觉风格（39 号票）。设置里选一套风格（经典、净白格栅……），按设备记住；和浅色 / 深色 / 跟随系统正交。
// 记住的风格读出来不认识（没选过、那套风格后来删了、被改过的值）就按经典。
import { describe, expect, test } from "vitest";
import { DEFAULT_VISUAL_STYLE, visualStyleOf } from "../../src/state/index.ts";

/** 风格清单里现有的几套（状态层不认具体有哪几套，由调用的地方给） */
const KNOWN = ["classic", "grid", "paper"];

describe("记住的风格", () => {
  test.each<[string | null, string]>([
    ["classic", "classic"],
    ["grid", "grid"],
    ["paper", "paper"],
    [null, "classic"], // 没选过
    ["", "classic"],
    ["night", "classic"], // 那套风格已经不在清单里了
    ["Grid", "classic"], // 大小写不对也不认
    [" grid", "classic"],
    ["__proto__", "classic"], // 不是清单里的名字，哪怕是对象自带的属性名
  ])("存的是 %j：用 %s", (raw, style) => {
    expect(visualStyleOf(raw, KNOWN)).toBe(style);
  });

  test("默认的风格是经典", () => {
    expect(DEFAULT_VISUAL_STYLE).toBe("classic");
  });
});
