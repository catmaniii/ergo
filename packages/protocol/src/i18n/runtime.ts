// 多语言的运行时（168 号票）：t()、单复数、回退中文、按语言格式化。网页、守护进程、共享协议包共用这一份，不加依赖，只用 Intl。
//
// 一个进程（一个页面）同时只有一种"正在用的语言"（全局一个语言，用户 2026-10-19 定）：setActiveLocale 换上，t() 现取。
// 谁来换上：
// - 守护进程：启动时按设置里的语言装上（自带的 + ~/.ergo/locales 里的，合好的），改了设置、语言文件变了再换（daemon/src/i18n/）；
//   单元测试由 vitest 的 setupFiles 装上自带的中文；
// - 网页：页面脚本一开始装上打包进去的自带语言（这台设备上次用的那种），连上守护进程后换成它给的完整词典（web/src/app/locale.ts）。
// 没装过时什么都查不到，t() 回 key 本身——所以**模块顶层不要调 t()**（那时可能还没装上）：常量表写成 key，用 tTable 包一层，取值时现查。
//
// 查一句：当前语言的词典里有就用它；没有就用中文的（回退，不提示：用户自己加的语言缺句子是常事，npm run i18n:check 列出来）；
// 中文也没有是写错了 key，回 key 本身并提示一次（setMissingMessageHandler 换提示的方式，默认 console.warn）。
// 单复数：参数里有数字 count 时，先找 key_zero（count 是 0）、再找按 Intl.PluralRules 挑的 key_one / key_few / …，再找 key_other，
// 最后找不带后缀的 key——中文、日文这类不分单复数的直接写不带后缀的那句就行。count 只用来挑，插不插它由句子定。
import { DEFAULT_LANGUAGE, type LocaleEntry, type LocaleMeta, MESSAGE_PARAM, type Messages } from "./catalog.ts";

/** 正在用的语言：当前语言的说明和词典（自带 + 覆盖，已经合好），回退用的中文的说明和词典 */
export interface ActiveLocale {
  readonly meta: LocaleMeta;
  readonly messages: Messages;
  readonly fallbackMeta: LocaleMeta;
  readonly fallback: Messages;
}

/** 由几种语言拼出"正在用的语言"：language 没有时用中文；中文也没有时什么都查不到 */
export function activeLocaleFrom(catalogs: ReadonlyMap<string, LocaleEntry>, language: string): ActiveLocale {
  const zh = catalogs.get(DEFAULT_LANGUAGE);
  const catalog = catalogs.get(language) ?? zh;
  return {
    meta: catalog?.meta ?? EMPTY_META,
    messages: catalog?.messages ?? {},
    fallbackMeta: zh?.meta ?? EMPTY_META,
    fallback: zh?.messages ?? {},
  };
}

/** 插值参数：t() 的值写成字符串；tParts() 的可以是任意值（界面上的元素） */
export type MessageParams = Readonly<Record<string, unknown>>;

/** 还没装上任何词典时 */
const EMPTY_META: LocaleMeta = { id: DEFAULT_LANGUAGE, nativeName: DEFAULT_LANGUAGE, modelName: DEFAULT_LANGUAGE, intlLocale: DEFAULT_LANGUAGE };
const EMPTY: ActiveLocale = { meta: EMPTY_META, messages: {}, fallbackMeta: EMPTY_META, fallback: {} };

let current: ActiveLocale = EMPTY;
let revision = 0;
const listeners = new Set<() => void>();
/** followLocale 登记的：换语言时先于 listeners 跑（网页重画时读到的已经是新的）；forModel 里也跟着换成中文 */
const followers = new Set<() => void>();

/** 默认的提示：console.warn（网页状态层的类型里没有 console，从 globalThis 取） */
const defaultMissing = (key: string) => (globalThis as { console?: { warn(message: string): void } }).console?.warn(`[i18n] 没有这句：${key}（中文的语言文件里也没有，key 写错了？）`);
let onMissing: (key: string) => void = defaultMissing;
const reported = new Set<string>();

/** 换上一种语言：版本号加一，通知登记的（网页据此重画） */
export function setActiveLocale(locale: ActiveLocale): void {
  current = locale;
  revision += 1;
  reported.clear();
  for (const fn of followers) fn();
  for (const fn of listeners) fn();
}

/** 正在用的语言 */
export function activeLocale(): ActiveLocale {
  return current;
}

/** 正在用的语言的代码（zh-CN、en……） */
export function activeLanguage(): string {
  return current.meta.id;
}

/** 换过几次语言（React 的 useSyncExternalStore 用它判断要不要重画） */
export function localeRevision(): number {
  return revision;
}

/** 语言换了时叫 fn；返回取消登记的函数 */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 按中文（回退的那种）跑一段 fn：给模型看的话照旧中文（用户 2026-10-19 定），一个函数同时给模型和给人看时，
 * 给模型的那份包一层 `forModel(() => f(x))`（172 号票）。只换 t() 查的词典，不算换语言（不加版本号、不通知 onLocaleChange 的）；
 * followLocale 的常量在里面也是中文（进出时各重算一次）。现在就是中文时直接跑。fn 要是同步的
 */
