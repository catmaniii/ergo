// 斜杠命令里的 skill（72 号票起 /skill:名字，82 号票改成直接 /目录名，用户 2026-10-10 定）。
// - **命令名就是 skill 的目录名**（/poteto-mode、/mp-tdd、pstack 的 /tdd），不论 SKILL.md 里的名字带不带空格；
//   显示的名字照 SKILL.md 原样（"Poteto Mode"）。目录名导入时已经规范成小写、不带空格的写法（skills/library.ts）。
// - 不做最长匹配：/ 后面到第一个空白就是命令名，后面是用户的话。
// - 几个 skill 目录名相同（不同集合里，或者集合里的和单个导入的）：集合里的写成"集合名:目录名"（/pstack:tdd），
//   单个导入的、框架自带的留着 /目录名；两个都不在集合里（只有手放进 skill 区才会）时先扫到的那个（框架自带的在前）留着，
//   另一个没有斜杠命令，skillDirProblems 里说明。命令按整个库算，同一个 skill 在哪个会话里都是同一个命令。
// - 和二狗自己的命令（/流程、/任务，slash-commands/commands.ts）撞上时二狗的命令优先，这个 skill 写 /skill:目录名——
//   只在命令存在的会话里（秘书、项目的会话）；任务的会话里没有这两个命令，同名的 skill 直接 /目录名 就展开。
//   /skill:目录名 什么时候都能用（后备写法）。
// - 只认这个会话装配了的 skill（宿主协议 skillPaths 里的目录）；不认识的 /xxx 原样交过去，不报错。
// 展开的写法照 pi 的 `_expandSkillCommand`（pi 只在用户消息以 /skill: 开头时展开，而二狗交给 pi 的每条用户消息第一行是
// 本地时间标记，pi 那边永远展不开，所以守护进程在投影（加时间标记）之前自己展开，conversation/agent-input.ts）：
//   <skill name="显示的名字" location="SKILL.md 的位置">\nReferences are relative to skill 目录.\n\n正文\n</skill>，后面跟用户写的其余的话。
import fs from "node:fs";
import path from "node:path";
import { type ErgouCommand, ergouCommandAt } from "../slash-commands/commands.ts";
import { frontmatter, isNormalSkillDirName, type LibrarySkill, normalizeSkillDirName, skillBody } from "./library.ts";

/** 点 skill 的后备写法：/skill:目录名（和二狗自己的命令同名时用） */
export const SKILL_COMMAND_PREFIX = "/skill:";

/** 一个 skill 的斜杠命令 */
export interface SkillCommand {
  /** 命令名（不带 /）：目录名；几个 skill 目录名相同时集合里的写成"集合名:目录名" */
  command: string;
  /** 显示的名字（SKILL.md 里的 name，照原样） */
  name: string;
  description: string;
  /** 属于哪个集合 */
  collection?: string;
  /** skill 目录 */
  dir: string;
}

const hasSpace = (s: string) => /\s/.test(s);

/** 按目录名分组（先后照给的顺序） */
function byDirName(skills: readonly LibrarySkill[]): Map<string, LibrarySkill[]> {
  const groups = new Map<string, LibrarySkill[]>();
  for (const s of skills) {
    const dirName = path.basename(s.dir);
    groups.set(dirName, [...(groups.get(dirName) ?? []), s]);
  }
  return groups;
}

/** 库里每个 skill 的斜杠命令（按给的顺序：框架自带的在前）。目录名带空白的打不出来，没有斜杠命令 */
export function skillCommands(skills: readonly LibrarySkill[]): SkillCommand[] {
  const byDir = byDirName(skills);
  return skills.flatMap((s): SkillCommand[] => {
    const dirName = path.basename(s.dir);
    if (dirName === "" || hasSpace(dirName)) return [];
    const same = byDir.get(dirName) ?? [s];
    const command = same.length === 1 ? dirName : s.entry.collection ? `${s.entry.collection}:${dirName}` : same.find((o) => !o.entry.collection) === s ? dirName : undefined;
    if (command === undefined) return [];
    return [{ command, name: s.entry.name, description: s.entry.description, ...(s.entry.collection ? { collection: s.entry.collection } : {}), dir: s.dir }];
  });
}

