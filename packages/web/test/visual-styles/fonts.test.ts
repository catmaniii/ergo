// 风格的字体（39 号票）由二狗自己提供：构建时把风格清单里写的 fontsource 包按 unicode-range 切好的 woff2 拷进
// dist/fonts/，每套有字体的风格一份样式表 <风格 id>.css。这里查构建插件给出的那份清单（拷什么、样式表长什么样），
// 以及这套风格提供的每个字体都有人用（正文、标题、数字三个字体 token 至少一个用到它；没提供字体的不查）；
// 设置里风格预览用的 preview.css 只收管着预览场景里那几个字的 @font-face（打开设置只为预览多下几片）。
// 风格清单里以后加的风格自动算进来。
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { fontFamiliesOf, planFonts, unicodeRanges } from "../../build/visual-styles-plugin.ts";
import { BASE_STYLE, effectiveTokens, fontStack, fontsHref, PREVIEW_FONTS_HREF, previewChars, VISUAL_STYLES } from "../../src/visual-styles/index.ts";

const plan = planFonts(VISUAL_STYLES);
const WITH_FONTS = VISUAL_STYLES.filter((s) => s.fonts?.length);

/** 这段 @font-face 管不管这个字 */
function covers(face: string, ch: string): boolean {
  return unicodeRanges(face).some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b);
}

/** 样式表里的 @font-face */
function faces(css: string): string[] {
  return css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
}

describe("哪些风格有字体样式表", () => {
  test("经典用系统字体，没有", () => {
    expect(BASE_STYLE.fonts ?? []).toEqual([]);
    expect(plan.stylesheets.has(`${BASE_STYLE.id}.css`)).toBe(false);
  });

  test("净白格栅有，地址就是页面上挂的那个", () => {
    expect(fontsHref("grid")).toBe("fonts/grid.css");
    expect(plan.stylesheets.has("grid.css")).toBe(true);
  });

  test.each(VISUAL_STYLES.map((s) => [s.name, s] as const))("%s：写了字体就有样式表，没写就没有", (_name, style) => {
    expect(plan.stylesheets.has(`${style.id}.css`)).toBe(Boolean(style.fonts?.length));
  });
});

describe.each(WITH_FONTS.map((s) => [s.name, s] as const))("%s 的字体样式表", (_name, style) => {
  const css = plan.stylesheets.get(`${style.id}.css`)!;

  test("每段 @font-face 都按 unicode-range 切片（只下页面上用到的字），没下好时先用系统字体（font-display: swap）", () => {
    expect(faces(css).length).toBeGreaterThan(0);
    for (const face of faces(css)) {
      expect(face).toMatch(/unicode-range:\s*U\+/);
      expect(face).toMatch(/font-display:\s*swap/);
    }
  });

  test("只用 woff2，地址都是相对的（由守护进程提供，不请求外部地址），落在带版本号的目录里", () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(faces(css).length);
    for (const url of urls) {
      expect(url).toMatch(/^[a-z0-9-]+@\d+\.\d+\.\d+\/[^/]+\.woff2$/);
      expect(plan.files.has(url)).toBe(true);
    }
    for (const face of faces(css)) expect(face).toMatch(/format\("woff2"\)/);
    expect(css).not.toMatch(/https?:/);
  });

  test.each((style.fonts ?? []).map((font) => [font.package, font] as const))(
    "提供的字体 %s 有人用：正文、标题、数字（--font-body / --font-title / --font-num）至少一个的字体栈里有它的字族",
    (_pkg, font) => {
      const tokens = effectiveTokens(style, BASE_STYLE);
      const used = new Set((["font-body", "font-title", "font-num"] as const).flatMap((name) => fontStack(tokens, name)));
      expect(fontFamiliesOf(font).some((family) => used.has(family))).toBe(true);
    },
  );
});

describe("设置里风格预览用的字体（preview.css）", () => {
  const preview = plan.stylesheets.get("preview.css");
  const chars = previewChars();

  test("有字体的风格就有，地址就是设置页挂的那个；都没有字体就不生成", () => {
    expect(PREVIEW_FONTS_HREF).toBe("fonts/preview.css");
    expect(preview !== undefined).toBe(WITH_FONTS.length > 0);
    expect(planFonts([BASE_STYLE]).stylesheets.size).toBe(0);
  });

  test.each(WITH_FONTS.map((s) => [s.name, s] as const))("%s：预览里的每个字，整份里管着它的那段也收进来了；别的段不收", (_name, style) => {
    const full = faces(plan.stylesheets.get(`${style.id}.css`)!);
    const needed = full.filter((face) => chars.some((ch) => covers(face, ch)));
    const got = faces(preview!);
    for (const face of needed) expect(got).toContain(face);
    for (const face of full.filter((f) => !needed.includes(f))) expect(got).not.toContain(face);
    // 只为预览下几片：比整份少得多（Noto Sans SC 是 101 段里的 1 段）
    expect(needed.length).toBeLessThanOrEqual(Math.max(1, full.length / 10));
  });

  test("净白格栅的预览：中文只下一片字体（169 号票起预览场景也有英文的，英文的字在拉丁字母那几片里，中文下用不着、浏览器不会去下）", () => {
    const grid = faces(plan.stylesheets.get("grid.css")!);
    const han = chars.filter((ch) => /\p{Script=Han}/u.test(ch));
    expect(faces(preview!).filter((face) => grid.includes(face) && han.some((ch) => covers(face, ch)))).toHaveLength(1);
    // 英文的字母全在基本拉丁字母那一段（U+0000–00FF）里，不多下中文的切片
    const latin = chars.filter((ch) => !han.includes(ch));
    expect(latin.length).toBeGreaterThan(0);
    for (const ch of latin) expect(ch.codePointAt(0)!).toBeLessThan(0x100);
  });

  test("unicode-range 的几种写法", () => {
    expect(unicodeRanges("unicode-range: U+4E00-4E10, U+20;")).toEqual([
      [0x4e00, 0x4e10],
      [0x20, 0x20],
    ]);
    expect(unicodeRanges("unicode-range:U+4??}")).toEqual([[0x400, 0x4ff]]);
    expect(unicodeRanges("font-family: X;")).toEqual([[0, 0x10ffff]]);
  });
});

describe("要拷的文件", () => {
  test("都在（装了包），许可证允许分发（SIL OFL 等），和字体放在同一个目录", () => {
    const dirs = new Set([...plan.files.keys()].map((rel) => rel.split("/")[0]!));
    expect(dirs.size).toBeGreaterThan(0);
    for (const dir of dirs) {
      const license = plan.files.get(`${dir}/LICENSE.txt`);
      expect({ dir, license: license !== undefined }).toEqual({ dir, license: true });
      expect(fs.readFileSync(license!, "utf8")).toMatch(/SIL Open Font License|Apache License|MIT License/);
    }
    for (const [rel, source] of plan.files) expect({ rel, exists: fs.existsSync(source) }).toEqual({ rel, exists: true });
  });
});
