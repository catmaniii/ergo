// 谷歌的静态地图（451，聊天卡片的预览图）：守护进程拿服务端 Key 调 Maps Static API（测试换成本机的假谷歌），图原样转回，
// 不缓存（谷歌条款不许缓存它的内容），上游给的 Cache-Control 照转。
// 参数（developers.google.com/maps/documentation/maps-static，2026-11 读的）：
// - center 中心（纬度,经度，最多 6 位小数）、zoom 级别（整数）、size 宽x高（最大 640x640）、scale=2 高清（像素翻倍、看的范围不变）、
//   format=png、language 跟界面的语言、colorscheme=dark 深色（只对 roadmap 管用）；
// - markers 一种样式一个参数："size:mid|color:0x…|label:1|纬度,经度"（标注只认一个大写字母或数字，只有 mid 和默认大小显示）；
// - path："weight:5|color:0x…|enc:<编码的折线>"（polyline.ts 编，地址短）；地址最长 16,384 个字。
// 大陆里的点转 GCJ-02（谷歌的大陆街道图是 GCJ-02，和 446 的底图、查询一样）。点和线由地图插件挑好、抽稀好（最多 10 个点、4 条线）。
// 出错：谷歌回 403 加一段字——Maps Static API 没开、服务端 Key 的 API 限制没勾它、Key 不对都是它，说不清是哪个，一起说；
// 记成"预览图：没开"（设置 · 数据源 · 谷歌地图上标出来），不挡别的（查询照常）。下一次取成了又记成能用。
// 用量：每取一张记一次 staticMaps（每月 1 万次免费）；超了、没放开时不取（不影响底图和查询）。
import { activeLanguage, type LatLon, t, wgsToGcj } from "@ergo/protocol";
import { fitSize, type MapStaticRequest, type MapStaticResult, staticView } from "../map/api.ts";
import { type GoogleClient, redactKey } from "./client.ts";
import { encodePolyline } from "./polyline.ts";

/** 谷歌静态地图的上限：一边最多 640 像素；级别收在 1～19（20 级以上很多地方没图） */
export const GOOGLE_STATIC_MAX_SIDE = 640;
export const GOOGLE_STATIC_ZOOM = { minZoom: 1, maxZoom: 19 } as const;
const SPOT = "size:mid|color:0xFC6054";
const HERE = "size:mid|color:0x3B82F6";
const LINE = "weight:5|color:0x2563EBD9";

/** 送给谷歌的坐标："纬度,经度"（大陆里转 GCJ-02） */
const googlePoint = (p: LatLon) => {
  const g = wgsToGcj(p);
  return `${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
};

/** 拼参数（不带 Key；测试看它）：按缩好的尺寸算视野 */
export function googleStaticParams(req: MapStaticRequest): URLSearchParams {
  const size = fitSize(req.width, req.height, GOOGLE_STATIC_MAX_SIDE);
  const view = staticView(req.bounds, size.width, size.height, GOOGLE_STATIC_ZOOM);
  const q = new URLSearchParams();
  q.set("size", `${size.width}x${size.height}`);
  if (req.scale === 2) q.set("scale", "2");
  q.set("format", "png");
  q.set("maptype", "roadmap");
  q.set("language", activeLanguage());
  if (view) {
    q.set("center", googlePoint(view.center));
    q.set("zoom", String(view.zoom));
  }
  if (req.dark) q.set("colorscheme", "dark");
  for (const m of req.marks) q.append("markers", m.kind === "here" ? `${HERE}|${googlePoint(m)}` : `${SPOT}${m.label === undefined ? "" : `|label:${m.label}`}|${googlePoint(m)}`);
  for (const line of req.lines) {
    if (line.length < 2) continue;
    q.append("path", `${LINE}|enc:${encodePolyline(line.map((p) => wgsToGcj(p)))}`);
  }
  return q;
}

export interface GoogleStaticOptions {
  client: GoogleClient;
  /** 能用的服务端 Key（填了、谷歌没说它不对）；没有是 undefined */
  key: () => string | undefined;
  /** 这个月静态地图超了免费量、又没放开 */
  over: () => boolean;
  /** 取了一次的结果：能用、没开（谷歌回 403） */
  noted: (state: "ok" | "off") => void;
  log: (line: string) => void;
}

/** 给人看的名字（"谷歌地图"） */
const name = () => t("googleMaps.provider.title");

export function createGoogleStatic(options: GoogleStaticOptions): (req: MapStaticRequest, signal?: AbortSignal) => Promise<MapStaticResult> {
  return async (req, signal) => {
    const key = options.key();
    if (key === undefined) return { ok: false, failure: "no_key", reason: t("googleMaps.static.noKey") };
    if (options.over()) return { ok: false, failure: "over", reason: t("googleMaps.static.over") };
    let reply;
    try {
      reply = await options.client.image(googleStaticParams(req), key, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return { ok: false, failure: "network", reason: t("map.preview.unreachable", { name: name() }) };
    }
    if (reply.status === 200 && reply.contentType.startsWith("image/") && reply.body.length > 0) {
      options.noted("ok");
      return { ok: true, reply: { status: 200, headers: { "Content-Type": reply.contentType, "Cache-Control": reply.cacheControl ?? "no-store" }, body: reply.body } };
    }
    const detail = redactKey(reply.body.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 160), key) || `HTTP ${reply.status}`;
    options.log(`谷歌地图：静态地图没取成（HTTP ${reply.status}）`); // @i18n-ignore log
    if (reply.status === 403) {
      options.noted("off");
      return { ok: false, failure: "off", reason: t("googleMaps.static.off") };
    }
    if (reply.status === 429) return { ok: false, failure: "quota", reason: t("map.preview.busy", { name: name() }) };
    return { ok: false, failure: "other", reason: t("map.preview.failed", { name: name(), detail }) };
  };
}
