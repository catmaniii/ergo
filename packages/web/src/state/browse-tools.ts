// "浏览"页签右上角 ⋮ 菜单（165 号票，用户 2026-10-19：替掉"用系统浏览器打开"的按钮，以后还能扩展别的选项；菜单项用户勾选）的纯函数：
// - 菜单（browseMenu）：三组十项——二狗（让二狗总结这一页、存进二狗的素材）、这一页（在页面里查找、文字大小、桌面版网站、分享、
//   用系统浏览器打开）、记录和数据（浏览记录、下载记录、清除浏览数据）。还没打开网页时和这一页有关的灰掉；旧版 App 上原生做不了的
//   灰掉、写"装新版 App 才能用"；
// - 按网站记住的文字大小、桌面版（SiteSettings，按主机名；记在这台设备上，app/browse-settings.ts），交给 App 的那一份（siteTuning）；
// - 浏览记录（state/browse.ts 的最近访问，165 号票起最多 500 条）：删几条、清一个网站的、搜、按日期分组（今天、昨天、更早）；
// - 查找栏的计数（findCountLabel）、下载记录存在哪（downloadWhere）、清除浏览数据怎么分给 App 和网页（clearPlan）。
import { type RecentVisit } from "./browse.ts";
import { t, tTable } from "./protocol.ts";

// ───────────────────────── 浏览记录 ─────────────────────────

/** 删几条（按地址） */
export function removeVisits(list: readonly RecentVisit[], urls: Iterable<string>): RecentVisit[] {
  const gone = new Set(urls);
  return list.filter((v) => !gone.has(v.url));
}

/** 清一个网站的（主机名一样的都删，不分路径和 http、https） */
export function removeSiteVisits(list: readonly RecentVisit[], host: string): RecentVisit[] {
  return list.filter((v) => siteKeyOf(v.url) !== host);
}

/** 搜：地址或标题里有（不分大小写）；空的不过滤 */
export function filterVisits(list: readonly RecentVisit[], query: string): readonly RecentVisit[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((v) => v.url.toLowerCase().includes(q) || v.title.toLowerCase().includes(q));
}

/** 浏览记录的一组 */
export interface VisitGroup {
  readonly key: "today" | "yesterday" | "earlier";
  readonly label: string;
  readonly visits: readonly RecentVisit[];
}

/** 本地日期那一天 0 点（毫秒） */
function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 按日期分组：今天、昨天、更早（按本地日期；没有的组不出现；组里新的在前） */
export function historyGroups(list: readonly RecentVisit[], now: number): VisitGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const sorted = list.toSorted((a, b) => b.time - a.time);
  const groups: VisitGroup[] = [
    { key: "today", label: t("state.browseTools.today"), visits: sorted.filter((v) => v.time >= today) },
    { key: "yesterday", label: t("state.browseTools.yesterday"), visits: sorted.filter((v) => v.time >= yesterday && v.time < today) },
    { key: "earlier", label: t("state.browseTools.earlier"), visits: sorted.filter((v) => v.time < yesterday) },
  ];
  return groups.filter((g) => g.visits.length > 0);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 一条的时间：今天、昨天写时分，更早写月日，不是今年的带年份 */
export function visitTimeLabel(time: number, now: number): string {
  const d = new Date(time);
  if (time >= dayStart(dayStart(now) - 1)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

// ───────────────────────── 按网站记住的文字大小、桌面版 ─────────────────────────

/** 文字大小（百分比）：50%–200%，每次 10% */
export const TEXT_ZOOM = { min: 50, max: 200, step: 10, normal: 100 } as const;

/** 一个网站记住的（默认值不记：文字 100%、不是桌面版） */
export interface SiteSetting {
  readonly zoom?: number;
  readonly desktop?: true;
}

/** 按主机名记住的 */
export type SiteSettings = Readonly<Record<string, SiteSetting>>;

/** 最多记多少个网站（多的丢掉，免得存储越积越大） */
export const SITE_SETTINGS_MAX = 1000;

/** 主机名像样：字母数字、点、横线（IPv6 带方括号和冒号） */
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]{1,253})$/;

