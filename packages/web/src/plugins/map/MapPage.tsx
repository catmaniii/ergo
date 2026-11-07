// 地图页（429，#/more/map[/<纬度>,<经度>[,<级别>]]）：上面一条标题栏，下面整块是地图（MapView.tsx）。
// - 一开始看哪里：地址里带了位置看那里；没带看这台设备上次看的地方（存在浏览器里，只是方便）；都没有看整个中国；
// - 演示页：上面一排两个地点（国内一处、新加坡一处），点了跳过去、底图跟着换，地图上标着它们；
// - 地图上的东西（MapScene）：429 只有演示页的两个地点；430 我的足迹、431 聊天里的地图卡片、432 高德查到的地点和路线往里放。
// 直接显示在导航里（MapSection）和收进"更多"（MapColumn）画的是同一页，后者左上角有返回。
import { useEffect, useMemo, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { type MapConfigView, parseMapFocusItem, t } from "../../state/index.ts";
import { TopBar } from "../../ui/common.tsx";
import type { PageColumnProps, PageSectionProps } from "../api.ts";
import { MapCanvas } from "./MapView.tsx";
import { DEFAULT_VIEW, EMPTY_SCENE, type MapScene, type MapView, parseSavedView } from "./scene.ts";
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

function MapScreen({ item, navigate, onBack }: { item: string | undefined; navigate: Navigate; onBack: (() => void) | undefined }) {
  const { http } = useStore();
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

  const scene = useMemo<MapScene>(() => (places.length === 0 ? EMPTY_SCENE : { marks: places.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, label: p.label, kind: "place" as const })), lines: [], circles: [] }), [places]);

  return (
    <div className="chat-col map-page">
      <TopBar title={t("ui.plugins.map.title")} onBack={onBack} />
      {places.length > 0 && (
        <div className="map-places" role="toolbar" aria-label={t("ui.plugins.map.places")}>
          {places.map((p) => (
            <button key={p.id} type="button" className="chip" data-place={p.id} onClick={() => setJump({ view: { lat: p.lat, lon: p.lon, zoom: p.zoom } })}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <MapCanvas
        config={config}
        scene={scene}
        initial={initial}
        jump={jump}
        onView={import.meta.env.MODE === "demo" ? undefined : saveView}
        onMarkClick={(id) => {
          const p = places.find((x) => x.id === id);
          if (p) setJump({ view: { lat: p.lat, lon: p.lon, zoom: Math.max(p.zoom, 15) } });
        }}
        navigate={navigate}
      />
    </div>
  );
}

/** 直接显示在导航里：整页 */
export function MapSection({ item, navigate }: PageSectionProps) {
  return <MapScreen item={item} navigate={navigate} onBack={undefined} />;
}

/** 收进"更多"时右边（竖屏是整页）那一栏：左上角返回"更多" */
export function MapColumn({ item, navigate, onBack }: PageColumnProps) {
  return <MapScreen item={item} navigate={navigate} onBack={onBack} />;
}
