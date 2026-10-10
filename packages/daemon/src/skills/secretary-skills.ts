// 秘书用的 skill（72 号票）：秘书也能用 skill 库里的 skill（之前只有执行中的维护者和项目维护者的对话段才有）。
// - 名单存在数据目录配置区的 secretary-skills.json（随数据目录备份，不进仓库），是真相；只由运行时写（设置里的 skill 库页，
//   POST HTTP_PATHS.secretarySkills）；配置区是受保护区域，agent 用任何方式都写不进（03 号票），所以秘书不能自己给自己加 skill。
// - 没有这个文件时按默认的（DEFAULT_SECRETARY_SKILLS：agent-browser、yt-dlp，用户 2026-10-10 定）；默认的这两个库里还没有的
//   不装也不记日志（导入之后下一次装配自动装上）——在设置里改过名单也一样：名单里留着的默认项可以先于导入（只有它们可以），
//   别的只能选库里有的。文件读不了、写错了时按默认的装，设置页上显示问题。
// - 每次装配秘书时现读（下一次装配生效）；在设置里改了之后叫 onChange 登记的函数（秘书据此做完手头这一条就按新名单重新装配）。
// - 设置页要看这些 skill 在秘书的系统提示里占多少（整套选 pstack 这类集合时很长）：view() 带上名字、说明、位置一共多少字、
//   多少字节（照 pi 列 skill 的写法估），超过 SECRETARY_SKILL_PROMPT_WARN_BYTES 时页面上提醒一句。
import fs from "node:fs";
import path from "node:path";
import { ASSISTANT_NAME_MARK, DEFAULT_SECRETARY_SKILLS, schemaChecker, type SecretarySkillsFile as SecretarySkillsFileShape, SecretarySkillsFile, type SecretarySkillsView } from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import type { LibrarySkill, SkillLibrary } from "./library.ts";

const fileShape = schemaChecker(SecretarySkillsFile);

export interface SecretarySkills {
  /** 现在的名单（现读文件） */
  view(): SecretarySkillsView;
  /** 改名单：只能选 skill 库里有的（默认的两个可以先于导入留着；别的不在库里的抛 RequestRejected），去重后写文件；有变化时叫 onChange 登记的函数 */
  set(skills: readonly string[]): SecretarySkillsView;
  /** 装配秘书时交给子进程的 skill 目录（库里没有的跳过） */
  paths(): string[];
  /** 名单在设置里改了时叫 fn；返回取消登记的函数 */
  onChange(fn: () => void): () => void;
}

/** 设置页上显示的问题：提到秘书写名字占位，前端按用户起的名字显示（43 号票） */
function problemText(reason: string): string {
  return `${ASSISTANT_NAME_MARK}用的 skill 的设置文件${reason}；先按默认的装`;
}

/** 设置文件里的名单（还没算提示长度） */
type SecretarySkillsList = Omit<SecretarySkillsView, "promptChars" | "promptBytes">;

/** 默认的名单（设置文件不对时带上问题） */
function defaults(problem?: string): SecretarySkillsList {
  return { skills: [...DEFAULT_SECRETARY_SKILLS], isDefault: true, ...(problem ? { problem } : {}) };
}

/** 这些 skill 在系统提示里的说明一共多长：照 pi 列 skill 的写法（名字、说明、SKILL.md 的位置各一行）估 */
export function skillPromptSize(skills: readonly LibrarySkill[]): { promptChars: number; promptBytes: number } {
  const text = skills
    .flatMap((s) => ["  <skill>", `    <name>${s.entry.name}</name>`, `    <description>${s.entry.description}</description>`, `    <location>${path.join(s.dir, "SKILL.md")}</location>`, "  </skill>"])
    .map((line) => `${line}\n`)
    .join("");
  return { promptChars: [...text].length, promptBytes: Buffer.byteLength(text, "utf8") };
}

export interface SecretarySkillsOptions {
  /** 数据目录配置区的 secretary-skills.json */
  file: string;
  library: Pick<SkillLibrary, "missing" | "find" | "pathsOf">;
  log: (line: string) => void;
}

export function createSecretarySkills(options: SecretarySkillsOptions): SecretarySkills {
  const { file, library, log } = options;
  const listeners = new Set<() => void>();

  const readList = (): SecretarySkillsList => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaults();
      const reason = `读不了（${file}）：${err instanceof Error ? err.message : String(err)}`;
      log(`秘书用的 skill 的设置文件${reason}；先按默认的装`);
      return defaults(problemText(reason));
    }
    if (fileShape.check(parsed)) return { skills: [...new Set(parsed.skills)], isDefault: false };
    const reason = `不对（${file}）：${fileShape.firstError(parsed)}`;
    log(`秘书用的 skill 的设置文件${reason}；先按默认的装`);
    return defaults(problemText(reason));
  };
  const withSize = (list: SecretarySkillsList): SecretarySkillsView => ({ ...list, ...skillPromptSize(library.find(list.skills)) });

  return {
    view: () => withSize(readList()),
    set(skills) {
      const wanted = [...new Set(skills.map((s) => s.trim()).filter(Boolean))];
      const missing = library.missing(wanted).filter((n) => !DEFAULT_SECRETARY_SKILLS.includes(n));
      if (missing.length > 0) throw new RequestRejected("bad_params", `skill 库里没有 ${missing.join("、")}（先在 skill 库页导入）`);
      const before = readList();
      writeJsonAtomic(file, { format: 1, skills: wanted } satisfies SecretarySkillsFileShape);
      // 名单没变（包括从默认改成和默认一样的）就不用重新装配
      const same = before.skills.length === wanted.length && before.skills.every((s, i) => s === wanted[i]);
      if (!same) for (const fn of listeners) fn();
      return withSize({ skills: wanted, isDefault: false });
    },
    paths() {
      const now = readList();
      // 默认的两个库里还没有的悄悄跳过（导入之后自动装上）；别的被删了的，pathsOf 记日志
      const missing = new Set(library.missing(now.skills).filter((n) => DEFAULT_SECRETARY_SKILLS.includes(n)));
      return library.pathsOf(now.skills.filter((s) => !missing.has(s)));
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
