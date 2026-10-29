// 网页这一侧的多语言（168 号票）：装上正在用的语言、跟着守护进程换、让界面重画。
//
// - 页面脚本一开始（main.tsx 最先引它）就装上：这台设备上次用的那种（localStorage 里记着上次守护进程给的词典），没记过用打包进去的中文。
//   免得英文用户每次打开先闪一下中文；
// - 由守护进程提供页面时：语言频道上的临时事件 locale（订阅时补推一条）带着实际在用的语言和词典的版本，版本和手里的对不上就
//   GET /api/locale 取完整的词典（自带 + ~/.ergo/locales 里的，合好的），垫上打包进去的自带语言装上（守护进程比网页旧时，
//   网页新加的句子照样有），记到这台设备上。换了语言、语言文件变了，开着的页面不刷新就换过来；
// - 原型（file://）：假连接扮演守护进程，词典取自打包进去的（prototype/fake-http.ts）；
// - 界面重画：App 最外层用 useLocale()，换了语言整棵树重画（组件里直接调 t() 就行）；memo 了的组件、useMemo 里用了 t() 的，
//   自己也调 useLocale()（或把它放进依赖），不然换了语言还是旧的；
// - <html lang> 跟着换（读屏、浏览器的断词按它）。
import { useEffect, useSyncExternalStore } from "react";
import {
  type ActiveLocale,
  activeLocale,
  DEFAULT_LANGUAGE,
  type LocaleDictionaryView,
  type LocaleEventPayload,
  localeRevision,
  type LocaleMeta,
  mergeMessages,
  type Messages,
  onLocaleChange,
  setActiveLocale,
} from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";
import { BUNDLED_LOCALES } from "./locale-bundle.ts";

/** 记在 localStorage 里的键：上次守护进程给的词典（连同版本） */
const CACHE_KEY = "ergo-locale";

/** 现在装着的是守护进程哪一版的词典（还没装过守护进程给的是 undefined） */
let appliedRevision: string | undefined;

const bundledZh = () => BUNDLED_LOCALES.get(DEFAULT_LANGUAGE);

/** 由守护进程给的词典拼出"正在用的语言"：垫上打包进去的自带语言 */
export function layeredLocale(view: Pick<LocaleDictionaryView, "language" | "meta" | "messages" | "fallback">): ActiveLocale {
  const zh = bundledZh();
  const bundled = BUNDLED_LOCALES.get(view.language);
  const zhMessages: Messages = view.language === DEFAULT_LANGUAGE ? view.messages : (view.fallback ?? {});
  return {
    meta: view.meta,
    messages: mergeMessages(bundled?.messages ?? {}, view.messages),
    fallbackMeta: zh?.meta ?? view.meta,
    fallback: mergeMessages(zh?.messages ?? {}, zhMessages),
  };
}

/** 打包进去的某种语言（没有就是中文） */
export function bundledLocale(language: string): ActiveLocale {
  const zh = bundledZh();
  const entry = BUNDLED_LOCALES.get(language) ?? zh;
  const meta: LocaleMeta = entry?.meta ?? { id: DEFAULT_LANGUAGE, nativeName: DEFAULT_LANGUAGE, modelName: DEFAULT_LANGUAGE, intlLocale: DEFAULT_LANGUAGE };
  return { meta, messages: entry?.messages ?? {}, fallbackMeta: zh?.meta ?? meta, fallback: zh?.messages ?? {} };
}

function install(locale: ActiveLocale): void {
  setActiveLocale(locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale.meta.intlLocale;
}

/** 记在这台设备上的词典（守护进程给的那份原样） */
function readCache(storage: DeviceStorage): LocaleDictionaryView | undefined {
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as LocaleDictionaryView;
    return typeof value?.language === "string" && typeof value.revision === "string" && value.meta && typeof value.messages === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 原型（file://）一开始用哪种语言：地址里的 ?lang=（打包进去的那几种才认），没写是中文 */
export function prototypeLanguage(): string {
  const wanted = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
  return wanted !== null && BUNDLED_LOCALES.has(wanted) ? wanted : DEFAULT_LANGUAGE;
}

/** 页面一开始：装上这台设备上次用的那种（记着的词典），没记过用打包进去的中文；language 给了就用打包进去的那种（原型的 ?lang=） */
export function bootLocale(storage: () => DeviceStorage, language?: string): void {
  if (language !== undefined) return install(bundledLocale(language));
  let cached: LocaleDictionaryView | undefined;
  try {
    cached = readCache(storage());
  } catch {
    cached = undefined;
  }
  if (cached) appliedRevision = cached.revision;
  install(cached ? layeredLocale(cached) : bundledLocale(DEFAULT_LANGUAGE));
}

/** 装上守护进程给的词典，记到这台设备上 */
export function applyDictionary(view: LocaleDictionaryView, storage: () => DeviceStorage): void {
  appliedRevision = view.revision;
  install(layeredLocale(view));
  try {
    storage().setItem(CACHE_KEY, JSON.stringify(view));
  } catch {
    // 存不了（隐私模式、满了）：这次照样换上，下次打开先用中文
  }
}

/** 现在装着的语言（测试、Debug 工具集看） */
export function appliedLocale(): { language: string; revision: string | undefined } {
  return { language: activeLocale().meta.id, revision: appliedRevision };
}

/** 换了语言时重画：返回词典换过几次（放进 useMemo 的依赖也行） */
export function useLocale(): number {
  return useSyncExternalStore(onLocaleChange, localeRevision, localeRevision);
}

/**
 * 跟着守护进程换词典：语言频道上推来的版本和手里的对不上就取一份（取的路上又变了，取到的版本对不上的照样装上，下一次再比）。
 * 放在 StoreProvider 里面，整个页面一份
 */
export function useDaemonLocale(http: { locale(): Promise<LocaleDictionaryView> }, locale: LocaleEventPayload | undefined, storage: () => DeviceStorage): void {
  const revision = locale?.revision;
  useEffect(() => {
    if (revision === undefined || revision === appliedRevision) return;
    let cancelled = false;
    http.locale().then(
      (view) => {
        if (!cancelled) applyDictionary(view, storage);
      },
      () => {
        // 取不到（断线了）：手里的照用，下次推来版本再取
      },
    );
    return () => {
      cancelled = true;
    };
  }, [http, revision, storage]);
}
