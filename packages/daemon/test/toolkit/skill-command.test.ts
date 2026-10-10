// 用户打的 /skill:名字（72 号票）：守护进程在加时间标记之前展开成 skill 的全文，写法照 pi 的 /skill: 展开。
// 名字照 SKILL.md 原样（可以带空格），按最长的匹配；写目录名也认；不认识的、不在开头的原样交过去。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandSkillCommand } from "../../src/skills/skill-command.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function skill(root: string, dirName: string, content: string): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return dir;
}

describe("/skill:名字 的展开", () => {
  it("照 pi 的写法：skill 的位置、相对路径按哪个目录解析、去掉 frontmatter 的正文，后面跟用户写的其余的话", () => {
    const root = makeTempDir("ergou-skills-");
    const alpha = skill(root, "alpha", "---\nname: alpha\ndescription: 第一个\n---\n\n# Alpha\n\n照着做。\n");
    expect(expandSkillCommand("/skill:alpha 帮我看看这个", [alpha])).toBe(
      `<skill name="alpha" location="${path.join(alpha, "SKILL.md")}">\nReferences are relative to ${alpha}.\n\n# Alpha\n\n照着做。\n</skill>\n\n帮我看看这个`,
    );
    expect(expandSkillCommand("/skill:alpha", [alpha])).toBe(`<skill name="alpha" location="${path.join(alpha, "SKILL.md")}">\nReferences are relative to ${alpha}.\n\n# Alpha\n\n照着做。\n</skill>`);
  });

  it("名字带空格的按最长的匹配；写目录名也认；不认识的、名字没写完的、不在开头的原样", () => {
    const root = makeTempDir("ergou-skills-");
    const fancy = skill(root, "fancy-mode", "---\nname: Fancy Mode\ndescription: 入口\n---\n入口的正文\n");
    const fancyPlus = skill(root, "fancy-mode-plus", "---\nname: Fancy Mode Plus\ndescription: 加强版\n---\n加强版的正文\n");
    const dirs = [fancy, fancyPlus];
    expect(expandSkillCommand("/skill:Fancy Mode 开始", dirs)).toContain('<skill name="Fancy Mode"');
    expect(expandSkillCommand("/skill:Fancy Mode 开始", dirs)).toMatch(/入口的正文\n<\/skill>\n\n开始$/);
    expect(expandSkillCommand("/skill:Fancy Mode Plus", dirs)).toContain("加强版的正文");
    expect(expandSkillCommand("/skill:fancy-mode 开始", dirs)).toContain('<skill name="Fancy Mode"');
    for (const text of ["/skill:nope 开始", "/skill:Fancy", "请用 /skill:Fancy Mode", "/skill:Fancy Modes"]) expect(expandSkillCommand(text, dirs)).toBe(text);
    expect(expandSkillCommand("/skill:Fancy Mode", [])).toBe("/skill:Fancy Mode");
  });
});
