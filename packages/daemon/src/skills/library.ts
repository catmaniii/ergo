// skill 库（规格第 20 节，27 号票）：二狗自己的一批 skill，会话只从这里按工具包挑。
// - 框架自带的：程序目录 packages/daemon/skills/ 下（第一阶段只有示例）；
// - 用户自己加的：数据目录的 skill 区（个人数据，随数据目录备份）。用户在设置里的 skill 库页显式导入一份（复制进 skill 区）；
//   intent-mining、reasoning-graph 这类现成的 skill 要用就这样导入。不自动读取 ~/.claude/skills、~/.pi。
// 每个 skill 是一个含 SKILL.md 的目录，名字和说明取 SKILL.md 开头的 frontmatter（name、description；没写 name 的取目录名）。
// 名字在库里唯一：导入同名的被拒（框架自带的和导入的也不能同名）。
// 装配会话时按工具包里的名字解析出目录（pathsOf），经宿主协议的 skillPaths 交给子进程（pi 的 additionalSkillPaths，noSkills）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillEntry } from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import { isWithin } from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";

/** 框架自带的 skill 所在的目录 */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

/** skill 名的写法（同 pi 和 Agent Skills 的约定）：小写字母、数字和短横线，最长 64 */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** SKILL.md 最大多少字节（只读开头的 frontmatter，太大的不认） */
const SKILL_FILE_MAX = 512 * 1024;
/** 导入时整个目录最多多少字节、多少个文件（skill 是说明书，不该很大） */
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const IMPORT_MAX_FILES = 2000;

export interface SkillLibraryOptions {
  /** 框架自带的 skill 所在的目录（测试可以换） */
  builtinDir: string;
  /** 数据目录的 skill 区（用户导入的） */
  userDir: string;
  /** 数据目录（导入的来源不能在它里面：已经在库里的不用再导入，别的区也不该被拷进 skill 区） */
  dataDir: string;
  log: (line: string) => void;
}

export interface SkillLibrary {
  /** 库里的全部 skill（框架自带的在前），按名字排 */
  list(): SkillEntry[];
  has(name: string): boolean;
  /** 名字 → skill 目录；库里没有的不在结果里 */
  pathsOf(names: readonly string[]): string[];
  /** 把一个含 SKILL.md 的目录复制一份进 skill 区；不合规矩的抛 RequestRejected（bad_params / conflict / not_allowed） */
  importFrom(source: string): SkillEntry;
}

interface Found {
  entry: SkillEntry;
  dir: string;
}

