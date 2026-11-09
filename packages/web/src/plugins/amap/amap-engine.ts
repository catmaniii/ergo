// 高德地图那一种（429；455 起在高德地图插件里）：国内、填了高德 Key 时用高德 JS API 2.0 画地图。
// - 加载（loadAmap）：先设 window._AMapSecurityConfig = { serviceHost: <本页的来源>/_AMapService }（要在加载脚本之前），
//   再从 webapi.amap.com 加载高德的脚本。安全密钥不在页面上：高德的脚本把要带它的请求发到 serviceHost，
//   守护进程拼上再转给高德（网关的 /_AMapService/）。这是二狗运行时从外站加载的脚本之一（用户定了用高德，ADR-0051）；
//   只在真要画高德地图时才加载（看国外没选高德、没填 Key 时一次都不连高德）；
// - 453 起**只出底图**：足迹、点、线、圈不交给高德的覆盖物（Marker、Polyline、Circle 一个都不建），由地图页盖在上面的自己那一层画
//   （地图插件的 overlay.ts）。这里每动一下报一次此刻画着哪一片（onSurface：GCJ-02 的中心、级别、大小），那一层照它投影。
//   高德的脚本和页面在同一个页面里（放不进隔离的框：它的安全密钥代理要带这台设备的凭证、本机端口要同源，框里发的请求两样都没有，
//   见 ADR-0059），技术上仍读得到页面；只是数据不再经它的接口；
// - 捏合、惯性、双击的过程中跟手（458）：高德 2.0 是自己一帧一帧画的（不像谷歌的栅格地图整块拉伸），中心和级别在动画里就是画面上的；
//   这里动着的时候每一帧读（surface-watch.ts），高德的 mapmove、zoomchange 来了当场再读，松手也叫醒；级别多要几位小数
//   （getZoom 默认只留两位）。没有真高德能量（要 Key），真机上看；要是真高德捏合时还漂，下一步照谷歌那样放探针（ADR-0059 的 458 修订）；
// - 不让转、不让斜（rotateEnable、pitchEnable 关掉）：上面那一层按正北朝上的 Web 墨卡托投影；
// - 坐标：二狗的 WGS-84 交给高德之前转 GCJ-02（大陆内才转），从高德拿回的中心转回 WGS-84；
// - 深色：高德自带的深色样式（amap://styles/dark）。
// 用到的高德接口只有下面类型里写的这几样；测试和演示页换成假的（setAmapLoader），不连真的高德。
import { AMAP_SERVICE_PREFIX, gcjToWgs, wgsToGcj } from "../../state/index.ts";
import { clampZoom, pointOnScreen } from "../../ui/map-tiles.ts";
import type { MapEngine, MapEngineEvents, MapSurfaceView, MapView } from "../api.ts";
import { watchSurface } from "./surface-watch.ts";

/** 高德 JS API 的脚本地址 */
export const AMAP_SCRIPT_URL = "https://webapi.amap.com/maps";
/** 加载高德的脚本最多等多久 */
const AMAP_LOAD_TIMEOUT_MS = 15_000;

/** 高德的经纬度（getCenter 交回的） */
export interface AmapLngLat {
  getLng(): number;
  getLat(): number;
}

/** 高德的地图对象：只列用到的 */
export interface AmapMap {
  getCenter(): AmapLngLat;
  /** digits：小数留几位（高德 2.0 不给时留 2 位） */
  getZoom(digits?: number): number;
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  setZoom(zoom: number): void;
  setCenter(center: [number, number], immediately?: boolean): void;
  setMapStyle(style: string): void;
  /** 移动、缩放的事件：mapmove、zoomchange、moveend、zoomend、resize（2.0 的名字） */
  on(event: AmapEvent, handler: () => void): void;
  destroy(): void;
}

/** 用到的高德地图事件 */
export type AmapEvent = "mapmove" | "zoomchange" | "moveend" | "zoomend" | "resize";

/** 高德的命名空间（window.AMap）：只列用到的（453 起只用 Map，覆盖物一个都不建） */
export interface AmapNamespace {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMap;
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
/**
 * 报给上面那一层的级别留几位小数（458）：高德 2.0 的 getZoom() 默认只留 2 位，捏合到一半时级别差 0.005 就是 0.35% 的比例，
 * 离屏幕中心 400 像素的点差 1.4 像素；留 6 位就看不出来了
 */
const SURFACE_ZOOM_DIGITS = 6;

export function createAmapEngine(host: HTMLElement, AMap: AmapNamespace, options: AmapEngineOptions): MapEngine {
  const doc = host.ownerDocument;
  const win = doc.defaultView ?? window;
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
    // 上面那一层按正北朝上投影：不让转、不让斜
    rotateEnable: false,
    pitchEnable: false,
    mapStyle: options.dark ? "amap://styles/dark" : "amap://styles/normal",
    // 国外也用高德时（451：国外没填谷歌默认高德）要它的"世界地图"——高德要提工单给 Key 开通，没开通时国外可能很空；
    // 照样带上，不因此报错（用户可以在地图切换里改用 OpenStreetMap）
    showOversea: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const view = (): MapView => {
    const c = map.getCenter();
    const w = gcjToWgs({ lat: c.getLat(), lon: c.getLng() });
    return { lat: w.lat, lon: w.lon, zoom: map.getZoom() };
  };
  /** 此刻画着哪一片（高德自己的坐标：大陆里 GCJ-02） */
  const surface = (): MapSurfaceView => {
    const c = map.getCenter();
    return { lat: c.getLat(), lon: c.getLng(), zoom: map.getZoom(SURFACE_ZOOM_DIGITS), width: root.clientWidth, height: root.clientHeight, datum: "gcj02" };
  };
  const watch = watchSurface(
    () => (destroyed ? undefined : surface()),
    (v) => options.onSurface?.(v),
    win,
  );
  const settled = () => {
    watch.poke();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!destroyed) options.onMoveEnd(view());
    }, SETTLE_MS);
  };
  map.on("moveend", settled);
  map.on("zoomend", settled);
  for (const e of ["mapmove", "zoomchange", "resize"] as const) map.on(e, () => watch.poke());
  // 手指、鼠标、滚轮一动就叫醒（拖的时候、惯性滑的时候每一帧都报）；松手也叫（458：松手后高德还要惯性滑、双击放大，那一段还在动）
  for (const e of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "touchstart", "touchmove", "touchend", "touchcancel", "dblclick"] as const) {
    root.addEventListener(e, () => watch.poke(), { capture: true, passive: true });
  }
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => watch.poke());
  resize?.observe(root);
  watch.poke();

  return {
    kind: "amap",
    view,
    setView(v) {
      map.setZoomAndCenter(clampZoom(v.zoom), toAmap(v), true);
      watch.poke();
    },
    zoomBy(delta) {
      map.setZoom(Math.round(map.getZoom()) + delta);
      watch.poke();
    },
    panBy(dx, dy) {
      const s = surface();
      const c = pointOnScreen(s.width / 2 - dx, s.height / 2 - dy, { lat: s.lat, lon: s.lon }, s.zoom, s.width, s.height);
      map.setCenter([c.lon, c.lat], true);
      watch.poke();
    },
    setDark(dark) {
      map.setMapStyle(dark ? "amap://styles/dark" : "amap://styles/normal");
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      watch.stop();
      resize?.disconnect();
      map.destroy();
      root.remove();
    },
  };
}
