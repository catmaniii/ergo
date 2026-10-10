// skill 库按集合显示、按集合选（72 号票）：集合显示成一项、点开才列成员；选择时能整套选、整套去掉，点开能单选其中几个。
// 守护进程的回答按协议的 schema 构造；用的是自己造的假集合（三五个成员），不是真的第三方 skill。
import { schemaChecker, ToolkitCatalog as CatalogSchema } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  addOptions,
  applyAddOption,
  collectionMeta,
  collectionPick,
  groupSkills,
  secretaryPromptSizeText,
  secretarySkillsNote,
  selectCollection,
  selectionChips,
  toggleSkill,
  type ToolkitCatalog,
  unselectCollection,
} from "../../src/state/index.ts";

const checkCatalog = schemaChecker(CatalogSchema);

function catalog(): ToolkitCatalog {
  const c: ToolkitCatalog = {
    skills: [
      { name: "example-checklist", description: "框架自带的示例", origin: "framework" },
      { name: "agent-browser", description: "浏览器", origin: "imported" },
      { name: "fake-alpha", description: "第一个", origin: "imported", collection: "fake-set" },
      { name: "fake-beta", description: "第二个", origin: "imported", collection: "fake-set" },
      { name: "fake-gamma", description: "第三个", origin: "imported", collection: "fake-set" },
      { name: "mp-tdd", description: "改了名的", origin: "imported", collection: "fake-mp" },
      { name: "to-spec", description: "规格", origin: "imported", collection: "fake-mp" },
      { name: "yt-dlp", description: "下载", origin: "imported" },
    ],
    collections: [
      { name: "fake-set", source: "假插件仓库的 fake-set/", version: "0.1.0", description: "假的方法论", skills: ["fake-alpha", "fake-beta", "fake-gamma"] },
      { name: "fake-mp", source: "假的 engineering", version: "1.2.3", description: "假的一套", skills: ["mp-tdd", "to-spec"] },
    ],
    mcp: [],
  };
  const problem = checkCatalog.firstError(c);
  if (problem) throw new Error(`构造的回答不合 schema：${problem}`);
  return c;
}

describe("skill 库按集合显示", () => {
  test("集合各显示成一项（按集合名排），成员按集合里的顺序；单个导入的、框架自带的照旧一个一个列", () => {
    const groups = groupSkills(catalog());
    expect(groups.collections.map((g) => [g.collection.name, g.members.map((m) => m.name)])).toEqual([
      ["fake-mp", ["mp-tdd", "to-spec"]],
      ["fake-set", ["fake-alpha", "fake-beta", "fake-gamma"]],
    ]);
    expect(groups.singles.map((s) => s.name)).toEqual(["example-checklist", "agent-browser", "yt-dlp"]);
    expect(collectionMeta(groups.collections[1]!.collection)).toBe("3 个 skill · 版本 0.1.0 · 来源：假插件仓库的 fake-set/");
  });

  test("老版本守护进程的目录里没有 collections：全是单个的", () => {
    const { collections: _, ...old } = catalog();
    expect(groupSkills(old).collections).toEqual([]);
    expect(groupSkills(old).singles).toHaveLength(8);
  });
});

