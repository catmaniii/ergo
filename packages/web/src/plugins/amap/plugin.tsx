// 高德地图插件的网页这一半（455，ADR-0061；守护进程那一半是 packages/daemon/src/amap/plugin.ts；429 起在地图插件里）。
// 插件名和守护进程的一样（amap）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - "地图服务"插槽的底图 amap（mapBasemaps，basemap.ts）：地图页国内"自动"用它（守护进程报的优先级 100），国外也能在地图切换里选；
// - 设置 · 数据源里"高德地图"下面填 Key、试查一下的那一块（dataSources 插槽，AmapPanel.tsx、AmapTry.tsx）。
// 停用时：底图那一条撤掉（地图页退回下一家，手动选了它的退回"自动"并说一句），数据源那一行写"高德地图插件没启用"、这一块不画。
// 地图页本身、查地点和路线的卡片都是地图插件的；这里不改它们。
import { AMAP_SOURCE_ID, t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { AmapPanel } from "./AmapPanel.tsx";
import { amapBasemap } from "./basemap.ts";

export const amapWebPlugin: WebPluginDefinition = {
  name: "amap",
  get title() {
    return t("ui.plugins.amap.title");
  },
  owns: { dataSources: [AMAP_SOURCE_ID], mapBasemaps: [amapBasemap.id] },
  // 设置 · 插件里列的网页上的页面、栏目
  get brings() {
    return [t("ui.plugins.amap.brings.basemap"), t("ui.plugins.amap.brings.panel")];
  },
  setup(ctx) {
    ctx.register("mapBasemaps", amapBasemap);
    ctx.register("dataSources", { id: AMAP_SOURCE_ID, Panel: AmapPanel });
  },
};
