// 视觉风格测试共用的颜色算法：WCAG 2 的相对亮度、对比度，半透明颜色叠在不透明颜色上。
// test/visual-styles/contrast.test.ts、glass.test.ts、test/styles/name-tag.test.ts 都用这一份，不各抄一遍。
import { BASE_STYLE, resolveColor } from "../../src/visual-styles/index.ts";

/** WCAG 2 的相对亮度（#rgb、#rrggbb） */
export function luminance(hex: string): number {
  const h = hex.length === 4 ? hex.slice(1).split("").map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** 两个不透明颜色（#rgb、#rrggbb）的对比度 */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * 一个颜色（可以半透明：#rrggbbaa、rgba()）叠在不透明的颜色上，得到 #rrggbb。
 * 用的就是 resolveColor 的算法（它把半透明的 token 叠在 --bg 上算）：下面的颜色当 --bg、上面的当 --surface
 */
export function over(top: string, under: string): string {
  return resolveColor({ ...BASE_STYLE.tokens, bg: under, surface: top }, "surface", "light");
}
