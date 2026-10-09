// 个人助理的名字标签（43 号票）：名字显示成带底色的小标签，颜色是 base.css 里的 token --name-bg / --name-fg
// （浅色、深色两个值写在 light-dark() 里）。字和底的对比度按 WCAG 算，浅色、深色下都不低于正文的 4.5:1；
// 底色和页面底色也要分得出来（不然看不出是个标签）。39 号票的风格覆盖这两个 token 时同样要达标。
import fs from "node:fs";
import { describe, expect, test } from "vitest";

const BASE_CSS = fs.readFileSync(new URL("../../src/styles/base.css", import.meta.url), "utf8");

/** base.css 里一个颜色 token 的浅色、深色两个值 */
function token(name: string): { light: string; dark: string } {
  const m = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i").exec(BASE_CSS);
  if (!m) throw new Error(`base.css 里没有 --${name}: light-dark(#……, #……)`);
  return { light: m[1]!, dark: m[2]! };
}

/** WCAG 2 的相对亮度 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("名字标签的颜色", () => {
  test.each(["light", "dark"] as const)("%s：字和底的对比度不低于 4.5:1", (mode) => {
    expect(contrast(token("name-fg")[mode], token("name-bg")[mode])).toBeGreaterThanOrEqual(4.5);
  });

  test.each(["light", "dark"] as const)("%s：标签的底色和页面底色、卡片底色分得出来（亮度差至少 1.15 倍）", (mode) => {
    expect(contrast(token("name-bg")[mode], token("bg")[mode])).toBeGreaterThanOrEqual(1.15);
    expect(contrast(token("name-bg")[mode], token("surface")[mode])).toBeGreaterThanOrEqual(1.15);
  });
});
