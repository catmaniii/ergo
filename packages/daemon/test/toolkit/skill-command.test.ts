// 斜杠命令里的 skill（72 号票起 /skill:名字，82 号票改成 /目录名）：守护进程在加时间标记之前展开成 skill 的全文，写法照 pi 的 /skill: 展开。
// - 命令名就是目录名（"Fancy Mode" 的是 /fancy-mode），/ 后面到第一个空白就是命令名，不做最长匹配；
// - 二狗自己的命令（/流程、/任务）优先，只在命令存在的会话里（秘书、项目）：同名的 skill 在那里写 /skill:目录名，任务的会话里直接展开；
//   不认识的、不在开头的原样交过去；
// - 几个 skill 目录名相同时集合里的写成"集合名:目录名"，两个都不在集合里的先扫到的留着、另一个没有命令并说明；
// - 目录名的规范写法：转小写，空格和别的不合适的字符换成 -，连续的 - 合成一个。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNormalSkillDirName, type LibrarySkill, normalizeSkillDirName } from "../../src/skills/library.ts";
import { expandSkillCommand, skillCommands, skillCommandsOfDirs, skillDirProblems } from "../../src/skills/skill-command.ts";
import { ergouCommandsIn } from "../../src/slash-commands/commands.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function skill(root: string, dirName: string, content: string): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return dir;
}

/** 秘书的会话里有的二狗自己的命令（/流程、/任务） */
const SECRETARY = ergouCommandsIn("secretary");

/** 库里的一个 skill（只算命令，不用真的文件） */
const lib = (dir: string, name: string, extra: Partial<LibrarySkill["entry"]> = {}): LibrarySkill => ({ entry: { name, description: `${name} 的说明`, origin: "imported", ...extra }, dir });

describe("/目录名 的展开", () => {
  it("照 pi 的写法：skill 的位置、相对路径按哪个目录解析、去掉 frontmatter 的正文，后面跟用户写的其余的话；/skill:目录名 一样", () => {
    const root = makeTempDir("ergou-skills-");
    const alpha = skill(root, "alpha", "---\nname: alpha\ndescription: 第一个\n---\n\n# Alpha\n\n照着做。\n");
    const commands = skillCommandsOfDirs([alpha]);
    const block = `<skill name="alpha" location="${path.join(alpha, "SKILL.md")}">\nReferences are relative to ${alpha}.\n\n# Alpha\n\n照着做。\n</skill>`;
    expect(expandSkillCommand("/alpha 帮我看看这个", commands, SECRETARY)).toBe(`${block}\n\n帮我看看这个`);
    expect(expandSkillCommand("/alpha", commands, SECRETARY)).toBe(block);
    expect(expandSkillCommand("/skill:alpha 帮我看看这个", commands, SECRETARY)).toBe(`${block}\n\n帮我看看这个`);
    // 命令名后面换行也算分开
    expect(expandSkillCommand("/alpha\n第二行", commands, SECRETARY)).toBe(`${block}\n\n第二行`);
  });

  it("命令名是目录名：名字带空格的写目录名才展开，显示的名字照原样；不做最长匹配；不认识的、没写完的、不在开头的原样", () => {
    const root = makeTempDir("ergou-skills-");
    const fancy = skill(root, "fancy-mode", "---\nname: Fancy Mode\ndescription: 入口\n---\n入口的正文\n");
    const fancyPlus = skill(root, "fancy-mode-plus", "---\nname: Fancy Mode Plus\ndescription: 加强版\n---\n加强版的正文\n");
    const commands = skillCommandsOfDirs([fancy, fancyPlus]);
    expect(commands.map((c) => [c.command, c.name])).toEqual([
      ["fancy-mode", "Fancy Mode"],
      ["fancy-mode-plus", "Fancy Mode Plus"],
    ]);
    expect(expandSkillCommand("/fancy-mode 开始", commands, SECRETARY)).toMatch(/^<skill name="Fancy Mode"[\s\S]*入口的正文\n<\/skill>\n\n开始$/);
    expect(expandSkillCommand("/fancy-mode-plus", commands, SECRETARY)).toContain("加强版的正文");
    expect(expandSkillCommand("/skill:fancy-mode 开始", commands, SECRETARY)).toContain('<skill name="Fancy Mode"');
    // 带空格的名字不认了（不做最长匹配，/ 后面到第一个空白就是命令名）
    for (const text of ["/Fancy Mode 开始", "/skill:Fancy Mode 开始", "/fancy", "/fancy-modes", "/nope 开始", "请用 /fancy-mode", " /fancy-mode", "/", "/skill:"]) {
      expect(expandSkillCommand(text, commands, SECRETARY)).toBe(text);
    }
    expect(expandSkillCommand("/fancy-mode", [], SECRETARY)).toBe("/fancy-mode");
  });

  it("二狗自己的命令优先，只在命令存在的会话里：秘书、项目的会话里和 /流程、/任务 撞上（或者被认成命令）的不展开、写 /skill:目录名 才展开；任务的会话里直接展开", () => {
    const root = makeTempDir("ergou-skills-");
    const flow = skill(root, "流程", "---\nname: 流程\ndescription: 同名的 skill\n---\n同名 skill 的正文\n");
    const flowHelper = skill(root, "流程-助手", "---\nname: 流程助手\ndescription: 命令后面跟着标点\n---\n助手的正文\n");
    const report = skill(root, "流程图", "---\nname: 流程图\ndescription: 命令后面跟着字，不是命令\n---\n流程图的正文\n");
    const commands = skillCommandsOfDirs([flow, flowHelper, report]);
    for (const kind of ["secretary", "project"] as const) {
      const ergou = ergouCommandsIn(kind);
      expect(expandSkillCommand("/流程 把下载目录整理好", commands, ergou)).toBe("/流程 把下载目录整理好");
      expect(expandSkillCommand("/任务", commands, ergou)).toBe("/任务");
      expect(expandSkillCommand("/skill:流程 把下载目录整理好", commands, ergou)).toMatch(/同名 skill 的正文\n<\/skill>\n\n把下载目录整理好$/);
      // "/流程-助手"：发起任务的判定按"命令后面是标点"认成 /流程，skill 跟着让路
      expect(expandSkillCommand("/流程-助手 看看", commands, ergou)).toBe("/流程-助手 看看");
      expect(expandSkillCommand("/skill:流程-助手 看看", commands, ergou)).toContain("助手的正文");
      // "/流程图" 不是命令
      expect(expandSkillCommand("/流程图 画一个", commands, ergou)).toContain("流程图的正文");
    }
    // 任务的会话里没有 /流程、/任务：同名的 skill 直接展开，/skill:目录名 也照样能用
    const task = ergouCommandsIn("task");
    expect(task).toEqual([]);
    expect(expandSkillCommand("/流程 把下载目录整理好", commands, task)).toMatch(/同名 skill 的正文\n<\/skill>\n\n把下载目录整理好$/);
    expect(expandSkillCommand("/流程-助手 看看", commands, task)).toContain("助手的正文");
    expect(expandSkillCommand("/skill:流程 一", commands, task)).toContain("同名 skill 的正文");
    expect(expandSkillCommand("/任务", commands, task)).toBe("/任务");
  });
});

