// 界面字号在风格 token 那一层：生成的样式表把字号阶、间距、标题栏高写成跟着 --fs-k 走的算式。
// - 比例是 1 时每套风格每个 token 算出来就是原值（1.0 下一像素不变）；
// - 字号阶乘比例，缩小时不低于 min(本来的大小, 11px)；间距乘 0.7 + 0.3 × 比例；
// - 标题栏高调到 1.5 时最多比本来高 12px，也不超过 max(56px, 本来的高)；调小时不变矮；
// - 栏（标题栏、导航）上把 --fs-k 换成 --bar-k、字号阶重算一遍；
// - 样式里不再有写死像素、不跟比例的字号（图标框里的字形除外，行尾写明"不跟字号"）。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BAR_REGIONS, BASE_STYLE, CONTROLS, effectiveTokens, scaledTokenValue, type TokenName, tokenValue, VISUAL_STYLES, visualStylesCss } from "../../src/visual-styles/index.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** 生成的算式在某个比例下的值（px）：只认 calc、min、max、clamp、加减乘、var(--fs-k)、var(--space-k)、var(--bar-k) */
function evaluate(expr: string, k: number, kVar: "fs" | "bar" = "fs"): number {
  const space = 1 + 0.3 * (k - 1);
  const bar = Math.min(k, 1 + 0.4 * (k - 1));
  const js = expr
    .replaceAll("var(--fs-k)", String(kVar === "fs" ? k : bar))
    .replaceAll("var(--space-k)", String(space))
    .replaceAll("var(--bar-k)", String(bar))
    .replaceAll("calc(", "(")
    .replaceAll("max(", "Math.max(")
    .replaceAll("min(", "Math.min(")
    .replace(/(\d+(?:\.\d+)?)px/g, "$1");
  if (!/^(?:[\d.\s+\-*/(),]|Math\.max|Math\.min|clamp)+$/.test(js)) throw new Error(`算不了：${expr}`);
  return new Function(`const clamp = (lo, v, hi) => Math.min(Math.max(lo, v), hi); return ${js};`)() as number;
}

/** 四舍五入到 0.001px（浮点算出来的 14.450000000000001 这类） */
const round = (n: number) => Math.round(n * 1000) / 1000;

const FONT_NAMES = ["fs-3xs", "fs-2xs", "fs-xs", "fs-s", "fs-m", "fs-l", "fs-body", "fs-title"] as const satisfies readonly TokenName[];

/** 一套风格某个 token 本来的像素（var(--别的) 顺着找下去） */
function basePx(styleId: string, name: TokenName): number {
  const style = VISUAL_STYLES.find((s) => s.id === styleId)!;
  const tokens = effectiveTokens(style, BASE_STYLE);
  let value = tokenValue(tokens[name], "light");
  for (let i = 0; i < 8; i++) {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (!ref) break;
    value = tokenValue(tokens[ref[1] as TokenName], "light");
  }
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!m) throw new Error(`${styleId} 的 --${name} 是 ${value}`);
  return Number(m[1]);
}

