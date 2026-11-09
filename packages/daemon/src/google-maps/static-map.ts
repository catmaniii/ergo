// 谷歌的静态地图（451，聊天卡片的预览图）：守护进程拿服务端 Key 调 Maps Static API（测试换成本机的假谷歌），图原样转回，
// 不缓存（谷歌条款不许缓存它的内容），上游给的 Cache-Control 照转。
// 453 起只要一张**光底图**：参数只有 center、zoom、size、scale、深色（和固定的 format、maptype、language），不带 markers、path——
// 足迹、二狗给的点和线不发给谷歌，页面按回应头里的视野自己画在图上。中心和级别由地图插件算好交来（map/static-map.ts 的 planStatic，
// 大陆里的中心已经转成 GCJ-02：谷歌的大陆街道图是 GCJ-02，和 446 的底图、查询一样）。
// 参数（developers.google.com/maps/documentation/maps-static，2026-11 读的）：
// - center 中心（纬度,经度，最多 6 位小数）、zoom 级别（整数）、size 宽x高（最大 640x640）、scale=2 高清（像素翻倍、看的范围不变）、
//   format=png、language 跟界面的语言、colorscheme=dark 深色（只对 roadmap 管用）；
// 出错：谷歌回 403 加一段字——Maps Static API 没开、服务端 Key 的 API 限制没勾它、Key 不对都是它，说不清是哪个，一起说；
// 记成"预览图：没开"（设置 · 数据源 · 谷歌地图上标出来），不挡别的（查询照常）。下一次取成了又记成能用。
// 用量：每取一张记一次 staticMaps（每月 1 万次免费）；超了、没放开时不取（不影响底图和查询）。
import { activeLanguage, t } from "@ergo/protocol";
import type { MapStaticRequest, MapStaticResult, MapStaticSource } from "../map/api.ts";
import { type GoogleClient, redactKey } from "./client.ts";

/** 谷歌静态地图的上限：一边最多 640 像素；级别收在 1～19（20 级以上很多地方没图）；坐标大陆里 GCJ-02；有深色的图（colorscheme=dark） */
export const GOOGLE_STATIC = { maxSide: 640, minZoom: 1, maxZoom: 19, datum: "gcj02", dark: true } as const;

/** 拼参数（不带 Key；测试看它）：中心、级别、尺寸、清晰度、深浅，别的只有固定的几样 */
export function googleStaticParams(req: MapStaticRequest): URLSearchParams {
  const q = new URLSearchParams();
  q.set("size", `${req.width}x${req.height}`);
  if (req.scale === 2) q.set("scale", "2");
  q.set("format", "png");
  q.set("maptype", "roadmap");
  q.set("language", activeLanguage());
  q.set("center", `${req.center.lat.toFixed(6)},${req.center.lon.toFixed(6)}`);
  q.set("zoom", String(req.zoom));
  if (req.dark) q.set("colorscheme", "dark");
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

export function createGoogleStatic(options: GoogleStaticOptions): MapStaticSource {
  const get = async (req: MapStaticRequest, signal?: AbortSignal): Promise<MapStaticResult> => {
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
  return { ...GOOGLE_STATIC, get };
}
