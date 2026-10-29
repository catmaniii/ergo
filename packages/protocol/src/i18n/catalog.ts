// 语言文件的形状和检查（168 号票，不读文件、不引用 TypeBox）：守护进程读目录（packages/daemon/src/i18n/）、Web 打包自带的、
// npm run i18n:check 都用这一份。
//
// 一种语言一个目录（目录名就是语言代码：zh-CN、en、fr……）：
// - _meta.json：{ "nativeName": "English", "modelName": "English", "intlLocale": "en" }——本地名（设置里列的），给模型的语言名
//   （系统提示末尾那句"用 <它> 回答用户"），Intl 用的区域码（日期、数字、单复数）。后两项不填分别用本地名、语言代码；
// - 其余每个 .json 是一块区域的句子，平铺的 { "key": "句子" }。自带的（packages/protocol/locales/）文件名就是 key 的第一段
//   （shell.json 里只有 shell.* 的 key），每张迁移票只碰自己区域的文件；~/.ergo/locales/ 里用户放的文件名、分几个文件随意。
//
// 句子里的 {name} 是插值参数；单复数用 key 后缀 _zero / _one / _two / _few / _many / _other（按 Intl.PluralRules 挑，见 runtime.ts），
// 这几种写法逻辑上是同一句（logicalKey），检查时按同一句比。

/** 写界面的原文用的语言，也是缺句子时的回退：中文 */
export const DEFAULT_LANGUAGE = "zh-CN";

/** 语言目录里的说明文件 */
export const LOCALE_META_FILE = "_meta.json";

/**
 * Web 用到的区域（key 的第一段）：网页打包自带的只打这几块，守护进程给网页的词典也只给这几块
 * （守护进程自己生成的话存进事件时已经写好了，网页用不着 tasks.*、guard.* 这些）。
 * 加一块网页用的区域：这里加一项，packages/web/src/app/locale-bundle.ts 的 import.meta.glob 也加上（test/i18n/web-bundle.test.ts 比对两边）。
 * harmony（175 号票）是鸿蒙 App 原生的字：网页不显示，经原生桥交给 App（app/native-app.ts 的 appTexts），所以也跟着网页走
 * setup（319 号票）是首次设置向导（pages/SetupWizard.tsx）的话，只有网页用
 * doctor（319 号票的 319b）是设置 · 体检（pages/DoctorPage.tsx）的话：八项检查的名字、查出来的事实怎么拼、"怎么修"，只有网页用
 */
export const WEB_NAMESPACES = ["common", "shell", "ui", "app", "model", "styles", "bridge", "state", "pages", "protocol", "harmony", "setup", "doctor"] as const;

/** 单复数的后缀（Intl.PluralRules 的几种，外加 count 是 0 时优先的 zero） */
export const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;

/** 一种语言的说明（语言目录里的 _meta.json，加上目录名） */
export interface LocaleMeta {
  /** 语言代码，也是目录名、设置里存的：zh-CN、en、fr…… */
  readonly id: string;
  /** 本地名：设置的语言列表里写的（"English"、"中文"） */
  readonly nativeName: string;
  /** 给模型的语言名：系统提示末尾"用 <它> 回答用户" */
  readonly modelName: string;
  /** Intl 用的区域码：日期、数字、列表、单复数 */
  readonly intlLocale: string;
}

/** 一种语言的句子：key → 句子 */
export type Messages = Readonly<Record<string, string>>;

/**
 * 读语言文件时出的问题（设置 · 语言里逐条写明是哪个文件、哪里错，网页按 code 写成话）：
 * - bad_json：不是合法的 JSON（detail 是解析器的原话，带位置）；
 * - not_object：顶层不是 { "key": "句子" }；
 * - bad_value：某一句不是字符串（key 写明哪句），这句跳过，同一文件别的照用；
 * - bad_meta：_meta.json 不对（detail 是哪一项），这种语言整个不认（自带语言的覆盖目录里的 _meta.json 不对时只是不覆盖说明）；
 * - missing_meta：新语言的目录里没有 _meta.json，整个不认；
 * - bad_dir：目录名不是语言代码（比如 en_US、中文），整个不认；
 * - unreadable：文件读不了（detail 是原因）
 */
export const LOCALE_PROBLEM_CODES = ["bad_json", "not_object", "bad_value", "bad_meta", "missing_meta", "bad_dir", "unreadable"] as const;
export type LocaleProblemCode = (typeof LOCALE_PROBLEM_CODES)[number];

export interface LocaleFileProblem {
  readonly code: LocaleProblemCode;
  /** 哪一句（bad_value） */
  readonly key?: string;
  /** 细节：解析器的原话、_meta.json 里错的那一项、读不了的原因 */
  readonly detail?: string;
}

