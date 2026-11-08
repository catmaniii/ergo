// 谷歌地图在"地图服务"插槽网页一半（mapBasemaps）里的那一条（446）：编号 google（和守护进程登记的一样）。
// - prepare(key)：用守护进程给的浏览器用的 Key 加载谷歌（loader.ts：官方加载法、固定版本，一页一次）；加载不上抛错（给人看：
//   "连不上谷歌"——设备在中国大陆、断网），地图页写一句、地图切换里标"连不上"、手动选的退回"自动"；
// - 建好的引擎（google-engine.ts）每建一张谷歌地图报一次 loaded、谷歌说 Key 不对报一次 auth_failed（POST /api/map/basemap，
//   守护进程数用量、记下 Key 被拒）；报不上不要紧（旧守护进程、断线），不耽误画地图。
// 演示页（MODE === "demo"）里谷歌是假的（demo-google.ts），瓦片是编的占位图，不连谷歌；安装版这个分支摇掉（字面的 MODE 比较）。
import { GOOGLE_MAP_PROVIDER, type MapBasemapEventBody, t } from "../../state/index.ts";
import type { MapBasemapSlot } from "../api.ts";
import { fakeGoogleMaps } from "./demo-google.ts";
import { createGoogleEngine } from "./google-engine.ts";
import { googleAuthFailed, loadGoogle, onGoogleAuthFailure, setGoogleLoader } from "./loader.ts";
import { demoTileUrl } from "../../prototype/fake-map.ts";

/**
 * 演示页：假的谷歌（编的占位瓦片）。照真的加载法那样挂上全局的 gm_authFailure（页面测试叫它扮"谷歌说 Key 不对"）
 */
const DEMO =
  import.meta.env.MODE === "demo"
    ? () =>
        setGoogleLoader(() => {
          (window as Window & { gm_authFailure?: () => void }).gm_authFailure = googleAuthFailed;
          return Promise.resolve(fakeGoogleMaps((z, x, y) => demoTileUrl("google", z, x, y)));
        })
    : undefined;
DEMO?.();

/** 报一件事给守护进程（报不上不要紧） */
export type BasemapReporter = (event: MapBasemapEventBody["event"]) => void;

/** 谷歌那一条：report 是报给守护进程的（网页插件装配时从 ctx.page 拿；测试不给） */
export function googleBasemap(report?: BasemapReporter): MapBasemapSlot {
  return {
    id: GOOGLE_MAP_PROVIDER,
    get title() {
      return t("ui.plugins.googleMaps.basemap");
    },
    async prepare(key) {
      if (key === undefined) throw new Error(t("ui.plugins.googleMaps.noKey"));
      const lib = await loadGoogle(key);
      return (host, o) =>
        createGoogleEngine(host, lib, {
          ...o,
          onLoaded: () => report?.("loaded"),
          watchAuth: (handler) =>
            onGoogleAuthFailure(() => {
              report?.("auth_failed");
              handler();
            }),
          authFailedText: t("ui.plugins.googleMaps.authFailed"),
        });
    },
  };
}
