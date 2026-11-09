// 聊天卡片、地图页的静态预览图（451）：高德、谷歌的静态地图经守护进程取（GET /api/map/preview，Key 不进页面、地址里不放坐标），
// 这里是页面这一半——
// - 几家地图服务（GET /api/map/config 的 providers）：聊天页上好多张卡共用一份，一分钟内不重取（useMapProviders）；
// - 看到了才取（useVisible：IntersectionObserver，往外多算 200 像素；浏览器没有它就当看到了）；
// - 要多大（previewSize）：盒子的宽度取整到 40 的倍数（同一种宽度的卡片地址一样），收在 [MAP_PREVIEW_MIN_SIDE, 640]；
//   像素密度高的屏幕要高清（scale 2）；
// - 取（useMapPreview）：同一个请求只取一次，换了请求、卸掉时放掉上一张（blob: 地址）；取不到交回原因（守护进程那一句）；
//   453 起图是光底图，连着回应头里的视野一起交回，点和线由 static-overlay.tsx 照它画在图上。
import { useEffect, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { MAP_PREVIEW_MIN_SIDE, type MapPreviewQuery, type MapPreviewView, type MapProviderView } from "../../state/index.ts";
import { providersOf } from "./providers.ts";

/** 预览图取到哪一步：在取、取到了（能放进 <img> 的地址；这张图的视野，453：页面照它画点和线）、取不到（原因） */
export type PreviewState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly url: string; readonly view?: MapPreviewView | undefined }
  | { readonly state: "failed"; readonly reason: string };

/** 卡片预览图最宽多少（谷歌的上限是 640，聊天里的卡片也用不着更宽） */
export const CARD_PREVIEW_MAX_WIDTH = 640;

/** 几家地图服务：同一个 http 一分钟内共用一份（取不到当没有：卡片都退回 OpenStreetMap 自己画） */
const PROVIDERS_TTL_MS = 60_000;
const providerCache = new WeakMap<DaemonHttp, { at: number; promise: Promise<readonly MapProviderView[]> }>();

function loadProviders(http: DaemonHttp): Promise<readonly MapProviderView[]> {
  const kept = providerCache.get(http);
  if (kept && Date.now() - kept.at < PROVIDERS_TTL_MS) return kept.promise;
  const promise = http.mapConfig().then(
    (config) => providersOf(config),
    () => [],
  );
  providerCache.set(http, { at: Date.now(), promise });
  return promise;
}

/** 几家地图服务（还没取到是 undefined） */
export function useMapProviders(http: DaemonHttp): readonly MapProviderView[] | undefined {
  const [providers, setProviders] = useState<readonly MapProviderView[]>();
  useEffect(() => {
    let alive = true;
    void loadProviders(http).then((list) => alive && setProviders(list));
    return () => {
      alive = false;
    };
  }, [http]);
  return providers;
}

/**
 * 这一块进了（或快进了）屏幕没有：进了一次就一直算看到了（浏览器没有 IntersectionObserver 当一开始就看到了）。
 * el 是那一块（回调 ref 存进 state 的；还没画出来是 null）
 */
export function useVisible(el: HTMLElement | null, active = true): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !active || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, active, el]);
  return seen;
}

/** 这一块的宽、高（量一次，ResizeObserver 报来；还没画出来是 0）。el 同 useVisible */
export function useBoxSize(el: HTMLElement | null, active = true): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measured = size.width > 0;
  useEffect(() => {
    if (!active || measured || !el) return;
    const take = () => {
      if (el.clientWidth > 0) setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    if (typeof ResizeObserver === "undefined") {
      const frame = requestAnimationFrame(take);
      return () => cancelAnimationFrame(frame);
    }
    const ro = new ResizeObserver(take);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, measured, el]);
  return size;
}

/** 收在 [MAP_PREVIEW_MIN_SIDE, hi] 里 */
const clampSide = (n: number, hi: number) => Math.max(MAP_PREVIEW_MIN_SIDE, Math.min(hi, n));

/** 要多大的图（逻辑像素）：宽取整到 40 的倍数、收在范围里；像素密度高的屏幕要高清 */
export function previewSize(width: number, height: number, maxWidth: number): { width: number; height: number; scale: 1 | 2 } {
  const clamp = clampSide;
  const w = clamp(Math.ceil(width / 40) * 40, maxWidth);
  const h = clamp(Math.round((height * w) / Math.max(1, width)), maxWidth);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return { width: w, height: h, scale: dpr >= 1.5 ? 2 : 1 };
}

/** 取一张预览图：q 变了重取（按内容认），卸掉时放掉；q 是 undefined 时不取 */
export function useMapPreview(http: DaemonHttp, q: MapPreviewQuery | undefined): PreviewState | undefined {
  const key = q === undefined ? undefined : JSON.stringify(q);
  const [got, setGot] = useState<{ key: string; state: PreviewState }>();
  useEffect(() => {
    if (key === undefined) return;
    const query = JSON.parse(key) as MapPreviewQuery;
    const gone = new AbortController();
    let release: (() => void) | undefined;
    http.mapPreview(query, gone.signal).then(
      (image) => {
        if (gone.signal.aborted) return image.release();
        release = image.release;
        setGot({ key, state: { state: "ready", url: image.url, view: image.view } });
      },
      (err: unknown) => {
        if (!gone.signal.aborted) setGot({ key, state: { state: "failed", reason: err instanceof Error ? err.message : String(err) } });
      },
    );
    return () => {
      gone.abort();
      release?.();
    };
  }, [http, key]);
  if (key === undefined) return undefined;
  return got?.key === key ? got.state : { state: "loading" };
}
