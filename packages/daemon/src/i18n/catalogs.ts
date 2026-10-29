// 把自带的语言和 ~/.ergo/locales 里的合成一份（168 号票，纯函数，读目录在 files.ts）：
// - 自带的语言（packages/protocol/locales/）每种一个目录；
// - ~/.ergo/locales/ 里的目录：和自带的同名就是覆盖——同名 key 换成用户的译法（_meta.json 可以不放，放了就换掉说明）；
//   不同名就是新语言，要有对的 _meta.json，否则整个不认；
// - 合好的每种语言只有自己的句子，缺的不在这里补：运行时查不到再用中文的（runtime.ts）。
import {
  DEFAULT_LANGUAGE,
  type LocaleMeta,
  type LocaleSource,
  logicalKey,
  mergeMessages,
  type Messages,
  missingCount,
  parseLocaleMeta,
} from "@ergo/protocol";
import type { LocaleDirContent, LocaleProblem, LocaleRootContent } from "./files.ts";

/** 合好的一种语言 */
export interface LocaleCatalog {
  meta: LocaleMeta;
  /** 自带的 + 用户的（用户的覆盖同名 key） */
  messages: Messages;
  source: LocaleSource;
  /** 用户改了自带的几句（逻辑上的句子数；source 是 builtin_user 时） */
  overridden: number;
}

export interface CatalogSet {
  /** 按设置里列的顺序：中文、别的自带的，再是用户加的（按语言代码） */
  catalogs: Map<string, LocaleCatalog>;
  /** ~/.ergo/locales 里的问题（设置 · 语言里列出来），按文件排 */
  problems: LocaleProblem[];
  /** 自带的语言文件的问题：是写错了代码，测试守着；万一有就记日志 */
  builtinProblems: LocaleProblem[];
}

const merged = (dir: LocaleDirContent): Messages => mergeMessages(...dir.files.map((f) => f.messages));

/** 设置里列的顺序：中文第一，别的按语言代码 */
const order = (ids: Iterable<string>) => [...ids].toSorted((a, b) => (a === DEFAULT_LANGUAGE ? -1 : b === DEFAULT_LANGUAGE ? 1 : a < b ? -1 : a > b ? 1 : 0));

const byFile = (a: LocaleProblem, b: LocaleProblem) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/** 合成一份 */
export function buildCatalogs(builtin: LocaleRootContent, user: LocaleRootContent): CatalogSet {
  const builtinProblems = [...builtin.problems];
  const problems = [...user.problems];
  const base = new Map<string, LocaleCatalog>();
  for (const dir of builtin.dirs) {
    const meta = parseLocaleMeta(dir.id, dir.meta);
    if (!meta.ok) {
      builtinProblems.push({ file: `${dir.id}/_meta.json`, ...(dir.meta === undefined ? { code: "missing_meta" as const } : meta.problem) });
      continue;
    }
    base.set(dir.id, { meta: meta.meta, messages: merged(dir), source: "builtin", overridden: 0 });
  }
  const added = new Map<string, LocaleCatalog>();
  for (const dir of user.dirs) {
    const own = merged(dir);
    const builtinCatalog = base.get(dir.id);
    const meta = dir.meta === undefined ? undefined : parseLocaleMeta(dir.id, dir.meta);
    if (meta && !meta.ok) problems.push({ file: `${dir.id}/_meta.json`, ...meta.problem });
    if (builtinCatalog) {
      const keys = new Set(Object.keys(own).map(logicalKey));
      base.set(dir.id, {
        meta: meta?.ok ? meta.meta : builtinCatalog.meta,
        messages: mergeMessages(builtinCatalog.messages, own),
        source: keys.size > 0 ? "builtin_user" : "builtin",
        overridden: keys.size,
      });
      continue;
    }
    if (!meta) {
      problems.push({ file: `${dir.id}/`, code: "missing_meta" });
      continue;
    }
    if (!meta.ok) continue;
    added.set(dir.id, { meta: meta.meta, messages: own, source: "user", overridden: 0 });
  }
  const catalogs = new Map<string, LocaleCatalog>();
  for (const id of order(base.keys())) catalogs.set(id, base.get(id)!);
  for (const id of order(added.keys())) catalogs.set(id, added.get(id)!);
  return { catalogs, problems: problems.toSorted(byFile), builtinProblems: builtinProblems.toSorted(byFile) };
}

/** 一种语言比中文缺几句（中文自己是 0） */
export function catalogMissing(set: CatalogSet, id: string): number {
  const zh = set.catalogs.get(DEFAULT_LANGUAGE);
  const catalog = set.catalogs.get(id);
  if (!zh || !catalog || id === DEFAULT_LANGUAGE) return 0;
  return missingCount(zh.messages, catalog.messages);
}
