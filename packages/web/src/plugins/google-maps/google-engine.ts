// 谷歌地图那一种底图（446；453 起只出底图、关在隔离框里），照核心 model/map.ts 的 MapEngine 写（地图页只经这个接口用它）。
// - 隔离（isolated，默认）：谷歌的脚本关进 <iframe sandbox="allow-scripts">（核心的 ui/map-frame.ts、public/map-frame.html），
//   读不到地图页——足迹、点、线画在地图页盖在上面的自己那一层（地图插件的 overlay.ts），右侧的聊天窗也在外面。
//   框里跑的是 google-bridge.ts 的小桥（整段转成字符串交过去）：加载谷歌、建地图、照这里说的挪，报此刻画着哪一片；
//   不隔离（isolated: false）时同一段小桥直接在页面里跑（万一隔离框在真机上跑不通时的退路），数据照样不交给谷歌的接口；
// - 交给框的只有视野（中心、级别）、深浅和 Key（Key 本来就要进页面：谷歌的设计，网站限制管着它），**足迹、点、线一样都不交**；
// - 坐标：二狗的 WGS-84 交给谷歌之前转 GCJ-02（大陆里才转），框里报回来的转回 WGS-84；报给那一层的视野是谷歌的坐标（datum gcj02）；
// - 深色：colorScheme（只能建地图时定）——换了就带着同一个中心和级别在框里重建一次（谷歌按"一次地图加载"计费，外观很少换）；
// - 每建一次谷歌地图报一次 onLoaded（守护进程数用量）；谷歌说 Key 不对、加载不上、等太久报 onFailed（只报一次），地图页退回下一家；
// - 建好时还在加载（loading）：框里的谷歌加载好了报 onReady，地图页在那之前写"正在加载谷歌地图…"、不先画别家。
// 测试和演示页里框里装的是假谷歌（demo-google.ts，先于小桥跑），不连真的谷歌。
import { activeLanguage, gcjToWgs, wgsToGcj } from "../../state/index.ts";
import { type MapFrame, openMapFrame } from "../../ui/map-frame.ts";
import type { MapEngine, MapEngineOptions, MapSurfaceView, MapView } from "../api.ts";
import { googleBridge, type GoogleBridgeConfig, type GoogleBridgeEnv } from "./google-bridge.ts";

/** 谷歌 Maps JavaScript API 的脚本地址 */
export const GOOGLE_MAPS_SCRIPT_URL = "https://maps.googleapis.com/maps/api/js";
/** 写死的版本（谷歌的"quarterly"那一版的版本号，2026-11；谷歌每季度出一版、每版留大约一年，升级时改这一个数、跑页面测试） */
export const GOOGLE_MAPS_VERSION = "3.65";
/** 框里加载谷歌最多等多久 */
export const GOOGLE_LOAD_TIMEOUT_MS = 15_000;
/** 外层兜底：框本身没起来（没说"好了"）、小桥一直不回，等这么久算加载不了 */
const FRAME_TIMEOUT_MS = GOOGLE_LOAD_TIMEOUT_MS + 3_000;

/** 谷歌地图能放大到第几级、最小第几级（和别的两种差不多） */
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;
const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** 二狗的点（WGS-84）→ 交给谷歌的（GCJ-02，大陆内才转） */
export function toGoogle(p: { lat: number; lon: number }): { lat: number; lng: number } {
  const g = wgsToGcj(p);
  return { lat: g.lat, lng: g.lon };
}

/** 框里先跑的一段（演示页、测试的假谷歌）：code 是交给框的源码，install 是不进框时在页面里直接装 */
export interface GoogleFake {
  readonly code: string;
  install(win: Window & typeof globalThis): void;
}

export interface GoogleEngineOptions extends MapEngineOptions {
  /** 浏览器用的 Key */
  readonly key: string;
  /** 关进隔离框（默认）；false 时小桥直接在页面里跑 */
  readonly isolated?: boolean;
  /** 假谷歌（演示页、测试） */
  readonly fake?: GoogleFake | undefined;
  /** 建了一次谷歌地图（计费的"一次地图加载"）：报给守护进程数用量 */
  onLoaded?(): void;
  /** 谷歌说 Key 不对时报（给守护进程记下）；onFailed 照样报 */
  onAuthFailed?(): void;
  /** 给人看的两句：连不上、Key 不对 */
  readonly texts: { readonly unreachable: string; readonly authFailed: string };
  /** 框的地址（测试换） */
  readonly frameSrc?: string;
}

