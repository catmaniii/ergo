// 谷歌地图在"地图服务"插槽网页一半（mapBasemaps）里的那一条（446）：编号 google（和守护进程登记的一样）。
// - prepare(key)：没 Key 抛错；有 Key 交回建引擎的函数（453 起谷歌在隔离框里加载：引擎建好时还在加载，好了报 onReady，
//   加载不上、Key 不对报 onFailed——地图页写一句、地图切换里标"连不上"、手动选的退回"自动"；加载着的时候地图页写"正在加载谷歌地图…"）；
// - 建好的引擎（google-engine.ts）每建一张谷歌地图报一次 loaded、谷歌说 Key 不对报一次 auth_failed（POST /api/map/basemap，
//   守护进程数用量、记下 Key 被拒）；报不上不要紧（旧守护进程、断线），不耽误画地图。
// - GOOGLE_FRAME_ISOLATED：谷歌关进隔离框（453，默认）。万一真的谷歌在框里跑不通（比如网站限制认不出框里发的请求），
//   改成 false 就退回"同一个页面里跑、地图页那一层画"：足迹、点、线照样不交给谷歌的接口，只是它的脚本读得到页面（ADR-0059）。
// - navigation（434）：卡片上"用手机地图导航"在浏览器里（和旧版鸿蒙 App 里）打开谷歌地图的导航网址（googleNavigationUrl）。
// 演示页（MODE === "demo"）里框里装的是假谷歌（demo-google.ts，占位瓦片），不连谷歌；安装版这个分支摇掉（字面的 MODE 比较）。
import { GOOGLE_MAP_PROVIDER, type MapBasemapEventBody, t, wgsToGcj } from "../../state/index.ts";
import type { MapBasemapSlot, MapNavTarget } from "../api.ts";
import { installFakeGoogle } from "./demo-google.ts";
import { createGoogleEngine, type GoogleFake } from "./google-engine.ts";
import { demoTileSource, demoTileUrl } from "../../prototype/fake-map.ts";

/** 谷歌关进隔离框（453）；false 是退路：小桥在页面里跑 */
export const GOOGLE_FRAME_ISOLATED = true;

/**
 * 演示页：框里先装假谷歌（编的占位瓦片）。地址带 ?demo-google=unreachable（或者这台设备存了 ergo-demo-google-fail）时
 * 扮"这台设备连不上谷歌"（设备在中国大陆）：过一会儿加载失败
 */
const DEMO =
  import.meta.env.MODE === "demo"
    ? (): GoogleFake => {
        let unreachable = false;
        try {
          unreachable = new URLSearchParams(window.location.search).get("demo-google") === "unreachable" || localStorage.getItem("ergo-demo-google-fail") === "1";
        } catch {
          unreachable = false;
        }
        const options = { unreachable };
        return {
          code: `(${installFakeGoogle.toString()})(env.win, ${demoTileSource()}, ${JSON.stringify(options)});`,
          install: (win) => installFakeGoogle(win, (style, z, x, y) => demoTileUrl(style === "googleDark" ? "googleDark" : "google", z, x, y), options),
        };
      }
    : undefined;

/**
 * 谷歌地图的导航网址（434，Maps URLs：https://developers.google.com/maps/documentation/urls/get-started#directions-action）：
 * 各平台通用，手机上装了谷歌地图的打开 App、没装和电脑上打开网页版；终点写坐标（谷歌在大陆的街道图是 GCJ-02，大陆外原样），
 * 走法 driving / transit / walking 和二狗的写法一样。名字带不进去（终点只能是坐标或者一段地址，二选一）
 */
export function googleNavigationUrl(target: MapNavTarget): string {
  const p = wgsToGcj(target);
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lon.toFixed(6)}&travelmode=${target.mode ?? "driving"}`;
}

/** 报一件事给守护进程（报不上不要紧） */
export type BasemapReporter = (event: MapBasemapEventBody["event"]) => void;

/** 谷歌那一条：report 是报给守护进程的（网页插件装配时从 ctx.page 拿；测试不给）；fake 是测试给的假谷歌 */
export function googleBasemap(report?: BasemapReporter, testing?: { fake?: GoogleFake; isolated?: boolean; frameSrc?: string }): MapBasemapSlot {
  return {
    id: GOOGLE_MAP_PROVIDER,
    get title() {
      return t("ui.plugins.googleMaps.basemap");
    },
    // 谷歌要求写明来自 Google Maps：卡片上写"数据来自 Google 地图"
    get credit() {
      return t("ui.plugins.googleMaps.credit");
    },
    prepare(key) {
      if (key === undefined) throw new Error(t("ui.plugins.googleMaps.noKey"));
      const fake = testing?.fake ?? DEMO?.();
      return (host, o) =>
        createGoogleEngine(host, {
          ...o,
          key,
          isolated: testing?.isolated ?? GOOGLE_FRAME_ISOLATED,
          fake,
          ...(testing?.frameSrc === undefined ? {} : { frameSrc: testing.frameSrc }),
          onLoaded: () => report?.("loaded"),
          onAuthFailed: () => report?.("auth_failed"),
          texts: { unreachable: t("ui.plugins.googleMaps.unreachable"), authFailed: t("ui.plugins.googleMaps.authFailed") },
        });
    },
    navigation: googleNavigationUrl,
  };
}
