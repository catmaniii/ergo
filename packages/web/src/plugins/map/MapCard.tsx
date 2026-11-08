// 聊天里的地图卡片（卡片类型 map，431，地图插件登记的画法）：秘书的"画在地图上"放进聊天的一张。出来就是已处理，没有按钮要点。
// - 某一天的足迹、秘书给的点和路线：标题下面一块缩略地图（MapThumb.tsx：OpenStreetMap 的瓦片经这台电脑转发、点和线自己画，
//   聊天页不加载高德的脚本），右下角"看大地图"；地图下面写概况（"待过 3 个地方 · 6 张照片"）和去过的几处（"家、公司、西湖边"）；
// - 查地点、算路线的结果（432 高德、433 OpenStreetMap）：按编号现取，只在守护进程的内存里留一会儿，过期了写"过期了，再问一次"；
//   写明数据来自哪家。OpenStreetMap 查来的和上面一样画缩略图；**高德查来的不画缩略图**（只能画在高德的地图上，amap-results.ts），
//   只写查到的（几处的名字、走法）和"在高德地图上看"（点开的地图页只在底图是高德时画）；445 起别家（谷歌……）查来的同样，
//   写"在<那一家>上看"；
// - 点开去哪：足迹卡去 #/more/map/<日期>（地图页看那一天），别的去 #/more/map/card/<卡片编号>（地图页画这张卡）。
// 数据怎么来：足迹按日期现取（GET /api/map/day），查到的按编号现取（GET /api/map/drawing），点和路线就在卡上（card-scene.ts 整理）。
import { useEffect, useMemo, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { type MapCardPayload, type MapCardShow, mapCardPath, mapCardTitle, t } from "../../state/index.ts";
import type { CardProps } from "../../ui/cards/CardShell.tsx";
import { Icon } from "../../ui/icons.tsx";
import { usePlugins } from "../api.ts";
import { AMAP_RESULT_SOURCE, ownBasemapShow } from "./amap-results.ts";
import { dayContent, drawingContent, type MapCardData, shownContent } from "./card-scene.ts";
import { MapThumb } from "./MapThumb.tsx";
import { MAP_PAGE } from "./route.ts";

/** 一张地图卡片要画的：点和路线就在卡上，足迹、查到的现取（卡片和点开后的地图页共用；没有卡是 undefined） */
export function useMapCardData(http: DaemonHttp, show: MapCardShow | undefined): MapCardData | undefined {
  const fixed = useMemo<MapCardData | undefined>(() => (show?.kind === "points" || show?.kind === "route" ? { state: "ready", content: shownContent(show) } : undefined), [show]);
  const [loaded, setLoaded] = useState<{ show: MapCardShow; data: MapCardData }>();
  useEffect(() => {
    if (show?.kind !== "day" && show?.kind !== "lookup") return;
    let alive = true;
    const data: Promise<MapCardData> = show.kind === "day" ? http.mapDay(show.date).then(dayContent) : http.mapDrawing(show.lookup).then((d) => ({ state: "ready", content: drawingContent(d) }));
    data.then(
      (d) => alive && setLoaded({ show, data: d }),
      (err: unknown) => alive && setLoaded({ show, data: { state: "failed", text: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      alive = false;
    };
  }, [http, show]);
  if (fixed || show === undefined) return fixed;
  return loaded?.show === show ? loaded.data : { state: "loading" };
}

/** 地图卡片点开去的地址 */
export function mapCardHref(cardId: string, show: MapCardShow): string {
  const path = mapCardPath(cardId, show);
  return toHash({ tab: "more", page: MAP_PAGE, item: path.item, ...(path.sub === undefined ? {} : { sub: path.sub }) });
}

/** 卡片本身（取到了什么交给 MapCardView 画；测试直接画 MapCardView） */
export function MapCard({ state, payload }: CardProps<MapCardPayload>) {
  const { http } = useStore();
  const data = useMapCardData(http, payload.show) ?? { state: "loading" };
  // 只能画在某一家的地图上的：那一家的名字（地图服务插槽里登记的底图，445）
  const own = ownBasemapShow(payload.show);
  const ownName = usePlugins().get("mapBasemaps", own ?? "")?.title;
  return <MapCardView cardId={state.card.id} payload={payload} data={data} ownName={ownName} />;
}

export function MapCardView({ cardId, payload, data, ownName }: { cardId: string; payload: MapCardPayload; data: MapCardData; ownName?: string | undefined }) {
  const title = mapCardTitle(payload);
  const href = mapCardHref(cardId, payload.show);
  const own = ownBasemapShow(payload.show);
  const amapOnly = own !== undefined;
  const content = data.state === "ready" ? data.content : undefined;
  const note = data.state === "loading" ? t("ui.plugins.map.card.loading") : data.state === "ready" ? undefined : data.text;
  return (
    <div className="card xcard xcard-map" data-show={payload.show.kind} data-state={data.state}>
      <div className="xcard-head">
        <span className="xcard-tag xt-map">{CARD_TYPE_LABEL.map}</span>
        <span className="xcard-title">{title}</span>
      </div>
      <div className="xcard-body">
        {!amapOnly && (
          <div className="map-card-thumb">
            {content ? (
              <>
                <MapThumb content={content} />
                <a className="map-card-open" href={href} aria-label={t("ui.plugins.map.card.openAria", { title })}>
                  <span className="map-card-open-chip">
                    <Icon name="map" />
                    {t("ui.plugins.map.card.open")}
                  </span>
                </a>
              </>
            ) : (
              <div className="map-card-placeholder">{note}</div>
            )}
          </div>
        )}
        {amapOnly && note !== undefined && <div className="map-card-note">{note}</div>}
        {content?.lines.map((line) => (
          <div key={line} className="map-card-line">
            {line}
          </div>
        ))}
        {amapOnly && content && (
          <a className="map-card-go" href={href}>
            <Icon name="map" />
            {own === AMAP_RESULT_SOURCE ? t("ui.plugins.map.card.openAmap") : t("ui.plugins.map.card.openOwn", { name: ownName ?? own })}
          </a>
        )}
      </div>
    </div>
  );
}
