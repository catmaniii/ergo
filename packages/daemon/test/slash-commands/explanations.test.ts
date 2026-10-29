// 斜杠候选的说明看得懂（310 号票）：
// - 参数提示：二狗自己的命令按现在的语言写（/workflow <要做的事>），运行时报的照带（空的不带）；
// - Claude Code 内置命令的中文说明表（语言文件 claudeCode.commands.*）：报回英文的直接换成中文、原文放 originalDescription，参数提示同样；
//   界面是英文时照它报的原文；只查现在这种语言自己的（不退到中文）；
// - 表里没有的英文说明（用户自己的命令、插件和 skill 带的）交给二狗的模型翻：第一次给原文、标 translating，翻好后缓存（数据目录），
//   再取直接给译文；只交说明原文；同一句只翻一次；模型没配、出错显示原文（出错的过一阵再试）；说明本来就是用户语言的不翻；
// - 记忆管理员的会话（含了解你访谈）有命令：/interview（访谈服务在时）、/consolidate（中文老写法 /访谈、/整理 也认）；管理员没在运行时没有这个会话。
import fs from "node:fs";
import path from "node:path";
import { activeLocaleFrom, DEFAULT_LANGUAGE, MEMORY_CURATOR_CONVERSATION, setActiveLocale, type SlashCommandList } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCommandText } from "../../src/claude-code/runtime.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { conversationSlashCommands, type SlashCommandSources } from "../../src/slash-commands/list.ts";
import { createSlashTranslations, inLanguage, TRANSLATION_RETRY_MS } from "../../src/slash-commands/translations.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const use = (language: string) => setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, language));
afterEach(() => use(DEFAULT_LANGUAGE));

