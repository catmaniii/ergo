// 主导航上的一项（ui/main-nav.tsx 的 NavTab）：宽屏竖栏、竖屏横栏、量长度的样本、设置里风格预览那排导航图标都用它画。
// 89 号票：秘书那一项固定写"秘书"，和别的项一样是普通的两个字，不带名字标签、不读用户起的名字——
// 所以这里不挂 StoreProvider 也渲染得出来（读名字要从 store 取，没有 store 会直接报错）。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { type NavEntry, NavTab } from "../../src/ui/main-nav.tsx";

const NO_BADGE = { unread: 0, seenPending: 0 };
const render = (entry: NavEntry, on = false) => renderToStaticMarkup(createElement(NavTab, { entry, on, badge: NO_BADGE }));

describe("导航上秘书那一项", () => {
  test("写“秘书”：普通的两个字，没有名字标签，也不另挂名字的 title、aria-label", () => {
    const html = render("secretary");
    expect(html).toContain('<span class="tab-label">秘书</span>');
    expect(html).not.toContain("assistant-name");
    expect(html).not.toContain("title=");
    expect(html).not.toContain("aria-label=");
  });

  test("选中时也是普通的两个字，和别的项一样只是 tab 挂上 on", () => {
    const html = render("secretary", true);
    expect(html).toContain('class="tab on"');
    expect(html).toContain('<span class="tab-label">秘书</span>');
    expect(html).not.toContain("assistant-name");
  });
});
