// 守护进程这一侧的多语言（168 号票）：读语言目录（files.ts）、合成一份（catalogs.ts）、自带的（builtin.ts）、
// 盯着 ~/.ergo/locales（locales.ts）、全局语言设置（language.ts）、系统提示末尾那句（prompt-line.ts）。
// t() 本身在共享协议包（@ergo/protocol 的 i18n/），守护进程里的模块直接从 @ergo/protocol 取 t。
export { activeLocaleOf, BUILTIN_LOCALES_DIR, builtinCatalogs, installBuiltinLocales } from "./builtin.ts";
export { buildCatalogs, catalogMissing, type CatalogSet, type LocaleCatalog } from "./catalogs.ts";
export { type LocaleProblem, localeRootSignature, readLocaleRoot } from "./files.ts";
export { createLanguageService, type LanguageService } from "./language.ts";
export { createLocales, DEFAULT_LOCALES_POLL_MS, type Locales } from "./locales.ts";
export { answerLanguageLine, withLanguageLine } from "./prompt-line.ts";
