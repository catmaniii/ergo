// 聊天里的地图卡片（卡片类型 map，431，地图插件登记的画法）：秘书的"画在地图上"放进聊天的一张。出来就是已处理，没有按钮要点。
// - 标题下面一块预览图，右上角"看大地图"；下面写概况（"待过 3 个地方 · 6 张照片"）和去过的几处（"家、公司、西湖边"）、数据来自哪家；
// - 451 起预览图跟着"当前地图"（providers.ts 的 cardBasemap）：
//   · 查到的（高德、谷歌……查来的，条款要求只画在它自己的地图上）：用查它的那家；
//   · 足迹、秘书给的点和路线、哪儿都能画的那家（OpenStreetMap）查的：用内容中心那个区域的当前地图（这台设备在那个区域手动选的，
//     没选就是"自动"）；
//   挑出来是瓦片底图（455：登记了 tiles 的那家，OpenStreetMap）就自己画（MapThumb.tsx：瓦片经这台电脑转发）；能出静态地图的（高德、谷歌）
//   放一张它的静态地图（守护进程拿 Key 去取，GET /api/map/preview，看到了才取，preview.ts）。453 起那张只是光底图（点和线不交给地图公司），
//   点和线照回应头里的视野在本机画上去（static-overlay.tsx）。取不到（没开、超额、出错、那家没填）时：足迹、点、路线退回瓦片底图自己画；
//   查到的退回只有字，加一句"预览图没出来：<原因>"和"在<那一家>上看"。聊天页照旧不加载高德、谷歌的脚本；
//   一家都用不了（455：三家都停了）、瓦片底图也没有：只有字；
// - 深色：静态图有深色的（那家报的 previewDark：谷歌）取深色的；没有的（高德）压暗一点（map-card.css）；图里有那家的标志，不另写署名；
// - 查到的结果按编号现取，只在守护进程的内存里留一会儿，过期了写"过期了，再问一次"；
// - 点开去哪：足迹卡去 #/more/map/<日期>（地图页看那一天），别的去 #/more/map/card/<卡片编号>（地图页画这张卡）。
// 数据怎么来：足迹按日期现取（GET /api/map/day），查到的按编号现取（GET /api/map/drawing），点和路线就在卡上（card-scene.ts 整理）。
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { useLocale } from "../../app/locale.ts";
import { toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { type MapCardPayload, type MapCardShow, mapCardPath, mapCardTitle, type MapDayView, type MapDrawing, type MapProviderView, mapRegionOf, t } from "../../state/index.ts";
import type { CardProps } from "../../ui/cards/CardShell.tsx";
import { Icon } from "../../ui/icons.tsx";
import { type MapTileSource, usePlugins } from "../api.ts";
import { type CardSources, contentCenter, dayContent, drawingContent, type MapCardData, shownContent } from "./card-scene.ts";
import { loadChoice } from "./MapSwitch.tsx";
import { MapThumb } from "./MapThumb.tsx";
import { useDark } from "./MapView.tsx";
import { ownBasemapShow } from "./own-results.ts";
import { CARD_PREVIEW_MAX_WIDTH, type PreviewState, previewSize, useBoxSize, useMapPreview, useMapProviders, useVisible } from "./preview.ts";
import { autoBasemap, type BasemapPage, cardBasemap } from "./providers.ts";
import { StaticPreview } from "./static-overlay.tsx";
import { MAP_PAGE } from "./route.ts";

/** 取来的原样（整理成要画的在渲染时做：几家报的、名字后到也跟着变） */
type Loaded = { readonly kind: "day"; readonly view: MapDayView } | { readonly kind: "drawing"; readonly drawing: MapDrawing } | { readonly kind: "failed"; readonly text: string };

/** 要现取的那两种（足迹按日期、查到的按编号）：取到的原样，取不到的写原因 */
function loadShow(http: DaemonHttp, show: Extract<MapCardShow, { kind: "day" | "lookup" }>): Promise<Loaded> {
  const data: Promise<Loaded> = show.kind === "day" ? http.mapDay(show.date).then((view) => ({ kind: "day", view })) : http.mapDrawing(show.lookup).then((drawing) => ({ kind: "drawing", drawing }));
  return data.catch((err: unknown): Loaded => ({ kind: "failed", text: err instanceof Error ? err.message : String(err) }));
}

/** 取来的整理成要画的 */
function derivedOf(raw: Loaded, sources: CardSources): MapCardData {
  if (raw.kind === "failed") return { state: "failed", text: raw.text };
  if (raw.kind === "day") return dayContent(raw.view);
  return { state: "ready", content: drawingContent(raw.drawing, sources) };
}

/**
 * 一张地图卡片要画的：点和路线就在卡上，足迹、查到的现取（卡片和点开后的地图页共用；没有卡是 undefined）。
 * sources：几家地图服务报的（查到的只能画在哪家的地图上）、卡上"数据来自 X"写的名字（455：地图插件不认得任何一家）
 */
export function useMapCardData(http: DaemonHttp, show: MapCardShow | undefined, sources: CardSources = {}): MapCardData | undefined {
  const fixed = useMemo<MapCardData | undefined>(() => (show?.kind === "points" || show?.kind === "route" ? { state: "ready", content: shownContent(show) } : undefined), [show]);
  const [loaded, setLoaded] = useState<{ show: MapCardShow; data: Loaded }>();
  useEffect(() => {
    if (show?.kind !== "day" && show?.kind !== "lookup") return;
    let alive = true;
    void loadShow(http, show).then((d) => alive && setLoaded({ show, data: d }));
    return () => {
      alive = false;
    };
  }, [http, show]);
  const raw = loaded !== undefined && loaded.show === show ? loaded.data : undefined;
  const locale = useLocale();
  const { providers, credit } = sources;
  const derived = useMemo<MapCardData | undefined>(
    () => (raw === undefined ? undefined : derivedOf(raw, { providers, ...(credit === undefined ? {} : { credit }) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale：换了语言重写那几行字
    [raw, providers, credit, locale],
  );
  if (fixed || show === undefined) return fixed;
  return derived ?? { state: "loading" };
}

/** 要画的一张：编号（同一张不重取）、画什么 */
export interface ShowToDraw {
  readonly key: string;
  readonly show: MapCardShow;
}

/**
 * 地图上叠着的几张要画的（461：二狗连着画的叠在一起）：和 useMapCardData 一样，点和路线就在卡上，足迹、查到的现取（按 key 只取一次，
 * 同一个 key 换了内容再取）。shows 要是稳定的（内容没变就是同一个数组），交回的也稳定
 */
export function useMapCardsData(http: DaemonHttp, shows: readonly ShowToDraw[], sources: CardSources = {}): ReadonlyMap<string, MapCardData> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, { readonly show: MapCardShow; readonly data: Loaded }>>(() => new Map());
  /** 取过、正在取的（同一个 key 换了内容再取） */
  const asked = useRef(new Map<string, MapCardShow>());
  /** 还在这一页上（卸下了取回来的不要） */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const { key, show } of shows) {
      if (show.kind !== "day" && show.kind !== "lookup") continue;
      if (asked.current.get(key) === show) continue;
      asked.current.set(key, show);
      void loadShow(http, show).then((data) => {
        if (mounted.current && asked.current.get(key) === show) setLoaded((m) => new Map(m).set(key, { show, data }));
      });
    }
  }, [http, shows]);
  const locale = useLocale();
  const { providers, credit } = sources;
  return useMemo(
    () => {
      const out = new Map<string, MapCardData>();
      for (const { key, show } of shows) {
        if (show.kind === "points" || show.kind === "route") {
          out.set(key, { state: "ready", content: shownContent(show) });
          continue;
        }
        const got = loaded.get(key);
        out.set(key, got !== undefined && got.show === show ? derivedOf(got.data, { providers, ...(credit === undefined ? {} : { credit }) }) : { state: "loading" });
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale：换了语言重写那几行字
    [shows, loaded, providers, credit, locale],
  );
}

/** 网页那一半登记了的几家：名字（title）、卡上"数据来自 X"写的名字（credit，没写用 title）、瓦片底图（455：登记了 tiles 的那家，OpenStreetMap） */
export function useBasemapEntries(): { title(id: string): string | undefined; credit(id: string): string | undefined; tiles(id: string): MapTileSource | undefined; page: BasemapPage } {
  const plugins = usePlugins();
  const version = plugins.version();
  return useMemo(() => {
    const entry = (id: string) => plugins.get("mapBasemaps", id);
    return {
      title: (id) => entry(id)?.title,
      credit: (id) => {
        const e = entry(id);
        return e?.credit ?? e?.title;
      },
      tiles: (id) => entry(id)?.tiles,
      // 聊天页不加载外站脚本：网页那一半在不在看插槽（插件停用了就没有），加载失败的不知道
      page: { has: (id) => entry(id) !== undefined, failed: () => undefined },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 只用来在装、停之后重算
  }, [plugins, version]);
}

/** 卡片自己画时用哪一家的瓦片（455）：这个区域里登记了瓦片底图、能用的那几家里"自动"会挑的；一家都没有是 undefined（只写字） */
export function tileFallback(center: { lat: number; lon: number }, providers: readonly MapProviderView[], entries: Pick<ReturnType<typeof useBasemapEntries>, "tiles" | "page">): string | undefined {
  return autoBasemap(
    mapRegionOf(center),
    providers.filter((p) => entries.tiles(p.id) !== undefined),
    entries.page,
  );
}

/** 地图卡片点开去的地址 */
export function mapCardHref(cardId: string, show: MapCardShow): string {
  const path = mapCardPath(cardId, show);
  return toHash({ tab: "more", page: MAP_PAGE, item: path.item, ...(path.sub === undefined ? {} : { sub: path.sub }) });
}

/**
 * 卡片上那一块画什么：tiles 自己画那一家的瓦片（455 以前叫 osm）；image 放那家的静态预览图（在取、取到了；dim 是深色时压暗：
 * 那家的图没有深色的）；none 不画图，只有字（查到的取不到图时，带原因）
 */
export type MapCardThumb =
  | { readonly kind: "tiles"; readonly provider: string; readonly tiles: MapTileSource }
  | { readonly kind: "image"; readonly provider: string; readonly preview: PreviewState; readonly name?: string | undefined; readonly dim?: boolean | undefined }
  | { readonly kind: "none"; readonly reason?: string | undefined };

/** 卡片上那一块的高度（map-card.css 的 .map-card-thumb） */
const THUMB_HEIGHT = 168;

/** 卡片本身（取到了什么、挑哪家地图、预览图取到哪一步，交给 MapCardView 画；测试直接画 MapCardView） */
export function MapCard({ state, payload }: CardProps<MapCardPayload>) {
  const { http } = useStore();
  const providers = useMapProviders(http);
  const entries = useBasemapEntries();
  const data = useMapCardData(http, payload.show, { providers, credit: entries.credit }) ?? { state: "loading" };
  // 只能画在某一家的地图上的（几家报的还没取到时一律当是）：那一家的名字（地图服务插槽里登记的底图，445）
  const own = ownBasemapShow(payload.show, providers);
  const ownName = own === undefined ? undefined : (entries.title(own) ?? providers?.find((p) => p.id === own)?.title);
  const content = data.state === "ready" ? data.content : undefined;
  const dark = useDark();
  // 那一块（回调 ref 存进来：量大小、看进没进屏幕）
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const pick = content && providers ? cardBasemap({ own, center: contentCenter(content), footprints: content.footprints, providers, choice: loadChoice(), page: entries.page }) : undefined;
  const wantsImage = pick === undefined ? content !== undefined : pick.image;
  const visible = useVisible(box, wantsImage);
  const boxSize = useBoxSize(box, wantsImage);
  const size = boxSize.width > 0 ? previewSize(boxSize.width, boxSize.height || THUMB_HEIGHT, CARD_PREVIEW_MAX_WIDTH) : undefined;
  /** 那家的静态图有深色的（谷歌）：深色时要深色的；没有的（高德）要浅色的、压暗 */
  const darkImage = (id: string) => providers?.find((p) => p.id === id)?.previewDark === true;
  const query =
    pick?.image && pick.provider !== undefined && visible && size ? { card: state.card.id, provider: pick.provider, width: size.width, height: size.height, dark: dark && darkImage(pick.provider), scale: size.scale } : undefined;
  const preview = useMapPreview(http, query);
  const providerName = (id: string) => entries.title(id) ?? providers?.find((p) => p.id === id)?.title ?? id;
  /** 自己画：挑出来的那家是瓦片底图就用它，不然这个区域能用的瓦片底图（都没有只写字） */
  const selfDrawn = (preferred: string | undefined): MapCardThumb => {
    const id = preferred !== undefined && entries.tiles(preferred) !== undefined ? preferred : content && providers ? tileFallback(contentCenter(content), providers, entries) : undefined;
    const tiles = id === undefined ? undefined : entries.tiles(id);
    return id === undefined || tiles === undefined ? { kind: "none" } : { kind: "tiles", provider: id, tiles };
  };
  const thumb: MapCardThumb =
    content === undefined || pick === undefined
      ? { kind: "image", provider: own ?? "", preview: { state: "loading" } }
      : !pick.image
        ? pick.own
          ? { kind: "none" }
          : selfDrawn(pick.provider)
        : preview?.state === "failed"
          ? pick.own
            ? { kind: "none", reason: preview.reason }
            : selfDrawn(undefined)
          : { kind: "image", provider: pick.provider ?? "", preview: preview ?? { state: "loading" }, name: providerName(pick.provider ?? ""), dim: dark && !darkImage(pick.provider ?? "") };
  return <MapCardView cardId={state.card.id} payload={payload} data={data} own={own} ownName={ownName} thumb={thumb} thumbRef={setBox} dark={dark} />;
}

export function MapCardView({
  cardId,
  payload,
  data,
  own,
  ownName,
  thumb,
  thumbRef,
}: {
  cardId: string;
  payload: MapCardPayload;
  data: MapCardData;
  /** 只能画在哪一家的地图上（查到的；MapCard 按几家报的算好交来） */
  own?: string | undefined;
  ownName?: string | undefined;
  /** 那一块画什么（不给就不画图，只有字） */
  thumb?: MapCardThumb | undefined;
  thumbRef?: Ref<HTMLDivElement> | undefined;
  dark?: boolean | undefined;
}) {
  const title = mapCardTitle(payload);
  const href = mapCardHref(cardId, payload.show);
  const shown: MapCardThumb = thumb ?? { kind: "none" };
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
    if (shown.kind === "tiles")
      return (
        <>
          <MapThumb content={content} provider={shown.provider} tiles={shown.tiles} />
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
            imgClass={`map-card-img${shown.dim === true ? " dim" : ""}`}
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
          <div className="map-card-thumb" ref={thumbRef} data-provider={shown.kind === "image" || shown.kind === "tiles" ? shown.provider : undefined} data-preview={shown.kind === "image" ? shown.preview.state : undefined}>
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
            {t("ui.plugins.map.card.openOwn", { name: ownName ?? own })}
          </a>
        )}
      </div>
    </div>
  );
}
