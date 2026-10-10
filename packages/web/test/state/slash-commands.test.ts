// 输入框里打 / 弹出的候选（82 号票）：什么时候弹、边打边过滤、选中插入什么、一行上显示什么、方向键怎么挪。
import { describe, expect, it } from "vitest";
import { filterSlashCommands, nextSlashIndex, type SlashCommandEntry, slashInsertText, slashQuery, slashShownName } from "../../src/state/index.ts";

const LIST: SlashCommandEntry[] = [
  { kind: "command", text: "/流程", name: "流程", description: "发起一个流程" },
  { kind: "command", text: "/任务", name: "任务", description: "发起一个长程任务" },
  { kind: "skill", text: "/agent-browser", name: "agent-browser", description: "浏览器自动化" },
  { kind: "skill", text: "/mp-tdd", name: "mp-tdd", description: "测试驱动", collection: "mp" },
  { kind: "skill", text: "/poteto-mode", name: "Poteto Mode", description: "入口", collection: "pstack" },
  { kind: "skill", text: "/pstack:tdd", name: "tdd", description: "pstack 的 tdd", collection: "pstack" },
  { kind: "skill", text: "/skill:流程", name: "流程", description: "和命令同名的 skill" },
];

const texts = (list: readonly SlashCommandEntry[]) => list.map((e) => e.text);

describe("斜杠命令的候选", () => {
  it("文字以 / 开头、还没打空白时弹（给出 / 后面打的那段）；打了空白、不在开头的不弹", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mp")).toBe("mp");
    expect(slashQuery("/skill:流")).toBe("skill:流");
    for (const text of ["", "mp", " /mp", "/mp-tdd ", "/mp-tdd 帮我写", "/Poteto Mode", "/a\nb"]) expect(slashQuery(text)).toBeUndefined();
  });

  it("边打边过滤（不分大小写）：写法以打的字开头的在前，其次写法、显示的名字里含有的，再次集合名里含有的；同档照原来的先后；什么都没打全列", () => {
    expect(texts(filterSlashCommands(LIST, ""))).toEqual(texts(LIST));
    expect(texts(filterSlashCommands(LIST, "流"))).toEqual(["/流程", "/skill:流程"]);
    // tdd：写法以它开头的没有；写法里含有的按原来的先后
    expect(texts(filterSlashCommands(LIST, "TDD"))).toEqual(["/mp-tdd", "/pstack:tdd"]);
    // poteto：写法开头；pstack：写法开头的在前，只有集合名对得上的在后
    expect(texts(filterSlashCommands(LIST, "pot"))).toEqual(["/poteto-mode"]);
    expect(texts(filterSlashCommands(LIST, "pstack"))).toEqual(["/pstack:tdd", "/poteto-mode"]);
    // 显示的名字里含有的也算（"Mode"）
    expect(texts(filterSlashCommands(LIST, "mode"))).toEqual(["/poteto-mode"]);
    expect(texts(filterSlashCommands(LIST, "skill:"))).toEqual(["/skill:流程"]);
    expect(filterSlashCommands(LIST, "nope")).toEqual([]);
  });

  it("选中插入写法加一个空格；显示的名字和写法最后一截一样时不重复；方向键到头接着从另一头来", () => {
    expect(slashInsertText(LIST[4]!)).toBe("/poteto-mode ");
    expect(slashInsertText(LIST[6]!)).toBe("/skill:流程 ");
    expect(LIST.map(slashShownName)).toEqual([undefined, undefined, undefined, undefined, "Poteto Mode", undefined, undefined]);
    expect(nextSlashIndex(0, 1, 3)).toBe(1);
    expect(nextSlashIndex(2, 1, 3)).toBe(0);
    expect(nextSlashIndex(0, -1, 3)).toBe(2);
    expect(nextSlashIndex(0, 1, 0)).toBe(0);
  });
});
