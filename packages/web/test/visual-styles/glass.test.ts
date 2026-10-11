// 玻璃光纹（46 号票）的对比度按"最坏的底色"算：文字对比度不能靠模糊撑。
// contrast.test.ts 把半透明的颜色叠在页面底色上算；这套风格的页面底色上还有一层点阵（style.css 的 --glass-dot），
// 标题栏、导航、输入栏是半透明的玻璃（--glass-bg），不支持 backdrop-filter 时就是这个半透明纯色，正好压在一个点上的地方最难看清：
// - 直接压在页面上的字（时间、分组说明、链接……）按点的颜色算（浅色下点比页面底深、深色下比页面底亮）；
// - 玻璃上的字按"玻璃叠在点上"算，玻璃上的浅底（--fill：按住说话不能用时那一块、输入框里的代码……）再叠一层；
// - 状态药丸（.st：字色 12% 的淡底，style.css）按叠在"玻璃叠在点上"上算（药丸在不透明的卡片上，这样算更严）；
// - 卡片、气泡、看板卡这些面板的底色是不透明的 --surface，小签、名字标签的淡底也写成不透明的，放在哪都一样（字和底在 contrast.test.ts 里查）。
// 点阵、玻璃的颜色从 style.css 里读，改了那边这里跟着查。颜色算法用 color.ts 那一份。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, resolveColor, type Theme, type TokenName, tokenValue, VISUAL_STYLES, voiceBarSizesOf } from "../../src/visual-styles/index.ts";
import { contrast, over } from "./color.ts";

const glass = VISUAL_STYLES.find((s) => s.id === "glass")!;
const tokens = effectiveTokens(glass, BASE_STYLE);
const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/visual-styles/glass/style.css"), "utf8");

/** style.css 里 :root[data-style="glass"] 上写成 light-dark(浅, 深) 的自定义属性 */
function cssLightDark(name: string, theme: Theme): string {
  const m = new RegExp(`--${name}:\\s*light-dark\\((.*)\\);`).exec(css);
  if (!m) throw new Error(`style.css 里没有 --${name}: light-dark(...)`);
  // 按最外层的逗号分成浅、深两个值（里面的 rgba() 也带逗号）
  let depth = 0;
  for (let i = 0; i < m[1]!.length; i++) {
    const c = m[1]![i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return (theme === "light" ? m[1]!.slice(0, i) : m[1]!.slice(i + 1)).trim();
  }
  throw new Error(`--${name} 不是 light-dark(浅, 深)`);
}

/** #rrggbb 换成同一个颜色、给定透明度的 rgba() */
function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const color = (name: TokenName, theme: Theme) => resolveColor(tokens, name, theme);
const THEMES: Theme[] = ["light", "dark"];

describe.each(THEMES)("玻璃光纹 · %s", (theme) => {
  const bg = color("bg", theme);
  const dot = cssLightDark("glass-dot", theme);
  const pane = cssLightDark("glass-bg", theme);
  /** 玻璃叠在点上：玻璃上的字最难看清的底 */
  const paneOnDot = over(pane, dot);

  test("点阵看得出来（和页面底色分得开），点本身不透明；玻璃是半透明的（不支持模糊时退回的就是它）", () => {
    expect(dot).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(dot, bg)).toBeGreaterThanOrEqual(1.25);
    expect(over(pane, "#000000")).not.toBe(over(pane, "#ffffff"));
  });

  test.each<TokenName>(["text", "muted", "primary", "you", "high-fg", "ok", "op-fg"])("直接压在页面上的 --%s：按点的颜色算也有 4.5:1", (name) => {
    expect(contrast(color(name, theme), dot)).toBeGreaterThanOrEqual(4.5);
  });

  test.each<TokenName>(["text", "muted", "primary", "nav-on", "you", "high-fg", "ok", "op-fg"])("玻璃上的 --%s：按玻璃叠在点上算也有 4.5:1", (name) => {
    expect(contrast(color(name, theme), paneOnDot)).toBeGreaterThanOrEqual(4.5);
  });

  test.each<TokenName>(["text", "muted"])("玻璃上的浅底（--fill）里的 --%s：4.5:1", (name) => {
    expect(contrast(color(name, theme), over(tokenValue(tokens.fill, theme), paneOnDot))).toBeGreaterThanOrEqual(4.5);
  });

  test.each<TokenName>(["muted", "primary", "you", "high-fg", "ok", "op-fg"])("状态药丸（字色 12% 的淡底叠在玻璃上）里的 --%s：4.5:1", (name) => {
    const fg = color(name, theme);
    expect(contrast(fg, over(withAlpha(fg, 0.12), paneOnDot))).toBeGreaterThanOrEqual(4.5);
  });

  test.each<TokenName>(["surface", "data-bg", "you-bg", "high-bg", "op-bg", "name-bg"])("面板、小签的底 --%s 是不透明的：放在点阵上、玻璃上都一样", (name) => {
    expect(tokenValue(tokens[name], theme)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

test("语音气泡的播放条照设计稿 e-chat：内边距 12、播放键 30 的圆角方块、和波形隔 10，竖条 2 隔 3，个人助理一侧四周 1px 亮边（左右合起来 2）", () => {
  expect(voiceBarSizesOf("glass", VISUAL_STYLES, BASE_STYLE)).toEqual({ pad: 12, line: 2, key: 30, gap: 10, bar: 2, barGap: 3 });
});
