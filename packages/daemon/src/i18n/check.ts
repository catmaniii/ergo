// npm run i18n:check 查的（168 号票）：每种语言比中文缺哪些句、多哪些句、插值参数对不上的；自带的语言文件放对了区域没有；
// 读 ~/.ergo/locales 出的问题。写死中文的计数在 hardcoded.ts。命令行的样子在 check-cli.ts。
// @i18n-ignore-file log：检查工具的输出（给开发者看）
import { compareMessages, DEFAULT_LANGUAGE, type MessagesComparison, namespaceOf, WEB_NAMESPACES } from "@ergo/protocol";
import fs from "node:fs";
import path from "node:path";
import { buildCatalogs } from "./catalogs.ts";
import { type LocaleProblem, readLocaleRoot } from "./files.ts";

/** 一种语言查出来的 */
export interface LanguageCheck extends MessagesComparison {
  id: string;
  nativeName: string;
  source: string;
}

export interface LocalesCheck {
  /** 合上 ~/.ergo/locales 之后的每种语言（中文除外） */
  languages: LanguageCheck[];
  /** 只看自带的：自带的英文这类必须全有 */
  builtinLanguages: LanguageCheck[];
  /** ~/.ergo/locales 里的问题 */
  problems: LocaleProblem[];
  /** 自带的语言文件的问题（读不了、格式不对、文件名和 key 的第一段对不上、区域不认得） */
  builtinProblems: string[];
}

/**
 * 自带的语言文件能用的区域（key 的第一段、也是文件名）：网页用到的几块（WEB_NAMESPACES）、守护进程自己用的 i18n，
 * 加上守护进程 src/ 下的目录名（小驼峰：scheduled-jobs → scheduledJobs）——守护进程的 key 以它所在的目录名开头，
 * src/ 根上的几个文件（daemon.ts……）用 daemon（174 号票）；鸿蒙 App 的是 harmony（175 号票）
 */
export function knownNamespaces(daemonSrc: string): Set<string> {
  const dirs = fs
    .readdirSync(daemonSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));
  return new Set<string>([...WEB_NAMESPACES, ...dirs, "daemon", "harmony"]);
}

/** 查一遍：builtinDir 是自带的，userDir 是 ~/.ergo/locales（不存在就只查自带的） */
export function checkLocales(options: { builtinDir: string; userDir?: string; daemonSrc: string }): LocalesCheck {
  const builtin = readLocaleRoot(options.builtinDir);
  const user = options.userDir ? readLocaleRoot(options.userDir) : { dirs: [], problems: [] };
  const set = buildCatalogs(builtin, user);
  const zh = set.catalogs.get(DEFAULT_LANGUAGE)?.messages ?? {};
  const known = knownNamespaces(options.daemonSrc);
  const builtinProblems = set.builtinProblems.map((p) => `${p.file}：${p.code}${p.detail ? `：${p.detail}` : ""}${p.key ? `（${p.key}）` : ""}`);
  for (const dir of builtin.dirs) {
    for (const file of dir.files) {
      const ns = file.name.replace(/\.json$/, "");
      if (!known.has(ns)) builtinProblems.push(`${dir.id}/${file.name}：区域 ${ns} 不认得（网页的几块、守护进程 src/ 下的目录名、harmony）`);
      const wrong = Object.keys(file.messages).filter((key) => namespaceOf(key) !== ns);
      if (wrong.length > 0) builtinProblems.push(`${dir.id}/${file.name}：这几句不该放在这个文件里（文件名要是 key 的第一段）：${wrong.join("、")}`);
    }
  }
  const compare = (catalogs: typeof set.catalogs, base: typeof zh): LanguageCheck[] =>
    [...catalogs.values()].filter((c) => c.meta.id !== DEFAULT_LANGUAGE).map((c) => ({ id: c.meta.id, nativeName: c.meta.nativeName, source: c.source, ...compareMessages(base, c.messages) }));
  const builtinOnly = buildCatalogs(builtin, { dirs: [], problems: [] }).catalogs;
  return { languages: compare(set.catalogs, zh), builtinLanguages: compare(builtinOnly, builtinOnly.get(DEFAULT_LANGUAGE)?.messages ?? {}), problems: set.problems, builtinProblems };
}

/** 自带的语言有没有问题（npm run i18n:check 据此以 1 退出）：文件放错、自带的英文这类不全 */
export function builtinBroken(check: LocalesCheck): boolean {
  return check.builtinProblems.length > 0 || check.builtinLanguages.some((l) => l.missing.length > 0 || l.extra.length > 0 || l.paramMismatch.length > 0);
}

/** 相对路径写法（命令行里显示） */
export const relativeTo = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
