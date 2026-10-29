// 输入框里打 / 弹出的候选列表（310 号票，ui/conversation/SlashMenu.tsx 的 SlashList）：用 React 在 Node 里渲染出来查（挂一个不连线的
// StoreProvider：名字标签要取名字）。
// - 选中的那一行说明完整展开（不截短，原文小字跟在下面），其余行的说明交给样式截成两行、没有原文那一行；
// - 参数提示写在写法后面（单独一段，选中插入时不插：插的是 entry.text）；
// - 分组：两组以上写组名（<名字>的命令、<名字>工具包里的 skill、Claude Code 的命令），只有一组时不写；
// - 每行右边一个"说明"小按钮（手机上点它只展开说明、不插入；电脑上用样式藏起来，悬停就展开）；
// - 界面文字里没有字面的"秘书""待我处理"。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { type SlashCommandEntry, slashGroups } from "../../src/state/index.ts";
import { SlashList } from "../../src/ui/conversation/SlashMenu.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
const noop = () => {};

const ENTRIES: SlashCommandEntry[] = [
  { kind: "command", text: "/workflow", name: "workflow", description: "发起一个流程：维护者把要做的事排成步骤，你授权一次，照步骤做", argumentHint: "<要做的事>" },
  { kind: "skill", text: "/ergo:tdd", name: "Test Driven", description: "先写测试再写实现", collection: "demo-methods" },
  {
    kind: "runtime",
    text: "/compact",
    name: "compact",
    description: "压缩对话：清掉历史、只在上下文里留一份摘要；后面可以写摘要时要特别留意什么",
    originalDescription: "Clear conversation history but keep a summary in context",
    argumentHint: "[摘要时要特别留意的]",
    collection: "Claude Code",
  },
  { kind: "runtime", text: "/review", name: "review", description: "评审一个拉取请求（PR）", originalDescription: "Review a pull request", collection: "Claude Code" },
];

const render = (entries: readonly SlashCommandEntry[], active: number) =>
  renderToStaticMarkup(createElement(StoreProvider, offline, createElement(SlashList, { groups: slashGroups(entries), active, onPick: noop, onActivate: noop })));

/** 渲染出来的第 i 行（按 slash-item 切） */
const rows = (html: string) => html.split('<div class="slash-item"').slice(1);

describe("斜杠候选列表", () => {
  test("选中的那一行说明完整、原文小字跟在下面；别的行没有原文那一行", () => {
    const html = render(ENTRIES, 2);
    const all = rows(html);
    expect(all).toHaveLength(4);
    expect(all[2]).toContain("data-active");
    expect(all[2]).toContain('<span class="slash-desc">压缩对话：清掉历史、只在上下文里留一份摘要；后面可以写摘要时要特别留意什么</span>');
    expect(all[2]).toContain("Clear conversation history but keep a summary in context");
    expect(all[2]).toMatch(/class="slash-original"/);
    // 别的行：说明照放（样式截成两行），没有原文
    expect(all[3]).not.toContain("data-active");
    expect(all[3]).toContain('<span class="slash-desc">评审一个拉取请求（PR）</span>');
    expect(all[3]).not.toContain("Review a pull request");
    // 选中的那一行由输入框的 aria-activedescendant 指着
    expect(all[2]).toContain('id="slash-item-2"');
  });

  test("参数提示写在写法后面；显示的名字和写法不一样时才写；skill 的集合名作小标，命令、运行时的不再另标", () => {
    const html = render(ENTRIES, 0);
    const all = rows(html);
    expect(all[0]).toMatch(/<span class="slash-cmd">\/workflow<\/span><span class="slash-hint">&lt;要做的事&gt;<\/span>/);
    expect(all[2]).toMatch(/<span class="slash-cmd">\/compact<\/span><span class="slash-hint">\[摘要时要特别留意的\]<\/span>/);
    expect(all[1]).toContain('<span class="slash-name">Test Driven</span>');
    expect(all[1]).toContain('<span class="chip slash-tag">demo-methods</span>');
    expect(all[0]).not.toContain("slash-tag");
    expect(all[2]).not.toContain("slash-tag");
  });

  test("两组以上写组名（名字标签、运行时的名字），只有一组不写", () => {
    const html = render(ENTRIES, 0);
    const titles = [...html.matchAll(/<div class="slash-group-title"[^>]*>(.*?)<\/div>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(titles).toEqual(["二狗的命令", "二狗工具包里的 skill", "Claude Code 的命令"]);
    expect(html).toContain('<span class="assistant-name">二狗</span>');
    const single = render(ENTRIES.slice(2), 0);
    expect(single).not.toContain("slash-group-title");
  });

  test("每行一个说明小按钮（只展开说明、不插入），选中的那一行按下的样子；界面文字里没有字面的秘书、待我处理", () => {
    const html = render(ENTRIES, 1);
    const buttons = [...html.matchAll(/<button type="button" class="slash-more"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(4);
    expect(buttons[1]).toContain('aria-pressed="true"');
    expect(buttons[0]).toContain('aria-pressed="false"');
    expect(buttons[0]).toContain('aria-label="看说明：/workflow"');
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});
