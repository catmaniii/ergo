// 高德的静态地图（451，聊天卡片的预览图）：守护进程拿 Web 服务 Key 调 restapi.amap.com/v3/staticmap（测试换成本机的假高德），
// 图原样转回，不缓存（高德协议不许缓存它的内容），上游给的 Cache-Control 照转。
// 参数（lbs.amap.com 的静态地图文档，2026-11 读的）：
// - location 中心（经度,纬度，GCJ-02，最多 6 位小数）、zoom 级别（[1,17] 的整数）、size 宽*高（最大 1024*1024）、scale=2 高清
//   （像素翻倍、级别跟着加一，看的范围不变）；
// - markers 最多 10 个："mid,颜色,序号:经度,纬度"，序号是一位数字或字母（small 不显示序号，所以用 mid），不同序号各写一组、用 | 连；
// - paths 最多 4 条："线宽,颜色,透明度,,:经度,纬度;经度,纬度"；
// 点和线由地图插件挑好、抽稀好（static-map.ts：最多 10 个点、4 条线、线上一共 200 个点），这里只换坐标（大陆里 WGS-84 → GCJ-02）、
// 算视野、拼地址。高德的静态地图没有深色：页面照 OSM 瓦片深色时的做法加滤镜。
// 用量：每取一张记一次 lbs（地址和路线那一类，个人认证每月 15 万）。出错时高德回 JSON（status / info / infocode），和查地点的分法一样，
// 也交给 onReply（amap.ts 记下 Web 服务 Key 不认）。Key 不进日志、不进给人看的原因。
import { t, wgsToGcj, type LatLon } from "@ergo/protocol";
import type { DataSourceSecrets } from "../data-sources/api.ts";
import type { MapStaticRequest, MapStaticResult } from "./api.ts";
import { AMAP_HOSTS, AMAP_SECRET, AMAP_TIMEOUT_MS, type AmapHosts } from "./amap.ts";
import { amapFailureOf } from "./amap-lookup.ts";
import type { AmapUsage } from "./amap-usage.ts";
import { fitSize, fixed, staticView } from "./static-map.ts";

/** 高德静态地图的上限：一边最多 1024 像素，级别 1～17 */
export const AMAP_STATIC_MAX_SIDE = 1024;
export const AMAP_STATIC_ZOOM = { minZoom: 1, maxZoom: 17 } as const;
/** 点的颜色：搜到的、去过的（高德默认的红）；"现在在哪"（蓝） */
const SPOT_COLOR = "0xFC6054";
const HERE_COLOR = "0x3B82F6";
/** 线：宽、颜色、透明度 */
const LINE_STYLE = "6,0x2563EB,0.85,,";
/** 图最大多少字节（再大的不要） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 送给高德的坐标："经度,纬度"（GCJ-02，大陆里才转） */
const amapPoint = (p: LatLon, digits: number) => {
  const g = wgsToGcj(p);
  return `${fixed(g.lon, digits)},${fixed(g.lat, digits)}`;
};

/** 拼地址（不带 Key 的那一部分；测试看它）：按缩好的尺寸算视野 */
export function amapStaticParams(req: MapStaticRequest): URLSearchParams {
  const size = fitSize(req.width, req.height, AMAP_STATIC_MAX_SIDE);
  const view = staticView(req.bounds, size.width, size.height, AMAP_STATIC_ZOOM);
  const q = new URLSearchParams();
  if (view) {
    q.set("location", amapPoint(view.center, 6));
    q.set("zoom", String(view.zoom));
  }
  q.set("size", `${size.width}*${size.height}`);
  if (req.scale === 2) q.set("scale", "2");
  const markers = req.marks.map((m) => (m.kind === "here" ? `mid,${HERE_COLOR},:${amapPoint(m, 6)}` : `mid,${SPOT_COLOR},${m.label ?? ""}:${amapPoint(m, 6)}`));
  if (markers.length > 0) q.set("markers", markers.join("|"));
  // 线上的点写 5 位小数（约 1 米），地址短一些
  const paths = req.lines.filter((l) => l.length >= 2).map((l) => `${LINE_STYLE}:${l.map((p) => amapPoint(p, 5)).join(";")}`);
  if (paths.length > 0) q.set("paths", paths.join("|"));
  return q;
}

