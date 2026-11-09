// 聊天里地图卡片的预览图（451，GET /api/map/preview）：卡片编号 → 卡片负载 → 要画的点和线（static-map.ts）→ 那一家的静态地图
// （MapProvider.staticMap，高德、谷歌拿各自的 Key 去取），图原样交回。地址里只有编号、用哪家、宽高、深浅、清晰度，不放坐标。
// - 足迹卡按日期现算（MAP_DAY：经手机插件，不联网）；点和路线就在卡上；查到的按编号从内存取（过期了 404，卡片照旧写"过期了"）；
// - 用哪家：查到的、而且查它的那家只能画在自己地图上（高德、谷歌……）——一律用查它的那家，q.provider 不管；
//   OpenStreetMap 查的、足迹、点、路线用页面挑的那家（内容中心那个区域的当前地图，q.provider）；
// - 不缓存图（高德、谷歌的条款）；那家没登记、不出静态图（OpenStreetMap：页面自己画）、没填 Key、超了免费量、连不上：
//   抛 MapPreviewUnavailable（接口回 503 带原因，页面退回自己画或只写字）。
import { type MapCardPayload, type MapPreviewQuery, t } from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import { type MapDayService, type MapPreviewService, MapPreviewUnavailable, type MapProviders } from "./api.ts";
import type { MapLookups } from "./show-on-map.ts";
import { dayStatic, drawingStatic, shownStatic, type StaticContent } from "./static-map.ts";

export interface MapPreviewDeps {
  cards: Pick<CardService, "get">;
  day: MapDayService["day"];
  /** 查到的那几份（现取；没有是 undefined） */
  lookups: () => MapLookups | undefined;
  providers: Pick<MapProviders, "list">;
}

export function createMapPreview(deps: MapPreviewDeps): MapPreviewService {
  /** 要画什么、该用哪家（查到的、只能画在自己地图上的：查它的那家） */
  const contentOf = (q: MapPreviewQuery): { content: StaticContent; own?: string } => {
    const lookupOf = (id: string) => {
      const drawing = deps.lookups()?.get(id);
      if (!drawing) throw new RequestRejected("not_found", t("map.drawing.gone"));
      const source = deps.providers.list().find((p) => p.id === drawing.source);
      // 查它的那家只能画在自己地图上（没登记了的也当是：不知道条款的一律这样，和网页的 ownBasemapOf 一样），OpenStreetMap 的哪儿都能画
      const own = drawing.source === "osm" || (source !== undefined && !source.ownBasemapOnly) ? undefined : drawing.source;
      return { content: drawingStatic(drawing), ...(own === undefined ? {} : { own }) };
    };
    if (q.lookup !== undefined) return lookupOf(q.lookup);
    const card = deps.cards.get(q.card ?? "");
    if (!card || card.type !== "map") throw new RequestRejected("not_found", t("map.preview.noCard"));
    const show = (card.payload as MapCardPayload).show;
    switch (show.kind) {
      case "day":
        return { content: dayStatic(deps.day(show.date)) };
      case "points":
      case "route":
        return { content: shownStatic(show) };
      case "lookup":
        return lookupOf(show.lookup);
    }
  };

  return {
    async preview(q, signal) {
      const { content, own } = contentOf(q);
      if (content.bounds.length === 0) throw new MapPreviewUnavailable(t("map.preview.empty"));
      const id = own ?? q.provider;
      if (id === undefined) throw new RequestRejected("bad_params", t("map.preview.noProvider"));
      const provider = deps.providers.list().find((p) => p.id === id);
      if (provider === undefined) throw new MapPreviewUnavailable(t("map.preview.notConnected", { name: id }));
      if (provider.staticMap === undefined) throw new MapPreviewUnavailable(t("map.preview.unsupported", { name: provider.title }));
      const result = await provider.staticMap({ marks: content.marks, lines: content.lines, bounds: content.bounds, width: q.width, height: q.height, scale: q.scale, dark: q.dark }, signal);
      if (!result.ok) throw new MapPreviewUnavailable(result.reason);
      return result.reply;
    },
  };
}