export function createSkillLibrary(options: SkillLibraryOptions): SkillLibrary {
  const scan = (): Found[] => {
    const builtin = scanDir(options.builtinDir, "framework", options.log);
    const imported = scanDir(options.userDir, "imported", options.log).filter((f) => {
      if (!builtin.some((b) => b.entry.name === f.entry.name)) return true;
      options.log(`skill 区里的 ${f.dir} 和框架自带的 skill 同名（${f.entry.name}），不用它`);
      return false;
    });
    return [...builtin.toSorted(byName), ...imported.toSorted(byName)];
  };

  return {
    list: () => scan().map((f) => f.entry),
    has: (name) => scan().some((f) => f.entry.name === name),
    pathsOf(names) {
      const found = scan();
      return names.flatMap((name) => {
        const hit = found.find((f) => f.entry.name === name);
        if (!hit) options.log(`工具包里的 skill ${name} 不在 skill 库里（可能被删了），这次装配不带它`);
        return hit ? [hit.dir] : [];
      });
    },
    importFrom(source) {
      if (!path.isAbsolute(source)) throw new RequestRejected("bad_params", `要写 skill 目录的绝对路径：${source}`);
      const dir = path.resolve(source);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dir);
      } catch {
        throw new RequestRejected("not_found", `找不到这个目录：${dir}`);
      }
      if (!stat.isDirectory()) throw new RequestRejected("bad_params", `不是目录：${dir}（选含 SKILL.md 的那个文件夹）`);
      if (isWithin(realPathOf(dir) ?? dir, realPathOf(options.dataDir) ?? options.dataDir)) throw new RequestRejected("not_allowed", `这个目录在二狗的数据目录里，不能当来源导入：${dir}`);
      const read = readSkill(dir);
      if ("problem" in read) throw new RequestRejected("bad_params", read.problem);
      const { name, description } = read;
      if (scan().some((f) => f.entry.name === name)) throw new RequestRejected("conflict", `skill 库里已经有叫 ${name} 的 skill 了`);
      const size = measure(dir);
      if (size.files > IMPORT_MAX_FILES || size.bytes > IMPORT_MAX_BYTES) {
        throw new RequestRejected("bad_params", `这个目录太大了（${size.files} 个文件、${Math.round(size.bytes / 1024)} KB），skill 是说明书，不该这么大`);
      }
      fs.mkdirSync(options.userDir, { recursive: true });
      // 先复制到旁边的临时目录，复制完整了再改名就位：中途出错不留半个 skill
      const target = path.join(options.userDir, name);
      const staging = path.join(options.userDir, `.importing-${name}-${process.pid}-${Date.now()}`);
      try {
        // 符号链接不跟进去、也不复制（免得把 skill 目录之外的东西带进来）
        fs.cpSync(dir, staging, { recursive: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
        fs.renameSync(staging, target);
      } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new RequestRejected("internal", `复制 skill 出错：${err instanceof Error ? err.message : String(err)}`);
      }
      options.log(`导入了 skill ${name}（来自 ${dir}）`);
      return { name, description, origin: "imported" };
    },
  };
}

const byName = (a: Found, b: Found) => a.entry.name.localeCompare(b.entry.name);

/** 一个目录下面一层的各个 skill 目录（含 SKILL.md 的） */
function scanDir(root: string, origin: SkillEntry["origin"], log: (line: string) => void): Found[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    // 目录还没有（还没导入过）
    return [];
  }
  return names.flatMap((name) => {
    // 导入到一半留下的临时目录、隐藏目录不算
    if (name.startsWith(".")) return [];
    const dir = path.join(root, name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) return [];
    const read = readSkill(dir);
    if ("problem" in read) {
      log(`skill 目录 ${dir} 不认：${read.problem}`);
      return [];
    }
    return [{ entry: { name: read.name, description: read.description, origin }, dir }];
  });
}

/** 读一个 skill 目录的 SKILL.md：名字和说明 */
function readSkill(dir: string): { name: string; description: string } | { problem: string } {
  const file = path.join(dir, "SKILL.md");
  let text: string;
  try {
    if (fs.statSync(file).size > SKILL_FILE_MAX) return { problem: `SKILL.md 太大了（超过 ${SKILL_FILE_MAX / 1024} KB）` };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { problem: `目录里没有 SKILL.md：${dir}` };
  }
  const front = frontmatter(text);
  if (!front) return { problem: "SKILL.md 开头没有 frontmatter（--- 包起来的 name、description）" };
  const name = front.name ?? path.basename(dir);
  if (!SKILL_NAME.test(name)) return { problem: `skill 名 ${name} 不合规矩：只能用小写字母、数字和短横线，最长 64 个字符` };
  const description = front.description?.trim();
  if (!description) return { problem: "SKILL.md 的 frontmatter 里没有 description（说明什么时候用它）" };
  return { name, description };
}

/**
 * SKILL.md 开头的 frontmatter 里的 name、description（YAML 的一小部分：单行的值，可以带引号；
 * 说明写成多行的 `>`、`|` 块也认）
 */
export function frontmatter(text: string): { name?: string; description?: string } | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined;
  const out: { name?: string; description?: string } = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body[i]!);
    if (!m) continue;
    const key = m[1]!;
    if (key !== "name" && key !== "description") continue;
    let value = m[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]!) || body[i + 1]!.trim() === "")) block.push(body[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 目录里一共多少个文件、多少字节（不跟符号链接） */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (files > IMPORT_MAX_FILES || bytes > IMPORT_MAX_BYTES) return;
      const p = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
