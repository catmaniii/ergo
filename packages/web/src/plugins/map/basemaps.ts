// 地图插件自带的两种底图（445：照"地图服务"插槽的网页一半 mapBasemaps 登记，plugin.tsx）：
// - OpenStreetMap（osm）：自己写的瓦片地图（osm-engine.ts），瓦片经守护进程的 /tiles/osm 转发；不用 Key、不用加载外站的脚本，
//   也是地图页的退路（别的还在加载、加载不上、看足迹时都先画它）；
// - 高德（amap）：高德 JS API（amap-engine.ts），第一次真要用时才从高德加载脚本（同一个 Key 只加载一次），Key 是守护进程给的
//   Web 端 Key。
// 演示页（MODE === "demo"）里瓦片是编的占位图、高德是假的（demo-amap.ts），不连任何地图服务；安装版这个分支摇掉（字面的 MODE 比较）。
import { mapTilePath, t } from "../../state/index.ts";
import type { MapBasemapSlot, MapEngineFactory } from "../api.ts";
import { createAmapEngine, loadAmap, setAmapLoader } from "./amap-engine.ts";
import { fakeAmapLoader } from "./demo-amap.ts";
import { createOsmEngine } from "./osm-engine.ts";
import { demoBasemapNote, demoTileUrl } from "../../prototype/fake-map.ts";

/** 演示页：编的瓦片、假的高德、底图下面写一句"是编的" */
const DEMO =
  import.meta.env.MODE === "demo"
    ? {
        osmTile: (z: number, x: number, y: number) => demoTileUrl("osm", z, x, y),
        install: () => setAmapLoader(fakeAmapLoader((z, x, y) => demoTileUrl("amap", z, x, y))),
        note: demoBasemapNote,
      }
    : undefined;
DEMO?.install();

/** 真的页面：瓦片经守护进程的 /tiles/osm 转发（聊天里地图卡片的缩略图也用它） */
export const osmTileUrl = DEMO ? DEMO.osmTile : (z: number, x: number, y: number) => mapTilePath("osm", z, x, y);

/** 演示页的底图是编的：署名后面写一句（地图页、缩略图都用） */
export const demoBasemapNoteText = DEMO ? DEMO.note : undefined;

/** 建一个 OpenStreetMap 的引擎（地图页的退路也用它） */
export const osmEngine: MapEngineFactory = (host, o) => createOsmEngine(host, { view: o.view, tileUrl: osmTileUrl, maxTileZoom: 19, onMoveEnd: o.onMoveEnd, ...(o.onMarkClick === undefined ? {} : { onMarkClick: o.onMarkClick }) });

/** 自带两家的编号（和守护进程登记的一样） */
export const OSM_BASEMAP = "osm";
export const AMAP_BASEMAP = "amap";

export const osmBasemap: MapBasemapSlot = {
  id: OSM_BASEMAP,
  get title() {
    return t("ui.plugins.map.basemap.osm");
  },
  prepare: () => osmEngine,
};

export const amapBasemap: MapBasemapSlot = {
  id: AMAP_BASEMAP,
  get title() {
    return t("ui.plugins.map.basemap.amap");
  },
  async prepare(key) {
    if (key === undefined) throw new Error("no key");
    const ns = await loadAmap(key);
    if (typeof ns.Map !== "function") throw new Error("AMap.Map missing");
    return (host, o) => createAmapEngine(host, ns, { view: o.view, dark: o.dark, onMoveEnd: o.onMoveEnd, ...(o.onMarkClick === undefined ? {} : { onMarkClick: o.onMarkClick }) });
  },
};
