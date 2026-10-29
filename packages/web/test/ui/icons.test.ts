// 共用的线条图标（122 号票，ui/icons.tsx）：导航、选项、按钮上原来拿表情符号或 Unicode 符号当的图标换成自己画的 SVG。
// 这里查三件事：
// - 每个图标都按同一套画法：24×24 视框、线宽 1.75、圆头圆角、颜色只用 currentColor、1em 大、不给读屏读；
// - 导航以外指同一项的地方（"更多"页菜单、记忆页的占位）用 NavIcon：和导航一样是 .tab-icon 挂 data-nav，跟着风格走；
// - 防回退：这次换掉的那几处组件的源码里（注释除外）不再出现当图标用的表情符号和符号。
//   用户 2026-10-14 收窄了范围：只换导航和选项、按钮上的；文本框里的标记、阶段进展的 ✓ ✕ ○ ◐、聊天和时间线文字里的
//   ⛔ 📨 💭、展开收起的 ▾ ▸、语音气泡的 ▶ ❚ 这些不换，所以这里只查换了的那几个文件。
//   关闭的 ×、列表行尾的 › 这次没动（拿不准算不算图标，留给用户定），这两个字不在查的范围里。
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CORE_NAV_ITEMS } from "../../src/state/index.ts";
import { Icon, ICON_NAMES } from "../../src/ui/icons.tsx";
import { type NavEntry, NavIcon, NavTab } from "../../src/ui/main-nav.tsx";

const ENTRIES: NavEntry[] = [...CORE_NAV_ITEMS, "more"];

/** 导航上的一项（没有提示） */
const renderTab = (entry: NavEntry) => renderToStaticMarkup(createElement(NavTab, { entry, on: false, badge: { unread: 0, seenPending: 0 } }));
/** 渲染出来的是哪个图标 */
const iconOf = (html: string) => /data-icon="([a-z]+)"/.exec(html)?.[1];

describe("共用的线条图标", () => {
  test.each(ICON_NAMES)("%s：24×24、线宽 1.75、圆头圆角、currentColor、1em 大，外层 aria-hidden", (name) => {
    const html = renderToStaticMarkup(createElement(Icon, { name }));
    expect(html).toMatch(new RegExp(`^<span class="icon" data-icon="${name}" aria-hidden="true"><svg `));
    const svg = /<svg ([^>]*)>/.exec(html)?.[1] ?? "";
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('width="1em"');
    expect(svg).toContain('height="1em"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    // 颜色只用当前字色：里面不许写死别的颜色，也不许另改线宽
    const body = html.slice(html.indexOf(">", html.indexOf("<svg")) + 1);
    for (const m of body.matchAll(/(?:fill|stroke)="([^"]*)"/g)) expect(["none", "currentColor"]).toContain(m[1]);
    expect(body).not.toContain("stroke-width");
  });

  test("每个图标画的都不一样", () => {
    const bodies = ICON_NAMES.map((name) => renderToStaticMarkup(createElement(Icon, { name })).replace(/data-icon="[^"]*"/, ""));
    expect(new Set(bodies).size).toBe(ICON_NAMES.length);
  });
});

describe("导航的图标", () => {
  test.each(ENTRIES)("%s：图标框里是共用的线条图标（风格没画导航图标时的退路），不是表情符号", (entry) => {
    const html = renderTab(entry);
    expect(html).toMatch(/<span class="tab-icon" aria-hidden="true"><span class="icon" data-icon="[a-z]+" aria-hidden="true"><svg /);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test.each(ENTRIES)("%s：导航以外的 NavIcon 和导航一样是 .tab-icon 挂 data-nav（风格按它画图标），里面同一个线条图标", (entry) => {
    const own = renderToStaticMarkup(createElement(NavIcon, { entry, className: "menu-icon" }));
    expect(own).toMatch(new RegExp(`^<span class="tab-icon menu-icon" data-nav="${entry}" aria-hidden="true"><span class="icon"`));
    expect(iconOf(own)).toBe(iconOf(renderTab(entry)));
  });

  test("网页插件的页面（193 号票，比如记忆）：图标、写的字由它给，data-nav 是页面的 id；导航以外的 NavIcon 同一个图标", () => {
    const tab = renderToStaticMarkup(createElement(NavTab, { entry: "memory", label: "记忆", icon: "layers", on: false, badge: { unread: 0, seenPending: 0 } }));
    expect(tab).toContain('data-nav="memory"');
    expect(iconOf(tab)).toBe("layers");
    expect(tab).toContain('<span class="tab-label">记忆</span>');
    const own = renderToStaticMarkup(createElement(NavIcon, { entry: "memory", icon: "layers", className: "menu-icon" }));
    expect(own).toMatch(/^<span class="tab-icon menu-icon" data-nav="memory" aria-hidden="true"><span class="icon" data-icon="layers"/);
  });
});

/** 换掉了图标的组件（相对 src/） */
const CHANGED = [
  "ui/icons.tsx",
  "ui/main-nav.tsx",
  "pages/MorePage.tsx",
  "ui/conversation/Composer.tsx",
  "ui/agent-settings.tsx",
  "ui/alerts.tsx",
  "ui/conversation/Conversation.tsx",
];

/** 当图标用的：表情符号（含 ⚙ ⌨ 这类带表情样式的符号）、箭头、技术符号（⌨ ⏹）、几何图形（▤ ▶ ○）、杂项符号和装饰符号（⚙ ✓）、全角加号、居中省略号（⋯）、表情变体选择符 */
const ICON_CHARS = /\p{Extended_Pictographic}|[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF\uFF0B\u22EF]|\uFE0F/u;

/** 去掉注释（注释里提到原来的符号不算）；`://` 里的两道斜杠不当注释 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("防回退：换过图标的组件里不再拿符号当图标", () => {
  test.each(CHANGED)("%s", (file) => {
    const src = withoutComments(fs.readFileSync(path.resolve(import.meta.dirname, "../../src", file), "utf8"));
    const hits = src.split("\n").flatMap((line, i) => (ICON_CHARS.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });
});