describe("每个 skill 的斜杠命令（按整个库算）", () => {
  it("目录名就是命令名；目录名相同时集合里的写成 集合名:目录名，单个导入的留着 /目录名；两个都在集合里就都写集合名", () => {
    const commands = skillCommands([
      lib("/b/example-checklist", "example-checklist", { origin: "framework" }),
      lib("/u/poteto-mode", "Poteto Mode"),
      lib("/u/tdd", "tdd"),
      lib("/u/pstack/skills/tdd", "pstack 的 tdd", { collection: "pstack" }),
      lib("/u/pstack/skills/review", "review", { collection: "pstack" }),
      lib("/u/other/review", "另一个 review", { collection: "other" }),
    ]);
    expect(commands.map((c) => [c.command, c.name, c.collection])).toEqual([
      ["example-checklist", "example-checklist", undefined],
      ["poteto-mode", "Poteto Mode", undefined],
      ["tdd", "tdd", undefined],
      ["pstack:tdd", "pstack 的 tdd", "pstack"],
      ["pstack:review", "review", "pstack"],
      ["other:review", "另一个 review", "other"],
    ]);
  });

  it("目录名的问题：不是小写、不带空格的写法的提示（不自动改）；带空白的没有命令；两个不在集合里的同目录名，先扫到的留着、另一个没有命令", () => {
    const skills = [
      lib("/b/shared", "框架的", { origin: "framework" }),
      lib("/u/shared", "手放的"),
      lib("/u/Upper Case", "Upper Case"),
      lib("/u/CamelDir", "camel"),
    ];
    expect(skillCommands(skills).map((c) => [c.command, c.name])).toEqual([
      ["shared", "框架的"],
      ["CamelDir", "camel"],
    ]);
    const problems = skillDirProblems(skills);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("你导入的 Upper Case 的目录名「Upper Case」不是小写、不带空格的写法（斜杠命令就是目录名，带空白的打不出来，现在没有斜杠命令）");
    expect(problems[0]).toContain("改名成 upper-case，二狗不自动改");
    expect(problems[1]).toContain("「CamelDir」不是小写、不带空格的写法（斜杠命令就是目录名，现在要打 /CamelDir）");
    expect(problems[2]).toBe("框架自带的 框架的、你导入的 手放的 的目录名都是 shared：/shared 认框架自带的 框架的，别的没有斜杠命令（把目录改个名）");
    // 集合里的同目录名不算问题（写集合名区分）
    expect(skillDirProblems([lib("/u/tdd", "tdd"), lib("/u/pstack/skills/tdd", "t", { collection: "pstack" })])).toEqual([]);
  });

  it("目录名的规范写法：转小写，空格和别的不合适的字符换成 -，连续的 - 合成一个，去掉两头的 -；中文照留", () => {
    expect(normalizeSkillDirName("Poteto Mode")).toBe("poteto-mode");
    expect(normalizeSkillDirName("Make Bot UI")).toBe("make-bot-ui");
    expect(normalizeSkillDirName("yt_dlp.v2")).toBe("yt-dlp-v2");
    expect(normalizeSkillDirName("  --A   b--  ")).toBe("a-b");
    expect(normalizeSkillDirName("代码 审查")).toBe("代码-审查");
    expect(normalizeSkillDirName("!!!")).toBe("");
    expect(isNormalSkillDirName("mp-tdd")).toBe(true);
    for (const bad of ["Mp-tdd", "a b", "a--b", "-a", "a_b", ""]) expect(isNormalSkillDirName(bad)).toBe(false);
  });
});
