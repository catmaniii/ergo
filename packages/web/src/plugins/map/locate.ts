// 地图页的"回到我现在的位置"（442）：取现在的位置、算挪到哪、画什么、说哪句话。不碰 DOM、不碰 React，测试在 Node 里跑
// （浏览器的定位、App 的原生桥、取手机最近一个点都由外面给）。
// 现在的位置按顺序从这几处取，前一处拿不到才用下一处：
// 1. 鸿蒙 App 里：原生桥现成的"现在在哪"（phonePlaceHere：定一次位，App 等最多 10 秒；没有精度）。安卓 App 没有这一组；
// 2. 浏览器：navigator.geolocation.getCurrentPosition（高精度、10 秒超时；本机 127.0.0.1、https、file:// 才是安全上下文，
//    局域网的 http 地址浏览器不给定位，当作用不了）。两个 App 的网页都关了网页定位，在 App 里这一步会马上被拒；
// 3. 退路：手机最近交来的一个位置点（GET /api/map/latest），写明是多久以前手机交来的。都没有就说拿不到。
// 设备给的坐标都是 WGS-84（二狗里一律存它）；画在高德底图上时由 amap-engine.ts 转 GCJ-02（大陆内才转），这里不转。
// 隐私：位置只在这个页面的内存里用，不存（地图页记"上次看哪里"时跳过定位挪过去的那一下，见 MapPage.tsx）、不发给二狗以外的地方。
import { type MapLatestView, t } from "../../state/index.ts";
import type { MapCircle, MapMark, MapScene, MapView } from "./scene.ts";
import { MAP_MIN_ZOOM } from "./scene.ts";

/** 浏览器定位等多久（毫秒）：交给 getCurrentPosition 的 timeout */
export const LOCATE_TIMEOUT_MS = 10_000;
/** 浏览器到点了还不回话（有的 WebView 关了定位就一直不回）：再多等这么久自己放弃 */
const LOCATE_GUARD_MS = 2_000;
/** 浏览器给的位置可以是多久以前定的（毫秒；电脑上 30 秒内定过就不再等） */
const LOCATE_MAX_AGE_MS = 30_000;
/** 上一次在这台设备上定到的位置多久以内算新的：再点一次直接回到那里，不重新定 */
export const FIX_FRESH_MS = 60_000;
/** 挪过去放大到几级（街道级） */
export const LOCATE_ZOOM = 17;
/** 手机交来的点多久以前就提一句"可能已经不在那儿了"（和查"附近"时的口径一样，2 小时） */
const PHONE_STALE_MS = 2 * 60 * 60_000;
/** 地图上那一点、那个圈的编号（地图上只有这一个） */
export const HERE_MARK_ID = "me-here";
export const HERE_CIRCLE_ID = "me-accuracy";

/** 现在的位置从哪来的：App 的原生定位、浏览器定位、手机最近交来的点 */
export type HereSource = "app" | "browser" | "phone";

/** 这台设备为什么没给位置：没给权限、等太久、定不了、这个页面用不了定位（没有这个接口、不是安全上下文） */
export type DeviceFailure = "denied" | "timeout" | "unavailable" | "unsupported";

/** 定到的位置（WGS-84） */
export interface HereFix {
  readonly lat: number;
  readonly lon: number;
  /** 精度（米）：浏览器、手机报了才有；App 的原生定位不报 */
  readonly accuracy?: number;
  readonly source: HereSource;
  /** 手机记下那个点的时间（协议时间，source 是 phone 才有） */
  readonly at?: string;
  /** 什么时候拿到的（毫秒） */
  readonly gotAt: number;
}

/** 取一次的结果：定到了（device 是这台设备为什么没给，用了手机的点时才有）、都拿不到 */
export type LocateOutcome = { readonly fix: HereFix; readonly device?: DeviceFailure } | { readonly fix?: undefined; readonly device: DeviceFailure };

/** App 原生"现在在哪"回的（app/native-phone.ts 的 NativePlaceFix 里用到的那几样） */
export type AppPlaceFix = { ok: true; lat: number; lon: number } | { ok: false; reason: "denied" | "not_found" | "unavailable" };

