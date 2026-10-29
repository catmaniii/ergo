// 全局语言设置（168 号票，用户 2026-10-19 定：全局一个语言，所有设备、秘书都用它）。
//
// 照个人助理的名字（assistant/assistant-name.ts）存和推，不另起一套：
// - 设置存在数据目录配置区的 language.json（{ format: 1, language }），是真相；只由运行时写（设置接口）。
// - 每次换语言是语言频道上的一条 language 事件（设置里选的那种）；先写文件、再追加事件。启动时文件和上一条事件不一样
//   （停着时手改过、从备份恢复了配置区）就以文件为准补一条 config_file 的；文件读不了、不对时不覆盖它，沿用上一次的。
// - 实际在用的语言（effective）：选的那种在语言列表里就是它；不在了（~/.ergo/locales 里删了）先用中文，设置不动，放回来又用上。
// - 实际在用的语言、或者语言文件变了：换上"正在用的语言"（t() 从此按它，守护进程这之后生成的话就是新语言；以前存下的不动），
//   词典版本号换一个，在语言频道上推一条临时事件 locale（网页据此重取词典，开着的页面不刷新就换过来）；
//   实际在用的语言变了还通知 onChange 的（秘书据此手头这一条处理完按新的系统提示重新拉起；维护者交下一条输入之前看一眼，见 agent-host）。
// - 停下时装回自带的中文（同一个进程里接着起的守护进程、单元测试从干净的开始）。
import fs from "node:fs";
import {
  CHANNELS,
  DEFAULT_LANGUAGE,
  EVENT_TYPES,
  type EventFrame,
  isLanguageId,
  type LanguageEventPayload,
  LanguageFile,
  type LanguageSource,
  type LocaleDictionaryView,
  type LocaleEventPayload,
  type LocaleListView,
  type LocaleMeta,
  schemaChecker,
  setActiveLocale,
  t,
  webMessages,
} from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { activeLocaleOf, installBuiltinLocales } from "./builtin.ts";
import type { Locales } from "./locales.ts";

const languageFile = schemaChecker(LanguageFile);

export interface LanguageService {
  /** 设置里选的语言（没选过是中文） */
  setting(): string;
  /** 实际在用的语言的说明（选的那种不在了时是中文） */
  effective(): LocaleMeta;
  /** 换语言：只能选语言列表里有的（不然抛 RequestRejected），写配置文件，有变化时追加事件 */
  change(raw: string, source: LanguageSource): { language: string; changed: boolean };
  /** 词典的版本（实际在用的语言、语言文件一变就换） */
  revision(): string;
  /** 设置 · 语言 */
  list(): LocaleListView;
  /** 网页的词典：实际在用的语言（只有网页用到的区域），不是中文时连同中文的 */
  dictionary(): LocaleDictionaryView;
  /** 语言频道上补推的临时事件（订阅时）：实际在用的语言和词典的版本 */
  snapshot(): EventFrame;
  /** 实际在用的语言变了（换了一种、或者它给模型的名字改了）时叫 fn；返回取消登记的函数 */
  onChange(fn: (meta: LocaleMeta) => void): () => void;
  /** 读配置文件，和事件日志对一遍，装上正在用的语言；之后跟着事件和语言文件走 */
  start(): void;
  stop(): void;
}

export interface LanguageServiceOptions {
  store: EventStore;
  layout: DataDirLayout;
  locales: Locales;
  /** 推临时事件（守护进程的 notifications） */
  publish(frame: EventFrame): void;
  log: (line: string) => void;
}

export function createLanguageService(options: LanguageServiceOptions): LanguageService {
  const { store, layout, locales, log } = options;
  const file = layout.languageFile;
  const boot = Date.now().toString(36);
  let setting = DEFAULT_LANGUAGE;
  let meta: LocaleMeta | undefined;
  let installs = 0;
  const listeners = new Set<(meta: LocaleMeta) => void>();
  let offStore: (() => void) | undefined;
  let offLocales: (() => void) | undefined;

  const append = (payload: LanguageEventPayload) => store.append({ channel: CHANNELS.language, type: EVENT_TYPES.language, payload });
  const effectiveId = () => (locales.catalog(setting) ? setting : DEFAULT_LANGUAGE);
  const revision = () => `${boot}-${installs}`;
  const localeFrame = (): EventFrame => ({
    channel: CHANNELS.language,
    seq: store.lastSeq(CHANNELS.language),
    type: EVENT_TYPES.locale,
    payload: { language: effectiveId(), revision: revision() } satisfies LocaleEventPayload,
  });

  /** 按现在的设置和语言文件换上正在用的语言；推一条临时事件；实际在用的语言变了通知 */
  const install = () => {
    const active = activeLocaleOf(locales.current(), effectiveId());
    const before = meta;
    meta = active.meta;
    installs += 1;
    setActiveLocale(active);
    options.publish(localeFrame());
    if (before && (before.id !== meta.id || before.modelName !== meta.modelName)) {
      log(`正在用的语言换成了 ${meta.id}（${meta.nativeName}）`);
      for (const fn of listeners) fn(meta);
    }
  };

  /** 配置文件里的语言；没有文件是 undefined；文件不对时 null（记日志，不覆盖它） */
  const readFile = (): string | undefined | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      log(`语言设置的配置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先按事件日志里上一次的用`);
      return null;
    }
    if (languageFile.check(parsed) && isLanguageId(parsed.language)) return parsed.language;
    log(`语言设置的配置文件不对：${file}：${languageFile.firstError(parsed) ?? "不是语言代码"}；先按事件日志里上一次的用`);
    return null;
  };

  return {
    setting: () => setting,
    effective: () => meta ?? activeLocaleOf(locales.current(), effectiveId()).meta,
    change(raw, source) {
      const language = raw.trim();
      if (!locales.catalog(language)) throw new RequestRejected("bad_params", t("i18n.unknownLanguage", { language }));
      if (language === setting) return { language, changed: false };
      writeJsonAtomic(file, { format: 1, language } satisfies LanguageFile);
      append({ language, source });
      return { language, changed: true };
    },
    revision,
    list: () => ({
      language: setting,
      effective: effectiveId(),
      userDir: locales.userDir,
      languages: locales.summaries(),
      problems: locales.problems(),
      revision: revision(),
    }),
    dictionary() {
      const active = activeLocaleOf(locales.current(), effectiveId());
      return {
        language: active.meta.id,
        meta: { ...active.meta },
        messages: webMessages(active.messages),
        ...(active.meta.id === DEFAULT_LANGUAGE ? {} : { fallback: webMessages(active.fallback) }),
        revision: revision(),
      };
    },
    snapshot: localeFrame,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    start() {
      offStore = store.onAppend((event) => {
        if (event.channel !== CHANNELS.language || event.type !== EVENT_TYPES.language) return;
        const next = (event.payload as LanguageEventPayload).language;
        if (next === setting) return;
        setting = next;
        install();
      });
      setting = (store.read(CHANNELS.language, 0, EVENT_TYPES.language).at(-1)?.payload as LanguageEventPayload | undefined)?.language ?? DEFAULT_LANGUAGE;
      install();
      // 配置文件是真相：和上一条事件（没有事件就是中文）不一样就补一条
      const fromFile = readFile();
      if (typeof fromFile === "string" && fromFile !== setting) append({ language: fromFile, source: "config_file" });
      // 语言文件变了：句子可能换了、选的那种可能出现或不在了
      offLocales = locales.onChange(install);
    },
    stop() {
      offStore?.();
      offLocales?.();
      listeners.clear();
      installBuiltinLocales();
    },
  };
}
