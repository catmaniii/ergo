// "浏览"页签（134 号票，鸿蒙 App 里的原生内置浏览器）的纯函数：搜索引擎（必应、百度、搜狗、谷歌，默认必应，设置里能改）、
// 最近访问（打开过的网页的标题和地址，空白页上列出来；165 号票起就是完整的浏览记录，删、清空、分组、搜在 browse-tools.ts）。地址栏里打的字变成要打开的网址在 app/browse-address.ts（要用 URL），
// 记在这台设备上的那一半在 app/browse-settings.ts。
import { BROWSE_SEARCH_ENGINE_IDS, BROWSE_SEARCH_ENGINES, type BrowseSearchEngineId, browseSearchEngineOf, browseSearchUrl, DEFAULT_BROWSE_SEARCH_ENGINE, t, tTable } from "./protocol.ts";

/** 搜索引擎的名字（170 号票起按当前语言现取） */
const ENGINE_LABEL = tTable({ bing: "state.browse.engine.bing", baidu: "state.browse.engine.baidu", sogou: "state.browse.engine.sogou", google: "state.browse.engine.google" });

/**
 * 能选的搜索引擎：名字和搜索地址（关键词按 encodeURIComponent 接在后面）；名字是取值函数，用的时候现取。
 * 182 号票起地址、认不认得、拼地址在协议包（守护进程给秘书拼内置浏览器要打开的结果页也用），这里只多名字
 */
export const SEARCH_ENGINES = {
  bing: {
    get label() {
      return ENGINE_LABEL.bing;
    },
    search: BROWSE_SEARCH_ENGINES.bing,
  },
  baidu: {
    get label() {
      return ENGINE_LABEL.baidu;
    },
    search: BROWSE_SEARCH_ENGINES.baidu,
  },
  sogou: {
    get label() {
      return ENGINE_LABEL.sogou;
    },
    search: BROWSE_SEARCH_ENGINES.sogou,
  },
  google: {
    get label() {
      return ENGINE_LABEL.google;
    },
    search: BROWSE_SEARCH_ENGINES.google,
  },
} as const;

export type SearchEngineId = BrowseSearchEngineId;

export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = BROWSE_SEARCH_ENGINE_IDS;

/** 默认用必应（国内能直接用、广告少）；设置 · 浏览与填框里能改 */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = DEFAULT_BROWSE_SEARCH_ENGINE;

/** 记住的值认不认得：不认得（没记过、改过名）按默认 */
export const searchEngineOf: (raw: string | null | undefined) => SearchEngineId = browseSearchEngineOf;

/** 关键词的搜索地址 */
export const searchUrl: (query: string, engine: SearchEngineId) => string = browseSearchUrl;

/** 一条最近访问：地址、标题（取不到是空的，显示地址）、什么时候打开的（毫秒） */
export interface RecentVisit {
  readonly url: string;
  readonly title: string;
  readonly time: number;
}

/**
 * 浏览记录最多记几条（165 号票：原来最近访问只记 20 条，现在是完整的浏览记录——菜单里"浏览记录"列全部、能搜能删，
 * 空白页的"最近访问"列前 RECENTS_SHOWN 条，地址栏输入时的候选从全部里找）
 */
export const BROWSE_HISTORY_MAX = 500;

/** 空白页的"最近访问"列几条（更多的在菜单的"浏览记录"里） */
export const RECENTS_SHOWN = 20;

/** 打开了一页：放到最前面（同一个地址只留一条，标题用新的；新的没标题就留旧的）；只记 http、https，最多 BROWSE_HISTORY_MAX 条 */
export function addRecentVisit(list: readonly RecentVisit[], visit: RecentVisit, max = BROWSE_HISTORY_MAX): RecentVisit[] {
  if (!/^https?:\/\//i.test(visit.url)) return [...list];
  const old = list.find((v) => v.url === visit.url);
  const title = visit.title.trim() || old?.title || "";
  return [{ url: visit.url, title, time: visit.time }, ...list.filter((v) => v.url !== visit.url)].slice(0, max);
}

/** 记住的最近访问（JSON）：认不得的条目丢掉 */
export function parseRecentVisits(raw: string | null | undefined): RecentVisit[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is RecentVisit => typeof v === "object" && v !== null && typeof v.url === "string" && /^https?:\/\//i.test(v.url) && typeof v.title === "string" && typeof v.time === "number")
      .slice(0, BROWSE_HISTORY_MAX)
      .map((v) => ({ url: v.url, title: v.title, time: v.time }));
  } catch {
    return [];
  }
}

/** 列表里一行显示的地址：去掉 https://、末尾的斜杠 */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/**
 * 秘书会话里网页指令那一句（134 号票第二部分，MessageEnvelope.pageCommand）下面的小字：在哪个网页、哪个框上说的、是说的还是打的。
 * 网页没标题写地址（去掉 http(s)://）
 */
export function pageCommandLabel(mark: { title: string; url: string; field: string; spoken?: boolean }): string {
  const page = (mark.title.trim() || shortAddress(mark.url)).slice(0, 40);
  if (mark.field) return t(mark.spoken ? "state.browse.pageCommand.fieldSpoken" : "state.browse.pageCommand.fieldTyped", { page, field: mark.field.slice(0, 30) });
  return t(mark.spoken ? "state.browse.pageCommand.boxSpoken" : "state.browse.pageCommand.boxTyped", { page });
}

/**
 * 网页候选卡（147 号票，browse_pick）上点一张：单张的框就选这一张，多张的框勾上或取消；按候选的先后排（照 145 号票的候选面板）。
 * order 是候选的取件码（按卡上的先后），不在里面的不认
 */
export function togglePick(selected: readonly string[], token: string, multiple: boolean, order: readonly string[]): string[] {
  if (!order.includes(token)) return [...selected];
  const chosen = multiple ? (selected.includes(token) ? selected.filter((x) => x !== token) : [...selected, token]) : [token];
  return order.filter((x) => chosen.includes(x));
}

/** 网页候选卡一开始选上哪几个：秘书推荐的（单张的框只取第一个） */
export function initialPick(card: { multiple: boolean; recommended: readonly string[]; files: readonly { token: string }[] }): string[] {
  const recommended = card.files.map((f) => f.token).filter((x) => card.recommended.includes(x));
  return card.multiple ? recommended : recommended.slice(0, 1);
}
