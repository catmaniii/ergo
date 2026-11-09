// 聊天里的地图卡片（卡片类型 map，431，地图插件登记的画法）：秘书的"画在地图上"放进聊天的一张。出来就是已处理，没有按钮要点。
// - 标题下面一块预览图，右上角"看大地图"；下面写概况（"待过 3 个地方 · 6 张照片"）和去过的几处（"家、公司、西湖边"）、数据来自哪家；
// - 451 起预览图跟着"当前地图"（providers.ts 的 cardBasemap）：
//   · 查到的（高德、谷歌……查来的，条款要求只画在它自己的地图上）：用查它的那家；
//   · 足迹、秘书给的点和路线、OpenStreetMap 查的：用内容中心那个区域的当前地图（这台设备在那个区域手动选的，没选就是"自动"）；
//   挑出来是 OpenStreetMap 就自己画（MapThumb.tsx：瓦片经这台电脑转发）；是高德、谷歌就放一张它的静态地图（守护进程拿 Key 去取，
//   GET /api/map/preview，看到了才取，preview.ts）。453 起那张只是光底图（点和线不交给地图公司），点和线照回应头里的视野
//   在本机画上去（static-overlay.tsx）。取不到（没开、超额、出错、那家没填）时：足迹、点、路线退回 OpenStreetMap 自己画；
//   查到的退回只有字，加一句"预览图没出来：<原因>"和"在<那一家>上看"。聊天页照旧不加载高德、谷歌的脚本；
// - 深色：谷歌取深色的静态图；高德的静态图没有深色，压暗一点（map-card.css）；图里有那家的标志，不另写署名；
// - 查到的结果按编号现取，只在守护进程的内存里留一会儿，过期了写"过期了，再问一次"；
// - 点开去哪：足迹卡去 #/more/map/<日期>（地图页看那一天），别的去 #/more/map/card/<卡片编号>（地图页画这张卡）。
// 数据怎么来：足迹按日期现取（GET /api/map/day），查到的按编号现取（GET /api/map/drawing），点和路线就在卡上（card-scene.ts 整理）。
import { type Ref, useEffect, useMemo, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { type MapCardPayload, type MapCardShow, mapCardPath, mapCardTitle, t } from "../../state/index.ts";
import type { CardProps } from "../../ui/cards/CardShell.tsx";
import { Icon } from "../../ui/icons.tsx";
import { usePlugins } from "../api.ts";
import { AMAP_RESULT_SOURCE, ownBasemapShow } from "./amap-results.ts";
import { contentCenter, dayContent, drawingContent, type MapCardData, shownContent } from "./card-scene.ts";
import { loadChoice } from "./MapSwitch.tsx";
import { MapThumb } from "./MapThumb.tsx";
import { useDark } from "./MapView.tsx";
import { CARD_PREVIEW_MAX_WIDTH, type PreviewState, previewSize, useBoxSize, useMapPreview, useMapProviders, useVisible } from "./preview.ts";
import { type BasemapPage, cardBasemap } from "./providers.ts";
import { StaticPreview } from "./static-overlay.tsx";
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

/**
 * 卡片上那一块画什么：osm 自己画 OpenStreetMap；image 放那家的静态预览图（在取、取到了）；none 不画图，只有字
 * （查到的取不到图时，带原因）
 */
export type MapCardThumb =
  | { readonly kind: "osm" }
  | { readonly kind: "image"; readonly provider: string; readonly preview: PreviewState; readonly name?: string | undefined }
  | { readonly kind: "none"; readonly reason?: string | undefined };

/** 卡片上那一块的高度（map-card.css 的 .map-card-thumb） */
const THUMB_HEIGHT = 168;

/** 卡片本身（取到了什么、挑哪家地图、预览图取到哪一步，交给 MapCardView 画；测试直接画 MapCardView） */
export function MapCard({ state, payload }: CardProps<MapCardPayload>) {
  const { http } = useStore();
  const data = useMapCardData(http, payload.show) ?? { state: "loading" };
  const own = ownBasemapShow(payload.show);
  const plugins = usePlugins();
  // 只能画在某一家的地图上的：那一家的名字（地图服务插槽里登记的底图，445）
  const ownName = plugins.get("mapBasemaps", own ?? "")?.title;
  const providers = useMapProviders(http);
  const content = data.state === "ready" ? data.content : undefined;
  const dark = useDark();
  // 那一块（回调 ref 存进来：量大小、看进没进屏幕）
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const version = plugins.version();
  // 聊天页不加载外站脚本：网页那一半在不在看插槽（插件停用了就没有），加载失败的不知道
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 只用来在装、停之后重算
  const page = useMemo<BasemapPage>(() => ({ has: (id) => plugins.get("mapBasemaps", id) !== undefined, failed: () => undefined }), [plugins, version]);
  const pick = content && providers ? cardBasemap({ own, center: contentCenter(content), footprints: content.footprints, providers, choice: loadChoice(), page }) : undefined;
  const wantsImage = pick === undefined ? content !== undefined : pick.image;
  const visible = useVisible(box, wantsImage);
  const boxSize = useBoxSize(box, wantsImage);
  const size = boxSize.width > 0 ? previewSize(boxSize.width, boxSize.height || THUMB_HEIGHT, CARD_PREVIEW_MAX_WIDTH) : undefined;
  const query = pick?.image && visible && size ? { card: state.card.id, provider: pick.provider, width: size.width, height: size.height, dark: dark && pick.provider === "google", scale: size.scale } : undefined;
  const preview = useMapPreview(http, query);
  const providerName = (id: string) => plugins.get("mapBasemaps", id)?.title ?? providers?.find((p) => p.id === id)?.title ?? id;
  const thumb: MapCardThumb =
    content === undefined
      ? own !== undefined
        ? { kind: "image", provider: own, preview: { state: "loading" } }
        : { kind: "osm" }
      : pick === undefined
        ? { kind: "image", provider: own ?? "", preview: { state: "loading" } }
        : !pick.image
          ? pick.own
            ? { kind: "none" }
            : { kind: "osm" }
          : preview?.state === "failed"
            ? pick.own
              ? { kind: "none", reason: preview.reason }
              : { kind: "osm" }
            : { kind: "image", provider: pick.provider, preview: preview ?? { state: "loading" }, name: providerName(pick.provider) };
  return <MapCardView cardId={state.card.id} payload={payload} data={data} ownName={ownName} thumb={thumb} thumbRef={setBox} dark={dark} />;
}

export function MapCardView({
  cardId,
  payload,
  data,
  ownName,
  thumb,
  thumbRef,
  dark = false,
}: {
  cardId: string;
  payload: MapCardPayload;
  data: MapCardData;
  ownName?: string | undefined;
  /** 那一块画什么（不给照 451 以前：查到的不画图，别的画 OpenStreetMap） */
  thumb?: MapCardThumb | undefined;
  thumbRef?: Ref<HTMLDivElement> | undefined;
  dark?: boolean | undefined;
}) {
  const title = mapCardTitle(payload);
  const href = mapCardHref(cardId, payload.show);
  const own = ownBasemapShow(payload.show);
  const shown: MapCardThumb = thumb ?? (own !== undefined ? { kind: "none" } : { kind: "osm" });
  const boxed = shown.kind !== "none";
  const content = data.state === "ready" ? data.content : undefined;
  const note = data.state === "loading" ? t("ui.plugins.map.card.loading") : data.state === "ready" ? undefined : data.text;
  const open = (
    <a className="map-card-open" href={href} aria-label={t("ui.plugins.map.card.openAria", { title })}>
      <span className="map-card-open-chip">
        <Icon name="map" />
        {t("ui.plugins.map.card.open")}
      </span>
    </a>
  );
  const box = (() => {
    if (!content) return <div className="map-card-placeholder">{note}</div>;
    if (shown.kind === "osm")
      return (
        <>
          <MapThumb content={content} />
          {open}
        </>
      );
    if (shown.kind === "image" && shown.preview.state === "ready")
      return (
        <>
          <StaticPreview
            url={shown.preview.url}
            view={shown.preview.view}
            scene={content.scene}
            imgClass={`map-card-img${dark && shown.provider !== "google" ? " dim" : ""}`}
            alt={t("ui.plugins.map.card.previewAlt", { name: shown.name ?? shown.provider, title })}
          />
          {open}
        </>
      );
    return <div className="map-card-placeholder">{t("ui.plugins.map.card.previewLoading")}</div>;
  })();
  return (
    <div className="card xcard xcard-map" data-show={payload.show.kind} data-state={data.state} data-thumb={shown.kind}>
      <div className="xcard-head">
        <span className="xcard-tag xt-map">{CARD_TYPE_LABEL.map}</span>
        <span className="xcard-title">{title}</span>
      </div>
      <div className="xcard-body">
        {boxed && (
          <div className="map-card-thumb" ref={thumbRef} data-provider={shown.kind === "image" ? shown.provider : "osm"} data-preview={shown.kind === "image" ? shown.preview.state : undefined}>
            {box}
          </div>
        )}
        {!boxed && note !== undefined && <div className="map-card-note">{note}</div>}
        {content?.lines.map((line) => (
          <div key={line} className="map-card-line">
            {line}
          </div>
        ))}
        {shown.kind === "none" && shown.reason !== undefined && content && <div className="map-card-line map-card-preview-failed">{t("ui.plugins.map.card.previewFailed", { reason: shown.reason })}</div>}
        {!boxed && own !== undefined && content && (
          <a className="map-card-go" href={href}>
            <Icon name="map" />
            {own === AMAP_RESULT_SOURCE ? t("ui.plugins.map.card.openAmap") : t("ui.plugins.map.card.openOwn", { name: ownName ?? own })}
          </a>
        )}
      </div>
    </div>
  );
}
