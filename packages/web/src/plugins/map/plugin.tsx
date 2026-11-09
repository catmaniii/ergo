// 地图插件的网页这一半（429，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/map/plugin.ts）。
// 插件名和守护进程的一样（map）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 页面"地图"（MapPage.tsx，#/more/map）：导航里排在记忆后面、设置前面（order 85），放不下时收进"更多"；
//   底图按"地图服务"插槽（mapBasemaps）里登记的几家和这台设备的手动切换挑，一家都没有时说"没有能用的地图"；
// - 卡片类型 map 的画法（MapCard.tsx：聊天里的地图卡片，431）：预览图或缩略地图，点开进地图页看大的。
// 455 起它自己不带哪一家地图（ADR-0061）：OpenStreetMap（瓦片底图）、高德地图（底图 + 设置 · 数据源里填 Key 的那一块）、谷歌地图
// 各是一个插件，各自往 mapBasemaps 里登记；这里只认插槽。
// 停用时：导航、"更多"里没有地图，#/more/map 写"地图插件没启用"；聊天里以前的地图卡片显示"（地图插件没启用，这条内容暂时看不到）"。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { MapCard } from "./MapCard.tsx";
import { MapColumn, MapSection } from "./MapPage.tsx";
import { MAP_PAGE } from "./route.ts";

export { MAP_PAGE };

export const mapWebPlugin: WebPluginDefinition = {
  name: "map",
  get title() {
    return t("ui.plugins.map.title");
  },
  owns: { pages: [MAP_PAGE], cards: ["map"] },
  // 设置 · 插件里列的网页上的页面、栏目
  get brings() {
    return [t("ui.plugins.map.brings.page"), t("ui.plugins.map.brings.card")];
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
    ctx.register("cards", { type: "map", Card: MapCard });
  },
};