/** 浏览器定位里用到的那一个方法（测试换成假的） */
export interface BrowserGeolocation {
  getCurrentPosition(success: (position: { coords: { latitude: number; longitude: number; accuracy: number } }) => void, error: (err: { code: number }) => void, options: PositionOptions): void;
}

export interface LocateDeps {
  /** 鸿蒙 App 的"现在在哪"；不在 App 里、App 没有这一组是 undefined */
  readonly appHere?: (() => Promise<AppPlaceFix>) | undefined;
  /** 浏览器的定位；没有这个接口、不是安全上下文是 undefined */
  readonly geolocation?: BrowserGeolocation | undefined;
  /** 手机最近交来的一个位置点（取不到当没有） */
  latest(): Promise<MapLatestView>;
  now(): number;
  /** 测试换短的 */
  readonly timeoutMs?: number;
}

const validLat = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const validLon = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
const validAccuracy = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 浏览器定一次：定到了给坐标和精度，没定到给为什么（PositionError 的 code：1 拒绝、2 定不了、3 超时） */
export function browserFix(geolocation: BrowserGeolocation, timeoutMs = LOCATE_TIMEOUT_MS): Promise<{ lat: number; lon: number; accuracy?: number } | DeviceFailure> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { lat: number; lon: number; accuracy?: number } | DeviceFailure) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve(v);
    };
    const guard = setTimeout(() => finish("timeout"), timeoutMs + LOCATE_GUARD_MS);
    try {
      geolocation.getCurrentPosition(
        ({ coords }) => {
          if (!validLat(coords.latitude) || !validLon(coords.longitude)) finish("unavailable");
          else finish({ lat: coords.latitude, lon: coords.longitude, ...(validAccuracy(coords.accuracy) ? { accuracy: coords.accuracy } : {}) });
        },
        (err) => finish(err.code === 1 ? "denied" : err.code === 3 ? "timeout" : "unavailable"),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: LOCATE_MAX_AGE_MS },
      );
    } catch {
      finish("unavailable");
    }
  });
}

/** 按顺序取现在的位置：App 的原生定位 → 浏览器定位 → 手机最近交来的点 */
export async function locateMe(deps: LocateDeps): Promise<LocateOutcome> {
  let device: DeviceFailure | undefined;
  if (deps.appHere) {
    const r = await deps.appHere().catch((): AppPlaceFix => ({ ok: false, reason: "unavailable" }));
    if (r.ok && validLat(r.lat) && validLon(r.lon)) return { fix: { lat: r.lat, lon: r.lon, source: "app", gotAt: deps.now() } };
    device = r.ok ? "unavailable" : r.reason === "denied" ? "denied" : "unavailable";
  }
  if (deps.geolocation) {
    const r = await browserFix(deps.geolocation, deps.timeoutMs);
    if (typeof r === "object") return { fix: { ...r, source: "browser", gotAt: deps.now() } };
    // 在 App 里先问过原生的：说原生那一步为什么没拿到（网页定位在 App 里本来就关着）
    device ??= r;
  }
  device ??= "unsupported";
  const latest = await deps.latest().catch((): MapLatestView => ({}));
  const p = latest.point;
  if (p && validLat(p.lat) && validLon(p.lon)) {
    return { fix: { lat: p.lat, lon: p.lon, ...(validAccuracy(p.accuracy) ? { accuracy: p.accuracy } : {}), source: "phone", at: p.at, gotAt: deps.now() }, device };
  }
  return { device };
}

/** 上一次定到的还算新（这台设备上定的、一分钟以内）：再点一次直接回到那里 */
export function fixIsFresh(fix: HereFix | undefined, now: number): boolean {
  return fix !== undefined && fix.source !== "phone" && now - fix.gotAt >= 0 && now - fix.gotAt < FIX_FRESH_MS;
}

/** 地球赤道上第 0 级一像素多少米（256 像素的瓦片） */
const METERS_PER_PIXEL_Z0 = 156_543.033_92;

/**
 * 挪到哪里：中心是定到的点；放大到街道级（17），精度圈比这一屏大时退到看得全那个圈的级别（宽高是地图的像素大小）。
 * 不放大到比街道级更近
 */