const LANGUAGE_ID = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** 能不能当语言代码（目录名）：zh-CN、en、pt-BR、zh-Hant-TW 这类 */
export function isLanguageId(value: string): boolean {
  return LANGUAGE_ID.test(value);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function validIntlLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/** 解析 _meta.json 的内容（id 是目录名）；不对时写明哪一项 */
const badMeta = (detail: string) => ({ ok: false as const, problem: { code: "bad_meta" as const, detail } });

export function parseLocaleMeta(id: string, raw: unknown): { ok: true; meta: LocaleMeta } | { ok: false; problem: LocaleFileProblem } {
  const bad = badMeta;
  if (!isPlainObject(raw)) return bad(LOCALE_META_FILE);
  if (!nonEmptyString(raw.nativeName)) return bad("nativeName");
  if (raw.modelName !== undefined && !nonEmptyString(raw.modelName)) return bad("modelName");
  if (raw.intlLocale !== undefined && !(nonEmptyString(raw.intlLocale) && validIntlLocale(raw.intlLocale))) return bad("intlLocale");
  const nativeName = raw.nativeName.trim();
  const modelName = typeof raw.modelName === "string" ? raw.modelName.trim() : nativeName;
  const intlLocale = typeof raw.intlLocale === "string" ? raw.intlLocale.trim() : validIntlLocale(id) ? id : "und";
  return { ok: true, meta: { id, nativeName, modelName, intlLocale } };
}

/** 解析一个语言文件的内容：不是字符串的那句跳过（写明 key），别的照用 */
export function parseMessagesFile(raw: unknown): { messages: Messages; problems: LocaleFileProblem[] } {
  if (!isPlainObject(raw)) return { messages: {}, problems: [{ code: "not_object" }] };
  const messages: Record<string, string> = {};
  const problems: LocaleFileProblem[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && key !== "") messages[key] = value;
    else problems.push({ code: "bad_value", key });
  }
  return { messages, problems };
}

/** 按顺序合并几层句子：后面的同名 key 覆盖前面的（自带的被用户的覆盖） */
export function mergeMessages(...layers: readonly Messages[]): Messages {
  return Object.assign({}, ...layers) as Messages;
}

const PLURAL_TAIL = new RegExp(`_(?:${PLURAL_SUFFIXES.join("|")})$`);

/** 逻辑上是哪一句：去掉单复数的后缀（shell.count_one → shell.count） */
export function logicalKey(key: string): string {
  return key.replace(PLURAL_TAIL, "");
}

/** key 的第一段（区域） */
export function namespaceOf(key: string): string {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}

/** 插值参数的写法：{标识符}（别的花括号原样是字） */
export const MESSAGE_PARAM = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 一句里的插值参数（去重，按出现的先后） */
export function messageParams(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MESSAGE_PARAM), (m) => m[1]!))];
}

/** 按逻辑上的一句归拢：每句的几种写法的插值参数并在一起 */
function logicalParams(messages: Messages): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, text] of Object.entries(messages)) {
    const k = logicalKey(key);
    const set = out.get(k) ?? new Set<string>();
    for (const p of messageParams(text)) set.add(p);
    out.set(k, set);
  }
  return out;
}

/** 两种语言比出来的：缺的、多的（都是逻辑上的一句）、插值参数对不上的 */
export interface MessagesComparison {
  readonly missing: string[];
  readonly extra: string[];
  readonly paramMismatch: { key: string; expected: string[]; actual: string[] }[];
}

/**
 * base（中文）和 other（某种语言）比：other 缺哪些句、多哪些句、两边插值参数不一样的。
 * 复数的几种写法算一句；参数比的是几种写法的并集（英文的 _one 可以不写 {count}，只要 _other 写了）
 */
export function compareMessages(base: Messages, other: Messages): MessagesComparison {
  const b = logicalParams(base);
  const o = logicalParams(other);
  const missing = [...b.keys()].filter((k) => !o.has(k)).toSorted();
  const extra = [...o.keys()].filter((k) => !b.has(k)).toSorted();
  const paramMismatch: MessagesComparison["paramMismatch"] = [];
  for (const [key, expected] of b) {
    const actual = o.get(key);
    if (!actual) continue;
    const e = [...expected].toSorted();
    const a = [...actual].toSorted();
    if (e.join("\n") !== a.join("\n")) paramMismatch.push({ key, expected: e, actual: a });
  }
  return { missing, extra, paramMismatch: paramMismatch.toSorted((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)) };
}

/** 一种语言缺几句（逻辑上的句子数，复数的几种写法算一句） */
export function missingCount(base: Messages, other: Messages): number {
  return compareMessages(base, other).missing.length;
}

/** 只留 Web 用到的区域（守护进程给网页的词典） */
export function webMessages(messages: Messages): Messages {
  const keep = new Set<string>(WEB_NAMESPACES);
  return Object.fromEntries(Object.entries(messages).filter(([key]) => keep.has(namespaceOf(key))));
}

/** 一种语言的说明和句子 */
export interface LocaleEntry {
  readonly meta: LocaleMeta;
  readonly messages: Messages;
}

/**
 * 由语言文件拼出几种语言（网页打包自带的、测试直接读目录时用；守护进程读目录另有一套，带问题记录）：
 * entries 是 [路径, 内容]，路径的最后两截是 <语言代码>/<文件名>.json。没有对的 _meta.json 的语言不要，不是字符串的句子跳过
 */
export function catalogsFromFiles(entries: Iterable<readonly [string, unknown]>): Map<string, LocaleEntry> {
  const metas = new Map<string, unknown>();
  const files = new Map<string, [string, Messages][]>();
  for (const [file, content] of entries) {
    const parts = file.split(/[\\/]/);
    const name = parts.at(-1);
    const id = parts.at(-2);
    if (!name || !id || !isLanguageId(id) || !name.endsWith(".json")) continue;
    if (name === LOCALE_META_FILE) metas.set(id, content);
    else files.set(id, [...(files.get(id) ?? []), [name, parseMessagesFile(content).messages]]);
  }
  const out = new Map<string, LocaleEntry>();
  for (const [id, raw] of metas) {
    const meta = parseLocaleMeta(id, raw);
    if (!meta.ok) continue;
    const layers = (files.get(id) ?? []).toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, m]) => m);
    out.set(id, { meta: meta.meta, messages: mergeMessages(...layers) });
  }
  return out;
}
