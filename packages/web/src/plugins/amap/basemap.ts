// 高德地图在"地图服务"插槽网页一半（mapBasemaps）里的那一条（429 起在地图插件里，455 挪进高德地图插件）：编号 amap（和守护进程登记的一样）。
// - prepare(key)：没 Key 抛错；有 Key 时第一次真要用才从高德加载脚本（amap-engine.ts，同一个 Key 只加载一次），交回建引擎的函数。
//   Key 是守护进程给的 Web 端 Key；安全密钥不在页面上（守护进程的 /_AMapService 拼上）。453 起只出底图，足迹、点、线由地图页
//   盖在上面的自己那一层画；
// - setup：国内没填 Key、Key 坏了时地图页照"自动"画着别家，提醒一句"填了高德 Key 国内地图更清楚"，按钮去 设置 · 数据源 · 高德地图。
// 演示页（MODE === "demo"）里高德是假的（demo-amap.ts：拿地图插件借来的瓦片引擎扮，底图是编的占位图），不连高德；安装版这个分支摇掉
// （字面的 MODE 比较）。
import { AMAP_SOURCE_ID, t } from "../../state/index.ts";
import type { MapBasemapSlot } from "../api.ts";
import { createAmapEngine, loadAmap, setAmapLoader } from "./amap-engine.ts";
import { fakeAmapLoader } from "./demo-amap.ts";
import { demoTileUrl } from "../../prototype/fake-map.ts";

/** 地图服务的编号（和守护进程 amap 插件登记的一样，这台设备的手动选择 ergo-map-choice 里存的也是它） */
export const AMAP_BASEMAP = "amap";

/** 演示页：假的高德（编的瓦片，地图插件借来的瓦片引擎画） */
const DEMO = import.meta.env.MODE === "demo" ? { tileUrl: (z: number, x: number, y: number) => demoTileUrl("amap", z, x, y) } : undefined;
/** 演示页的假高德装过没有（装一次） */
let demoInstalled = false;

export const amapBasemap: MapBasemapSlot = {
  id: AMAP_BASEMAP,
  get title() {
    return t("ui.plugins.amap.basemap");
  },
  setup: {
    regions: ["mainland"],
    dataSource: AMAP_SOURCE_ID,
    get noKey() {
      return t("ui.plugins.amap.hint.noKey");
    },
  },
  async prepare(key, kit) {
    if (key === undefined) throw new Error("no key");
    if (DEMO && !demoInstalled) {
      setAmapLoader(fakeAmapLoader(DEMO.tileUrl, kit.tileEngine));
      demoInstalled = true;
    }
    const ns = await loadAmap(key);
    if (typeof ns.Map !== "function") throw new Error("AMap.Map missing");
    return (host, o) => createAmapEngine(host, ns, o);
  },
};
