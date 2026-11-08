// 加载谷歌的 Maps JavaScript API（446）：照谷歌官方的"动态库导入"加载法（developers.google.com/maps/documentation/javascript/load-maps-js-api
// 的 bootstrap loader，这里写成读得懂的样子，参数一样）：
// - 往页面里加一个 <script src="https://maps.googleapis.com/maps/api/js?key=…&v=3.65&language=…&callback=google.maps.__ib__">，
//   脚本好了谷歌叫 google.maps.__ib__，再 google.maps.importLibrary("maps") 拿到 Map、Polyline、Circle、OverlayView；
// - 版本写死（GOOGLE_MAPS_VERSION，谷歌每季度出一版、每版留大约一年；删了以后谷歌自动给默认那一档，地图照样能用——升级时改这一个数、
//   跑页面测试）；
// - 一页只加载一次（谷歌的规矩：同一页再加载会被忽略）：同一个 Key 交回同一份；换了 Key 要刷新页面才生效（抛错说明）；
// - 谷歌说 Key 不对（Key 填错、没开 Maps JavaScript API、网站限制里没写这个地址、没开结算）时叫全局的 gm_authFailure（谷歌文档写的办法），
//   这里转给登记了的（onGoogleAuthFailure：谷歌那一种引擎、报给守护进程的那一份）；
// - 加载不上（设备在中国大陆连不上谷歌、断网）、15 秒没好：抛错，message 给人看——地图页写一句、地图切换里这一家标"连不上"、退回"自动"。
// 这是二狗第二处运行时从外站加载的脚本（第一处是高德，ADR-0051）；只在真要画谷歌地图时才加载（看足迹时、在大陆"自动"时一次都不连谷歌）。
// 测试和演示页换成假的（setGoogleLoader），不连真的谷歌。
import { activeLanguage, t } from "../../state/index.ts";
import type { GoogleMapsLibrary } from "./google-engine.ts";

/** 谷歌 Maps JavaScript API 的脚本地址 */
export const GOOGLE_MAPS_SCRIPT_URL = "https://maps.googleapis.com/maps/api/js";
/** 写死的版本（谷歌的"quarterly"那一版的版本号，2026-11） */
export const GOOGLE_MAPS_VERSION = "3.65";
/** 加载谷歌的脚本最多等多久 */
const LOAD_TIMEOUT_MS = 15_000;
/** 脚本好了谷歌叫的回调（官方加载法里的名字） */
const CALLBACK = "__ib__";

/** 怎么拿到谷歌：Key → importLibrary("maps") 交回的那一份 */
export type GoogleLoader = (key: string) => Promise<GoogleMapsLibrary>;

interface GoogleMapsGlobal {
  importLibrary?(name: string): Promise<unknown>;
  [CALLBACK]?: () => void;
}
type GoogleWindow = Window & { google?: { maps?: GoogleMapsGlobal }; gm_authFailure?: () => void };

/** 谷歌说 Key 不对时要叫的 */
const authListeners = new Set<() => void>();

/** 登记"谷歌说 Key 不对"（交回撤销）；谷歌的 gm_authFailure 是全局的，一页一个，这里分给每个登记的 */
export function onGoogleAuthFailure(handler: () => void): () => void {
  authListeners.add(handler);
  return () => authListeners.delete(handler);
}

/** 谷歌叫 gm_authFailure 时：转给每一个登记的（测试里直接叫它扮谷歌） */
export function googleAuthFailed(): void {
  for (const fn of authListeners) fn();
}

let pending: { key: string; promise: Promise<GoogleMapsLibrary> } | undefined;

/** 真的加载：官方的动态库导入加载法（同一个 Key 只加载一次；换了 Key 要刷新页面） */
export const loadGoogleScript: GoogleLoader = (key) => {
  if (pending !== undefined) return pending.key === key ? pending.promise : Promise.reject(new Error(t("ui.plugins.googleMaps.reloadForKey")));
  const w = window as unknown as GoogleWindow;
  w.gm_authFailure = googleAuthFailed;
  const promise = new Promise<GoogleMapsLibrary>((resolve, reject) => {
    const unreachable = () => reject(new Error(t("ui.plugins.googleMaps.unreachable")));
    const timer = setTimeout(unreachable, LOAD_TIMEOUT_MS);
    const g = (w.google ??= {});
    const maps = (g.maps ??= {});
    maps[CALLBACK] = () => {
      clearTimeout(timer);
      const importLibrary = maps.importLibrary;
      if (typeof importLibrary !== "function") return unreachable();
      importLibrary.call(maps, "maps").then((lib) => {
        const l = lib as Partial<GoogleMapsLibrary>;
        if (typeof l.Map === "function" && typeof l.OverlayView === "function") resolve(l as GoogleMapsLibrary);
        else unreachable();
      }, unreachable);
    };
    const params = new URLSearchParams({ key, v: GOOGLE_MAPS_VERSION, language: activeLanguage(), callback: `google.maps.${CALLBACK}` });
    const script = document.createElement("script");
    script.async = true;
    script.src = `${GOOGLE_MAPS_SCRIPT_URL}?${params}`;
    script.addEventListener("error", () => {
      clearTimeout(timer);
      unreachable();
    });
    document.head.append(script);
  });
  pending = { key, promise };
  // 没加载上的可以再试（比如设备换了网络）：下一次真要用时重新加
  promise.catch(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  return promise;
};

let loader: GoogleLoader = loadGoogleScript;

/** 换掉加载谷歌的办法（演示页、测试给假的） */
export function setGoogleLoader(next: GoogleLoader): void {
  loader = next;
}

/** 加载谷歌（用现在登记的办法） */
export function loadGoogle(key: string): Promise<GoogleMapsLibrary> {
  return loader(key);
}
