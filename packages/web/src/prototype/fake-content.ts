// 假数据按界面语言出内容。结构、编号、状态、个数、日期都只有一份（各 fake-*.ts 里的），英文只换字：
// - en/ 下是"中文原文 → 英文"的表，按源文件分开放（不进语言文件：那是产品界面的字）；
// - 从假连接、假 HTTP 出来的东西（事件、接口的回复、错误）整棵照表换成当前语言，中文界面原样不动；
// - 进假连接、假 HTTP 的参数（页面上点的、选的名字）照表换回中文，假数据里按字认的逻辑不用分语言；
// - 少数不经这两处的（页面直接引的假详情、提示）自己调 localized、fakeText。
// 换语言时页面重新连一遍（App.tsx 的 key），已经推过的内容跟着换。
// 金额：英文写美元（约 7 元 = 1 美元），表里每处按这个换好了；算出来的金额用 fakeMoney。
import { activeLocale, ASSISTANT_NAME_MARK, inboxActionText, type Messages } from "../state/index.ts";
import { EN_PHRASES } from "./en/index.ts";

const CHINESE = /[　-〿㐀-䶿一-鿿豈-﫿！-｠]/;

/** 表里的插值 */
const HOLE = "{}";

/** 英文的金额按多少元换一美元 */
const YUAN_PER_DOLLAR = 7;

/** 这两个字段里的字是待办的动作：协议包认得的存中文原字（按字认，显示时协议包换），别的照表换 */
const ACTION_FIELDS = new Set(["actions", "handled"]);

/** 取语言词典的接口：词典里本来就有中文（兜底的那一份、语言列表的本地名），不过表 */
const RAW_METHODS = new Set(["locale", "locales"]);

/** 换回中文时不认的：全小写的一个词多半是枚举（action: "archive"），不是给人看的字 */
const LOOKS_LIKE_ENUM = /^[a-z][a-z0-9_-]*$/;

/** 有没有中文（内部的名字记号不算） */
export function hasChinese(text: string): boolean {
  return CHINESE.test(text.replaceAll(ASSISTANT_NAME_MARK, ""));
}

/** 现在要不要出英文内容 */
export function isEnglishContent(): boolean {
  return activeLocale().meta.id === "en";
}

interface Template {
  pattern: RegExp;
  to: string;
  literal: number;
}

interface Book {
  exact: ReadonlyMap<string, string>;
  /** 字面长的排前面：先试说得具体的 */
  templates: readonly Template[];
  reverse: ReadonlyMap<string, string>;
  /** 兜底：句子是现拼的（把假项目名拼进协议包的话里），只换认得的那几段 */
  pieces: readonly (readonly [string, string])[];
  memo: Map<string, string>;
}

let book: Book | undefined;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bookOf(): Book {
  if (book) return book;
  const entries = Object.entries(EN_PHRASES);
  const plain = entries.filter(([zh]) => !zh.includes(HOLE));
  const reverse = new Map<string, string>();
  for (const [zh, en] of plain) if (!reverse.has(en)) reverse.set(en, zh);
  book = {
    exact: new Map(plain),
    templates: entries
      .filter(([zh]) => zh.includes(HOLE))
      .map(([zh, en]) => ({ pattern: new RegExp(`^${zh.split(HOLE).map(escapeRegex).join("([\\s\\S]*?)")}$`), to: en, literal: zh.length - zh.split(HOLE).length }))
      .toSorted((a, b) => b.literal - a.literal),
    reverse,
    pieces: plain.filter(([zh]) => zh.length >= 2 || zh === "、").toSorted(([a], [b]) => b.length - a.length),
    memo: new Map(),
  };
  return book;
}

function fill(to: string, holes: readonly string[]): string {
  let at = 0;
  return to.replaceAll(HOLE, () => holes[at++] ?? "");
}

/** 插值里可能是几个名字用顿号连起来的 */
function holeText(hole: string): string {
  return hole.includes("、") ? hole.split("、").map(toEnglish).join(", ") : toEnglish(hole);
}

/** 协议包的字（假数据在中文下装好的状态名、卡片种类这些）：语言文件里中英一一对应，查它 */
let dictionary: { of: Messages; words: ReadonlyMap<string, string> } | undefined;
function dictionaryWord(text: string): string | undefined {
  const { messages, fallback } = activeLocale();
  if (dictionary?.of !== messages) {
    const words = new Map<string, string>();
    for (const [key, zh] of Object.entries(fallback)) {
      const en = messages[key];
      if (en !== undefined && !zh.includes("{") && !words.has(zh)) words.set(zh, en);
    }
    dictionary = { of: messages, words };
  }
  return dictionary.words.get(text);
}

