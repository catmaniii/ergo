// 经典的主色（119 号票，用户 2026-10-13 定 8 种）：蓝（默认，就是原来的颜色）、靛紫、青绿、绿、橙、红、粉、石墨灰。
// 选了的挂在根元素的 data-accent 上，生成的样式表在 [data-style="classic"][data-accent="<id>"] 上换掉几个颜色 token——
// 只在经典下生效，别的风格不受影响。对比度（主色当字、主色块上的白字）在 contrast.test.ts 里按每种主色查；
// 记住、首屏挂载、换风格时拿掉在 test/app/theme.test.ts 里查。
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, resolveColor, stylePageInfo, type Theme, tokenValue, VISUAL_STYLES, visualStylesCss } from "../../src/visual-styles/index.ts";

const classic = BASE_STYLE;
const accents = classic.accents ?? [];
const THEMES: Theme[] = ["light", "dark"];

/** 主色换掉的颜色 token：当字用的、实色块、你发的消息 */
const ACCENT_TOKENS = ["primary", "primary-fill", "user-bubble"];

describe("经典的 8 种主色", () => {
  test("按这个顺序：蓝、靛紫、青绿、绿、橙、红、粉、石墨灰，id 不重复", () => {
    expect(accents.map((a) => a.name)).toEqual(["蓝", "靛紫", "青绿", "绿", "橙", "红", "粉", "石墨灰"]);
    expect(new Set(accents.map((a) => a.id)).size).toBe(8);
  });

  test("默认（没选过）是蓝，它什么都不换：就是原来经典的颜色，现有用户看到的不变", () => {
    expect(accents[0]).toEqual({ id: "blue", name: "蓝", tokens: {} });
    expect(classic.tokens.primary).toEqual(["#3b6cf6", "#5b86ff"]);
    expect(classic.tokens["primary-fill"]).toEqual(["#3b6cf6", "#3369ff"]);
    expect(classic.tokens["user-bubble"]).toEqual(["#3b6cf6", "#3a5bd0"]);
    expect(classic.tokens["nav-on"]).toBe("var(--primary)");
  });

  test.each(accents.slice(1).map((a) => [a.name, a] as const))("%s：换掉当字用的、实色块、你发的消息三个颜色，浅色深色各一个值", (_name, accent) => {
    expect(Object.keys(accent.tokens).toSorted()).toEqual(ACCENT_TOKENS.toSorted());
    const tokens = effectiveTokens(classic, BASE_STYLE, accent.id);
    // 当字用的在深色下要调亮（压在深色卡片上），两个值不一样
    expect(resolveColor(tokens, "primary", "light")).not.toBe(resolveColor(tokens, "primary", "dark"));
  });

  test.each(THEMES)("%s 下 8 种颜色两两不同（当字用的、实色块各自）", (theme) => {
    for (const name of ["primary", "primary-fill"] as const) {
      const colors = accents.map((a) => resolveColor(effectiveTokens(classic, BASE_STYLE, a.id), name, theme));
      expect(new Set(colors).size).toBe(8);
    }
  });

  test("导航高亮（nav-on 是 var(--primary)）跟着主色变", () => {
    for (const accent of accents) {
      const tokens = effectiveTokens(classic, BASE_STYLE, accent.id);
      for (const theme of THEMES) expect(resolveColor(tokens, "nav-on", theme)).toBe(resolveColor(tokens, "primary", theme));
    }
  });

  test("只有经典能换主色", () => {
    expect(VISUAL_STYLES.filter((s) => s.accents?.length).map((s) => s.id)).toEqual(["classic"]);
  });

  test("要的主色这套风格没有：报错（不悄悄按本来的颜色）", () => {
    expect(() => effectiveTokens(classic, BASE_STYLE, "purple")).toThrow("没有主色 purple");
    expect(() => effectiveTokens(VISUAL_STYLES.find((s) => s.id === "grid")!, BASE_STYLE, "orange")).toThrow("没有主色 orange");
  });
});

describe("生成的样式表：主色只在经典下生效", () => {
  const css = visualStylesCss(VISUAL_STYLES, BASE_STYLE);
  /** 选择器里带 data-accent 的每一块：选择器 → 里面的声明 */
  const blocks = [...css.matchAll(/([^{}\n]*\[data-accent[^{]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

  test("不是默认的 7 种各一块，选择器是 [data-style=\"classic\"][data-accent=\"<id>\"]（同一个元素上两个属性都在才选得中）", () => {
    expect(blocks.map((b) => b.selector)).toEqual(accents.slice(1).map((a) => `[data-style="classic"][data-accent="${a.id}"]`));
  });

  test("每块只写这种主色换掉的 token，浅深不一样的写成 light-dark()", () => {
    for (const accent of accents.slice(1)) {
      const block = blocks.find((b) => b.selector.includes(`"${accent.id}"`))!;
      const declared = [...block.body.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]);
      expect(declared).toEqual(
        Object.entries(accent.tokens)
          .toSorted(([a], [b]) => ACCENT_TOKENS.indexOf(a) - ACCENT_TOKENS.indexOf(b))
          .map(([name, value]) => {
            const [light, dark] = THEMES.map((t) => tokenValue(value, t));
            return [name, light === dark ? light : `light-dark(${light}, ${dark})`];
          }),
      );
    }
  });

  test("主色的块写在全部风格的块后面（特异度本来就高，写在后面更稳）", () => {
    const lastStyle = Math.max(...VISUAL_STYLES.map((s) => css.indexOf(`[data-style="${s.id}"] {`)));
    expect(css.indexOf("[data-accent=")).toBeGreaterThan(lastStyle);
  });
});

describe("页面上要挂的东西（内联脚本、app/theme.ts 用的那张表）", () => {
  test("经典带着可选的主色 id，第一个是默认的蓝；别的风格不带", () => {
    const table = stylePageInfo(VISUAL_STYLES, BASE_STYLE);
    expect(table.classic?.accents).toEqual(["blue", "indigo", "teal", "green", "orange", "red", "pink", "graphite"]);
    for (const style of VISUAL_STYLES.filter((s) => s.id !== "classic")) expect(table[style.id]).not.toHaveProperty("accents");
  });
});
