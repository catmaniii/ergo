// 视觉风格的对比度（39 号票）：风格清单里的每一套，在浅色、深色下，字和它底下的颜色要拉得开——正文 4.5:1，大字 3:1
// （WCAG 2 的算法）。按风格清单跑，以后加的风格自动算进来，经典也一样，没有例外。
// 119 号票起风格可以带几种主色（经典的 8 种）：每种主色换上之后整张表再查一遍——主色当字用（链接、导航高亮）压在卡片上、
// 主色块（主按钮）和你发的消息上的白字，都要 4.5:1。
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, resolveColor, type Theme, type TokenName, VISUAL_STYLES } from "../../src/visual-styles/index.ts";
import { contrast } from "./color.ts";

/** 字的颜色、底下的颜色、用在哪、至少多少 */
const PAIRS: ReadonlyArray<readonly [fg: TokenName, bg: TokenName, where: string, min: number]> = [
  ["text", "bg", "页面底色上的正文", 4.5],
  ["text", "surface", "卡片上的正文", 4.5],
  ["text", "bar-bg", "标题栏上的字（页面标题）", 4.5],
  ["text", "fill", "输入框里的字", 4.5],
  ["muted", "bg", "页面底色上的说明文字（时间、分组说明）", 4.5],
  ["muted", "surface", "卡片上的说明文字", 4.5],
  ["user-text", "user-bubble", "你发的消息", 4.5],
  ["primary-text", "primary-fill", "主按钮上的字", 4.5],
  ["primary", "surface", "链接、选中的分段", 4.5],
  ["nav-on", "surface", "主导航里当前那一项", 4.5],
  ["you", "surface", "跟你有关的字（等你、问你）", 4.5],
  ["you", "you-bg", "跟你有关的小签", 4.5],
  ["high-fg", "surface", "出错、拦下的字", 4.5],
  ["high-fg", "high-bg", "出错提示条、拦下的小签", 4.5],
  ["ok", "surface", "通过、完成的字", 4.5],
  ["data-fg", "data-bg", "数据小签", 4.5],
  ["op-fg", "op-bg", "命中关注类别的小签", 4.5],
  ["on-color", "danger-fill", "危险按钮上的字", 4.5],
  ["name-fg", "name-bg", "个人助理的名字标签（43 号票）", 4.5],
];

describe("对比度的算法", () => {
  test.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#777777", "#ffffff", 4.48], // 常见的"差一点到 4.5"的灰
    ["#fff", "#000", 21],
  ])("%s 对 %s 是 %s:1", (a, b, ratio) => {
    expect(contrast(a, b)).toBeCloseTo(ratio, 2);
  });
});

const THEMES: Theme[] = ["light", "dark"];
/** 每套风格本来的样子，加上它每种不是默认的主色（默认的那种就是本来的样子） */
const LOOKS = VISUAL_STYLES.flatMap((style) => [
  { style, accent: undefined as string | undefined, label: style.name },
  ...(style.accents ?? []).slice(1).map((a) => ({ style, accent: a.id as string | undefined, label: `${style.name}（${a.name}）` })),
]);
const CASES = LOOKS.flatMap((look) => THEMES.flatMap((theme) => PAIRS.map(([fg, bg, where, min]) => ({ ...look, theme, fg, bg, where, min }))));

describe("风格清单里每一套（每种主色）、浅色深色下的对比度", () => {
  test.each(CASES)("$label · $theme · $where（--$fg 对 --$bg）至少 $min:1", ({ style, accent, theme, fg, bg, min }) => {
    const tokens = effectiveTokens(style, BASE_STYLE, accent);
    expect(contrast(resolveColor(tokens, fg, theme), resolveColor(tokens, bg, theme))).toBeGreaterThanOrEqual(min);
  });

  test("经典的 8 种主色都算进来了", () => {
    expect(LOOKS.filter((l) => l.style.id === "classic").map((l) => l.label)).toEqual([
      "经典",
      "经典（靛紫）",
      "经典（青绿）",
      "经典（绿）",
      "经典（橙）",
      "经典（红）",
      "经典（粉）",
      "经典（石墨灰）",
    ]);
  });
});