export interface AmapStaticOptions {
  hosts?: Partial<AmapHosts>;
  timeoutMs?: number;
  /** 密钥区里高德那一格（现取） */
  secrets: () => DataSourceSecrets;
  usage: AmapUsage;
  /** 高德说 Key 不对、到上限时（JSON 和 HTTP 状态）：amap.ts 记下 */
  onReply?: (body: unknown, httpStatus: number) => void;
  /** 高德说 Web 服务 Key 不对（记着的）：给人看的一句；没问题是 undefined */
  keyProblem: () => string | undefined;
  log: (line: string) => void;
}

/** 一句话里的 Key 换成 *** */
const redact = (text: string, key: string) => (key.length >= 4 ? text.split(key).join("***") : text);

export function createAmapStatic(options: AmapStaticOptions): (req: MapStaticRequest, signal?: AbortSignal) => Promise<MapStaticResult> {
  const hosts: AmapHosts = { ...AMAP_HOSTS, ...options.hosts };
  const timeoutMs = options.timeoutMs ?? AMAP_TIMEOUT_MS;
  return async (req, signal) => {
    const key = options.secrets().get(AMAP_SECRET.serviceKey);
    if (key === undefined) return { ok: false, failure: "no_key", reason: t("map.preview.amapNoKey") };
    const problem = options.keyProblem();
    if (problem !== undefined) return { ok: false, failure: "key", reason: t("map.preview.amapKey") };
    const q = amapStaticParams(req);
    q.set("key", key);
    options.usage.count("lbs");
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let body: Buffer;
    try {
      res = await fetch(`${hosts.rest}/v3/staticmap?${q}`, { headers: { Accept: "image/*" }, redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = timeout.aborted ? "timeout" : redact(err instanceof Error ? err.message : String(err), key);
      options.log(`高德：静态地图没连上：${reason}`); // @i18n-ignore log
      return { ok: false, failure: "network", reason: t("map.preview.unreachable", { name: t("map.provider.amap") }) };
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.startsWith("image/") && body.length > 0 && body.length <= MAX_IMAGE_BYTES) {
      const cache = res.headers.get("cache-control");
      return { ok: true, reply: { status: 200, headers: { "Content-Type": type, "Cache-Control": cache ?? "no-store" }, body } };
    }
    // 不是图：高德的出错写法（JSON 的 status / info / infocode）
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      options.log(`高德：静态地图回的不是图（HTTP ${res.status}）`); // @i18n-ignore log
      return { ok: false, failure: "other", reason: t("map.preview.failed", { name: t("map.provider.amap"), detail: `HTTP ${res.status}` }) };
    }
    options.onReply?.(parsed, res.status);
    const b = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const code = typeof b.infocode === "string" ? b.infocode : "";
    const info = redact(typeof b.info === "string" ? b.info : "", key) || `HTTP ${res.status}`;
    const failure = amapFailureOf(code, info);
    options.log(`高德：静态地图没取成（${code || "?"} ${info}）`); // @i18n-ignore log
    if (failure === "key") return { ok: false, failure: "key", reason: t("map.preview.amapKey") };
    if (failure === "denied") return { ok: false, failure: "off", reason: t("map.preview.amapDenied", { detail: info }) };
    if (failure === "quota" || failure === "rate") return { ok: false, failure: "quota", reason: t("map.preview.busy", { name: t("map.provider.amap") }) };
    return { ok: false, failure: "other", reason: t("map.preview.failed", { name: t("map.provider.amap"), detail: info }) };
  };
}
