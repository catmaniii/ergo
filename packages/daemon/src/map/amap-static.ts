// 高德的静态地图（451，聊天卡片的预览图）：守护进程拿 Web 服务 Key 调 restapi.amap.com/v3/staticmap（测试换成本机的假高德），
// 图原样转回，不缓存（高德协议不许缓存它的内容），上游给的 Cache-Control 照转。
// 453 起只要一张**光底图**：参数只有 location、zoom、size、scale，不带 markers、paths——足迹、二狗给的点和线不发给高德，
// 页面按回应头里的视野自己画在图上。中心和级别由地图插件算好交来（static-map.ts 的 planStatic，中心已经转成 GCJ-02）。
// 参数（lbs.amap.com 的静态地图文档，2026-02-02 更新、2026-11 读的）：
// - location 中心（经度,纬度，GCJ-02，最多 6 位小数）、zoom 级别（[1,17] 的整数）、size 宽*高（最大 1024*1024）、scale=2 高清
//   （"图片高度和宽度都增加一倍，zoom 也增加一倍（当 zoom 为最大值时，zoom 不再改变）"——17 级时高清图看的范围对不上，
//   所以高清图最大到 16 级：AMAP_STATIC.maxZoomHiDpi）；
// 高德的静态地图没有深色：页面照 OSM 瓦片深色时的做法压暗。
// 用量：每取一张记一次 lbs（地址和路线那一类，个人认证每月 15 万）。出错时高德回 JSON（status / info / infocode），和查地点的分法一样，
// 也交给 onReply（amap.ts 记下 Web 服务 Key 不认）。Key 不进日志、不进给人看的原因。
import { t } from "@ergo/protocol";
import type { DataSourceSecrets } from "../data-sources/api.ts";
import type { MapStaticRequest, MapStaticResult, MapStaticSource } from "./api.ts";
import { AMAP_HOSTS, AMAP_SECRET, AMAP_TIMEOUT_MS, type AmapHosts } from "./amap.ts";
import { amapFailureOf } from "./amap-lookup.ts";
import type { AmapUsage } from "./amap-usage.ts";
import { fixed } from "./static-map.ts";

/** 高德静态地图的上限：一边最多 1024 像素，级别 1～17，高清图最大 16 级，坐标大陆里 GCJ-02 */
export const AMAP_STATIC = { maxSide: 1024, minZoom: 1, maxZoom: 17, maxZoomHiDpi: 16, datum: "gcj02" } as const;
/** 图最大多少字节（再大的不要） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 拼参数（不带 Key 的那一部分；测试看它）：中心、级别、尺寸、清晰度，别的一概不带 */
export function amapStaticParams(req: MapStaticRequest): URLSearchParams {
  const q = new URLSearchParams();
  q.set("location", `${fixed(req.center.lon, 6)},${fixed(req.center.lat, 6)}`);
  q.set("zoom", String(req.zoom));
  q.set("size", `${req.width}*${req.height}`);
  if (req.scale === 2) q.set("scale", "2");
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

export function createAmapStatic(options: AmapStaticOptions): MapStaticSource {
  const hosts: AmapHosts = { ...AMAP_HOSTS, ...options.hosts };
  const timeoutMs = options.timeoutMs ?? AMAP_TIMEOUT_MS;
  const get = async (req: MapStaticRequest, signal?: AbortSignal): Promise<MapStaticResult> => {
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
  return { ...AMAP_STATIC, get };
}
