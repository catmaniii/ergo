// 设置 · 外观 · 风格里的预览（39 号票）：风格清单里的每一套都有浅色、深色两张；预览用这套风格自己的 token 和规则现场画——
// 页面样式表复制给预览的 shadow root 时，每套风格规则开头的 :root[data-style="<id>"] 换成 :host([data-style="<id>"])。
// 这里查换法本身，以及每套风格的 style.css 换完之后一条不落（以后加的风格自动算进来）。
// 构建产物（压缩过的样式）换完的样子在 test/build.test.ts 里查；预览只下几个字的字体切片在 fonts.test.ts 里查。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PREVIEW_PAGE_CLASS, PREVIEW_SCENE, previewChars, previewCss, stylePreviews, VISUAL_STYLES } from "../../src/visual-styles/index.ts";
import { activeLocaleFrom, DEFAULT_LANGUAGE, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const STYLES_DIR = path.resolve(import.meta.dirname, "../../src/visual-styles");

describe("每套风格都有浅色、深色两张预览", () => {
  test("风格清单里的每一套都在，顺序和清单一样，各有浅色、深色", () => {
    const previews = stylePreviews(VISUAL_STYLES);
    expect(previews.map((p) => p.style.id)).toEqual(VISUAL_STYLES.map((s) => s.id));
    for (const p of previews) expect({ id: p.style.id, themes: p.themes }).toEqual({ id: p.style.id, themes: ["light", "dark"] });
  });

  test("以后加的风格自动有预览", () => {
    const extra = { id: "x", name: "某风格", blurb: "", tokens: {} };
    expect(stylePreviews([...VISUAL_STYLES, extra]).at(-1)).toEqual({ style: extra, themes: ["light", "dark"] });
  });
});

describe("页面样式表 → 预览里用的样式表", () => {
  test("风格规则开头的 :root[data-style] 换成 :host(...)，引号有没有、后面再跟的属性都照搬", () => {
    expect(previewCss(':root[data-style="grid"] .a { color: red; }')).toBe(':host([data-style="grid"]) .a { color: red; }');
    expect(previewCss(":root[data-style=grid] .a,:root[data-style=grid] .b>.c{color:red}")).toBe(":host([data-style=grid]) .a,:host([data-style=grid]) .b>.c{color:red}");
    expect(previewCss(':root[data-style="x"][data-theme="dark"] .a{}')).toBe(':host([data-style="x"][data-theme="dark"]) .a{}');
    expect(previewCss('@media (min-width: 600px) { :root[data-style="x"] .a { color: red; } }')).toBe(
      '@media (min-width: 600px) { :host([data-style="x"]) .a { color: red; } }',
    );
  });

  test("挂在根元素本身、body 上的（这套风格下的整页）在预览里挂到场景最外层：空格 body、> body 都一样", () => {
    const page = `.${PREVIEW_PAGE_CLASS}`;
    expect(previewCss(':root[data-style="x"] body { line-height: 1.5; }')).toBe(`:host([data-style="x"]) ${page} { line-height: 1.5; }`);
    expect(previewCss(":root[data-style=x] body .a{}")).toBe(`:host([data-style=x]) ${page} .a{}`);
    expect(previewCss(':root[data-style="x"] > body { line-height: 1.5; }')).toBe(`:host([data-style="x"]) ${page} { line-height: 1.5; }`);
    expect(previewCss(":root[data-style=x]>body .a{}")).toBe(`:host([data-style=x]) ${page} .a{}`);
    expect(previewCss(':root[data-style="x"] { letter-spacing: 1px; }')).toBe(`:host([data-style="x"]) ${page} { letter-spacing: 1px; }`);
    expect(previewCss(":root[data-style=x][data-theme=dark],.y{}")).toBe(`:host([data-style=x][data-theme=dark]) ${page},.y{}`);
    // 类名里带 body 的不动
    expect(previewCss(":root[data-style=x] body-text{}")).toBe(":host([data-style=x]) body-text{}");
  });

  test("页面现在那套风格挂在根元素上的可继承属性，进不了别的风格的预览", () => {
    // 页面是 a 风格，它在根元素上设了字距和字体特性：在页面上照样生效；复制给预览后只挂在 a 的预览的场景最外层上
    const css = ':root[data-style="a"] { letter-spacing: 3px; font-feature-settings: "ss01"; }';
    expect(previewCss(css)).toBe(`:host([data-style="a"]) .${PREVIEW_PAGE_CLASS} { letter-spacing: 3px; font-feature-settings: "ss01"; }`);
    // 别的风格的预览：经宿主继承过来的，被场景最外层的 all: initial 挡住——它写在最前面，后面补回的除了 color-scheme 没有一个是继承来的
    const pages = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/styles/pages.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = new RegExp(`\\n\\.${PREVIEW_PAGE_CLASS} \\{([^}]*)\\}`).exec(pages)?.[1] ?? "";
    const decls = block
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    expect(decls[0]).toBe("all: initial");
    expect(decls.filter((d) => /:\s*(?:inherit|unset|revert)/.test(d))).toEqual(["color-scheme: inherit"]);
  });

  test("别的原样：经典的样式、token、深浅色的开关", () => {
    const css = ':root{--bg:#fff}[data-style="grid"]{--bg:#fafafa}:root[data-theme="dark"]{color-scheme:dark}.bubble{padding:10px}html,body{margin:0}';
    expect(previewCss(css)).toBe(css);
  });
});

describe("每套风格的 style.css 换完一条不落", () => {
  test.each(VISUAL_STYLES.map((s) => [s.name, s.id] as const))("%s（%s）", (_name, id) => {
    const file = path.join(STYLES_DIR, id, "style.css");
    const css = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") : "";
    const before = css.split(`:root[data-style="${id}"]`).length - 1;
    const out = previewCss(css);
    expect(out).not.toContain(":root[data-style");
    expect(out.split(`:host([data-style="${id}"])`).length - 1).toBe(before);
  });
});

describe("预览场景里的字", () => {
  test("就是自带的几种语言里场景那几段文字的字，不重复；中文的没有数字、标点、空格（它们在另一片字体里），英文的都是基本拉丁字母那片里的", () => {
    const chars = previewChars();
    const zh = [...new Set(Object.values(PREVIEW_SCENE).join(""))];
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const en = [...new Set(Object.values(PREVIEW_SCENE).join(""))];
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    expect(chars.join("")).toBe([...new Set([...zh, ...en])].join(""));
    for (const ch of zh) expect(ch).toMatch(/^\p{Script=Han}$/u);
    for (const ch of en) expect(ch).toMatch(/^[ -~]$/);
  });
});
