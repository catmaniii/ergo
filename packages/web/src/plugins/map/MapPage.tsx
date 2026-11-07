// 地图页（429，#/more/map[/<纬度>,<经度>[,<级别>]]）：上面一条标题栏，下面整块是地图（MapView.tsx）。
// - 一开始看哪里：地址里带了位置看那里；没带看这台设备上次看的地方（存在浏览器里，只是方便）；都没有看整个中国；
// - 演示页：上面一排两个地点（国内一处、新加坡一处），点了跳过去、底图跟着换，地图上标着它们；
// - 地图上的东西（MapScene）：429 只有演示页的两个地点；430 我的足迹、431 聊天里的地图卡片、432 高德查到的地点和路线往里放。
// - 我的足迹（430，DayFootprints.tsx）：标题栏下面一条选日期的，地图上画那一天的轨迹、停留、照片、常去的地方，点停留点看详情；
//   地址里可以带日期（#/more/map/<YYYY-MM-DD>）。
// - 聊天里的地图卡片点开（431，#/more/map/card/<卡片编号>）：从手里的卡片状态取出这张卡，画它的点、线（和卡片同一份 card-scene.ts），
//   视野挪到看全它；标题栏下面一条写卡片的标题和概况，"×"回到足迹。看卡片时不画足迹。高德查来的只在底图是高德时画（amap-results.ts）。
// 直接显示在导航里（MapSection）和收进"更多"（MapColumn）画的是同一页，后者左上角有返回。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { type MapCardPayload, type MapConfigView, mapCardTitle, parseMapCardPath, parseMapFocusItem, t } from "../../state/index.ts";
import { TopBar } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { PageColumnProps, PageSectionProps } from "../api.ts";
import { FOOTPRINT_LABEL_ROOM, FOOTPRINT_PANEL_W, FOOTPRINT_WIDE_MIN, FootprintBar, FootprintPanel, FootprintToggle, useFootprints, useWidth } from "./DayFootprints.tsx";
import { contentSummary } from "./card-scene.ts";
import { shiftViewRight, withFootprints } from "./footprints.ts";
import { useMapCardData } from "./MapCard.tsx";
import { MapCanvas } from "./MapView.tsx";
import { DEFAULT_VIEW, EMPTY_SCENE, type MapScene, type MapView, parseSavedView, viewToFit } from "./scene.ts";
import { demoMapPlaces } from "../../prototype/fake-map.ts";

/** 这台设备上次看的地方存在哪（浏览器里，只是方便） */
const SAVED_VIEW_KEY = "ergo-map-view";

/** 演示页的两个地点（安装版这个分支摇掉） */
const demoPlaces = () => (import.meta.env.MODE === "demo" ? demoMapPlaces() : []);

function savedView(): MapView | undefined {
  try {
    return parseSavedView(localStorage.getItem(SAVED_VIEW_KEY));
  } catch {
    return undefined;
  }
}

function saveView(view: MapView): void {
  try {
    localStorage.setItem(SAVED_VIEW_KEY, JSON.stringify({ lat: Number(view.lat.toFixed(6)), lon: Number(view.lon.toFixed(6)), zoom: Number(view.zoom.toFixed(2)) }));
  } catch {
    // 存不了（隐私模式）就算了
  }
}

/** 地址里的位置 → 看哪里（没写级别看 15 级） */
function focusOf(item: string | undefined): MapView | undefined {
  const f = parseMapFocusItem(item);
  return f ? { lat: f.lat, lon: f.lon, zoom: f.zoom ?? 15 } : undefined;
}

