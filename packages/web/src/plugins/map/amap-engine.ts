// 高德地图那一种（429）：国内、填了高德 Key 时用高德 JS API 2.0 画地图。
// - 加载（loadAmap）：先设 window._AMapSecurityConfig = { serviceHost: <本页的来源>/_AMapService }（要在加载脚本之前），
//   再从 webapi.amap.com 加载高德的脚本。安全密钥不在页面上：高德的脚本把要带它的请求发到 serviceHost，
//   守护进程拼上再转给高德（网关的 /_AMapService/）。这是二狗唯一一处运行时从外站加载的脚本（用户定了用高德，ADR-0051）；
//   只在真要画高德地图时才加载（看国外、没填 Key 时一次都不连高德）；
// - 坐标：二狗给的点是 WGS-84，交给高德之前转 GCJ-02（大陆内才转），从高德拿回的中心转回 WGS-84；
// - 深色：高德自带的深色样式（amap://styles/dark）；
// - 点用和 OSM 那一种同一个样子（fillMark），线、圈用高德的折线、圆，颜色取这套风格的 token；
//   "回到我现在的位置"（442）的蓝点也是这样交给高德（同样先转 GCJ-02），精度圈取 --you。
// 用到的高德接口只有下面类型里写的这几样；测试和演示页换成假的（setAmapLoader），不连真的高德。
import { AMAP_SERVICE_PREFIX, gcjToWgs, wgsToGcj } from "../../state/index.ts";
import type { MapEngine, MapEngineEvents } from "./engine.ts";
import { fillMark } from "./osm-engine.ts";
import { clampZoom, type MapScene, type MapView } from "./scene.ts";

/** 高德 JS API 的脚本地址 */
export const AMAP_SCRIPT_URL = "https://webapi.amap.com/maps";
/** 加载高德的脚本最多等多久 */
const AMAP_LOAD_TIMEOUT_MS = 15_000;

/** 高德的经纬度（getCenter 交回的） */
export interface AmapLngLat {
  getLng(): number;
  getLat(): number;
}

/** 地图上的一样东西（标记、折线、圆） */
export interface AmapOverlay {
  on?(event: "click", handler: () => void): void;
}

/** 高德的地图对象：只列用到的 */
export interface AmapMap {
  getCenter(): AmapLngLat;
  getZoom(): number;
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  setZoom(zoom: number): void;
  setMapStyle(style: string): void;
  on(event: "moveend" | "zoomend", handler: () => void): void;
  add(overlays: AmapOverlay[]): void;
  remove(overlays: AmapOverlay[]): void;
  destroy(): void;
}

/** 高德的命名空间（window.AMap）：只列用到的 */
export interface AmapNamespace {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMap;
  Marker: new (options: { position: [number, number]; content: HTMLElement; anchor: string; zIndex?: number }) => AmapOverlay;
  Polyline: new (options: { path: [number, number][]; strokeColor: string; strokeWeight: number; strokeOpacity: number; lineJoin: string; lineCap: string }) => AmapOverlay;
  Circle: new (options: {
    center: [number, number];
    radius: number;
    strokeColor: string;
    strokeWeight: number;
    strokeOpacity?: number;
    fillColor: string;
    fillOpacity: number;
    /** 高德原样留着的附加数据：记下是哪一个圈、哪一种（演示页的假高德按它画样式） */
    extData?: { id: string; kind?: string };
  }) => AmapOverlay;
}

/** 怎么拿到高德：Key、serviceHost → 命名空间 */
export type AmapLoader = (key: string, serviceHost: string) => Promise<AmapNamespace>;

type AmapWindow = Window & { AMap?: AmapNamespace; _AMapSecurityConfig?: { serviceHost: string }; [callback: string]: unknown };

let pending: { key: string; promise: Promise<AmapNamespace> } | undefined;

/** 真的加载：设好安全密钥的代理，从高德加载脚本（同一个 Key 只加载一次） */
export const loadAmapScript: AmapLoader = (key, serviceHost) => {
  const w = window as unknown as AmapWindow;
  if (pending?.key === key) return pending.promise;
  if (w.AMap?.Map) return Promise.resolve(w.AMap);
  const callback = "__ergoAmapReady";
  const promise = new Promise<AmapNamespace>((resolve, reject) => {
    // 安全密钥的代理：必须在加载脚本之前设好
    w._AMapSecurityConfig = { serviceHost };
    const timer = setTimeout(() => reject(new Error("timeout")), AMAP_LOAD_TIMEOUT_MS);
    w[callback] = () => {
      clearTimeout(timer);
      delete w[callback];
      if (w.AMap?.Map) resolve(w.AMap);
      else reject(new Error("AMap missing"));
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = `${AMAP_SCRIPT_URL}?v=2.0&key=${encodeURIComponent(key)}&callback=${callback}`;
    script.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("script failed"));
    });
    document.head.append(script);
  });
  pending = { key, promise };
  promise.catch(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  return promise;
};