function lookUp(text: string, b: Book): string {
  const exact = b.exact.get(text) ?? dictionaryWord(text);
  if (exact !== undefined) return exact;
  for (const { pattern, to } of b.templates) {
    const found = pattern.exec(text);
    if (!found) continue;
    const out = fill(to, found.slice(1).map(holeText));
    if (!hasChinese(out)) return out;
  }
  // 几段拼起来的：一段一段查
  for (const separator of ["\n\n", "\n"]) {
    if (!text.includes(separator)) continue;
    const out = text.split(separator).map(toEnglish).join(separator);
    if (!hasChinese(out)) return out;
  }
  return b.pieces.reduce((out, [zh, en]) => (out.includes(zh) ? out.replaceAll(zh, en) : out), text);
}

function toEnglish(text: string): string {
  if (!hasChinese(text)) return text;
  const b = bookOf();
  const known = b.memo.get(text);
  if (known !== undefined) return known;
  const out = lookUp(text, b);
  b.memo.set(text, out);
  return out;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** 照着 text 换一棵对象里的字（键是中文的也换）：只换字，什么都没变的原样还回去（对象还是原来那个） */
function mapStrings(value: unknown, text: (s: string, field: string | undefined) => string, field?: string): unknown {
  if (typeof value === "string") return text(value, field);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item: unknown) => {
      const next = mapStrings(item, text, field);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!isPlainObject(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = mapStrings(item, text, key);
    const nextKey = text(key, undefined);
    if (next !== item || nextKey !== key) changed = true;
    out[nextKey] = next;
  }
  return changed ? out : value;
}

const outgoing = (s: string, field: string | undefined): string => (field !== undefined && ACTION_FIELDS.has(field) && inboxActionText(s) !== s ? s : toEnglish(s));

const incoming = (s: string): string => (LOOKS_LIKE_ENUM.test(s) ? s : (bookOf().reverse.get(s) ?? s));

/** 一句假数据的字，按当前语言 */
export function fakeText(text: string): string {
  return isEnglishContent() ? toEnglish(text) : text;
}

/** 假数据（整棵对象）按当前语言；中文界面原样还回去 */
export function localized<T>(value: T): T {
  return isEnglishContent() ? (mapStrings(value, outgoing) as T) : value;
}

/** 一直不变的假详情按当前语言：同一份、同一种语言拿到的是同一个对象（页面拿它当依赖不会一直重画） */
const stable = new WeakMap<object, { language: string; value: unknown }>();
export function localizedConstant<T extends object>(value: T): T {
  if (!isEnglishContent()) return value;
  const language = activeLocale().meta.id;
  const known = stable.get(value);
  if (known?.language === language) return known.value as T;
  const out = localized(value);
  stable.set(value, { language, value: out });
  return out;
}

/** 现拼的一句（表里的键写 {}）：一次要拼很多行、不值得逐行查表的地方用。插值要换的自己先换好 */
export function fakeFormat(key: string, ...holes: readonly (string | number)[]): string {
  const to = isEnglishContent() ? (EN_PHRASES[key] ?? key) : key;
  return fill(to, holes.map(String));
}

/** 算出来的金额（单位元）按当前语言：英文是美元 */
export function fakeMoney(yuan: number): number {
  return isEnglishContent() ? yuan / YUAN_PER_DOLLAR : yuan;
}

function localizedError(err: unknown): unknown {
  if (err instanceof Error && isEnglishContent()) err.message = toEnglish(err.message);
  return err;
}

/**
 * 给假连接、假 HTTP 套一层：调进去的参数换回中文，回来的（结果、错误、回调的参数）换成当前语言。
 * 中文界面下什么都不换
 */
export function localizedFake<T extends object>(target: T): T {
  const wrappers = new Map<string | symbol, unknown>();
  const argIn = (arg: unknown): unknown => {
    if (typeof arg === "function") return (...inner: unknown[]) => (arg as (...a: unknown[]) => unknown)(...inner.map(localized));
    return isEnglishContent() ? mapStrings(arg, incoming) : arg;
  };
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj) as unknown;
      if (typeof value !== "function") return value;
      const known = wrappers.get(prop);
      if (known !== undefined) return known;
      const method = value as (...a: unknown[]) => unknown;
      const raw = typeof prop === "string" && RAW_METHODS.has(prop);
      const wrapper = raw
        ? method.bind(obj)
        : (...args: unknown[]) => {
            let out: unknown;
            try {
              out = method.apply(obj, args.map(argIn));
            } catch (err) {
              throw localizedError(err);
            }
            if (out instanceof Promise) return out.then(localized, (err: unknown) => Promise.reject(localizedError(err)));
            return localized(out);
          };
      wrappers.set(prop, wrapper);
      return wrapper;
    },
  });
}
