// 个人助理的名字标签（43 号票）：名字显示成带底色的小标签，颜色是 token --name-bg / --name-fg。
// 39 号票起 token 写在风格清单里（src/visual-styles/），每套风格可以覆盖这两个：字和底的对比度在
// test/visual-styles/contrast.test.ts 的表格里（不低于正文的 4.5:1）；这里查标签的底色和页面底色、卡片底色分得出来
// （不然看不出是个标签）。风格清单里每一套、浅色深色都查，以后加的风格自动算进来。
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, resolveColor, type Theme, VISUAL_STYLES } from "../../src/visual-styles/index.ts";
import { contrast } from "../visual-styles/color.ts";

const THEMES: Theme[] = ["light", "dark"];
const CASES = VISUAL_STYLES.flatMap((style) => THEMES.map((theme) => ({ style, theme })));

describe("名字标签的颜色", () => {
  test.each(CASES)("$style.name · $theme：标签的底色和页面底色、卡片底色分得出来（亮度差至少 1.15 倍）", ({ style, theme }) => {
    const tokens = effectiveTokens(style, BASE_STYLE);
    const tag = resolveColor(tokens, "name-bg", theme);
    expect(contrast(tag, resolveColor(tokens, "bg", theme))).toBeGreaterThanOrEqual(1.15);
    expect(contrast(tag, resolveColor(tokens, "surface", theme))).toBeGreaterThanOrEqual(1.15);
  });

  test("经典的值就是 43 号票定的：字和底浅色 7.8:1、深色 7.6:1", () => {
    const tokens = BASE_STYLE.tokens;
    expect(contrast(resolveColor(tokens, "name-fg", "light"), resolveColor(tokens, "name-bg", "light"))).toBeCloseTo(7.8, 1);
    expect(contrast(resolveColor(tokens, "name-fg", "dark"), resolveColor(tokens, "name-bg", "dark"))).toBeCloseTo(7.6, 1);
  });
});
