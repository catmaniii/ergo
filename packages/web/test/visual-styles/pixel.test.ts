// 像素小屋（49 号票）的对比度按"最坏的底色"算：contrast.test.ts 查的是 token 两两之间，这套风格还有两种不在 token 表里的底——
// - 页面上的 16px 格子（style.css 的 --pixel-grid：墨绿 6% 的 2px 线），直接压在页面上的字（时间、分组说明、链接、出错……）按格子线的颜色算；
// - 选中的看板卡、待办行、作业行、发起任务弹层里选中的种类的浅绿底（--pixel-pick），上面的字照常是正文、说明、各种结果色。
// 还有几对 style.css 自己拼的：状态签（粉底深莓字、浅绿底正文字、卡片底绿 / 灰字、淡红底暖红字）、看板件数（草地绿底）、
// 处理过的卡片的类型标签（浅底灰字）、按住说话（浅绿底正文字）。格子线和选中的底从 style.css 里读，改了那边这里跟着查。
// 最后一组查 HP 格进度：步数多时格数封顶，每格还看得清（条宽、上限也从 style.css 里读）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, resolveColor, type Theme, type TokenName, VISUAL_STYLES } from "../../src/visual-styles/index.ts";
import { contrast, over } from "./color.ts";

const pixel = VISUAL_STYLES.find((s) => s.id === "pixel")!;
const tokens = effectiveTokens(pixel, BASE_STYLE);
const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/visual-styles/pixel/style.css"), "utf8");
const color = (name: TokenName, theme: Theme) => resolveColor(tokens, name, theme);

/** 格子线的颜色（--pixel-grid 里的 rgba，浅深一样）叠在页面底色上 */
function gridLine(theme: Theme): string {
  const m = /--pixel-grid:\s*linear-gradient\((rgba\([^)]*\))/.exec(css);
  if (!m) throw new Error("style.css 里没有 --pixel-grid: linear-gradient(rgba(...) ...)");
  return over(m[1]!, color("bg", theme));
}

/** 选中的浅绿底（--pixel-pick: light-dark(浅, 深)） */
function pick(theme: Theme): string {
  const m = /--pixel-pick:\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/i.exec(css);
  if (!m) throw new Error("style.css 里没有 --pixel-pick: light-dark(#浅, #深)");
  return (theme === "light" ? m[1] : m[2])!.toLowerCase();
}

const THEMES: Theme[] = ["light", "dark"];
/** 会直接压在页面格子上、或者压在选中的浅绿底上的字 */
const TEXTS: TokenName[] = ["text", "muted", "primary", "you", "high-fg", "ok", "op-fg", "pull-fg", "reject-fg"];

describe("像素小屋：格子线、选中的浅绿底上的字", () => {
  test.each(THEMES.flatMap((theme) => TEXTS.map((fg) => ({ theme, fg }))))("$theme · --$fg 压在格子线上至少 4.5:1", ({ theme, fg }) => {
    expect(contrast(color(fg, theme), gridLine(theme))).toBeGreaterThanOrEqual(4.5);
  });

  test.each(THEMES.flatMap((theme) => TEXTS.map((fg) => ({ theme, fg }))))("$theme · --$fg 压在选中的浅绿底上至少 4.5:1", ({ theme, fg }) => {
    expect(contrast(color(fg, theme), pick(theme))).toBeGreaterThanOrEqual(4.5);
  });
});

/** style.css 自己拼的字和底 */
const PAIRS: ReadonlyArray<readonly [fg: TokenName, bg: TokenName, where: string]> = [
  ["user-text", "user-bubble", "等你、待确认的状态签（设计稿的粉底深莓字）"],
  ["text", "data-bg", "在做的状态签、按住说话、播放键（浅绿底）"],
  ["muted", "surface", "中性的状态签、个人助理语音的时长"],
  ["ok", "surface", "运行完成、工单完成的状态签"],
  ["high-fg", "high-bg", "出错的状态签"],
  ["primary-text", "primary-fill", "看板件数、选中的分段和导航"],
  ["muted", "fill", "处理过的卡片的类型标签"],
];

describe("像素小屋：style.css 自己拼的字和底", () => {
  test.each(THEMES.flatMap((theme) => PAIRS.map(([fg, bg, where]) => ({ theme, fg, bg, where }))))(
    "$theme · $where（--$fg 对 --$bg）至少 4.5:1",
    ({ theme, fg, bg }) => {
      expect(contrast(color(fg, theme), color(bg, theme))).toBeGreaterThanOrEqual(4.5);
    },
  );
});

/** style.css 里选择器列表含 :root[data-style="pixel"] <sel> 的规则里，prop 最后一次的值（同一个选择器，后写的赢） */
function declared(sel: string, prop: string): string | undefined {
  const full = `:root[data-style="pixel"] ${sel}`;
  let value: string | undefined;
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").some((s) => s.trim() === full)) continue;
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i > 0 && d.slice(0, i).trim() === prop) value = d.slice(i + 1).trim();
    }
  }
  return value;
}

/**
 * HP 格（评审 2）：步数多时格数封顶（--pixel-hp-max），每格的格心 =（条宽 + 2）÷ 格数 − 4（两边 1px 的框、2px 的格间）至少 5px。
 * 条宽：小进度条、标题栏上的是 style.css 写死的；看板卡上的占满一整行、随卡片宽，取 200（量过：手机 390 宽 326、360 宽 296，
 * 平板和宽屏的看板栏 276），留出余地
 */
const HP_BARS = [
  { where: "项目页内部任务一行的小进度条", sel: ".sl-progress", width: Number.parseFloat(declared(".sl-progress", "width") ?? "NaN") },
  { where: "流程会话标题栏的进度条", sel: ".topbar .progress-bar", width: Number.parseFloat(declared(".topbar .progress-bar", "width") ?? "NaN") },
  { where: "看板卡上占满一整行的进度条", sel: ".bcard .sl-progress", width: 200 },
];
const face = (width: number, cells: number) => (width + 2) / cells - 4;
const hpMax = (sel: string) => Number(declared(sel, "--pixel-hp-max"));

describe("像素小屋：HP 格步数多时不挤成一团", () => {
  test("一格的宽只写一处：（条宽 + 2px）÷ min(一共几格, 上限)", () => {
    const cells = [...css.matchAll(/--pixel-hp-cell:\s*([^;]+);/g)].map((m) => m[1]);
    expect(cells).toEqual(["calc((100cqw + 2px) / min(var(--progress-total, 1), var(--pixel-hp-max)))"]);
  });

  test.each(HP_BARS)("$where（$sel）：宽 $width、上限是整数", ({ sel, width }) => {
    expect(Number.isFinite(width)).toBe(true);
    expect(Number.isInteger(hpMax(sel))).toBe(true);
  });

  test.each(HP_BARS.flatMap((bar) => [3, 10, 20, 30, 100].map((total) => ({ ...bar, total }))))("$where：一共 $total 步，每格的格心至少 5px", ({ sel, width, total }) => {
    expect(face(width, Math.min(total, hpMax(sel)))).toBeGreaterThanOrEqual(5);
  });

  test.each(HP_BARS)("$where：上限没有压得过低——再多一格格心就不到 5px，或者已经是 20 格", ({ sel, width }) => {
    const max = hpMax(sel);
    expect(max >= 20 || face(width, max + 1) < 5).toBe(true);
  });
});
