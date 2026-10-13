// 经典的导航图标（119 号票）：原来是表情符号，换成一套实心图标（classic/style.css，照别的风格按 data-nav 换图标的写法）。
// 这里查导航的每一项（包括"更多"）都有图标、表情符号藏起来了、图标是能用的 data: 地址的 SVG。
// 规则只管到经典（:root[data-style="classic"] 开头）在 scope.test.ts 里查；设置里预览换成 :host(...) 在 preview.test.ts 里查。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NAV_ITEMS } from "../../src/state/index.ts";

const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/visual-styles/classic/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ENTRIES = [...NAV_ITEMS, "more"];

/** 某一项的图标：url("data:image/svg+xml,...") 里的 SVG（解码后） */
function iconOf(entry: string): string | undefined {
  const block = new RegExp(`:root\\[data-style="classic"\\] \\[data-nav="${entry}"\\] \\{([^}]*)\\}`).exec(css)?.[1];
  const url = /--classic-icon:\s*url\("data:image\/svg\+xml,([^"]*)"\);/.exec(block ?? "")?.[1];
  return url;
}

describe("经典的导航图标", () => {
  test("表情符号藏起来（图标框的字号 0），图标按当前字色用 mask 画：没选中是次要字色，选中是主色", () => {
    expect(css).toMatch(/:root\[data-style="classic"\] \.tab-icon \{\s*font-size: 0;\s*\}/);
    const before = /:root\[data-style="classic"\] \.tab-icon::before \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(before).toContain("background: currentColor;");
    expect(before).toContain("mask: var(--classic-icon) center / contain no-repeat;");
    expect(before).toContain("width: 22px;");
    expect(before).toContain("height: 22px;");
  });

  test.each(ENTRIES)("%s 有自己的图标：24×24 的 SVG，# 写成 %%23（不然 data: 地址在 # 处就断了）", (entry) => {
    const url = iconOf(entry);
    expect(url).toBeDefined();
    expect(url).not.toContain("#");
    expect(url).not.toMatch(/[<>"]/);
    const svg = decodeURIComponent(url!);
    expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 24 24'>.*<\/svg>$/);
  });

  test("每一项的图标都不一样", () => {
    const icons = ENTRIES.map(iconOf);
    expect(new Set(icons).size).toBe(ENTRIES.length);
  });
});