export function locateView(fix: Pick<HereFix, "lat" | "lon" | "accuracy">, width: number, height: number): MapView {
  let zoom = LOCATE_ZOOM;
  if (fix.accuracy !== undefined && fix.accuracy > 0) {
    // 圈的直径占这一屏短边的八成
    const side = Math.max(1, Math.min(width, height)) * 0.8;
    const fit = Math.log2((METERS_PER_PIXEL_Z0 * Math.cos((fix.lat * Math.PI) / 180) * side) / (2 * fix.accuracy));
    zoom = Math.max(MAP_MIN_ZOOM, Math.min(LOCATE_ZOOM, Math.floor(fit)));
  }
  return { lat: fix.lat, lon: fix.lon, zoom };
}

/** 两位数 */
const pad = (n: number) => String(n).padStart(2, "0");

/** 手机那个点是几点记的：今天的写 14:05，别的日子写 11-06 14:05 */
function clockOf(at: string, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** 手机交来的点旁边写的字：几点交来的（按拿到它的那一刻算是不是今天）；别的来源不写 */
export function hereLabel(fix: HereFix | undefined): string | undefined {
  if (fix?.source !== "phone" || fix.at === undefined || Number.isNaN(Date.parse(fix.at))) return undefined;
  return t("ui.plugins.map.locate.phoneLabel", { time: clockOf(fix.at, fix.gotAt) });
}

/** 地图上画什么：一个蓝点（旁边写 label），知道精度时再画一个精度圈 */
export function hereScene(fix: HereFix | undefined, label: string | undefined = hereLabel(fix)): MapScene {
  if (!fix) return { marks: [], lines: [], circles: [] };
  const mark: MapMark = { id: HERE_MARK_ID, lat: fix.lat, lon: fix.lon, kind: "me", ...(label === undefined ? {} : { label }) };
  const circles: MapCircle[] = fix.accuracy !== undefined && fix.accuracy > 0 ? [{ id: HERE_CIRCLE_ID, lat: fix.lat, lon: fix.lon, radius: fix.accuracy, kind: "accuracy" }] : [];
  return { marks: [mark], lines: [], circles };
}

/** 地图上已有的东西再加上"我现在的位置"（压在最上面） */
export function withHere(scene: MapScene, here: MapScene): MapScene {
  if (here.marks.length === 0 && here.circles.length === 0) return scene;
  return { marks: [...scene.marks, ...here.marks], lines: scene.lines, circles: [...scene.circles, ...here.circles] };
}

/** 多久以前：N 分钟前（不到 1 分钟也写 1 分钟）、N 小时前、N 天前 */
export function agoText(at: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(at));
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return t("ui.plugins.map.locate.ago.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ui.plugins.map.locate.ago.hours", { count: hours });
  return t("ui.plugins.map.locate.ago.days", { count: Math.floor(hours / 24) });
}

/** 这台设备为什么没给位置（一小句，放在括号里） */
export function deviceFailureText(why: DeviceFailure): string {
  switch (why) {
    case "denied":
      return t("ui.plugins.map.locate.device.denied");
    case "timeout":
      return t("ui.plugins.map.locate.device.timeout");
    case "unavailable":
      return t("ui.plugins.map.locate.device.unavailable");
    case "unsupported":
      return t("ui.plugins.map.locate.device.unsupported");
  }
}

/** 取完说哪句话：这台设备定到了不说；用了手机的点说"没拿到这台设备的位置，这是 N 分钟前手机交来的"；都没有说拿不到 */
export function locateNote(outcome: LocateOutcome, now: number): string | undefined {
  if (outcome.fix && outcome.fix.source !== "phone") return undefined;
  const why = deviceFailureText(outcome.device ?? "unsupported");
  if (!outcome.fix) return t("ui.plugins.map.locate.none", { why });
  const at = outcome.fix.at ?? new Date(outcome.fix.gotAt).toISOString();
  const age = now - Date.parse(at);
  const text = age < 60_000 ? t("ui.plugins.map.locate.phoneJustNow", { why }) : t("ui.plugins.map.locate.phone", { why, ago: agoText(at, now) });
  return age > PHONE_STALE_MS ? `${text}${t("ui.plugins.map.locate.phoneStale")}` : text;
}
