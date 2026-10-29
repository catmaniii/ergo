// 多语言（168 号票）：全局语言设置的事件、配置文件、设置接口，网页取词典、设置 · 语言列语言的接口的 schema。
// 语言文件的形状和运行时在 i18n/（不引用 TypeBox）。
//
// 照个人助理的名字（43 号票）存和推：数据目录配置区的 language.json 是真相，只由运行时写（设置接口）；
// 每次改动是语言频道上的一条 language 事件（设置里选的那种）。实际在用哪种（选的那种不在了时是中文）、词典有没有变
// （~/.ergo/locales 里的文件改了）由语言频道上的临时事件 locale 推（订阅时补推一条现在的），网页按它的 revision 判断要不要重取词典。
import { type Static, Type } from "typebox";
import { LOCALE_PROBLEM_CODES } from "./i18n/catalog.ts";

/** 语言设置改动的来源：设置页，以及启动时发现配置文件和上一条事件不一样（停着时手改过、从备份恢复了配置区） */
export const LANGUAGE_SOURCES = ["settings", "config_file"] as const;
export type LanguageSource = (typeof LANGUAGE_SOURCES)[number];

/** 语言频道上的 language 事件：设置里选的语言（语言代码） */
export const LanguageEventPayload = Type.Object({
  language: Type.String({ minLength: 1 }),
  source: Type.Enum(LANGUAGE_SOURCES),
});
export type LanguageEventPayload = Static<typeof LanguageEventPayload>;

/** 语言频道上的临时事件 locale：实际在用的语言，和词典的版本（语言、语言文件一变就换） */
export const LocaleEventPayload = Type.Object({
  language: Type.String({ minLength: 1 }),
  revision: Type.String({ minLength: 1 }),
});
export type LocaleEventPayload = Static<typeof LocaleEventPayload>;

/** 语言设置在数据目录配置区里的文件（config/language.json） */
export const LanguageFile = Type.Object({ format: Type.Literal(1), language: Type.String() });
export type LanguageFile = Static<typeof LanguageFile>;

/** 换语言（POST /api/language）：只能选语言列表里有的 */
export const LanguageBody = Type.Object({ language: Type.String() });
export type LanguageBody = Static<typeof LanguageBody>;

/** 换语言的结果：存下的语言，有没有变化（没变化不推事件） */
export const LanguageResult = Type.Object({ language: Type.String(), changed: Type.Boolean() });
export type LanguageResult = Static<typeof LanguageResult>;

const MetaView = Type.Object({
  id: Type.String(),
  nativeName: Type.String(),
  modelName: Type.String(),
  intlLocale: Type.String(),
});

/** 语言从哪来：自带的、~/.ergo/locales 里新加的、自带的被 ~/.ergo/locales 里的改了几句 */
export const LOCALE_SOURCES = ["builtin", "user", "builtin_user"] as const;
export type LocaleSource = (typeof LOCALE_SOURCES)[number];

/** 设置 · 语言里的一种语言 */
export const LocaleSummary = Type.Object({
  id: Type.String(),
  nativeName: Type.String(),
  source: Type.Enum(LOCALE_SOURCES),
  /** ~/.ergo/locales 里改了自带的几句（builtin_user 时） */
  overridden: Type.Integer({ minimum: 0 }),
  /** 比中文缺几句（复数的几种写法算一句）：缺的用中文补 */
  missing: Type.Integer({ minimum: 0 }),
});
export type LocaleSummary = Static<typeof LocaleSummary>;

/** 读语言文件时出的问题：哪个文件（相对 ~/.ergo/locales 的路径）、哪里错（网页按 code 写成话） */
export const LocaleProblemView = Type.Object({
  file: Type.String(),
  code: Type.Enum(LOCALE_PROBLEM_CODES),
  key: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
});
export type LocaleProblemView = Static<typeof LocaleProblemView>;

/** 设置 · 语言（GET /api/locales）：选的、实际在用的、有哪些语言、~/.ergo/locales 的真实路径、读文件出的问题 */
export const LocaleListView = Type.Object({
  language: Type.String(),
  effective: Type.String(),
  userDir: Type.String(),
  languages: Type.Array(LocaleSummary),
  problems: Type.Array(LocaleProblemView),
  revision: Type.String(),
});
export type LocaleListView = Static<typeof LocaleListView>;

/**
 * 网页的词典（GET /api/locale）：实际在用的语言的说明和句子（自带 + ~/.ergo/locales 里的，合好的，只有网页用到的区域），
 * 中文的（回退用；在用的就是中文时不给）。网页再垫上打包进去的自带语言（守护进程比网页旧时缺的新句子照样有）
 */
export const LocaleDictionaryView = Type.Object({
  language: Type.String(),
  meta: MetaView,
  messages: Type.Record(Type.String(), Type.String()),
  fallback: Type.Optional(Type.Record(Type.String(), Type.String())),
  revision: Type.String(),
});
export type LocaleDictionaryView = Static<typeof LocaleDictionaryView>;
