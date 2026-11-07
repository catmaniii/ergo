// OpenStreetMap 的免费服务（433）：查地点、算路线，照 lookup.ts 的 LookupProvider。不用 Key、不用注册。哪儿都管：国外一直用它；
// 国内没有高德（没填 Key、关了、Key 坏了，或者高德那套整个不在）时也用它，结果里提一句国内的店名和小路可能不全。
// - 查地点、地址 → 位置、某处 → 地址：Nominatim 公共实例（nominatim.openstreetmap.org 的 /search、/reverse，format=jsonv2，
//   addressdetails=1，accept-language 跟着界面的语言再加英文）。"附近"是在中心点四周的方框里找（viewbox + bounded=1），
//   二狗自己算距离、按近的排、去掉圈外的；按名字找时知道这一问的另一头在哪的，用它做 viewbox（不限死，只让近的排前面）。
//   Nominatim 只认名字、地址和种类的说法（"hawker centre""cafe"），列不出"附近有什么"的全部：没说找什么时直接说找不了，不发请求。
// - 路线：OSRM 演示服务（FOSSGIS 在 routing.openstreetmap.de 上跑的，OSRM 项目的 Demo server 页面列的就是它和
//   router.project-osrm.org；只有它分开车、步行，路径 /routed-car/、/routed-foot/）。开车、步行；**没有公交、没有实时路况**
//   （用时是按路的限速估的）。overview=full、geometries=geojson 拿整条折线（[经度, 纬度]），点多了均匀抽到 2000 个。
// - 规矩（osm-client.ts）：每家每秒最多 1 次、一次一个、带能认出二狗的 User-Agent、结果在内存里缓存一天、不做输入联想。
// - 管哪：哪儿都管（covers 一律 true）；有高德时国内的点归高德（工具按 providers 的先后挑第一家管它的）。
// - 坐标：两家都是 WGS-84，进出不转。
// - 署名：结果末尾写"数据来自 OpenStreetMap（© OpenStreetMap 贡献者）"——Nominatim、OSRM 的数据都是 ODbL 授权的 OSM 数据。
// 出错：连不上、太频繁、被拒、那边出错的抛 MapLookupError（工具那边说"免费服务暂时不可用"）；OSRM 的 NoRoute、NoSegment（附近没有路）
// 是 no_route，TooBig 是 too_far，参数不对的是 params。
import { activeLanguage, distanceMeters, inMainlandChina, type LatLon } from "@ergo/protocol";
import { createPoliteClient, type PoliteClient } from "./osm-client.ts";
import { type LookupProvider, MapLookupError, type MapLookupFailure, type PlaceHit, type RouteAnswer, thinLine } from "./lookup.ts";

/** 两家的地址（测试换成本机的假服务） */
export interface OsmHosts {
  readonly nominatim: string;
  readonly osrm: string;
}

export const OSM_HOSTS: OsmHosts = { nominatim: "https://nominatim.openstreetmap.org", osrm: "https://routing.openstreetmap.de" };

/** OSRM 演示服务上开车、步行的路径（一个实例只有一种走法；地址里的 profile 那一段照文档写） */
export const OSRM_PATHS = { driving: "/routed-car/route/v1/driving", walking: "/routed-foot/route/v1/foot" } as const;

export interface OsmLookupOptions {
  hosts?: Partial<OsmHosts>;
  userAgent: string;
  now: () => number;
  /** 两次请求之间至少隔多久（毫秒；默认 osm-client.ts 的 OSM_MIN_INTERVAL_MS，测试可以调小） */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** 排队时怎么等（测试换成假的） */
  wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  log: (line: string) => void;
}

export interface OsmLookup extends LookupProvider {
  /** 扔掉缓存（插件停用时） */
  clear(): void;
  /** 两家各真发出去了几次（测试用） */
  sent(): { nominatim: number; osrm: number };
}

/** 在中国大陆里用它查时提一句（给模型看的） */
export const MAINLAND_NOTE = "国内的地点用 OpenStreetMap 查，店名和小路可能不全"; // @i18n-ignore model
/** 找附近没说找什么（Nominatim 列不出全部） */
const NEED_KEYWORD = "keyword needed";
/** 免费服务用不了的几种：连不上、太频繁、拒绝了、那边出错 */
const UNAVAILABLE: ReadonlySet<MapLookupFailure> = new Set(["network", "rate", "denied", "server"]);

/** 一次最多要几条（Nominatim 的上限是 40） */
const NOMINATIM_LIMIT_MAX = 40;
/** 找附近时多要几条（Nominatim 按重要程度排，不按远近：多要一些，二狗自己按距离挑） */
const NEAR_FETCH = 20;
/** 按名字找时让结果靠近另一头：另一头四周多大的方框（度） */
const BIAS_BOX_DEG = 0.5;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = str(v);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 坐标写进地址（6 位小数，约 0.1 米） */
const fixed = (n: number) => n.toFixed(6);