export function forModel<T>(fn: () => T): T {
  const saved = current;
  if (saved.messages === saved.fallback) return fn();
  current = { meta: saved.fallbackMeta, messages: saved.fallback, fallbackMeta: saved.fallbackMeta, fallback: saved.fallback };
  for (const f of followers) f();
  try {
    return fn();
  } finally {
    current = saved;
    for (const f of followers) f();
  }
}

/**
 * 跟着当前语言更新：装上过语言就先跑一次 fn，之后每换一次语言再跑（172 号票）。给导出的单个字符串常量用——
 * 别的区域直接拿它当字符串用（`{LAST_RUN_FAILED_LABEL}`、`${X}`），改成函数要动所有用的地方，就写成
 * `export let X = ""; followLocale(() => { X = t("…"); });`（ES 模块的导出是活的绑定，用的地方读到的总是现在的）。
 * 还没装上语言时是空字符串（网页、守护进程、测试用之前都装好了）；在模块顶层拿它拼别的常量的会停在那一刻的值。
 * 在 forModel 里读到的是中文
 */
export function followLocale(fn: () => void): void {
  followers.add(fn);
  if (revision > 0) fn();
}

/** 换掉"中文也没有这句"时的提示（测试里收集、守护进程记日志）；不给是默认的 console.warn */
export function setMissingMessageHandler(handler: ((key: string) => void) | undefined): void {
  onMissing = handler ?? defaultMissing;
  reported.clear();
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralOf(locale: string, n: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("en");
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

/** 这个数在当前语言里是哪种单复数（one、other……） */
export function pluralCategory(n: number): Intl.LDMLPluralRule {
  return pluralOf(current.meta.intlLocale, n);
}

/** 在一本词典里找：有 count 时先按单复数的几种写法找，最后找不带后缀的 */
function lookupIn(messages: Messages, locale: string, key: string, count: number | undefined): string | undefined {
  if (count !== undefined) {
    if (count === 0 && messages[`${key}_zero`] !== undefined) return messages[`${key}_zero`];
    const exact = messages[`${key}_${pluralOf(locale, count)}`];
    if (exact !== undefined) return exact;
    const other = messages[`${key}_other`];
    if (other !== undefined) return other;
  }
  return messages[key];
}

/** 找到的句子；当前语言没有用中文的；都没有是 undefined */
function lookup(key: string, params: MessageParams | undefined): string | undefined {
  const count = typeof params?.count === "number" ? params.count : undefined;
  return lookupIn(current.messages, current.meta.intlLocale, key, count) ?? lookupIn(current.fallback, current.fallbackMeta.intlLocale, key, count);
}

function missing(key: string): string {
  if (!reported.has(key)) {
    reported.add(key);
    onMissing(key);
  }
  return key;
}

/** 按当前语言取一句，{name} 换成参数（写成字符串）；没给的参数原样留着 */
export function t(key: string, params?: MessageParams): string {
  const text = lookup(key, params);
  if (text === undefined) return missing(key);
  if (!params) return text;
  return text.replace(MESSAGE_PARAM, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/**
 * 同 t()，但参数可以是任意值（界面上要在句子中间放名字标签、链接这类元素时）：拆成文字和参数交错的一串，空的文字段去掉。
 * 网页里一般用 ui/i18n.tsx 的 <T>
 */
export function tParts(key: string, params: MessageParams): unknown[] {
  const text = lookup(key, params) ?? missing(key);
  const out: unknown[] = [];
  let last = 0;
  for (const m of text.matchAll(MESSAGE_PARAM)) {
    const name = m[1]!;
    if (!Object.hasOwn(params, name)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(params[name]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 常量表：值写成 key，取值时按当前语言现查（换了语言不用重新建表，模块顶层建也行——取值时才查）。
 * 原来是 `const LABELS: Record<X, string> = { a: "甲" }` 的，改成 `const LABELS = tTable({ a: "<区域>.labels.a" })`，用的地方不用改。
 * 可以 Object.entries / Object.values、展开、toEqual（属性是可枚举的取值函数）
 */
export function tTable<K extends string>(keys: Readonly<Record<K, string>>): Readonly<Record<K, string>> {
  const table = {} as Record<K, string>;
  for (const [name, key] of Object.entries(keys) as [K, string][]) {
    Object.defineProperty(table, name, { enumerable: true, get: () => t(key) });
  }
  return Object.freeze(table);
}

/** Intl 用的区域码（当前语言的） */
export function intlLocale(): string {
  return current.meta.intlLocale;
}

/** 数字按当前语言写（千分位、小数点） */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(n);
}

/** 日期、时间按当前语言写（options 同 Intl.DateTimeFormat；时区不给是运行环境的） */
export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(), options).format(typeof value === "string" ? new Date(value) : value);
}

/** 几样东西连成一句（"a, b, and c" /"甲、乙和丙"） */
export function formatList(items: readonly string[], options?: Intl.ListFormatOptions): string {
  return new Intl.ListFormat(intlLocale(), options).format(items);
}

/** 相对时间（"3 分钟前" / "3 minutes ago"） */
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string {
  return new Intl.RelativeTimeFormat(intlLocale(), options).format(value, unit);
}