/** http(s) 地址的"协议://主机[:端口]"那一截（state 里不用 URL：这一层不碰浏览器的全局变量） */
const AUTHORITY = /^(https?):\/\/([^/?#]*)/i;

/** 网站按主机名认（小写，去掉用户名和端口）；不是 http(s) 的没有 */
export function siteKeyOf(url: string): string | undefined {
  const m = AUTHORITY.exec(url);
  if (!m) return undefined;
  const authority = m[2]!.replace(/^.*@/, "");
  const host = (authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:\d*$/, "")).toLowerCase();
  return HOST.test(host) && host !== "" ? host : undefined;
}

const clampZoom = (zoom: number) => Math.min(TEXT_ZOOM.max, Math.max(TEXT_ZOOM.min, Math.round(zoom)));

/** 这一页的网站的文字大小（没记过是 100） */
export function siteZoomOf(sites: SiteSettings, url: string): number {
  const key = siteKeyOf(url);
  return (key !== undefined && sites[key]?.zoom) || TEXT_ZOOM.normal;
}

/** 这一页的网站是不是桌面版 */
export function siteDesktopOf(sites: SiteSettings, url: string): boolean {
  const key = siteKeyOf(url);
  return key !== undefined && sites[key]?.desktop === true;
}

/** 再大一档、再小一档（不在档上的先落到档上），夹在范围里 */
export function stepTextZoom(zoom: number, dir: 1 | -1): number {
  const { step } = TEXT_ZOOM;
  const next = dir > 0 ? Math.floor(zoom / step) * step + step : Math.ceil(zoom / step) * step - step;
  return clampZoom(next);
}

/** 改一个网站的：默认值不记，一项都不剩就整条去掉；文字大小夹在范围里 */
export function withSiteSetting(sites: SiteSettings, host: string, change: { zoom?: number; desktop?: boolean }): SiteSettings {
  const old = sites[host] ?? {};
  const zoom = change.zoom === undefined ? old.zoom : clampZoom(change.zoom);
  const desktop = change.desktop === undefined ? old.desktop === true : change.desktop;
  const next: SiteSetting = { ...(zoom !== undefined && zoom !== TEXT_ZOOM.normal ? { zoom } : {}), ...(desktop ? { desktop: true as const } : {}) };
  const { [host]: _old, ...rest } = sites;
  return Object.keys(next).length === 0 ? rest : { ...rest, [host]: next };
}

/** 记住的（JSON）：认不得的条目丢掉 */
export function parseSiteSettings(raw: string | null | undefined): SiteSettings {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, SiteSetting> = {};
  for (const [host, s] of Object.entries(value as Record<string, unknown>).slice(0, SITE_SETTINGS_MAX)) {
    if (!HOST.test(host) || typeof s !== "object" || s === null) continue;
    const { zoom, desktop } = s as { zoom?: unknown; desktop?: unknown };
    const z = typeof zoom === "number" && Number.isFinite(zoom) ? clampZoom(zoom) : undefined;
    const setting: SiteSetting = { ...(z !== undefined && z !== TEXT_ZOOM.normal ? { zoom: z } : {}), ...(desktop === true ? { desktop: true as const } : {}) };
    if (Object.keys(setting).length > 0) out[host] = setting;
  }
  return out;
}

/** 交给 App 的（browserTool sites）：桌面版的浏览器标识、哪些网站用桌面版、哪些网站的文字大小不是 100% */
export interface SiteTuning {
  readonly desktopUserAgent: string;
  readonly desktop: readonly string[];
  readonly zoom: Readonly<Record<string, number>>;
}

export function siteTuning(sites: SiteSettings, desktopUa: string): SiteTuning {
  const entries = Object.entries(sites);
  return {
    desktopUserAgent: desktopUa,
    desktop: entries.filter(([, s]) => s.desktop === true).map(([host]) => host),
    zoom: Object.fromEntries(entries.flatMap(([host, s]) => (s.zoom !== undefined ? [[host, s.zoom] as const] : []))),
  };
}

/** 认不出 Chrome 版本时用的（ArkWeb 内核的版本附近） */
const FALLBACK_CHROME = "132.0.0.0";

/**
 * 桌面版的浏览器标识：手机的标识（"Mozilla/5.0 (Phone; OpenHarmony 5.0) … Chrome/114.0.0.0 Safari/537.36 ArkWeb/… Mobile"）换成
 * Windows 上 Chrome 的样子，Chrome 版本照旧（网站按版本判断能力），去掉 Mobile、Phone、ArkWeb——网站多半看这几个词给手机版
 */
export function desktopUserAgent(ua: string): string {
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? FALLBACK_CHROME;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

// ───────────────────────── ⋮ 菜单 ─────────────────────────

/** 菜单项 */
export type BrowseMenuId = "summarize" | "save" | "find" | "zoom" | "desktop" | "share" | "outside" | "history" | "downloads" | "clear";

export interface BrowseMenuItem {
  readonly id: BrowseMenuId;
  readonly label: string;
  /** 点不了的原因（灰掉，写在下面） */
  readonly disabled?: string;
  /** 带勾的开关（桌面版网站）开着没有 */
  readonly checked?: boolean;
  /** 文字大小那一行：现在多大、能不能再小、再大 */
  readonly zoom?: { readonly value: number; readonly down: boolean; readonly up: boolean };
}

export interface BrowseMenuGroup {
  readonly key: "ergo" | "page" | "records";
  readonly items: readonly BrowseMenuItem[];
}

export interface BrowseMenuInput {
  /** 现在这一页（还没打开网页是空串） */
  readonly url: string;
  readonly title: string;
  /** 有浏览侧边栏（147 号票的 App 才有）：让二狗总结这一页在那里发 */
  readonly side: boolean;
  /** 页面桥能取整页文字（147 号票的 App 才有）：存进素材要它 */
  readonly text: boolean;
  /** App 有 165 号票的原生工具（查找、文字大小、桌面版、分享、清数据、下载记录） */
  readonly tools: boolean;
  readonly sites: SiteSettings;
  /** 二狗自己的来源（转发的服务页面不分桌面版） */
  readonly ownOrigin: string;
}

/** 点不了的原因：旧版 App 上原生做不了、还没打开网页（170 号票起按当前语言现取，原来是常量 NEEDS_NEW_APP、NO_PAGE） */
export const BROWSE_DISABLED = tTable({ needsNewApp: "state.browseTools.needsNewApp", noPage: "state.browseTools.noPage" });

/**
 * 让二狗总结这一页：替用户发的那一句（147 号票侧边栏发消息的那条路，带网页上下文）。在聊天里是用户说的话，按当前语言写
 * （170 号票起是函数，原来是常量 SUMMARIZE_PAGE_TEXT）
 */
export function summarizePageText(): string {
  return t("state.browseTools.summarizePage");
}

/** 地址的来源（协议加主机加端口，小写）；不是 http(s) 是空串 */
function originOf(url: string): string {
  const m = AUTHORITY.exec(url);
  return m ? `${m[1]!.toLowerCase()}://${m[2]!.replace(/^.*@/, "").toLowerCase()}` : "";
}

/** 点不了的原因：第一个不是 false 的（没打开网页先于装新版 App） */
function why(...reasons: (string | false)[]): { disabled?: string } {
  const reason = reasons.find((r): r is string => r !== false);
  return reason === undefined ? {} : { disabled: reason };
}

/** 旧版 App 没有这样能力 */
const oldApp = (have: boolean) => !have && BROWSE_DISABLED.needsNewApp;

/** 菜单：三组十项 */
export function browseMenu(input: BrowseMenuInput): BrowseMenuGroup[] {
  const page = input.url !== "";
  const noPage = !page && BROWSE_DISABLED.noPage;
  const zoom = siteZoomOf(input.sites, input.url);
  const own = page && input.ownOrigin !== "" && originOf(input.url) === input.ownOrigin;
  return [
    {
      key: "ergo",
      items: [
        { id: "summarize", label: t("state.browseTools.menu.summarize"), ...why(noPage, oldApp(input.side)) },
        { id: "save", label: t("state.browseTools.menu.save"), ...why(noPage, oldApp(input.text)) },
      ],
    },
    {
      key: "page",
      items: [
        { id: "find", label: t("state.browseTools.menu.find"), ...why(noPage, oldApp(input.tools)) },
        { id: "zoom", label: t("state.browseTools.menu.zoom"), zoom: { value: zoom, down: zoom > TEXT_ZOOM.min, up: zoom < TEXT_ZOOM.max }, ...why(noPage, oldApp(input.tools)) },
        { id: "desktop", label: t("state.browseTools.menu.desktop"), checked: siteDesktopOf(input.sites, input.url), ...why(noPage, oldApp(input.tools), own && t("state.browseTools.ownNoDesktop")) },
        { id: "share", label: t("state.browseTools.menu.share"), ...why(noPage, oldApp(input.tools)) },
        { id: "outside", label: t("state.browseTools.menu.outside"), ...why(noPage) },
      ],
    },
    {
      key: "records",
      items: [
        { id: "history", label: t("state.browseTools.menu.history") },
        { id: "downloads", label: t("state.browseTools.menu.downloads"), ...why(oldApp(input.tools)) },
        { id: "clear", label: t("state.browseTools.menu.clear") },
      ],
    },
  ];
}

// ───────────────────────── 查找栏、下载记录、清除浏览数据 ─────────────────────────

/** App 报的查找结果：第几个（从 0 数）、一共几个、数完了没有 */
export interface FindResult {
  readonly active: number;
  readonly total: number;
  readonly done: boolean;
}

/** 查找栏的计数：第 n / 共 m 个；没找到；还在数的后面加省略号；没打字、还没结果不写 */
export function findCountLabel(query: string, result: FindResult | undefined): string {
  if (query.trim() === "" || !result) return "";
  if (result.total === 0) return result.done ? t("state.browseTools.notFound") : "";
  return `${t("state.browseTools.findCount", { n: Math.min(result.active + 1, result.total), total: result.total })}${result.done ? "" : "…"}`;
}

/** 系统"保存到"给的地址（file://docs/storage/Users/currentUser/Download/…）里用户认得的那一截 */
const USER_FILES = "file://docs/storage/Users/currentUser/";

/** 下载记录里"存在哪"：去掉用户目录前缀、解码；认不出的去掉 file:// 照原样解码，解不了照原样 */
export function downloadWhere(uri: string): string {
  const rest = uri.startsWith(USER_FILES) ? uri.slice(USER_FILES.length) : uri.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** 清除浏览数据的对话框上勾的 */
export interface ClearChoice {
  readonly cache: boolean;
  readonly cookies: boolean;
  readonly history: boolean;
  readonly scope: "all" | "site";
}

/** 交给 App 的（browserTool clear）：缓存、Cookie 和网站数据，全部还是只清这个地址的网站 */
export interface NativeClearRequest {
  readonly cache: boolean;
  readonly cookies: boolean;
  readonly scope: "all" | "site";
  readonly url: string;
}

export interface ClearPlan {
  readonly native?: NativeClearRequest;
  readonly history?: { readonly kind: "all" } | { readonly kind: "site"; readonly host: string };
}

/** 怎么清：缓存、Cookie 和网站数据交给 App，浏览记录在网页里清；没开网页时"只清当前网站"按全部 */
export function clearPlan(choice: ClearChoice, url: string): ClearPlan {
  const host = choice.scope === "site" ? siteKeyOf(url) : undefined;
  const site = host !== undefined;
  return {
    ...(choice.cache || choice.cookies ? { native: { cache: choice.cache, cookies: choice.cookies, scope: site ? "site" : "all", url: site ? url : "" } } : {}),
    ...(choice.history ? { history: site ? { kind: "site", host } : { kind: "all" } } : {}),
  };
}
