// 谷歌地图那一种底图（446）：用 Maps JavaScript API 画地图，照核心 model/map.ts 的 MapEngine 写（地图页只经这个接口用它）。
// - 坐标：二狗给的点是 WGS-84；谷歌在中国大陆的街道图是 GCJ-02——交给谷歌之前转 GCJ-02（大陆里才转），从谷歌拿回的中心转回 WGS-84
//   （protocol 的 geo.ts，和高德那一种一样）。大陆外原样；
// - 只要地图本身：不要谷歌自带的按钮（disableDefaultUI，放大缩小用地图页自己的）、不让点谷歌的兴趣点（clickableIcons: false），
//   谷歌的标志和版权行谷歌自己画、不遮（条款要求署名清楚可见）；
// - 深色：colorScheme（只能建地图时定）——外观换了就带着同一个中心和级别重建一次（谷歌按"一次地图加载"计费，外观很少换）；
// - 点：用和 OSM、高德那两种同一个样子（fillMark 的写法照抄在这里：插件之间不互相 import），放在一个 OverlayView 的
//   overlayMouseTarget 层里，按谷歌给的投影摆；线、圈用谷歌的 Polyline、Circle，颜色取这套风格的 token；
// - 每建一次谷歌地图报一次 onLoaded（守护进程数用量）；谷歌说 Key 不对（gm_authFailure，loader.ts 转来）时报 onFailed，地图页退回 OpenStreetMap。
// 用到的谷歌接口只有下面类型里写的这几样；测试和演示页换成假的（loader.ts 的 setGoogleLoader），不连真的谷歌。
import { gcjToWgs, wgsToGcj } from "../../state/index.ts";
import type { MapEngine, MapEngineOptions, MapMark, MapScene, MapView } from "../api.ts";

/** 谷歌的经纬度（getCenter 交回的） */
export interface GoogleLatLng {
  lat(): number;
  lng(): number;
}

/** 交给谷歌的经纬度 */
export interface GoogleLatLngLiteral {
  lat: number;
  lng: number;
}

/** 监听的句柄（addListener 交回的） */
export interface GoogleListener {
  remove(): void;
}

/** 谷歌的地图对象：只列用到的 */
export interface GoogleMap {
  getCenter(): GoogleLatLng | undefined;
  getZoom(): number | undefined;
  setCenter(center: GoogleLatLngLiteral): void;
  setZoom(zoom: number): void;
  addListener(event: "idle", handler: () => void): GoogleListener;
}

/** 放在地图上的一样东西（线、圈） */
export interface GoogleShape {
  setMap(map: GoogleMap | null): void;
}

/** 投影：经纬度 → 覆盖层里的像素 */
export interface GoogleProjection {
  fromLatLngToDivPixel(latLng: GoogleLatLngLiteral): { x: number; y: number } | null;
}

/** 自己画的覆盖层（谷歌的 OverlayView，子类写 onAdd、draw、onRemove） */
export interface GoogleOverlayView extends GoogleShape {
  getPanes(): { overlayMouseTarget: HTMLElement } | null;
  getProjection(): GoogleProjection | null;
}

/** importLibrary("maps") 交回的：只列用到的 */
export interface GoogleMapsLibrary {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Polyline: new (options: { path: GoogleLatLngLiteral[]; strokeColor: string; strokeWeight: number; strokeOpacity: number; clickable: boolean; map: GoogleMap }) => GoogleShape;
  Circle: new (options: { center: GoogleLatLngLiteral; radius: number; strokeColor: string; strokeWeight: number; strokeOpacity: number; fillColor: string; fillOpacity: number; clickable: boolean; map: GoogleMap }) => GoogleShape;
  OverlayView: (new () => GoogleOverlayView) & { preventMapHitsAndGesturesFrom?(element: HTMLElement): void };
}

/** 谷歌地图能放大到第几级、最小第几级（和别的两种差不多） */
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;
const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** 二狗的点（WGS-84）→ 交给谷歌的（GCJ-02，大陆内才转） */
export function toGoogle(p: { lat: number; lon: number }): GoogleLatLngLiteral {
  const g = wgsToGcj(p);
  return { lat: g.lat, lng: g.lon };
}

/** 这套风格的一个颜色（谷歌的线、圈要写成颜色值，不认 CSS 变量） */
function tokenColor(el: HTMLElement, name: string, fallback: string): string {
  const v = typeof getComputedStyle === "function" ? getComputedStyle(el).getPropertyValue(name).trim() : "";
  return v === "" ? fallback : v;
}

/** 一个点的样子：一枚定位针，旁边写字（和地图插件的 fillMark 一样的结构，样式在 map.css） */
function fillMark(el: HTMLElement, label: string | undefined): void {
  const doc = el.ownerDocument;
  const pin = doc.createElement("span");
  pin.className = "map-pin";
  pin.setAttribute("aria-hidden", "true");
  el.replaceChildren(pin);
  if (label) {
    const text = doc.createElement("span");
    text.className = "map-mark-label";
    text.textContent = label;
    el.append(text);
    el.setAttribute("aria-label", label);
  } else el.removeAttribute("aria-label");
}

export interface GoogleEngineOptions extends MapEngineOptions {
  /** 建了一次谷歌地图（计费的"一次地图加载"）：报给守护进程数用量 */
  onLoaded?(): void;
  /** 谷歌说 Key 不对时登记（loader.ts 的 onGoogleAuthFailure），交回撤销 */
  watchAuth?(handler: () => void): () => void;
  /** 谷歌说 Key 不对时给人看的一句 */
  authFailedText?: string;
}

