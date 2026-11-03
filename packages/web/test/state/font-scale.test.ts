// 界面字号的纯函数：屏幕形态按窗口宽度分（鸿蒙"一多"的断点），记住的比例落到 0.85–1.5、按 0.05 取整，
// 四个预设都在范围里、都在格上，写坏的、没记过的按 1。
import { describe, expect, test } from "vitest";
import {
  clampFontScale,
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_PRESETS,
  FONT_SCALE_STEP,
  fontScaleCss,
  fontScaleKey,
  fontScaleOf,
  fontScalePresetOf,
  screenFormOf,
} from "../../src/state/index.ts";

describe("屏幕形态", () => {
  test.each<[number, string]>([
    [320, "narrow"],
    [390, "narrow"],
    [599, "narrow"],
    [600, "medium"],
    [720, "medium"],
    [839, "medium"],
    [840, "wide"],
    [1280, "wide"],
  ])("宽 %i 是 %s", (width, form) => {
    expect(screenFormOf(width)).toBe(form);
  });

  test("每种形态一个键", () => {
    expect([fontScaleKey("narrow"), fontScaleKey("medium"), fontScaleKey("wide")]).toEqual(["ergo-font-scale-narrow", "ergo-font-scale-medium", "ergo-font-scale-wide"]);
  });
});

describe("比例", () => {
  test.each<[string | null, number]>([
    [null, 1],
    ["", 1],
    ["  ", 1],
    ["大", 1],
    ["NaN", 1],
    ["Infinity", 1],
    ["1.25", 1.25],
    ["1.17", 1.15],
    ["1.18", 1.2],
    ["0.5", FONT_SCALE_MIN],
    ["3", FONT_SCALE_MAX],
    ["0.85", 0.85],
    ["1.5", 1.5],
  ])("记住的 %j 按 %f", (raw, scale) => {
    expect(fontScaleOf(raw)).toBe(scale);
  });

  test("滑杆上的每一格取整后写出来就是两位小数，没有浮点尾巴", () => {
    const steps = Math.round((FONT_SCALE_MAX - FONT_SCALE_MIN) / FONT_SCALE_STEP);
    expect(steps).toBe(13);
    for (let i = 0; i <= steps; i++) {
      const raw = FONT_SCALE_MIN + i * FONT_SCALE_STEP;
      const scale = clampFontScale(raw);
      expect(String(scale)).toBe(String(Number(raw.toFixed(2))));
    }
  });

  test("四个预设：小 0.9、标准 1、大 1.15、特大 1.3，都在范围里、在格上，认得回来", () => {
    expect(FONT_SCALE_PRESETS.map((p) => [p.id, p.scale])).toEqual([
      ["small", 0.9],
      ["standard", 1],
      ["large", 1.15],
      ["xlarge", 1.3],
    ]);
    for (const p of FONT_SCALE_PRESETS) {
      expect(clampFontScale(p.scale)).toBe(p.scale);
      expect(fontScalePresetOf(p.scale)).toBe(p.id);
    }
    expect(fontScalePresetOf(1.25)).toBeUndefined();
  });

  test("根元素上的 --fs-k：1 不写（和没有这个功能时一样），别的写成数", () => {
    expect(fontScaleCss(FONT_SCALE_DEFAULT)).toBeUndefined();
    expect(fontScaleCss(1.15)).toBe("1.15");
    expect(fontScaleCss(0.85)).toBe("0.85");
  });
});
