// 会话外层 .conv 上给风格用的属性（40 号票，ui/conversation/conversation-root.ts）：data-mode 两种会话都有，
// --assistant-initial（名字的第一个字，CSS 字符串）只在秘书的会话里挂。用 React 在 Node 里渲染出来查，确认 React 真的把
// 自定义属性写进了 style（暖纸手帐的字头像靠它），维护者的会话一个 style 都不带。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { conversationRootProps, cssString } from "../../src/ui/conversation/conversation-root.ts";

const render = (mode: "secretary" | "maintainer", name: string) => renderToStaticMarkup(createElement("div", { className: "conv", ...conversationRootProps(mode, name) }));

describe("会话外层 .conv 的属性", () => {
  test("秘书的会话：data-mode 是 secretary，style 里挂着名字的第一个字", () => {
    expect(render("secretary", "二狗")).toBe('<div class="conv" data-mode="secretary" style="--assistant-initial:&quot;二&quot;"></div>');
  });

  test("起名个人助理（89 号票之前的默认名字）是个；国旗这类按一个字取", () => {
    expect(render("secretary", "个人助理")).toContain("--assistant-initial:&quot;个&quot;");
    expect(render("secretary", "🇨🇳二狗")).toContain("--assistant-initial:&quot;🇨🇳&quot;");
  });

  test("维护者的会话：只有 data-mode，不挂 --assistant-initial", () => {
    const html = render("maintainer", "二狗");
    expect(html).toBe('<div class="conv" data-mode="maintainer"></div>');
    expect(html).not.toContain("assistant-initial");
  });
});

describe("写成 CSS 字符串", () => {
  test.each([
    ["二", '"二"'],
    ["🇨🇳", '"🇨🇳"'],
    ['"', '"\\""'],
    ["\\", '"\\\\"'],
    ["\n", '"\\a "'],
    ["\u0007", '"\\7 "'],
    ["", '""'],
  ])("%j → %s", (text, css) => {
    expect(cssString(text)).toBe(css);
  });
});