function MapScreen({ item, sub, navigate, onBack }: { item: string | undefined; sub: string | undefined; navigate: Navigate; onBack: (() => void) | undefined }) {
  const { http, ui } = useStore();
  const [config, setConfig] = useState<MapConfigView>();
  const places = useMemo(() => demoPlaces(), []);
  const [initial] = useState<MapView>(() => focusOf(item) ?? (places[0] ? { lat: places[0].lat, lon: places[0].lon, zoom: places[0].zoom } : (savedView() ?? DEFAULT_VIEW)));
  // 跳到哪里：点了地点、地址里的位置变了（聊天里的地图卡片点进来）。地址变了在渲染时就换（React 推荐的"跟着 props 调 state"的写法）
  const [jump, setJump] = useState<{ view: MapView }>();
  const [lastItem, setLastItem] = useState(item);
  if (item !== lastItem) {
    setLastItem(item);
    const f = focusOf(item);
    if (f) setJump({ view: f });
  }

  useEffect(() => {
    let alive = true;
    http.mapConfig().then(
      (c) => alive && setConfig(c),
      // 取不到（插件刚停用、断线）：当作没填 Key，照样能看 OpenStreetMap
      () => alive && setConfig({}),
    );
    return () => {
      alive = false;
    };
  }, [http]);

  const base = useMemo<MapScene>(() => (places.length === 0 ? EMPTY_SCENE : { marks: places.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, label: p.label, kind: "place" as const })), lines: [], circles: [] }), [places]);

  // 我的足迹：取到一天就把视野挪到看得全它（宽的时候让开左边那一栏，右边给点旁边的字留地方），点了列表里的一行挪过去
  const fp = useFootprints(http, item);
  const stageRef = useRef<HTMLDivElement>(null);
  const wide = useWidth(stageRef) >= FOOTPRINT_WIDE_MIN;
  const [listOpen, setListOpen] = useState(false);
  /** 现在看的是哪里（只挪不缩放时用它的级别） */
  const viewNow = useRef<MapView>(initial);
  // 聊天里的地图卡片点开（431）：这张卡画什么
  const cardId = parseMapCardPath(item, sub);
  const cardState = cardId === undefined ? undefined : ui.cards[cardId];
  const cardPayload = cardState?.card.type === "map" ? (cardState.card.payload as MapCardPayload) : undefined;
  const cardData = useMapCardData(http, cardPayload?.show);
  const cardContent = cardData?.state === "ready" ? cardData.content : undefined;
  useEffect(() => {
    if (!cardContent) return;
    const el = stageRef.current;
    const v = viewToFit(cardContent.bounds, (el?.clientWidth ?? 390) - FOOTPRINT_LABEL_ROOM, el?.clientHeight ?? 600);
    if (v) setJump({ view: shiftViewRight(v, -FOOTPRINT_LABEL_ROOM / 2) });
  }, [cardContent]);

  useEffect(() => {
    // 看卡片时不挪到足迹；关了卡片（回到 #/more/map）再挪回来
    if (!fp.fit || cardId !== undefined) return;
    const el = stageRef.current;
    const panel = el && el.clientWidth >= FOOTPRINT_WIDE_MIN ? FOOTPRINT_PANEL_W : 0;
    const v = viewToFit(fp.fit.bounds, (el?.clientWidth ?? 390) - panel - FOOTPRINT_LABEL_ROOM, el?.clientHeight ?? 600);
    if (v) setJump({ view: shiftViewRight(v, (panel - FOOTPRINT_LABEL_ROOM) / 2) });
  }, [fp.fit, cardId]);
  useEffect(() => {
    if (!fp.focus) return;
    const el = stageRef.current;
    const panel = el && el.clientWidth >= FOOTPRINT_WIDE_MIN ? FOOTPRINT_PANEL_W : 0;
    setJump({ view: shiftViewRight({ lat: fp.focus.lat, lon: fp.focus.lon, zoom: fp.focus.zoom ?? viewNow.current.zoom }, panel / 2) });
  }, [fp.focus]);
  // 看卡片时画卡片（高德查来的另交给 amapScene：只在底图是高德时画），不画足迹
  const showCard = cardId !== undefined;
  const scene = useMemo(
    () => (showCard ? withFootprints(base, cardContent && !cardContent.amapOnly ? cardContent.scene : undefined) : withFootprints(base, fp.shown ? fp.day?.scene : undefined)),
    [base, showCard, cardContent, fp.shown, fp.day],
  );
  const amapScene = cardContent?.amapOnly ? cardContent.scene : undefined;
  // "足迹"开着就当画着足迹（还没取到、这一天空着也算）：底图一律 OpenStreetMap，也不为它加载高德的脚本（scene.ts 的 AMAP_WITH_FOOTPRINTS）
  const footprintsDrawn = showCard ? cardContent?.footprints === true : fp.shown;
  const cardTitle = cardPayload ? mapCardTitle(cardPayload) : undefined;
  const cardNote = cardId === undefined ? undefined : cardState === undefined ? t("ui.plugins.map.card.missing") : cardData ? contentSummary(cardData) : undefined;

  return (
    <div className="chat-col map-page">
      <TopBar title={t("ui.plugins.map.title")} onBack={onBack}>
        {!showCard && <FootprintToggle fp={fp} />}
      </TopBar>
      {showCard ? (
        <div className="map-card-bar" role="status">
          <Icon name="map" />
          <span className="map-card-bar-text">
            <b>{cardTitle ?? t("ui.plugins.map.card.bar")}</b>
            {cardNote !== undefined && <span className="map-card-bar-note">{cardNote}</span>}
          </span>
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.card.close")} title={t("ui.plugins.map.card.close")} onClick={() => navigate({ tab: "more", page: "map" })}>
            <Icon name="cross" />
          </button>
        </div>
      ) : (
        <FootprintBar fp={fp} wide={wide} listOpen={listOpen} onList={() => setListOpen(!listOpen)} navigate={navigate} />
      )}
      {places.length > 0 && (
        <div className="map-places" role="toolbar" aria-label={t("ui.plugins.map.places")}>
          {places.map((p) => (
            <button key={p.id} type="button" className="chip" data-place={p.id} onClick={() => setJump({ view: { lat: p.lat, lon: p.lon, zoom: p.zoom } })}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="map-stage" ref={stageRef}>
        <MapCanvas
          config={config}
          scene={scene}
          footprints={footprintsDrawn}
          amapScene={amapScene}
          initial={initial}
          jump={jump}
          onView={(v) => {
            viewNow.current = v;
            if (import.meta.env.MODE !== "demo") saveView(v);
          }}
          onMarkClick={(id) => {
            if (fp.markClick(id)) return;
            const p = places.find((x) => x.id === id);
            if (p) setJump({ view: { lat: p.lat, lon: p.lon, zoom: Math.max(p.zoom, 15) } });
          }}
          navigate={navigate}
        />
        {!showCard && <FootprintPanel fp={fp} wide={wide} listOpen={listOpen} onCloseList={() => setListOpen(false)} navigate={navigate} />}
      </div>
    </div>
  );
}

/** 直接显示在导航里：整页 */
export function MapSection({ item, sub, navigate }: PageSectionProps) {
  return <MapScreen item={item} sub={sub} navigate={navigate} onBack={undefined} />;
}

/** 收进"更多"时右边（竖屏是整页）那一栏：左上角返回"更多" */
export function MapColumn({ item, sub, navigate, onBack }: PageColumnProps) {
  return <MapScreen item={item} sub={sub} navigate={navigate} onBack={onBack} />;
}
