// 有哪些语言（168 号票）：自带的加上 ~/.ergo/locales（数据目录的 locales/）里放的，合成一份；放一个文件就能加新语言、改译法。
// - 启动时读一遍；之后每隔一会儿（默认 2 秒）看一眼 ~/.ergo/locales 里的 .json 有没有变（路径、大小、修改时间），变了重新读；
//   合出来的和上次不一样才算变了（版本号加一，通知 onChange 的）。目录不存在就当是空的，建了也看得到。
//   不用 fs.watch：Windows 上编辑器存文件时它报的事件重复、时有时无；这个目录很小，轮询便宜（同网页的版本号，116 号票）；
// - 自带的只在启动时读（程序文件不会在运行中变）；
// - 文件放坏了只记成问题（设置 · 语言里列出来），不抛错。
import { DEFAULT_LANGUAGE, type LocaleProblemView, type LocaleSummary } from "@ergo/protocol";
import { BUILTIN_LOCALES_DIR } from "./builtin.ts";
import { buildCatalogs, catalogMissing, type CatalogSet, type LocaleCatalog } from "./catalogs.ts";
import { localeRootSignature, readLocaleRoot } from "./files.ts";

/** 默认多久看一眼 ~/.ergo/locales 变没变（毫秒） */
export const DEFAULT_LOCALES_POLL_MS = 2_000;

export interface Locales {
  /** ~/.ergo/locales 的真实路径（设置页上写明放哪） */
  readonly userDir: string;
  /** 合好的这一份 */
  current(): CatalogSet;
  catalog(id: string): LocaleCatalog | undefined;
  /** 设置 · 语言里列的：每种语言的本地名、从哪来、缺几句 */
  summaries(): LocaleSummary[];
  /** ~/.ergo/locales 里的问题 */
  problems(): LocaleProblemView[];
  /** 合出来的变过几次（启动时读的那次是 0） */
  revision(): number;
  /** 变了（语言多了少了、句子改了、问题变了）时叫 fn；返回取消登记的函数 */
  onChange(fn: () => void): () => void;
  /** 现在就重新读一遍（轮询也是调它）；变了返回 true */
  reload(): boolean;
  start(): void;
  stop(): void;
}

export interface LocalesOptions {
  /** 用户放语言文件的目录（数据目录的 locales/） */
  userDir: string;
  /** 自带的在哪（不填是共享协议包的 locales/；测试换成自己的） */
  builtinDir?: string;
  /** 多久看一眼变没变（毫秒，默认 2 秒） */
  pollMs?: number;
  log: (line: string) => void;
}

/** 合出来的这一份的指纹：比一比内容真变了没有 */
const fingerprintOf = (s: CatalogSet) => JSON.stringify({ c: [...s.catalogs], p: s.problems });

export function createLocales(options: LocalesOptions): Locales {
  const { userDir, log } = options;
  const builtin = readLocaleRoot(options.builtinDir ?? BUILTIN_LOCALES_DIR);
  const listeners = new Set<() => void>();
  let signature = "";
  let set = buildCatalogs(builtin, { dirs: [], problems: [] });
  let fingerprint = "";
  let revision = 0;
  let timer: NodeJS.Timeout | undefined;

  const load = (): boolean => {
    signature = localeRootSignature(userDir);
    const next = buildCatalogs(builtin, readLocaleRoot(userDir));
    const print = fingerprintOf(next);
    if (print === fingerprint) return false;
    const first = fingerprint === "";
    set = next;
    fingerprint = print;
    for (const p of next.builtinProblems) log(`自带的语言文件有问题：${p.file}：${p.code}${p.detail ? `：${p.detail}` : ""}${p.key ? `（${p.key}）` : ""}`);
    for (const p of next.problems) log(`语言文件没读进来：${userDir}/${p.file}：${p.code}${p.detail ? `：${p.detail}` : ""}${p.key ? `（${p.key}）` : ""}`);
    if (first) return false;
    revision += 1;
    log(`语言文件变了：现在有 ${[...next.catalogs.keys()].join("、")}`);
    for (const fn of listeners) fn();
    return true;
  };

  const poll = () => {
    if (localeRootSignature(userDir) === signature) return;
    load();
  };

  return {
    userDir,
    current: () => set,
    catalog: (id) => set.catalogs.get(id),
    summaries: () =>
      [...set.catalogs.values()].map((c) => ({
        id: c.meta.id,
        nativeName: c.meta.nativeName,
        source: c.source,
        overridden: c.overridden,
        missing: catalogMissing(set, c.meta.id),
      })),
    problems: () => set.problems.map((p) => ({ file: p.file, code: p.code, ...(p.key === undefined ? {} : { key: p.key }), ...(p.detail === undefined ? {} : { detail: p.detail }) })),
    revision: () => revision,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reload: load,
    start() {
      load();
      if (!set.catalogs.has(DEFAULT_LANGUAGE)) throw new Error(`自带的中文语言文件读不出来：${options.builtinDir ?? BUILTIN_LOCALES_DIR}`); // @i18n-ignore log
      timer = setInterval(poll, options.pollMs ?? DEFAULT_LOCALES_POLL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