export function createGoogleEngine(host: HTMLElement, lib: GoogleMapsLibrary, options: GoogleEngineOptions): MapEngine {
  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = "map-google";
  root.dataset.engine = "google";
  host.append(root);
  let last: MapView = { ...options.view, zoom: clamp(options.view.zoom) };
  let dark = options.dark;
  let scene: MapScene = { marks: [], lines: [], circles: [] };
  let shapes: GoogleShape[] = [];
  let destroyed = false;
  let failed = false;

  /** 点那一层：一个 OverlayView，里面每个点一个按钮，按投影摆 */
  const pane = doc.createElement("div");
  pane.className = "map-google-marks";
  let markEls: Array<{ mark: MapMark; el: HTMLElement }> = [];
  class Marks extends lib.OverlayView {
    onAdd() {
      this.getPanes()?.overlayMouseTarget.append(pane);
    }
    draw() {
      const projection = this.getProjection();
      if (!projection) return;
      for (const { mark, el } of markEls) {
        const p = projection.fromLatLngToDivPixel(toGoogle(mark));
        if (!p) continue;
        el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      }
    }
    onRemove() {
      pane.remove();
    }
  }

  let map: GoogleMap;
  let idle: GoogleListener | undefined;
  let marks: Marks | undefined;

  const view = (): MapView => {
    const c = map.getCenter();
    const zoom = map.getZoom();
    if (c === undefined || zoom === undefined) return last;
    const w = gcjToWgs({ lat: c.lat(), lon: c.lng() });
    last = { lat: w.lat, lon: w.lon, zoom };
    return last;
  };

  /** 线、圈、点照这一份画（换了地图要重放一遍） */
  const draw = () => {
    for (const s of shapes) s.setMap(null);
    const line = tokenColor(root, "--primary", "#3367d6");
    const next: GoogleShape[] = [];
    for (const c of scene.circles) {
      const color = c.kind === "accuracy" ? tokenColor(root, "--you", line) : line;
      next.push(new lib.Circle({ center: toGoogle(c), radius: c.radius, strokeColor: color, strokeWeight: 1, strokeOpacity: c.kind === "accuracy" ? 0.5 : 0.85, fillColor: color, fillOpacity: c.kind === "accuracy" ? 0.15 : 0.12, clickable: false, map }));
    }
    for (const l of scene.lines) {
      if (l.points.length < 2) continue;
      next.push(new lib.Polyline({ path: l.points.map(toGoogle), strokeColor: line, strokeWeight: l.kind === "route" ? 6 : 4, strokeOpacity: 0.85, clickable: false, map }));
    }
    shapes = next;
    markEls = scene.marks.map((mark) => {
      const el = doc.createElement("button");
      el.type = "button";
      el.className = "map-mark";
      el.dataset.id = mark.id;
      el.dataset.kind = mark.kind ?? "place";
      fillMark(el, mark.label);
      el.addEventListener("click", () => options.onMarkClick?.(mark.id));
      lib.OverlayView.preventMapHitsAndGesturesFrom?.(el);
      return { mark, el };
    });
    // "我现在的位置"的蓝点压在别的点上面：放在最后
    pane.replaceChildren(...markEls.toSorted((a, b) => Number(a.mark.kind === "me") - Number(b.mark.kind === "me")).map((m) => m.el));
    marks?.draw();
  };

  /** 建一张谷歌地图（第一次、换深浅色时） */
  const build = () => {
    idle?.remove();
    marks?.setMap(null);
    for (const s of shapes) s.setMap(null);
    shapes = [];
    root.replaceChildren();
    const canvas = doc.createElement("div");
    canvas.className = "map-google-canvas";
    root.append(canvas);
    map = new lib.Map(canvas, {
      center: toGoogle(last),
      zoom: clamp(last.zoom),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      colorScheme: dark ? "DARK" : "LIGHT",
      disableDefaultUI: true,
      gestureHandling: "greedy",
      clickableIcons: false,
      keyboardShortcuts: false,
    });
    options.onLoaded?.();
    idle = map.addListener("idle", () => {
      if (!destroyed) options.onMoveEnd(view());
    });
    marks = new Marks();
    marks.setMap(map);
    draw();
  };
  build();

  // 谷歌说 Key 不对：报给地图页（退回 OpenStreetMap、标"连不上"），只报一次
  const unwatch = options.watchAuth?.(() => {
    if (destroyed || failed) return;
    failed = true;
    options.onFailed?.(options.authFailedText ?? "auth");
  });

  return {
    kind: "google",
    view,
    setView(v) {
      last = { ...v, zoom: clamp(v.zoom) };
      map.setZoom(clamp(v.zoom));
      map.setCenter(toGoogle(v));
    },
    zoomBy(delta) {
      map.setZoom(clamp(Math.round(view().zoom) + delta));
    },
    setScene(next) {
      scene = next;
      draw();
    },
    setDark(next) {
      if (next === dark) return;
      dark = next;
      view();
      build();
    },
    destroy() {
      destroyed = true;
      unwatch?.();
      idle?.remove();
      marks?.setMap(null);
      for (const s of shapes) s.setMap(null);
      root.remove();
    },
  };
}
