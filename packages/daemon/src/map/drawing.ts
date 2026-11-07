// 聊天里的地图卡片（431）按编号取查地点、算路线（432）查到的那一份：GET /api/map/drawing?lookup=amap-r1。
// 那一份只在地图插件的内存里留一会儿（高德的协议不许存，432 的 lookup-results.ts），卡上只存编号；过期了、二狗重启过、编号不对回 404
// "过期了，再问一次"，卡片照样显示标题。这里不联网、不重查。
import { type MapDrawing, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { MapDrawingService } from "./api.ts";
import type { MapLookups } from "./show-on-map.ts";

/** lookups 现取（没有查地点、算路线时是 undefined） */
export function createMapDrawings(lookups: () => MapLookups | undefined): MapDrawingService {
  return {
    drawing(lookup: string): MapDrawing {
      const id = lookup.trim();
      if (id === "") throw new RequestRejected("bad_params", t("map.drawing.noLookup"));
      const found = lookups()?.get(id);
      if (!found) throw new RequestRejected("not_found", t("map.drawing.gone"));
      return found;
    },
  };
}
