// 秘书页左上角的标题（89 号票，ui/secretary-title.tsx）："个人秘书："后面跟名字标签（.assistant-name，和正文里的名字同一个样子），
// 名字跟着改名变；外层挂窄屏上字号按几个字的名字缩 --secretary-fit-chars（最多 4，base.css 的 .secretary-title）和整行的
// 纯文字 title（名字被截成省略号时悬停看得到全称）。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SecretaryTitle } from "../../src/ui/secretary-title.tsx";

const render = (name: string) => renderToStaticMarkup(createElement(SecretaryTitle, { name }));

describe("秘书页的标题", () => {
  test("个人秘书：加名字标签", () => {
    expect(render("二狗")).toBe(
      '<span class="secretary-title" title="个人秘书：二狗" style="--secretary-fit-chars:2">' +
        '<span class="secretary-title-lead">个人秘书：</span><span class="assistant-name">二狗</span></span>',
    );
  });

  test("改了名跟着变（以前存下的四个字的个人助理也照样显示）", () => {
    expect(render("阿福")).toContain('<span class="assistant-name">阿福</span>');
    expect(render("阿福")).toContain('title="个人秘书：阿福"');
    expect(render("个人助理")).toContain('<span class="assistant-name">个人助理</span>');
    expect(render("个人助理")).toContain("--secretary-fit-chars:4");
  });

  test("起名到上限 8 个字：名字整个放进标签（截不截是样式的事），字号照 4 个字的缩，title 里是全称", () => {
    const html = render("超级无敌全能管家");
    expect(html).toContain('<span class="assistant-name">超级无敌全能管家</span>');
    expect(html).toContain("--secretary-fit-chars:4");
    expect(html).toContain('title="个人秘书：超级无敌全能管家"');
  });
});
