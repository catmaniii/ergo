// 自带的语言（168 号票）：仓库里 packages/protocol/locales/ 下的中文、英文。
// 守护进程启动时和 ~/.ergo/locales 里的合起来用（locales.ts）；进程入口、单元测试（vitest 的 setupFiles）在还没有守护进程时
// 用 installBuiltinLocales() 先装上自带的中文，t() 才查得到句子。
import { fileURLToPath } from "node:url";
import { type ActiveLocale, activeLocaleFrom, DEFAULT_LANGUAGE, setActiveLocale } from "@ergo/protocol";
import { buildCatalogs, type CatalogSet } from "./catalogs.ts";
import { readLocaleRoot } from "./files.ts";

/** 自带的语言文件所在的目录（共享协议包的 locales/） */
export const BUILTIN_LOCALES_DIR = fileURLToPath(new URL("../../../protocol/locales/", import.meta.url));

let cached: CatalogSet | undefined;

/** 自带的语言（读一次，之后用同一份；程序文件不会在运行中变） */
export function builtinCatalogs(): CatalogSet {
  cached ??= buildCatalogs(readLocaleRoot(BUILTIN_LOCALES_DIR), { dirs: [], problems: [] });
  return cached;
}

/** 由合好的一份拼出"正在用的语言"：没有这种语言时用中文 */
export function activeLocaleOf(set: CatalogSet, language: string): ActiveLocale {
  return activeLocaleFrom(set.catalogs, language);
}

/** 装上自带的某种语言（默认中文）：进程入口、单元测试、守护进程停下之后 */
export function installBuiltinLocales(language: string = DEFAULT_LANGUAGE): void {
  setActiveLocale(activeLocaleOf(builtinCatalogs(), language));
}