describe("按集合选 skill", () => {
  const groups = groupSkills(catalog());
  const set = groups.collections.find((g) => g.collection.name === "fake-set")!;

  test("整套选上、整套去掉；单选其中几个；选了几个", () => {
    const all = selectCollection(["yt-dlp"], set);
    expect(all).toEqual(["yt-dlp", "fake-alpha", "fake-beta", "fake-gamma"]);
    expect(collectionPick(set, all)).toEqual({ state: "all", count: 3, total: 3 });
    const some = toggleSkill(all, "fake-beta");
    expect(collectionPick(set, some)).toEqual({ state: "some", count: 2, total: 3 });
    expect(unselectCollection(some, set)).toEqual(["yt-dlp"]);
    expect(collectionPick(set, ["yt-dlp"])).toEqual({ state: "none", count: 0, total: 3 });
    expect(toggleSkill(["yt-dlp"], "fake-beta")).toEqual(["yt-dlp", "fake-beta"]);
  });

  test("选中的名单怎么显示：集合（选了至少一个成员的）显示成一项，整套的写全部几个、部分的写几/几；单个的照名字；库里没有了的也列出来", () => {
    expect(selectionChips(["yt-dlp", "fake-alpha", "fake-beta", "fake-gamma", "mp-tdd", "gone-skill"], groups)).toEqual([
      { kind: "collection", name: "fake-mp", label: "fake-mp（1/2）", pick: { state: "some", count: 1, total: 2 } },
      { kind: "collection", name: "fake-set", label: "fake-set（全部 3 个）", pick: { state: "all", count: 3, total: 3 } },
      { kind: "skill", name: "yt-dlp", label: "yt-dlp" },
      { kind: "skill", name: "gone-skill", label: "gone-skill" },
    ]);
    expect(selectionChips([], groups)).toEqual([]);
  });

  test("加 skill 的候选：没整套选上的集合可以整套加（一个没选的还能点开挑几个），没选的单个 skill；选了之后的名单", () => {
    const selected = ["mp-tdd", "agent-browser"];
    expect(addOptions(selected, groups)).toEqual([
      { value: "collection:fake-mp", label: "整套：fake-mp（2 个 skill）" },
      { value: "collection:fake-set", label: "整套：fake-set（3 个 skill）" },
      { value: "pick:fake-set", label: "从 fake-set 里挑几个…" },
      { value: "skill:example-checklist", label: "example-checklist" },
      { value: "skill:yt-dlp", label: "yt-dlp" },
    ]);
    // 整套加
    expect(applyAddOption(selected, "collection:fake-set", groups)).toEqual({ selected: ["mp-tdd", "agent-browser", "fake-alpha", "fake-beta", "fake-gamma"] });
    expect(applyAddOption(selected, "collection:fake-mp", groups)).toEqual({ selected: ["mp-tdd", "agent-browser", "to-spec"] });
    // 挑几个：名单不变，点开那个集合
    expect(applyAddOption(selected, "pick:fake-set", groups)).toEqual({ selected, open: "fake-set" });
    // 单个的
    expect(applyAddOption(selected, "skill:yt-dlp", groups)).toEqual({ selected: ["mp-tdd", "agent-browser", "yt-dlp"] });
    // 整套都选上了的集合不再出现
    expect(addOptions(["mp-tdd", "to-spec"], groups).map((o) => o.value)).not.toContain("collection:fake-mp");
  });
});

describe("秘书用的 skill 那一栏", () => {
  test("默认的写明；名单里库里还没有的说导入之后自动装上", () => {
    const library = catalog().skills.filter((s) => s.name !== "agent-browser");
    expect(secretarySkillsNote({ skills: ["agent-browser", "yt-dlp"], isDefault: true }, library)).toBe("现在用的是默认的名单；agent-browser 还没导入进 skill 库，导入之后自动装上");
    expect(secretarySkillsNote({ skills: ["yt-dlp"], isDefault: false }, library)).toBe("");
  });
});

describe("秘书的系统提示里 skill 说明有多长", () => {
  test("写出一共多少字、多少 KB；超过 8 KB 提醒一句，没超过不提醒；一个都没有时照说", () => {
    expect(secretaryPromptSizeText({ promptChars: 900, promptBytes: 1536 })).toEqual({ text: "这些 skill 的说明在系统提示里一共约 900 字（1.5 KB），每轮对话都带上", warn: undefined });
    expect(secretaryPromptSizeText({ promptChars: 6000, promptBytes: 9 * 1024 }).warn).toBe("超过 8 KB 了：每轮都多花 token、挤占上下文，用不上的可以去掉（整套的集合可以点开只留几个）");
    expect(secretaryPromptSizeText({ promptChars: 0, promptBytes: 0 })).toEqual({ text: "系统提示里没有 skill 说明", warn: undefined });
  });
});