/** 一个点四周的方框（Nominatim 的 viewbox："左经度,上纬度,右经度,下纬度"），半径按米 */
export function viewboxAround(p: LatLon, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.01, Math.cos((p.lat * Math.PI) / 180)));
  return `${fixed(p.lon - dLon)},${fixed(p.lat + dLat)},${fixed(p.lon + dLon)},${fixed(p.lat - dLat)}`;
}

/** 地址明细里第一个有的 */
const firstOf = (address: Record<string, unknown>, keys: readonly string[]) => keys.map((k) => str(address[k])).find((v) => v !== "") ?? "";

/** Nominatim 的一条（jsonv2）→ 一个地点 */
export function nominatimHit(v: unknown): PlaceHit | undefined {
  const p = obj(v);
  const lat = num(p.lat);
  const lon = num(p.lon);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const display = str(p.display_name);
  const name = str(p.name) || display.split(",")[0]!.trim();
  if (name === "") return undefined;
  const a = obj(p.address);
  const road = [str(a.house_number), firstOf(a, ["road", "pedestrian", "footway", "street"])].filter((s) => s !== "").join(" ");
  const area = [...new Set([firstOf(a, ["suburb", "neighbourhood", "quarter", "city_district"]), firstOf(a, ["city", "town", "village", "municipality", "county"]), str(a.country)].filter((s) => s !== ""))].join(", ");
  const osmType = str(p.osm_type);
  const osmId = num(p.osm_id);
  const type = str(p.type).replace(/_/g, " ");
  const level = str(p.addresstype);
  return {
    ...(osmType === "" || osmId === undefined ? {} : { id: `${osmType[0]!.toUpperCase()}${osmId}` }),
    name,
    ...(road === "" ? (display.includes(",") ? { address: display.slice(display.indexOf(",") + 1).trim() } : {}) : { address: road }),
    ...(area === "" ? {} : { area }),
    ...(type === "" || type === "yes" ? {} : { type }),
    lat,
    lon,
    ...(level === "" ? {} : { level }),
  };
}

/** OSRM 回的 geojson 折线（[经度, 纬度] 一串）→ WGS-84 的点 */
export function osrmLine(geometry: unknown): LatLon[] {
  const out: LatLon[] = [];
  for (const c of arr(obj(geometry).coordinates)) {
    const pair = arr(c);
    const lon = num(pair[0]);
    const lat = num(pair[1]);
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ lat, lon });
  }
  return thinLine(out);
}

/** OSRM 的错误码 → 哪一种出错 */
function osrmFailure(code: string): MapLookupError["failure"] {
  if (code === "NoRoute" || code === "NoSegment") return "no_route";
  if (code === "TooBig") return "too_far";
  if (code.startsWith("Invalid")) return "params";
  return "other";
}

/** 结果的语言：界面的语言在前，再加英文（没有中文名的地方用当地的名字） */
const language = () => `${activeLanguage()},en`;
/** 在哪个城市找：写进查询里（Nominatim 的自由查询认"地名, 城市"） */
const withCity = (text: string, city: string | undefined) => (city === undefined || city.trim() === "" ? text : `${text}, ${city.trim()}`);
/** 让结果靠近另一头（不限死） */
const bias = (near: LatLon | undefined): Record<string, string> => (near === undefined ? {} : { viewbox: viewboxAround(near, BIAS_BOX_DEG * 111_320), bounded: "0" });

