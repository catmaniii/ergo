// 会话滚到最后一条就停（108 号票）：滚动范围要等于 sizer 的高度，内容里伸到内容下面的东西（对话层看不见的右侧标注、
// 缩小后被挤下去的标注和箭头）不能再撑出空白。真的排版这里没有（jsdom 不排版），只锁住样式里那一条裁剪；
// 在浏览器里量的办法见 docs/dev.md 的"会话滚到最后一条就停"（viewport 的 scrollHeight 等于 sizer 的高度）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ZOOM_CSS = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/styles/zoom.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 某个选择器单独成一条的规则里写了什么 */
function declarations(selector: string): string {
  const m = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(ZOOM_CSS);
  expect(m, `${selector} 那一条规则`).not.toBeNull();
  return m![2]!;
}

describe("会话的滚动范围只到 sizer 的底", () => {
  test("sizer 把伸到下面的裁掉：上下 clip（不用 hidden：hidden 会多出一个能滚的容器）", () => {
    expect(declarations(".zh-sizer")).toMatch(/overflow-y:\s*clip;/);
    expect(declarations(".zh-sizer")).not.toMatch(/overflow(-y)?:\s*hidden/);
  });

  test("左右不裁（标注、底色带横向铺满视口，由视口自己裁）", () => {
    expect(declarations(".zh-sizer")).not.toMatch(/overflow(-x)?:\s*(clip|hidden)/);
    expect(declarations(".zh-viewport")).toMatch(/overflow-x:\s*hidden;/);
  });
});
