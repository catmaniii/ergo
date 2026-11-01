// 工具包里的 skill 复制进运行时自己的目录（Claude Code 拼本地插件、Codex 的额外 skill 目录共用）：不改原件，不写外部程序的配置目录。
// - 复制，不硬链接：外部程序改了这里的文件也改不到 skill 库的原件。依赖目录（skill 库里的 node_modules、.venv、venv 是指向来源的目录联接，
//   skills/library.ts）照样建一个联接指到同一个地方，不复制；别的链接不跟（skill 库导入时已经拒绝了）；
// - 目录名：skill 目录自己的名字（skill 库导入时已规范成小写、不带空格）；两个 skill 的目录名相同时，后面的加 -2、-3……（按工具包的先后）；
// - 每个 skill 记一个指纹（来源目录、各文件的相对路径、大小、修改时间）：没变的不重复复制，变了的整个重拷，不在工具包里的删掉。
// @i18n-ignore-file log：日志
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 工具包里的 skill 复制后的目录名（和 skillDirs 一一对应、同样的先后）：目录自己的名字，重名的后面加 -2、-3…… */
export function skillDirNames(skillDirs: readonly string[]): string[] {
  const used = new Set<string>();
  return skillDirs.map((dir) => {
    const base = safeName(path.basename(dir));
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
}

/** 目录名里不能放的字符换成 -（skill 库的目录名本来就是规范的，这里只防手放进 skill 区的） */
function safeName(name: string): string {
  const cleaned = name.replace(/[\s<>:"/\\|?*]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "skill" : cleaned;
}

interface Stamp {
  name: string;
  source: string;
  print: string;
}

/** 记各 skill 指纹的文件的名字（默认放在 skills 目录旁边） */
const STAMPS = "ergo-skills.json";

/**
 * 同步一个放 skill 的目录（skillsDir/<目录名>/…）：没变的不动；变了的、新加的整个重拷；不在工具包里的删掉。读不了的 skill（目录没了）跳过、记日志。
 * stampsFile 不给放在 skillsDir 旁边。返回各 skill 的目录名，和 changed：和原来比有增减或内容变了
 */
export function syncSkillDirs(skillsDir: string, skillDirs: readonly string[], log: (line: string) => void = () => {}, stampsFile: string = path.join(path.dirname(skillsDir), STAMPS)): { names: string[]; changed: boolean } {
  fs.mkdirSync(skillsDir, { recursive: true });
  const before = readStamps(stampsFile);
  const names = skillDirNames(skillDirs);
  const stamps: Stamp[] = [];
  let changed = false;
  skillDirs.forEach((source, i) => {
    const name = names[i]!;
    let print: string;
    try {
      print = fingerprint(source);
    } catch (err) {
      log(`工具包里的 skill 读不了，没放进去：${source}（${err instanceof Error ? err.message : String(err)}）`);
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
  fs.writeFileSync(stampsFile, `${JSON.stringify(stamps, null, 2)}\n`);
  return { names: stamps.map((s) => s.name), changed };
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