export function createOsmLookup(options: OsmLookupOptions): OsmLookup {
  const hosts: OsmHosts = { ...OSM_HOSTS, ...options.hosts };
  const common = {
    userAgent: options.userAgent,
    now: options.now,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    log: options.log,
  };
  const nominatim: PoliteClient = createPoliteClient({ name: "Nominatim", ...common });
  const osrm: PoliteClient = createPoliteClient({ name: "OSRM", ...common });

  /** Nominatim 的 /search：交回地点（认不出的扔掉） */
  const search = async (params: Record<string, string>, signal?: AbortSignal): Promise<PlaceHit[]> => {
    const q = new URLSearchParams({ ...params, format: "jsonv2", addressdetails: "1", "accept-language": language() });
    const reply = await nominatim.get(`${hosts.nominatim}/search?${q}`, signal);
    if (reply.status !== 200) throw new MapLookupError(reply.status === 400 ? "params" : "other", str(obj(reply.body).error) || str(obj(obj(reply.body).error).message) || `HTTP ${reply.status}`);
    return arr(reply.body)
      .map(nominatimHit)
      .filter((h): h is PlaceHit => h !== undefined);
  };

  return {
    id: "osm",
    name: "OpenStreetMap", // @i18n-ignore model：工具结果里"数据来自 OpenStreetMap"
    credit: "数据来自 OpenStreetMap（© OpenStreetMap 贡献者，免费的公共服务），现查的，没存（同样的查询一天内用内存里那一份）", // @i18n-ignore model：工具结果末尾的那句
    routeModes: ["driving", "walking"],
    defaultModes: ["driving", "walking"],
    liveTraffic: false,
    browsesNearby: false,
    covers: () => true,
    coverageNote: (p) => (inMainlandChina(p) ? MAINLAND_NOTE : undefined),
    // @i18n-ignore-start model：出错时给模型的话
    explain(err) {
      if (UNAVAILABLE.has(err.failure)) {
        const detail = err.detail === "" ? "" : `（${err.detail}）`;
        const why = err.failure === "rate" ? "（查得太频繁：它每秒最多查 1 次）" : err.failure === "denied" ? `（它拒绝了这台电脑的请求${detail}）` : detail;
        return `OpenStreetMap 的免费服务暂时不可用${why}：它不保证一直能用。如实告诉用户，过一会儿再试。`;
      }
      if (err.failure === "params" && err.detail === NEED_KEYWORD) return "OpenStreetMap 的免费服务列不出某处附近的全部地点：要说找什么（咖啡店、hawker centre、超市……）。";
      return undefined;
    },
    // @i18n-ignore-end

    async searchText(q, signal) {
      const limit = Math.min(NOMINATIM_LIMIT_MAX, Math.max(1, q.limit));
      return (await search({ q: withCity(q.keyword.slice(0, 80), q.city), limit: String(limit), ...bias(q.near) }, signal)).slice(0, q.limit);
    },

    async searchNear(q, signal) {
      if (q.keyword === undefined || q.keyword.trim() === "") throw new MapLookupError("params", NEED_KEYWORD);
      const radius = Math.min(50_000, Math.max(1, q.radius));
      const hits = await search({ q: q.keyword.slice(0, 80), limit: String(Math.min(NOMINATIM_LIMIT_MAX, Math.max(NEAR_FETCH, q.limit * 3))), viewbox: viewboxAround(q.center, radius), bounded: "1" }, signal);
      return hits
        .map((h) => ({ ...h, distanceM: Math.round(distanceMeters(q.center, h)) }))
        .filter((h) => h.distanceM <= radius)
        .toSorted((a, b) => a.distanceM - b.distanceM)
        .slice(0, q.limit);
    },

    async geocode(q, signal) {
      return (await search({ q: withCity(q.address.slice(0, 200), q.city), limit: "3", ...bias(q.near) }, signal)).slice(0, 3);
    },

    async reverse(p, signal) {
      const params = new URLSearchParams({ lat: fixed(p.lat), lon: fixed(p.lon), format: "jsonv2", zoom: "18", addressdetails: "1", "accept-language": language() });
      const reply = await nominatim.get(`${hosts.nominatim}/reverse?${params}`, signal);
      const body = obj(reply.body);
      // 那里什么都没有：{ "error": "Unable to geocode" }
      if (reply.status !== 200 || str(body.error) !== "") return undefined;
      const hit = nominatimHit(body);
      if (!hit) return undefined;
      // 某处 → 地址：名字写完整的地址（display_name），点用问的那个
      const display = str(body.display_name);
      return { ...hit, name: display === "" ? hit.name : display, lat: p.lat, lon: p.lon };
    },

    async route(q, signal): Promise<RouteAnswer> {
      if (q.mode === "transit") throw new MapLookupError("params", "no transit on OpenStreetMap");
      const coords = `${fixed(q.from.lon)},${fixed(q.from.lat)};${fixed(q.to.lon)},${fixed(q.to.lat)}`;
      const params = new URLSearchParams({ overview: "full", geometries: "geojson", alternatives: "false", steps: "false" });
      const reply = await osrm.get(`${hosts.osrm}${OSRM_PATHS[q.mode]}/${coords}?${params}`, signal);
      const body = obj(reply.body);
      const code = str(body.code);
      if (reply.status !== 200 || code !== "Ok") {
        const detail = str(body.message) || code || `HTTP ${reply.status}`;
        options.log(`OSRM：没算成（${code || reply.status}）`); // @i18n-ignore log
        throw new MapLookupError(osrmFailure(code), detail, code === "" ? undefined : code);
      }
      const route = obj(arr(body.routes)[0]);
      const distanceM = num(route.distance);
      const durationS = num(route.duration);
      if (distanceM === undefined || durationS === undefined) throw new MapLookupError("no_route", "no routes");
      const line = osrmLine(route.geometry);
      return q.mode === "driving" ? { mode: "driving", durationS, distanceM, line } : { mode: "walking", durationS, distanceM, line };
    },

    clear() {
      nominatim.clear();
      osrm.clear();
    },
    sent: () => ({ nominatim: nominatim.sent(), osrm: osrm.sent() }),
  };
}
