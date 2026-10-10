// 用户在输入框里打 `/skill:名字`（72 号票，主会话 2026-10-10 定）：和 pi 的 `/skill:` 一样展开成那个 skill 的全文。
// pi 只在用户消息以 `/skill:` 开头时展开，而二狗交给 pi 的每条用户消息第一行是本地时间标记，pi 那边永远展不开；
// 所以守护进程在投影（加时间标记）之前自己展开，写法照 pi 的 `_expandSkillCommand`：
//   <skill name="名字" location="SKILL.md 的位置">\nReferences are relative to skill 目录.\n\n正文\n</skill>，后面跟用户写的其余的话。
// 名字照 SKILL.md 原样（可以带空格，"Poteto Mode"），按最长的名字匹配；写目录名（/skill:poteto-mode）也认。
// 只认这个会话装配了的 skill（宿主协议 skillPaths 里的目录）；不认识的名字原样交过去。
import fs from "node:fs";
import path from "node:path";
import { frontmatter, skillBody } from "./library.ts";

export const SKILL_COMMAND_PREFIX = "/skill:";

/** 文字以 /skill:名字 开头、名字是这个会话装配了的 skill 时，换成 skill 的全文（后面跟其余的话）；否则原样 */
export function expandSkillCommand(text: string, skillDirs: readonly string[]): string {
  if (!text.startsWith(SKILL_COMMAND_PREFIX) || skillDirs.length === 0) return text;
  const rest = text.slice(SKILL_COMMAND_PREFIX.length);
  const skills = skillDirs.flatMap((dir) => {
    const file = path.join(dir, "SKILL.md");
    try {
      const content = fs.readFileSync(file, "utf8");
      return [{ name: frontmatter(content)?.name ?? path.basename(dir), dirName: path.basename(dir), dir, file, content }];
    } catch {
      return [];
    }
  });
  // 名字后面要么结束，要么是空白（后面是用户的话）
  const matches = (key: string) => rest === key || (rest.startsWith(key) && /\s/.test(rest.charAt(key.length)));
  const byName = skills.filter((s) => matches(s.name)).toSorted((a, b) => b.name.length - a.name.length)[0];
  const hit = byName ?? skills.filter((s) => matches(s.dirName)).toSorted((a, b) => b.dirName.length - a.dirName.length)[0];
  if (!hit) return text;
  const key = byName ? hit.name : hit.dirName;
  const args = rest.slice(key.length).trim();
  const block = `<skill name="${hit.name}" location="${hit.file}">\nReferences are relative to ${hit.dir}.\n\n${skillBody(hit.content)}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}
