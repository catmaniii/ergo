// 工具包里的 skill 交给 Claude Code（291 号票；用户 2026-10-26 问"二狗的 skill 能不能自动配给单独的一个 Claude 进程去用"）：
// SDK 的 plugins 选项能加载本地插件目录（{ type: "local", path }，插件里可以带 skills）。适配子进程每次起 query 之前、工具包变了的时候，
// 按这个维护者的工具包（装配参数 skillPaths：skill 库里的目录）在它的运行时目录（装配参数 runtimeDir，数据目录缓存区下每个 agent 一格）里
// 拼一个本地插件：
//   <runtimeDir>/ergo/.claude-plugin/plugin.json   插件清单（名字 ergo）
//   <runtimeDir>/ergo/skills/<目录名>/...          skill 从 skill 库复制进来
// - 复制，不硬链接：Claude 改了插件里的文件也改不到 skill 库的原件。依赖目录（skill 库里的 node_modules、.venv、venv 是指向来源的目录联接，
//   skills/library.ts）照样建一个联接指到同一个地方，不复制；别的链接不跟（skill 库导入时已经拒绝了）；
// - 目录名：skill 目录自己的名字（skill 库导入时已规范成小写、不带空格）；工具包里两个 skill 的目录名相同时，后面的加 -2、-3……（按工具包的先后）。
//   Claude Code 里插件的 skill 带插件名：斜杠命令是 /ergo:<目录名>（SKILL.md 的 name 写了别的时以 Claude Code 报回的为准，见 Comments）；
// - 每个 skill 记一个指纹（来源目录、各文件的相对路径、大小、修改时间）：没变的不重复复制，变了的整个重拷，不在工具包里的删掉；
// - 二狗只写这个目录，不写用户的 ~/.claude、项目的 .claude/（用户自己的 skill 照常由 Claude Code 自己加载）。
// 守护进程这边也用 pluginSkillNames 算斜杠命令（runtime.ts 的 toolkitSkillCommands：输入框的 / 补全），和子进程拼目录用同一套名字。
// @i18n-ignore-file log：日志；插件清单里的说明是给 Claude Code 看的
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { oldNameOf } from "@ergo/protocol";

/** 插件名：Claude Code 里插件的 skill 写成 ergo:<目录名>，定了别改 */
export const ERGO_PLUGIN = "ergo";

/** 插件清单的位置（Claude Code 认的） */
const MANIFEST = path.join(".claude-plugin", "plugin.json");
/** 记各 skill 指纹的文件（插件根目录下，Claude Code 不看它） */
const STAMPS = "ergo-skills.json";

/** 工具包里的 skill 在插件里的目录名（和 skillDirs 一一对应、同样的先后）：目录自己的名字，重名的后面加 -2、-3…… */
export function pluginSkillNames(skillDirs: readonly string[]): string[] {
  const used = new Set<string>();
  return skillDirs.map((dir) => {
    const base = safeName(path.basename(dir));
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
}

/** Claude Code 里这个 skill 的斜杠命令（不带 /） */
export const pluginSkillCommand = (name: string): string => `${ERGO_PLUGIN}:${name}`;

/** 目录名里不能放的字符换成 -（skill 库的目录名本来就是规范的，这里只防手放进 skill 区的） */
function safeName(name: string): string {
  const cleaned = name.replace(/[\s<>:"/\\|?*]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "skill" : cleaned;
}

/** 拼好的插件：根目录（交给 query 的 plugins）、各 skill 的目录名，这次和上次比 skill 有没有变 */
export interface BuiltSkillPlugin {
  root: string;
  names: string[];
  changed: boolean;
}

interface Stamp {
  name: string;
  source: string;
  print: string;
}

/**
 * 拼（或更新）插件目录：插件根目录是 <runtimeDir>/ergo。skill 没变的不动；变了的、新加的整个重拷；不在工具包里的删掉。
 * 读不了的 skill（目录没了）跳过、记日志。返回 changed：和目录里原来的比，skill 有增减或内容变了。
 * 312 号票：插件名从旧的 ergou 换成 ergo，旧名字的插件目录（<runtimeDir>/ergou）是缓存，拼的时候顺手删掉
 */
export function buildSkillPlugin(runtimeDir: string, skillDirs: readonly string[], log: (line: string) => void = () => {}): BuiltSkillPlugin {
  const root = path.join(runtimeDir, ERGO_PLUGIN);
  removeTree(path.join(runtimeDir, oldNameOf(ERGO_PLUGIN)));
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const manifest = path.join(root, MANIFEST);
  const manifestText = `${JSON.stringify({ name: ERGO_PLUGIN, version: "1.0.0", description: "二狗交给这个会话的 skill（维护者工具包里的）" }, null, 2)}\n`;
  if (readText(manifest) !== manifestText) fs.writeFileSync(manifest, manifestText);

  const before = readStamps(path.join(root, STAMPS));
  const names = pluginSkillNames(skillDirs);
  const stamps: Stamp[] = [];
  let changed = false;
  skillDirs.forEach((source, i) => {
    const name = names[i]!;
    let print: string;
    try {
      print = fingerprint(source);
    } catch (err) {
      log(`工具包里的 skill 读不了，没放进插件：${source}（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }
    stamps.push({ name, source, print });
    const target = path.join(skillsDir, name);
    const old = before.find((s) => s.name === name);
    if (old && old.source === source && old.print === print && fs.existsSync(path.join(target, "SKILL.md"))) return;
    changed = true;
    removeTree(target);
    copySkill(source, target);
  });
  // 不在工具包里的（含上次没拼成留下的）删掉
  const wanted = new Set(stamps.map((s) => s.name));
  for (const entry of fs.readdirSync(skillsDir)) {
    if (wanted.has(entry)) continue;
    changed = true;
    removeTree(path.join(skillsDir, entry));
  }
  if (before.length !== stamps.length) changed = true;
  fs.writeFileSync(path.join(root, STAMPS), `${JSON.stringify(stamps, null, 2)}\n`);
  return { root, names: stamps.map((s) => s.name), changed };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readStamps(file: string): Stamp[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is Stamp => typeof s === "object" && s !== null && typeof (s as Stamp).name === "string") : [];
  } catch {
    return [];
  }
}

/** skill 目录的指纹：各文件的相对路径、大小、修改时间（链接记它指到哪） */
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const relPath = path.join(rel, entry.name);
      const st = fs.lstatSync(path.join(dir, relPath));
      if (st.isSymbolicLink()) hash.update(`L ${relPath} ${linkTarget(path.join(dir, relPath))}\n`);
      else if (st.isDirectory()) walk(relPath);
      else hash.update(`F ${relPath} ${st.size} ${st.mtimeMs}\n`);
    }
  };
  if (!fs.statSync(dir).isDirectory()) throw new Error("不是目录");
  walk("");
  return hash.digest("hex");
}

function linkTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return "";
  }
}

/** 复制一个 skill：文件照拷；目录链接（依赖目录的联接）建一个指到同一处的联接；指向文件的链接拷它指的内容；坏了的链接跳过 */
function copySkill(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) {
      const real = linkTarget(from);
      if (!real) continue;
      if (fs.statSync(real).isDirectory()) fs.symlinkSync(real, to, "junction");
      else fs.copyFileSync(real, to);
    } else if (st.isDirectory()) copySkill(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 删掉一个目录（或文件）：链接只删链接本身，不进去（依赖目录的联接指着 skill 库外面的东西） */
export function removeTree(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
  fs.rmdirSync(target);
}