let loader: AmapLoader = loadAmapScript;

/** 换掉加载高德的办法（演示页、测试给假的） */
export function setAmapLoader(next: AmapLoader): void {
  loader = next;
}

/** 加载高德（用现在登记的办法）；serviceHost 是本页的来源加上 /_AMapService */
export function loadAmap(key: string): Promise<AmapNamespace> {
  return loader(key, `${window.location.origin}${AMAP_SERVICE_PREFIX}`);
}

/** 这套风格的一个颜色（高德的折线、圆要写成颜色值，不认 CSS 变量） */
function tokenColor(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

/** 二狗的点（WGS-84）→ 交给高德的 [经度, 纬度]（GCJ-02，大陆内才转） */
function toAmap(p: { lat: number; lon: number }): [number, number] {
  const g = wgsToGcj(p);
  return [g.lon, g.lat];
}

export interface AmapEngineOptions extends MapEngineEvents {
  view: MapView;
  dark: boolean;
}

/** 停下来多久算"移动完"（高德的 moveend、zoomend 可能连着来） */
const SETTLE_MS = 120;

export function createAmapEngine(host: HTMLElement, AMap: AmapNamespace, options: AmapEngineOptions): MapEngine {
  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = "map-amap";
  root.dataset.engine = "amap";
  host.append(root);
  const start = toAmap(options.view);
  const map = new AMap.Map(root, {
    center: start,
    zoom: clampZoom(options.view.zoom),
    zooms: [3, 20],
    viewMode: "2D",
    resizeEnable: true,
    mapStyle: options.dark ? "amap://styles/dark" : "amap://styles/normal",
  });
  let overlays: AmapOverlay[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const view = (): MapView => {
    const c = map.getCenter();
    const w = gcjToWgs({ lat: c.getLat(), lon: c.getLng() });
    return { lat: w.lat, lon: w.lon, zoom: map.getZoom() };
  };
  const settled = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!destroyed) options.onMoveEnd(view());
    }, SETTLE_MS);
  };
  map.on("moveend", settled);
  map.on("zoomend", settled);

  return {
    kind: "amap",
    view,
    setView(v) {
      map.setZoomAndCenter(clampZoom(v.zoom), toAmap(v), true);
    },
    zoomBy(delta) {
      map.setZoom(Math.round(map.getZoom()) + delta);
    },
    setScene(scene: MapScene) {
      if (overlays.length > 0) map.remove(overlays);
      const line = tokenColor(root, "--primary", getComputedStyle(root).color);
      const next: AmapOverlay[] = [];
      for (const c of scene.circles) {
        // 定位的精度圈（442）和蓝点同色（--you："跟你有关的蓝"），别的范围圈用强调色
        const color = c.kind === "accuracy" ? tokenColor(root, "--you", line) : line;
        next.push(
          new AMap.Circle({
            center: toAmap(c),
            radius: c.radius,
            strokeColor: color,
            strokeWeight: 1,
            ...(c.kind === "accuracy" ? { strokeOpacity: 0.5 } : {}),
            fillColor: color,
            fillOpacity: c.kind === "accuracy" ? 0.15 : 0.12,
            extData: { id: c.id, ...(c.kind ? { kind: c.kind } : {}) },
          }),
        );
      }
      for (const l of scene.lines) {
        if (l.points.length < 2) continue;
        next.push(new AMap.Polyline({ path: l.points.map(toAmap), strokeColor: line, strokeWeight: l.kind === "route" ? 6 : 4, strokeOpacity: 0.85, lineJoin: "round", lineCap: "round" }));
      }
      for (const m of scene.marks) {
        const el = doc.createElement("button");
        el.type = "button";
        el.className = "map-mark";
        el.dataset.id = m.id;
        el.dataset.kind = m.kind ?? "place";
        fillMark(el, m.label);
        el.addEventListener("click", () => options.onMarkClick?.(m.id));
        // "我现在的位置"的蓝点压在别的点上面
        next.push(new AMap.Marker({ position: toAmap(m), content: el, anchor: "bottom-center", zIndex: m.kind === "me" ? 130 : 120 }));
      }
      overlays = next;
      if (next.length > 0) map.add(next);
    },
    setDark(dark) {
      map.setMapStyle(dark ? "amap://styles/dark" : "amap://styles/normal");
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      map.destroy();
      root.remove();
    },
  };
}
