// 地图插件的网页这一半（429，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/map/plugin.ts）。
// 插件名和守护进程的一样（map）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 页面"地图"（MapPage.tsx，#/more/map）：导航里排在记忆后面、设置前面（order 85），放不下时收进"更多"；
//   国内用高德地图（填了 Key），国外和没填 Key 时用 OpenStreetMap，按看的地方自动换；
// - 设置 · 数据源里"高德地图"下面填 Key 的那一块（dataSources 插槽，AmapPanel.tsx）。
// 停用时：导航、"更多"里没有地图，#/more/map 写"地图插件没启用"；数据源那一行写"地图插件没启用"，这一块不画。
import { AMAP_SOURCE_ID, t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { AmapPanel } from "./AmapPanel.tsx";
import { MapColumn, MapSection } from "./MapPage.tsx";

/** 地图页的页面 id（地址 #/more/map、导航那一项的 data-nav） */
export const MAP_PAGE = "map";

export const mapWebPlugin: WebPluginDefinition = {
  name: "map",
  get title() {
    return t("ui.plugins.map.title");
  },
  owns: { pages: [MAP_PAGE], dataSources: [AMAP_SOURCE_ID] },
  // 设置 · 插件里列的网页上的页面、栏目
  get brings() {
    return [t("ui.plugins.map.brings.page"), t("ui.plugins.map.brings.panel")];
  },
  setup(ctx) {
    ctx.register("pages", {
      id: MAP_PAGE,
      order: 85,
      icon: "map",
      get navLabel() {
        return t("ui.plugins.map.nav");
      },
      get title() {
        return t("ui.plugins.map.title");
      },
      get sub() {
        return t("ui.plugins.map.sub");
      },
      Section: MapSection,
      Column: MapColumn,
    });
    ctx.register("dataSources", { id: AMAP_SOURCE_ID, Panel: AmapPanel });
  },
};
