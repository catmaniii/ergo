// "浏览"页签（134 号票）记在这台设备上的几样（localStorage）：搜索引擎（设置 · 浏览与填框里选，默认必应）、最近访问（打开过的网页，
// 空白页上列出来；165 号票起就是完整的浏览记录，最多 500 条，能删、多选删、清空、清一个网站的）、按网站记住的文字大小和桌面版
// （165 号票，按主机名）。和别的设备设置一样：存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效，不抛错。
// 认不认记住的值在 state/browse.ts、state/browse-tools.ts。页面上用的那一份在 app/page-browse.ts。
import {
  addRecentVisit,
  parseRecentVisits,
  parseSiteSettings,
  type RecentVisit,
  removeSiteVisits,
  removeVisits,
  type SearchEngineId,
  searchEngineOf,
  type SiteSettings,
  withSiteSetting,
} from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

const SEARCH_ENGINE_KEY = "ergo-search-engine";
const RECENT_VISITS_KEY = "ergo-browse-recents";
const SITE_SETTINGS_KEY = "ergo-browse-sites";

export interface BrowseSettings {
  searchEngine(): SearchEngineId;
  setSearchEngine(engine: SearchEngineId): void;
  recents(): readonly RecentVisit[];
  /** 打开了一页（地址、标题），记进最近访问 */
  visited(url: string, title: string): void;
  /** 删几条浏览记录（按地址：长按删一条、多选删） */
  removeVisits(urls: Iterable<string>): void;
  /** 清一个网站的浏览记录（清除浏览数据选"只清当前网站"） */
  removeSiteVisits(host: string): void;
  clearRecents(): void;
  /** 按网站记住的文字大小、桌面版 */
  sites(): SiteSettings;
  setSiteZoom(host: string, zoom: number): void;
  setSiteDesktop(host: string, on: boolean): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

export function browseSettingsIn(storage: () => DeviceStorage, now: () => number = Date.now): BrowseSettings {
  const read = (key: string): string | null => {
    try {
      return storage().getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | undefined) => {
    try {
      if (value === undefined) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch {
      // 存不了：这次打开里照样生效
    }
  };
  let engine = searchEngineOf(read(SEARCH_ENGINE_KEY));
  let recents: readonly RecentVisit[] = parseRecentVisits(read(RECENT_VISITS_KEY));
  let sites: SiteSettings = parseSiteSettings(read(SITE_SETTINGS_KEY));
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  /** 换一份浏览记录（条数一样就是没变：删、清只会变少，visited 自己比较） */
  const setRecents = (next: readonly RecentVisit[]) => {
    if (next.length === recents.length) return;
    recents = next;
    write(RECENT_VISITS_KEY, next.length === 0 ? undefined : JSON.stringify(next));
    changed();
  };
  const setSites = (next: SiteSettings) => {
    if (JSON.stringify(next) === JSON.stringify(sites)) return;
    sites = next;
    write(SITE_SETTINGS_KEY, Object.keys(next).length === 0 ? undefined : JSON.stringify(next));
    changed();
  };
  return {
    searchEngine: () => engine,
    setSearchEngine(next) {
      if (next === engine) return;
      engine = next;
      write(SEARCH_ENGINE_KEY, next);
      changed();
    },
    recents: () => recents,
    visited(url, title) {
      const next = addRecentVisit(recents, { url, title, time: now() });
      if (next.length === recents.length && next.every((v, i) => v.url === recents[i]!.url && v.title === recents[i]!.title)) return;
      recents = next;
      write(RECENT_VISITS_KEY, JSON.stringify(next));
      changed();
    },
    removeVisits: (urls) => setRecents(removeVisits(recents, urls)),
    removeSiteVisits: (host) => setRecents(removeSiteVisits(recents, host)),
    clearRecents: () => setRecents([]),
    sites: () => sites,
    setSiteZoom: (host, zoom) => setSites(withSiteSetting(sites, host, { zoom })),
    setSiteDesktop: (host, on) => setSites(withSiteSetting(sites, host, { desktop: on })),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