/** Claude Code 报的命令：内置的（在表里）、用户自己的（不在表里、英文）、带参数提示的、说明已经是中文的 */
const CLAUDE_COMMANDS = [
  { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>" },
  { name: "context", description: "Visualize current context usage", argumentHint: "" },
  { name: "deploy-notes", description: "Write release notes for the current branch", argumentHint: "[version]" },
  { name: "周报", description: "写这周的周报" },
];

const sources = (over: Partial<SlashCommandSources> = {}): SlashCommandSources => ({
  table: () => [],
  secretarySkills: () => [],
  projectSkills: () => undefined,
  taskSkills: (id) => (id === "tm-1" ? [] : undefined),
  runtimeCommands: (id) => (id === "tm-1" ? { title: "Claude Code", commands: CLAUDE_COMMANDS, builtin: claudeCommandText } : undefined),
  ...over,
});

describe("参数提示和 Claude Code 内置命令的中文说明表", () => {
  it("二狗的命令带参数提示；运行时报的照带（空的不带）；内置命令报回英文的换成中文、原文留着，参数提示也换；表里没有的照原文", () => {
    const list = conversationSlashCommands(sources(), "maintainer:tm-1")!.commands;
    expect(list.map((c) => c.text)).toEqual(["/compact", "/context", "/deploy-notes", "/周报"]);
    const [compact, context, deploy, weekly] = list;
    expect(compact).toEqual({
      kind: "runtime",
      text: "/compact",
      name: "compact",
      description: expect.stringMatching(/^压缩对话/),
      originalDescription: "Clear conversation history but keep a summary in context",
      argumentHint: "[摘要时要特别留意的]",
      collection: "Claude Code",
    });
    expect(context).toMatchObject({ description: expect.stringMatching(/^看上下文用了多少/), originalDescription: "Visualize current context usage" });
    expect(context).not.toHaveProperty("argumentHint");
    // 表里没有的：原文照旧（由翻译那一步接着管），参数提示照它报的
    expect(deploy).toEqual({ kind: "runtime", text: "/deploy-notes", name: "deploy-notes", description: "Write release notes for the current branch", argumentHint: "[version]", collection: "Claude Code" });
    // 本来就是中文的不动
    expect(weekly).toEqual({ kind: "runtime", text: "/周报", name: "周报", description: "写这周的周报", collection: "Claude Code" });

    const secretary = conversationSlashCommands(sources(), "secretary")!.commands;
    expect(secretary.map((c) => [c.text, c.argumentHint])).toEqual([
      ["/workflow", "<要做的事>"],
      ["/task", "<要做的事>"],
    ]);
  });

  it("界面是英文：Claude Code 报的英文照原样（不查表、没有原文那一行）；二狗的命令写英文的提示", () => {
    use("en");
    const list = conversationSlashCommands(sources(), "maintainer:tm-1")!.commands;
    expect(list[0]).toEqual({
      kind: "runtime",
      text: "/compact",
      name: "compact",
      description: "Clear conversation history but keep a summary in context",
      argumentHint: "<optional custom summarization instructions>",
      collection: "Claude Code",
    });
    expect(conversationSlashCommands(sources(), "secretary")!.commands[0]).toMatchObject({ text: "/workflow", argumentHint: "<what to do>" });
  });

  it("说明表只查现在这种语言自己的：中文、英文都有；没有的命令、用户加的语言里没翻的是 undefined（不退到中文）", () => {
    expect(claudeCommandText("review")).toEqual({ description: "评审一个拉取请求（PR）", argumentHint: "[PR 号]" });
    expect(claudeCommandText("security-review")?.description).toMatch(/安全审查/);
    expect(claudeCommandText("deploy-notes")).toBeUndefined();
    use("en");
    expect(claudeCommandText("review")).toEqual({ description: "Review a pull request", argumentHint: "[PR number]" });
    // 一种只有 _meta 的语言：表里一句都没有，也不拿中文的
    setActiveLocale({ ...activeLocaleFrom(builtinCatalogs().catalogs, "en"), meta: { id: "fr", nativeName: "Français", modelName: "French", intlLocale: "fr" }, messages: {} });
    expect(claudeCommandText("review")).toBeUndefined();
  });

  it("说明是不是用户的语言：中文看有没有汉字，英文看没有汉字，别的语言一律交给模型", () => {
    expect(inLanguage("压缩对话", "zh-CN")).toBe(true);
    expect(inLanguage("Review a pull request", "zh-CN")).toBe(false);
    expect(inLanguage("Review a pull request", "en")).toBe(true);
    expect(inLanguage("评审", "en")).toBe(false);
    expect(inLanguage("Review a pull request", "fr")).toBe(false);
  });
});

describe("记忆管理员的会话有命令", () => {
  it("/interview（访谈服务在时）、/consolidate，带说明和参数提示；访谈服务不在时只有 /consolidate；管理员没在运行时没有这个会话", () => {
    const list = conversationSlashCommands(sources({ curator: () => ({ interview: true }) }), MEMORY_CURATOR_CONVERSATION)!.commands;
    expect(list).toEqual([
      { kind: "command", text: "/interview", name: "interview", description: expect.stringMatching(/^开一次了解你访谈/), argumentHint: "[主题]" },
      { kind: "command", text: "/consolidate", name: "consolidate", description: expect.stringMatching(/^现在整理一次记忆/) },
    ]);
    expect(conversationSlashCommands(sources({ curator: () => ({ interview: false }) }), MEMORY_CURATOR_CONVERSATION)!.commands.map((c) => c.text)).toEqual(["/consolidate"]);
    expect(conversationSlashCommands(sources({ curator: () => undefined }), MEMORY_CURATOR_CONVERSATION)).toBeUndefined();
    expect(conversationSlashCommands(sources(), MEMORY_CURATOR_CONVERSATION)).toBeUndefined();
    use("en");
    expect(conversationSlashCommands(sources({ curator: () => ({ interview: true }) }), MEMORY_CURATOR_CONVERSATION)!.commands.map((c) => [c.text, c.argumentHint])).toEqual([
      ["/interview", "[topic]"],
      ["/consolidate", undefined],
    ]);
  });
});

/** 一份候选：Claude Code 的（先查过表）加一个英文说明的 skill、一个中文说明的 skill */
function claudeList(): SlashCommandList {
  const list = conversationSlashCommands(
    sources({ runtimeCommands: () => ({ title: "Claude Code", commands: CLAUDE_COMMANDS, builtin: claudeCommandText, skills: [{ command: "ergo:tdd", name: "tdd", description: "Test-driven development: red, green, refactor" }, { command: "ergo:写周报", name: "写周报", description: "照模板写周报" }] }) }),
    "maintainer:tm-1",
  )!;
  return list;
}

/** 假的翻译：记下每批交了什么；按 answer 回 */
function fakeTranslator(answer: (text: string) => string | null | Error = (text) => `【译】${text}`) {
  const batches: Array<{ texts: string[]; language: string }> = [];
  return {
    batches,
    translate: (texts: readonly string[], language: string) => {
      batches.push({ texts: [...texts], language });
      const out = texts.map(answer);
      const error = out.find((x) => x instanceof Error);
      return error ? Promise.reject(error) : Promise.resolve(out as Array<string | null>);
    },
  };
}

describe("表里没有的英文说明交给二狗的模型翻", () => {
  it("第一次给原文、标 translating；翻好后再取是译文（原文留着）；只交说明原文；缓存进文件，重开的服务直接用", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "cache", "slash-translations.json");
    const fake = fakeTranslator();
    let now = 1_000;
    const service = createSlashTranslations({ file, available: () => true, translate: fake.translate, now: () => now, log: () => {} });

    const first = service.localize(claudeList()).commands;
    const byText = (list: typeof first) => Object.fromEntries(list.map((c) => [c.text, c]));
    expect(byText(first)["/ergo:tdd"]).toMatchObject({ description: "Test-driven development: red, green, refactor", translating: true });
    expect(byText(first)["/deploy-notes"]).toMatchObject({ description: "Write release notes for the current branch", translating: true });
    // 查过表的、中文的不翻
    expect(byText(first)["/compact"]).not.toHaveProperty("translating");
    expect(byText(first)["/ergo:写周报"]).not.toHaveProperty("translating");
    expect(byText(first)["/周报"]).not.toHaveProperty("translating");
    // 排着的时候再取：照旧 translating，不重复排
    expect(byText(service.localize(claudeList()).commands)["/deploy-notes"]).toMatchObject({ translating: true });
    await service.idle();
    // 一批，只有这两句原文，语言是给模型看的名字
    expect(fake.batches).toEqual([{ texts: ["Test-driven development: red, green, refactor", "Write release notes for the current branch"], language: "中文" }]);

    const second = byText(service.localize(claudeList()).commands);
    expect(second["/ergo:tdd"]).toEqual({
      kind: "skill",
      text: "/ergo:tdd",
      name: "tdd",
      description: "【译】Test-driven development: red, green, refactor",
      originalDescription: "Test-driven development: red, green, refactor",
    });
    expect(second["/deploy-notes"]).toMatchObject({ description: "【译】Write release notes for the current branch", originalDescription: "Write release notes for the current branch", argumentHint: "[version]" });
    expect(second["/deploy-notes"]).not.toHaveProperty("translating");
    expect(fake.batches).toHaveLength(1);

    // 缓存在文件里：按语言、命令名、原文
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Array<Record<string, string>> };
    expect(saved.entries).toContainEqual({ language: "zh-CN", name: "deploy-notes", original: "Write release notes for the current branch", text: "【译】Write release notes for the current branch" });
    const reopened = createSlashTranslations({ file, available: () => true, translate: fake.translate, now: () => now, log: () => {} });
    expect(byText(reopened.localize(claudeList()).commands)["/deploy-notes"]).toMatchObject({ description: "【译】Write release notes for the current branch" });
    expect(fake.batches).toHaveLength(1);

    // 原文变了（Claude Code 升级改了说法）：重新翻
    now += 1;
    const changed: SlashCommandList = { commands: [{ kind: "runtime", text: "/deploy-notes", name: "deploy-notes", description: "Draft release notes", collection: "Claude Code" }] };
    expect(reopened.localize(changed).commands[0]).toMatchObject({ description: "Draft release notes", translating: true });
    await reopened.idle();
    expect(fake.batches.at(-1)!.texts).toEqual(["Draft release notes"]);
  });

  it("同一句原文只翻一次（同一个 skill 在不同会话里写法不一样）；模型回的和原文一样的不另写原文", async () => {
    const fake = fakeTranslator((text) => (text === "Same" ? "Same" : `译：${text}`));
    const service = createSlashTranslations({ file: path.join(makeTempDir(), "t.json"), available: () => true, translate: fake.translate, now: () => 0, log: () => {} });
    const list: SlashCommandList = {
      commands: [
        { kind: "skill", text: "/tdd", name: "tdd", description: "Test first" },
        { kind: "skill", text: "/ergo:tdd", name: "tdd", description: "Test first" },
        { kind: "skill", text: "/same", name: "same", description: "Same" },
      ],
    };
    service.localize(list);
    await service.idle();
    expect(fake.batches.map((b) => b.texts)).toEqual([["Test first", "Same"]]);
    const after = service.localize(list).commands;
    expect(after.map((c) => c.description)).toEqual(["译：Test first", "译：Test first", "Same"]);
    expect(after[2]).not.toHaveProperty("originalDescription");
  });

  it("模型出错（整批起不来、这一条没翻成）：显示原文、不标 translating，过一阵再试；模型没配：不排队、显示原文", async () => {
    let now = 0;
    const logs: string[] = [];
    const broken = fakeTranslator(() => new Error("模型出错了"));
    const service = createSlashTranslations({ file: path.join(makeTempDir(), "t.json"), available: () => true, translate: broken.translate, now: () => now, log: (line) => logs.push(line) });
    const list: SlashCommandList = { commands: [{ kind: "skill", text: "/tdd", name: "tdd", description: "Test first" }] };
    expect(service.localize(list).commands[0]).toMatchObject({ translating: true });
    await service.idle();
    expect(service.localize(list).commands[0]).toEqual({ kind: "skill", text: "/tdd", name: "tdd", description: "Test first" });
    expect(broken.batches).toHaveLength(1);
    expect(logs.join("\n")).toContain("模型出错了");
    now += TRANSLATION_RETRY_MS;
    expect(service.localize(list).commands[0]).toMatchObject({ translating: true });
    await service.idle();
    expect(broken.batches).toHaveLength(2);

    // 这一条没翻成（null）也一样
    const partial = fakeTranslator((text) => (text === "Bad" ? null : `译：${text}`));
    const second = createSlashTranslations({ file: path.join(makeTempDir(), "t.json"), available: () => true, translate: partial.translate, now: () => 0, log: () => {} });
    const two: SlashCommandList = { commands: [{ kind: "skill", text: "/bad", name: "bad", description: "Bad" }, { kind: "skill", text: "/ok", name: "ok", description: "Fine" }] };
    second.localize(two);
    await second.idle();
    expect(second.localize(two).commands.map((c) => [c.description, c.translating])).toEqual([
      ["Bad", undefined],
      ["译：Fine", undefined],
    ]);

    const off = fakeTranslator();
    const unconfigured = createSlashTranslations({ file: path.join(makeTempDir(), "t.json"), available: () => false, translate: off.translate, now: () => 0, log: () => {} });
    expect(unconfigured.localize(list).commands[0]).toEqual({ kind: "skill", text: "/tdd", name: "tdd", description: "Test first" });
    await unconfigured.idle();
    expect(off.batches).toEqual([]);
  });

  it("界面是英文：中文说明的 skill 翻成英文、英文的不动；二狗自己的命令不翻", async () => {
    use("en");
    const fake = fakeTranslator((text) => `EN: ${text}`);
    const service = createSlashTranslations({ file: path.join(makeTempDir(), "t.json"), available: () => true, translate: fake.translate, now: () => 0, log: () => {} });
    const list: SlashCommandList = {
      commands: [
        { kind: "command", text: "/task", name: "task", description: "Start a long-running task" },
        { kind: "skill", text: "/weekly", name: "weekly", description: "照模板写周报" },
        { kind: "skill", text: "/tdd", name: "tdd", description: "Test first" },
      ],
    };
    service.localize(list);
    await service.idle();
    expect(fake.batches).toEqual([{ texts: ["照模板写周报"], language: "English" }]);
    expect(service.localize(list).commands.map((c) => c.description)).toEqual(["Start a long-running task", "EN: 照模板写周报", "Test first"]);
  });
});
