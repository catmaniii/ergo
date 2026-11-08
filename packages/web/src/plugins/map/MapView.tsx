// 地图页中间那块地图（429）：按看的地方自动挑底图，两种底图之间整个换。
// - 看的中心在中国大陆、填了高德 Key（且高德没说 Key 不对、脚本加载上了）用高德；国外、香港澳门台湾、没填 Key 用 OpenStreetMap
//   （chooseBasemap）。拖、缩放停下来时按新的中心再挑一次，挑到别的就换（带着同一个中心和级别）；
// - 高德的脚本只在第一次真要用高德时加载；加载着的那一会儿先画 OpenStreetMap；加载不上就一直用 OpenStreetMap，写一句为什么；
// - 没填 Key 而看的是国内：照样用 OpenStreetMap，写一句"填了高德 Key 国内地图更清楚"，点了去设置 · 数据源 · 高德地图；
// - 署名：OpenStreetMap 时右下角写"© OpenStreetMap 贡献者"（链到它的版权页）；高德地图自己画它的标志和审图号，不遮；
// - 深色：跟着页面的外观（OSM 的瓦片加滤镜，高德换深色样式）；
// - 放大、缩小的按钮在右上（手机上捏合、电脑上滚轮也行）；"回到我现在的位置"在右下（442，地图页画，LocateControl.tsx），
//   它要说的那句话（notice）放在下面那句提示的位置上；
// - 画着用户自己的足迹时一律 OpenStreetMap、不加载高德的脚本（scene.ts 的 AMAP_WITH_FOOTPRINTS，用户 2026-11-07 定）；
// - 高德查来的地点和路线（amapScene，431 的地图卡片点开）只画在高德的地图上（高德的协议不许脱离它的服务展示）：底图是 OpenStreetMap 时
//   不画，写一句为什么（没填 Key 去填、拖到国外了回国内、高德没加载上）。
// 演示页（MODE === "demo"）里瓦片是编的占位图、高德是假的（demo-amap.ts），不连任何地图服务。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import type { Navigate } from "../../app/route.ts";
import { AMAP_SOURCE_ID, inMainlandChina, type MapConfigView, mapTilePath, t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { type AmapNamespace, createAmapEngine, loadAmap, setAmapLoader } from "./amap-engine.ts";
import { fakeAmapLoader } from "./demo-amap.ts";
import type { MapEngine } from "./engine.ts";
import { createOsmEngine } from "./osm-engine.ts";
import { AMAP_WITH_FOOTPRINTS, chooseBasemap, type MapScene, type MapView } from "./scene.ts";
import { demoBasemapNote, demoTileUrl } from "../../prototype/fake-map.ts";

/** OpenStreetMap 的版权页（署名角标链过去） */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/** 演示页：编的瓦片、假的高德、底图下面写一句"是编的"。安装版这个分支摇掉（字面的 MODE 比较） */
const DEMO =
  import.meta.env.MODE === "demo"
    ? {
        osmTile: (z: number, x: number, y: number) => demoTileUrl("osm", z, x, y),
        install: () => setAmapLoader(fakeAmapLoader((z, x, y) => demoTileUrl("amap", z, x, y))),
        note: demoBasemapNote,
      }
    : undefined;
DEMO?.install();

/** 真的页面：瓦片经守护进程的 /tiles/osm 转发（聊天里地图卡片的缩略图也用它） */
export const osmTileUrl = DEMO ? DEMO.osmTile : (z: number, x: number, y: number) => mapTilePath("osm", z, x, y);

/** 演示页的底图是编的：署名后面写一句（缩略图也用） */
export const demoBasemapNoteText = DEMO ? DEMO.note : undefined;

/** 高德加载到哪一步了（idle 包括正在加载） */
type AmapState = { state: "idle" } | { state: "ready"; key: string; ns: AmapNamespace } | { state: "failed"; key: string; reason: string };

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 页面现在是不是深色（跟着外观、系统） */
export function useDark(): boolean {
  const theme = pageTheme();
  return useSyncExternalStore(theme.subscribe, () => theme.theme() === "dark");
}

export interface MapCanvasProps {
  /** 地图页要的设置；还没取到是 undefined（先不画，免得先画 OSM 又换高德） */
  config: MapConfigView | undefined;
  scene: MapScene;
  /** 画着用户自己的足迹（挑底图时按 scene.ts 的 AMAP_WITH_FOOTPRINTS 走） */
  footprints?: boolean | undefined;
  /** 高德查来的地点和路线：只在底图是高德时画（在 scene 上面） */
  amapScene?: MapScene | undefined;
  /** 一开始看哪里 */
  initial: MapView;
  /** 跳到哪里：换了一个对象就跳（点了地点、地址里带了位置） */
  jump?: { view: MapView } | undefined;
  /** 停下来时看的是哪里（记住它） */
  onView?(view: MapView): void;
  onMarkClick?(id: string): void;
  navigate: Navigate;
  /**
   * 地图页"回到我现在的位置"（442）要说的那句话（正在找、拿不到这台设备的位置……）：放在下面那句提示的位置上，有它时先不显示提示；
   * onClose 有了才有"关上"
   */
  notice?: { text: string; onClose?: (() => void) | undefined } | undefined;
}

export function MapCanvas({ config, scene, footprints = false, amapScene, initial, jump, onView, onMarkClick, navigate, notice }: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | undefined>(undefined);
  /** 现在看的地方（换底图时带过去）；停下来时更新 */
  const viewRef = useRef<MapView>(initial);
  const dark = useDark();
  /** 停下来时的中心：底图按它挑、提示按它写 */
  const [settled, setSettled] = useState<MapView>(initial);
  const [amap, setAmap] = useState<AmapState>({ state: "idle" });
  const loadingRef = useRef<string | undefined>(undefined);

  const amapKey = config?.amapKey;
  // 高德那一种：这个 Key 加载上了就能画；这个 Key 加载不上就不再试（换了 Key 重新试）
  const amapNs = amap.state === "ready" && amap.key === amapKey ? amap.ns : undefined;
  const amapFailed = amap.state === "failed" && amap.key === amapKey ? amap.reason : undefined;
  const wantAmap = chooseBasemap(settled, amapKey !== undefined && amapFailed === undefined, footprints) === "amap";
  const rendered = wantAmap && amapNs ? "amap" : "osm";
  const ready = config !== undefined;
  const inChina = inMainlandChina(settled);
  // 真画上去的：高德查来的只在底图是高德时加上
  const amapExtra = amapScene !== undefined && amapScene.marks.length + amapScene.lines.length > 0;
  const drawn = useMemo<MapScene>(
    () => (rendered === "amap" && amapScene ? { marks: [...scene.marks, ...amapScene.marks], lines: [...scene.lines, ...amapScene.lines], circles: [...scene.circles, ...amapScene.circles] } : scene),
    [scene, amapScene, rendered],
  );

  // 拿最新的回调、外观、要画的东西（引擎的事件回调里用）
  const latest = useRef({ dark, scene: drawn, onView, onMarkClick });
  useEffect(() => {
    latest.current = { dark, scene: drawn, onView, onMarkClick };
  });

  // 真要用高德时才加载它的脚本（同一个 Key 只试一次）
  useEffect(() => {
    if (!wantAmap || amapKey === undefined || amapNs || amapFailed !== undefined || loadingRef.current === amapKey) return;
    loadingRef.current = amapKey;
    loadAmap(amapKey).then(
      (ns) => setAmap(typeof ns.Map === "function" ? { state: "ready", key: amapKey, ns } : { state: "failed", key: amapKey, reason: "AMap.Map missing" }),
      (err: unknown) => setAmap({ state: "failed", key: amapKey, reason: reasonOf(err) }),
    );
  }, [wantAmap, amapKey, amapNs, amapFailed]);

  // 画地图的那一层：底图换了就整个换掉，带着同一个中心和级别
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return;
    const events = {
      onMoveEnd: (v: MapView) => {
        viewRef.current = v;
        latest.current.onView?.(v);
        setSettled(v);
      },
      onMarkClick: (id: string) => latest.current.onMarkClick?.(id),
    };
    const osm = () => createOsmEngine(host, { view: viewRef.current, tileUrl: osmTileUrl, maxTileZoom: 19, ...events });
    let engine: MapEngine;
    if (rendered === "amap" && amapNs) {
      try {
        engine = createAmapEngine(host, amapNs, { view: viewRef.current, dark: latest.current.dark, ...events });
      } catch (err) {
        // 高德的脚本加载上了，但建不了地图：退回 OSM，记下为什么（下一轮再换）
        engine = osm();
        const key = amapKey ?? "";
        void Promise.resolve().then(() => setAmap({ state: "failed", key, reason: reasonOf(err) }));
      }
    } else engine = osm();
    engine.setDark(latest.current.dark);
    engine.setScene(latest.current.scene);
    engineRef.current = engine;
    return () => {
      viewRef.current = engine.view();
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = undefined;
    };
  }, [rendered, amapNs, amapKey, ready]);

  useEffect(() => engineRef.current?.setScene(drawn), [drawn]);
  useEffect(() => engineRef.current?.setDark(dark), [dark]);
  // 跳过去：引擎停下来时报回来（onMoveEnd），底图按新的地方再挑
  useEffect(() => {
    if (!jump) return;
    viewRef.current = jump.view;
    engineRef.current?.setView(jump.view);
  }, [jump]);

  const hint = ((): { text: string; action?: boolean } | undefined => {
    if (!ready || rendered === "amap") return undefined;
    // 高德查来的画不上去：为什么（高德还在加载的那一会儿不写）
    if (amapExtra) {
      if (amapFailed !== undefined) return { text: t("ui.plugins.map.hint.amapOnlyFailed", { reason: amapFailed }) };
      if (!inChina) return { text: t("ui.plugins.map.hint.amapOnlyAbroad") };
      if (config.amapKey === undefined || config.amapProblem) return { text: t("ui.plugins.map.hint.amapOnlyNoKey"), action: true };
      return undefined;
    }
    // 看足迹时本来就用 OpenStreetMap（scene.ts 的 AMAP_WITH_FOOTPRINTS）：不催着填高德的 Key
    if (footprints && !AMAP_WITH_FOOTPRINTS) return undefined;
    if (amapFailed !== undefined) return { text: t("ui.plugins.map.hint.amapFailed", { reason: amapFailed }) };
    if (!inChina) return undefined;
    if (config.amapProblem) return { text: t("ui.plugins.map.hint.amapProblem", { problem: config.amapProblem }), action: true };
    if (config.amapKey === undefined) return { text: t("ui.plugins.map.hint.noKey"), action: true };
    return undefined;
  })();

  return (
    <div
      className="map-canvas"
      data-basemap={ready ? rendered : "loading"}
      data-amap={amapNs ? "ready" : amapFailed !== undefined ? "failed" : "idle"}
      data-amap-results={amapExtra ? (rendered === "amap" ? "shown" : "hidden") : undefined}
    >
      <div className="map-host" ref={hostRef} />
      {!ready && <div className="map-loading">{t("ui.plugins.map.loading")}</div>}
      <span className="map-badge" data-basemap={rendered}>
        {rendered === "amap" ? t("ui.plugins.map.basemap.amap") : t("ui.plugins.map.basemap.osm")}
      </span>
      <div className="map-zoom">
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.zoomIn")} title={t("ui.plugins.map.zoomIn")} onClick={() => engineRef.current?.zoomBy(1)}>
          <Icon name="plus" />
        </button>
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.zoomOut")} title={t("ui.plugins.map.zoomOut")} onClick={() => engineRef.current?.zoomBy(-1)}>
          <Icon name="minus" />
        </button>
      </div>
      {notice && (
        <div className="map-hint map-locate-note" role="status">
          <span>{notice.text}</span>
          {notice.onClose && (
            <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.locate.close")} title={t("ui.plugins.map.locate.close")} onClick={notice.onClose}>
              <Icon name="cross" />
            </button>
          )}
        </div>
      )}
      {hint && !notice && (
        <div className="map-hint" role="status">
          <span>{hint.text}</span>
          {hint.action && (
            <button type="button" className="btn small" onClick={() => navigate({ tab: "more", page: "data-sources", item: AMAP_SOURCE_ID })}>
              {t("ui.plugins.map.hint.goSettings")}
            </button>
          )}
        </div>
      )}
      {rendered === "osm" && (
        <div className="map-attribution">
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">
            © OpenStreetMap
          </a>{" "}
          {t("ui.plugins.map.osmContributors")}
          {DEMO && <span className="map-demo-note"> · {DEMO.note()}</span>}
        </div>
      )}
      {rendered === "amap" && DEMO && <div className="map-attribution">{DEMO.note()}</div>}
    </div>
  );
}