describe("跟着字号比例走的 token", () => {
  for (const style of VISUAL_STYLES) {
    test(`${style.id}：比例是 1 时字号阶、间距、标题栏高都是原值；调大、调小照规则走`, () => {
      const tokens = effectiveTokens(style, BASE_STYLE);
      /** 每个 token 在 0.85、1、1.5 下算出来的（四舍五入到 0.001px），和按规则该是的 */
      const got: Record<string, number[]> = {};
      const want: Record<string, number[]> = {};
      for (const name of [...FONT_NAMES, "space-page", "space-msg", "bar-h"] as const) {
        const raw = tokenValue(tokens[name], "light");
        const expr = scaledTokenValue(name, raw);
        // 引用别的 token 的原样留着（跟着它引用的那个走，不乘两遍）
        if (raw.startsWith("var(")) {
          got[name] = [expr === raw ? 1 : 0];
          want[name] = [1];
          continue;
        }
        const px = basePx(style.id, name);
        got[name] = [0.85, 1, 1.5].map((k) => round(evaluate(expr, k)));
        if (name.startsWith("fs-")) want[name] = [Math.max(px * 0.85, Math.min(px, 11)), px, px * 1.5].map(round);
        else if (name === "bar-h") want[name] = [px, px, Math.min(px * 1.15, Math.max(56, px), px + 12)].map(round);
        else want[name] = [px * 0.955, px, px * 1.15].map(round);
      }
      expect(got).toEqual(want);
    });
  }

  test("不是像素写法的报错，别的 token 原样", () => {
    expect(() => scaledTokenValue("fs-body", "1rem")).toThrow("要写成像素");
    expect(() => scaledTokenValue("bar-h", "clamp(40px, 5vh, 60px)")).toThrow("要写成像素");
    expect(scaledTokenValue("fs-title", "var(--fs-body)")).toBe("var(--fs-body)");
    expect(scaledTokenValue("radius-m", "8px")).toBe("8px");
    expect(scaledTokenValue("voice-pad", "13px")).toBe("13px");
  });

  test("生成的样式表：根上按 --fs-k 算；栏上换成 --bar-k、调小时能点的东西上换成 1，字号阶各重算一遍", () => {
    const css = visualStylesCss(VISUAL_STYLES, BASE_STYLE);
    expect(css).toContain("--fs-body: max(15px * var(--fs-k), 11px);");
    expect(css).toContain("--space-page: calc(12px * var(--space-k));");
    expect(css).toContain("--bar-h: clamp(42px, 42px * var(--space-k), 54px);");
    // 每套风格两块：栏上先把 --fs-k 换成 --bar-k，调小时能点的东西上换成 1；再把字号阶照这套风格的值写一遍
    const fontLines = (scope: string, region: string, k: string) => {
      const head = `${scope} ${region} {\n  --fs-k: ${k};\n`;
      const at = css.indexOf(head);
      if (at < 0) return 0;
      return css
        .slice(at + head.length, css.indexOf("\n}", at))
        .split("\n")
        .filter((l) => l.startsWith("  --fs-")).length;
    };
    const counts = VISUAL_STYLES.map((style) => [
      style.id,
      fontLines(`[data-style="${style.id}"]`, BAR_REGIONS, "var(--bar-k)"),
      fontLines(`[data-style="${style.id}"][data-font-scale="down"]`, CONTROLS, "1"),
    ]);
    expect(counts).toEqual(VISUAL_STYLES.map((s) => [s.id, FONT_NAMES.length, FONT_NAMES.length]));
  });

  test("栏里的字调大时只跟四成：1.5 时标题字号是本来的 1.2 倍，调小时全跟", () => {
    expect(evaluate("max(17px * var(--fs-k), 11px)", 1.5, "bar")).toBeCloseTo(17 * 1.2, 6);
    expect(evaluate("max(17px * var(--fs-k), 11px)", 0.85, "bar")).toBeCloseTo(17 * 0.85, 6);
    expect(evaluate("max(17px * var(--fs-k), 11px)", 1, "bar")).toBe(17);
  });
});

describe("样式里写死像素的字号", () => {
  /** 经典的样式（styles/）和每套风格的 style.css */
  const files = [
    ...readdirSync(path.join(SRC, "styles"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => path.join("styles", f)),
    ...VISUAL_STYLES.map((s) => path.join("visual-styles", s.id, "style.css")),
  ];

  test("都跟着 --fs-k 走：calc(Npx * var(--fs-k))，不到 13px 的写成 max(Npx * var(--fs-k), min(N, 11)px)；图标框里的字形行尾写明不跟字号", () => {
    const wrong: string[] = [];
    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(path.join(SRC, rel), "utf8");
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, i) => {
        const fixed = /font-size:\s*\d+(?:\.\d+)?px;/.test(line);
        if (fixed && !line.includes("不跟字号")) wrong.push(`${rel}:${i + 1}: ${line.trim()}`);
        const floor = /font-size:\s*max\((\d+(?:\.\d+)?)px \* var\(--fs-k\), (\d+(?:\.\d+)?)px\)/.exec(line);
        if (floor && Number(floor[2]) !== Math.min(Number(floor[1]), 11)) wrong.push(`${rel}:${i + 1}: 下限不对 ${line.trim()}`);
        const plain = /font-size:\s*calc\((\d+(?:\.\d+)?)px \* var\(--fs-k\)\)/.exec(line);
        if (plain && Number(plain[1]) < 13) wrong.push(`${rel}:${i + 1}: 不到 13px 要兜下限 ${line.trim()}`);
      });
    }
    expect(wrong).toEqual([]);
  });
});