/** 一个 skill 是谁的：说给人听的 */
function whose(s: LibrarySkill): string {
  if (s.entry.origin === "framework") return `框架自带的 ${s.entry.name}`;
  if (s.entry.collection) return `集合 ${s.entry.collection} 里的 ${s.entry.name}`;
  return `你导入的 ${s.entry.name}`;
}

/**
 * skill 目录名的问题（82 号票，启动时记日志、skill 库页上提示，二狗不自动改名）：
 * - 目录名不是小写、不带空格的写法（手放进 skill 区的、82 号票之前导入的）；
 * - 两个不在集合里的 skill 目录名相同（只有手放的才会）：/目录名 认先扫到的那个，另一个没有斜杠命令
 */
export function skillDirProblems(skills: readonly LibrarySkill[]): string[] {
  const problems: string[] = [];
  for (const s of skills) {
    const dirName = path.basename(s.dir);
    if (isNormalSkillDirName(dirName)) continue;
    const fixed = normalizeSkillDirName(dirName);
    const now = hasSpace(dirName) ? "带空白的打不出来，现在没有斜杠命令" : `现在要打 /${dirName}`;
    problems.push(`${whose(s)} 的目录名「${dirName}」不是小写、不带空格的写法（斜杠命令就是目录名，${now}）：${fixed ? `可以把目录（${s.dir}）改名成 ${fixed}` : "目录名里没有能用的字，把目录改个名"}，二狗不自动改`);
  }
  for (const [dirName, same] of byDirName(skills)) {
    const loose = same.filter((s) => !s.entry.collection);
    if (loose.length < 2) continue;
    problems.push(`${loose.map(whose).join("、")} 的目录名都是 ${dirName}：/${dirName} 认${whose(loose[0]!)}，别的没有斜杠命令（把目录改个名）`);
  }
  return problems;
}

/** 只有目录（没有 skill 库可查时）：读各自的 SKILL.md 当作库里的 skill，算出斜杠命令（这时没有集合） */
export function skillCommandsOfDirs(dirs: readonly string[]): SkillCommand[] {
  return skillCommands(
    dirs.flatMap((dir) => {
      try {
        const front = frontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
        return [{ entry: { name: front?.name ?? path.basename(dir), description: front?.description ?? "", origin: "imported" as const }, dir }];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * 文字以 /命令名 开头、命令名是这个会话装配了的 skill 时，换成 skill 的全文（后面跟其余的话）；否则原样。
 * skills 是这个会话的 skill 的斜杠命令（按整个库算出来的，见 skillCommands）；commands 是这个会话里有的二狗自己的命令
 * （slash-commands/commands.ts 的 ergouCommandsIn），打的字被认成它们时不展开
 */
export function expandSkillCommand(text: string, skills: readonly SkillCommand[], commands: readonly ErgouCommand[]): string {
  if (skills.length === 0) return text;
  // / 后面到第一个空白就是命令名（不做最长匹配）
  const token = /^\/(\S+)/.exec(text)?.[1];
  if (token === undefined) return text;
  const fallback = SKILL_COMMAND_PREFIX.slice(1);
  let key = token;
  if (token.startsWith(fallback)) key = token.slice(fallback.length);
  // 这个会话里有的二狗自己的命令优先（秘书、项目的会话里的 /流程、/任务）：同名的 skill 要写 /skill:目录名
  else if (ergouCommandAt(text, commands)) return text;
  const hit = skills.find((s) => s.command === key);
  if (!hit) return text;
  const file = path.join(hit.dir, "SKILL.md");
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return text;
  }
  const args = text.slice(1 + token.length).trim();
  const block = `<skill name="${hit.name}" location="${file}">\nReferences are relative to ${hit.dir}.\n\n${skillBody(content)}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}
