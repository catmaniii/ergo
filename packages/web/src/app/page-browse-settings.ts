// "浏览"的设备设置（134、165 号票：地址栏的搜索引擎、最近访问、按网站记住的文字大小和桌面版）接到这个页面的 localStorage 上，整个页面一份。
// 212 号票从浏览插件的 page-browse.ts 挪出来留在核心：设置 · 浏览与填框（pages/more/BrowsingPage.tsx，里面还有联网搜索、授权的文件夹，
// 都是内核的）也看、也改搜索引擎；浏览插件的"浏览"页、⋮ 菜单照旧从 page-browse.ts 取（那里转出这几个）。
// 单独一个文件，browse-settings.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { useSyncExternalStore } from "react";
import type { RecentVisit, SearchEngineId, SiteSettings } from "../state/index.ts";
import { type BrowseSettings, browseSettingsIn } from "./browse-settings.ts";

let settings: BrowseSettings | undefined;

/** 整个页面共用的一份（搜索引擎、最近访问） */
export function pageBrowseSettings(): BrowseSettings {
  settings ??= browseSettingsIn(() => window.localStorage);
  return settings;
}

export function useSearchEngine(): SearchEngineId {
  const s = pageBrowseSettings();
  return useSyncExternalStore(s.subscribe, s.searchEngine);
}

export function useRecentVisits(): readonly RecentVisit[] {
  const s = pageBrowseSettings();
  return useSyncExternalStore(s.subscribe, s.recents);
}

/** 按网站记住的文字大小、桌面版（165 号票），变了跟着变 */
export function useSiteSettings(): SiteSettings {
  const s = pageBrowseSettings();
  return useSyncExternalStore(s.subscribe, s.sites);
}
