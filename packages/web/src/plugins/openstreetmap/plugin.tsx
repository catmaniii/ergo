// OpenStreetMap 插件的网页这一半（455，ADR-0061；守护进程那一半是 packages/daemon/src/openstreetmap/plugin.ts；429 起在地图插件里）。
// 插件名和守护进程的一样（openstreetmap）：守护进程报它在运行就装，停用了、移除了就停。登记的只有一样：
// - "地图服务"插槽的瓦片底图 osm（mapBasemaps 的 tiles）：只给瓦片的地址和署名，地图插件自己画（点、线、字也自己画），同步就能用、
//   不用 Key、不加载外站的脚本；聊天卡片的缩略图也照它画。瓦片经守护进程的 /tiles/osm 转发（浏览器不直接连 OpenStreetMap）。
// - 导航网址（navigation，434）：卡片上"用手机地图导航"在浏览器里、别家（高德、谷歌）都没开时的退路，打开 OpenStreetMap 网站的
//   "路线"，终点填好、起点空着（网站上点"我的位置"或者自己填）。
// 停用时：底图那一条撤掉，地图页、卡片只用别家（三家都停了地图页说"没有能用的地图"、卡片只有字）。
// 演示页（MODE === "demo"）里瓦片是编的占位图（不连任何地图服务）；安装版这个分支摇掉（字面的 MODE 比较）。
import { type MapRouteMode, mapTilePath, t } from "../../state/index.ts";
import type { MapBasemapSlot, MapNavTarget, WebPluginDefinition } from "../api.ts";
import { demoTileUrl } from "../../prototype/fake-map.ts";

/** 地图服务的编号（和守护进程 openstreetmap 插件登记的一样；瓦片地址 /tiles/osm、这台设备的手动选择里存的都是它） */
export const OSM_BASEMAP = "osm";

/** OpenStreetMap 的版权页（署名角标链过去） */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/** OpenStreetMap 网站"路线"用哪个算路线的服务：开车、步行用 OSRM；没有公交（不写，网站上自己选） */
const OSM_NAV_ENGINE: Readonly<Partial<Record<MapRouteMode, string>>> = { driving: "fossgis_osrm_car", walking: "fossgis_osrm_foot" };

/** OpenStreetMap 网站的"路线"：route 写"起点;终点"（纬度,经度，WGS-84），起点空着；只是网页，不拉起 App */
export function osmNavigationUrl(target: MapNavTarget): string {
  const engine = OSM_NAV_ENGINE[target.mode ?? "driving"];
  return `https://www.openstreetmap.org/directions?${engine === undefined ? "" : `engine=${engine}&`}route=%3B${target.lat.toFixed(6)}%2C${target.lon.toFixed(6)}`;
}

/** 演示页：编的瓦片 */
const DEMO_TILE = import.meta.env.MODE === "demo" ? (z: number, x: number, y: number) => demoTileUrl("osm", z, x, y) : undefined;

export const osmBasemap: MapBasemapSlot = {
  id: OSM_BASEMAP,
  get title() {
    return t("ui.plugins.openstreetmap.basemap");
  },
  tiles: {
    // 真的页面：瓦片经守护进程的 /tiles/osm 转发
    tileUrl: DEMO_TILE ?? ((z, x, y) => mapTilePath("osm", z, x, y)),
    maxZoom: 19,
    attribution: {
      label: "© OpenStreetMap",
      href: OSM_COPYRIGHT_URL,
      get after() {
        return t("ui.plugins.openstreetmap.contributors");
      },
    },
  },
  navigation: osmNavigationUrl,
};

export const openStreetMapWebPlugin: WebPluginDefinition = {
  name: "openstreetmap",
  get title() {
    return t("ui.plugins.openstreetmap.title");
  },
  owns: { mapBasemaps: [osmBasemap.id] },
  // 设置 · 插件里列的网页上的页面、栏目
  get brings() {
    return [t("ui.plugins.openstreetmap.brings.basemap")];
  },
  setup(ctx) {
    ctx.register("mapBasemaps", osmBasemap);
  },
};