/** 框里报来的一个数（不是有限的数当没有） */
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** 交给框的那一段：先装假谷歌（有的话），再跑小桥 */
export function bridgeCode(fake?: GoogleFake): string {
  return `${fake ? `${fake.code}\n` : ""}(${googleBridge.toString()})(env, config);`;
}

export function createGoogleEngine(host: HTMLElement, options: GoogleEngineOptions): MapEngine {
  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = "map-google";
  root.dataset.engine = "google";
  const isolated = options.isolated !== false;
  root.dataset.isolated = isolated ? "frame" : "page";
  root.dataset.state = "loading";
  host.append(root);

  let last: MapView = { ...options.view, zoom: clamp(options.view.zoom) };
  let failed = false;
  let destroyed = false;
  const start = toGoogle(last);
  const config: GoogleBridgeConfig = {
    key: options.key,
    version: GOOGLE_MAPS_VERSION,
    language: activeLanguage(),
    scriptUrl: GOOGLE_MAPS_SCRIPT_URL,
    lat: start.lat,
    lng: start.lng,
    zoom: last.zoom,
    dark: options.dark,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    timeoutMs: GOOGLE_LOAD_TIMEOUT_MS,
    unreachable: options.texts.unreachable,
    authFailed: options.texts.authFailed,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** 框里（或页面里的小桥）报来的 */
  const handle = (msg: { readonly type: string; readonly [field: string]: unknown }) => {
    if (destroyed) return;
    const lat = num(msg.lat);
    const lng = num(msg.lng);
    const zoom = num(msg.zoom);
    switch (msg.type) {
      case "surface": {
        const width = num(msg.width);
        const height = num(msg.height);
        if (lat === undefined || lng === undefined || zoom === undefined || width === undefined || height === undefined) return;
        const view: MapSurfaceView = { lat, lon: lng, zoom, width, height, datum: "gcj02" };
        options.onSurface?.(view);
        return;
      }
      case "moveend": {
        if (lat === undefined || lng === undefined || zoom === undefined) return;
        const w = gcjToWgs({ lat, lon: lng });
        last = { lat: w.lat, lon: w.lon, zoom };
        options.onMoveEnd(last);
        return;
      }
      case "loaded":
        options.onLoaded?.();
        return;
      case "ready":
        if (root.dataset.state !== "loading") return;
        clearTimeout(timer);
        root.dataset.state = "ready";
        options.onReady?.();
        return;
      case "failed":
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        root.dataset.state = "failed";
        if (msg.auth === true) options.onAuthFailed?.();
        options.onFailed?.(typeof msg.reason === "string" ? msg.reason : options.texts.unreachable);
        return;
    }
  };

  timer = setTimeout(() => handle({ type: "failed", reason: options.texts.unreachable }), FRAME_TIMEOUT_MS);
  let send: (msg: { readonly type: string; readonly [field: string]: unknown }) => void;
  let frame: MapFrame | undefined;
  let stopBridge: (() => void) | undefined;
  if (isolated) {
    frame = openMapFrame(root, { code: bridgeCode(options.fake), config }, handle, options.frameSrc);
    send = (msg) => frame?.post(msg);
  } else {
    // 不隔离：同一段小桥在页面里跑（退路）
    const win = (doc.defaultView ?? window) as Window & typeof globalThis;
    options.fake?.install(win);
    const canvas = doc.createElement("div");
    canvas.className = "map-google-canvas";
    root.append(canvas);
    const listeners: Array<(msg: { readonly type: string; readonly [field: string]: unknown }) => void> = [];
    const env: GoogleBridgeEnv = { win, container: canvas, post: handle, listen: (fn) => listeners.push(fn) };
    stopBridge = googleBridge(env, config);
    send = (msg) => {
      for (const fn of listeners) fn(msg);
    };
  }

  return {
    kind: "google",
    loading: true,
    view: () => last,
    setView(v) {
      last = { ...v, zoom: clamp(v.zoom) };
      send({ type: "setView", ...toGoogle(v), zoom: last.zoom });
    },
    zoomBy(delta) {
      send({ type: "zoomBy", delta });
    },
    panBy(dx, dy) {
      send({ type: "panBy", dx, dy });
    },
    setDark(dark) {
      send({ type: "setDark", dark });
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      frame?.destroy();
      stopBridge?.();
      root.remove();
    },
  };
}
