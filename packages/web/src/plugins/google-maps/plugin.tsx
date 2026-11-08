// 谷歌地图插件的网页这一半（446，ADR-0057；守护进程那一半是 packages/daemon/src/google-maps/plugin.ts）。
// 插件名和守护进程的一样（google-maps）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - "地图服务"插槽的底图 google（mapBasemaps，basemap.ts）：地图页大陆以外"自动"用它（守护进程报的优先级 50，高于 OpenStreetMap），
//   地图切换里国内国外都能手动选它；建一次谷歌地图、谷歌说 Key 不对时报给守护进程（数用量、记下）；
// - 设置 · 数据源里"谷歌地图"下面填两个 Key 的那一块（dataSources 插槽，GoogleMapsPanel.tsx）。
// 停用时：底图那一条撤掉（地图页退回下一家，手动选了它的退回"自动"并说一句），数据源那一行写"谷歌地图插件没启用"、这一块不画。
// 地图页本身、查地点和路线的卡片都是地图插件的；这里不改它们。
import { GOOGLE_MAP_PROVIDER, GOOGLE_MAPS_SOURCE_ID, t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { googleBasemap } from "./basemap.ts";
import { GoogleMapsPanel } from "./GoogleMapsPanel.tsx";

export const googleMapsWebPlugin: WebPluginDefinition = {
  name: "google-maps",
  get title() {
    return t("ui.plugins.googleMaps.title");
  },
  owns: { dataSources: [GOOGLE_MAPS_SOURCE_ID], mapBasemaps: [GOOGLE_MAP_PROVIDER] },
  // 设置 · 插件里列的网页上的页面、栏目
  get brings() {
    return [t("ui.plugins.googleMaps.brings.basemap"), t("ui.plugins.googleMaps.brings.panel")];
  },
  setup(ctx) {
    const http = ctx.page?.http;
    ctx.register(
      "mapBasemaps",
      googleBasemap(
        http === undefined
          ? undefined
          : (event) => {
              // 报不上不要紧（旧守护进程、断线）：不耽误画地图
              http.mapBasemap({ provider: GOOGLE_MAP_PROVIDER, event }).catch(() => undefined);
            },
      ),
    );
    ctx.register("dataSources", { id: GOOGLE_MAPS_SOURCE_ID, Panel: GoogleMapsPanel });
  },
};
