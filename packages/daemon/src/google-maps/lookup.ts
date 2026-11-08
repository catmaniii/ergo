// 谷歌地图的查询那一半（446）：照地图插件的 LookupProvider（map/api.ts）查地点、周边、地址 ↔ 位置、路线，结果统一成 432/433 的形状。
// 怎么调（每一种只要用得到的字段，字段决定收费档，见 usage.ts）：
// - 按名字搜：Places Text Search，textQuery（说了城市就拼在后面），知道路线另一头时 locationBias 一个 50 公里的圈让结果靠近它；
// - 附近说了找什么（"附近的 hawker centre"）：同样 Text Search，locationBias 是中心和半径的圈、rankPreference DISTANCE，
//   回来的再按离中心多远排、去掉圈外的（bias 只是偏向，不是限定）；
// - 附近不说找什么：Places Nearby Search，locationRestriction 圈、rankPreference DISTANCE（它不收关键字，只收种类）；
// - 地点要的字段：places.id（place ID，条款许长期存，这票也不存）、displayName、formattedAddress、location、primaryTypeDisplayName
//   ——都在 Text Search Pro / Nearby Search Pro 档；
// - 地址 → 位置、位置 → 地址：Geocoding API（address= / latlng=，language 跟着界面的语言）；
// - 路线：Routes API computeRoutes，要折线（polyline.encodedPolyline）。开车 routingPreference TRAFFIC_AWARE（用时带实时路况，算 Pro 档）；
//   步行；公交 computeAlternativeRoutes 拿最多 3 个方案，每一步的 travelMode、距离、transitDetails（上下车站、线路名、车的种类、几站），
//   票价（travelAdvisory.transitFare，只在人民币时写进结果：结果里写的是"元"）。分段路况（speedReadingIntervals）是 Enterprise 档，不要。
// 坐标：二狗的点是 WGS-84；谷歌在中国大陆的数据是 GCJ-02（和它的大陆街道图一样）——大陆里的点交给谷歌前转 GCJ-02，
// 回来的大陆坐标转回 WGS-84（protocol 的 geo.ts，大陆外原样）。手动选了谷歌时大陆的点也会问它（445 的插槽按登记的区域定管不管）。
// 结果只现用：不落盘、不进记忆素材（条款只许长期存 place ID、坐标最多存 30 天——这票干脆都不存），结果末尾写明数据来自 Google 地图。
import { activeLanguage, distanceMeters, gcjToWgs, inMainlandChina, type LatLon, wgsToGcj } from "@ergo/protocol";
import { type LookupProvider, MapLookupError, type PlaceHit, type RouteAnswer, thinLine, type TransitLeg, type TransitPlan } from "../map/api.ts";
import type { GoogleClient } from "./client.ts";
import { decodePolyline } from "./polyline.ts";

/** 地点要的字段（Pro 档；不要营业时间、评分这些 Enterprise 档的） */
export const PLACE_FIELDS = ["places.id", "places.displayName", "places.formattedAddress", "places.location", "places.primaryTypeDisplayName"].join(",");
/** 开车、步行的路线要的字段 */
export const ROUTE_FIELDS = ["routes.duration", "routes.staticDuration", "routes.distanceMeters", "routes.polyline.encodedPolyline"].join(",");
/** 公交的路线要的字段 */
export const TRANSIT_FIELDS = ["routes.duration", "routes.distanceMeters", "routes.polyline.encodedPolyline", "routes.legs.steps.travelMode", "routes.legs.steps.distanceMeters", "routes.legs.steps.transitDetails", "routes.travelAdvisory.transitFare"].join(",");

/** Text Search、Nearby Search 一次最多给几个；圈最大多少米（文档写的） */
const MAX_RESULTS = 20;
const MAX_RADIUS_M = 50_000;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** 谷歌的时长 "165s" → 秒 */
const seconds = (v: unknown): number | undefined => {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(str(v));
  return m ? Number(m[1]) : undefined;
};

/** 交给谷歌的点：大陆里转 GCJ-02 */
export const toGoogle = (p: LatLon) => {
  const g = wgsToGcj(p);
  return { latitude: Number(g.lat.toFixed(6)), longitude: Number(g.lon.toFixed(6)) };
};

/** 谷歌回的 { latitude, longitude }（大陆里是 GCJ-02）→ WGS-84；认不出是 undefined */
export function fromGoogle(v: unknown): LatLon | undefined {
  const o = obj(v);
  const lat = num(o.latitude ?? o.lat);
  const lon = num(o.longitude ?? o.lng);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return gcjToWgs({ lat, lon });
}

/** 编码的折线 → WGS-84 的点 */
const lineOf = (v: unknown): LatLon[] => decodePolyline(str(obj(v).encodedPolyline)).map((p) => gcjToWgs(p));

/** 一个地点（Places API (New) 的 Place） */
function placeOf(v: unknown): PlaceHit | undefined {
  const p = obj(v);
  const where = fromGoogle(p.location);
  const name = str(obj(p.displayName).text);
  if (!where || name === "") return undefined;
  const id = str(p.id);
  // 完整地址（带城市、国家）：模型看得出在哪个城市
  const address = str(p.formattedAddress);
  const type = str(obj(p.primaryTypeDisplayName).text);
  return {
    ...(id === "" ? {} : { id }),
    name,
    ...(address === "" ? {} : { address }),
    ...(type === "" ? {} : { type }),
    lat: where.lat,
    lon: where.lon,
  };
}

/** 地理编码匹配到哪一级（给模型看的） */
const LOCATION_TYPE: Readonly<Record<string, string>> = {
  ROOFTOP: "精确到门牌", // @i18n-ignore model
  RANGE_INTERPOLATED: "门牌号（按路段估的）", // @i18n-ignore model
  GEOMETRIC_CENTER: "道路或区域的中心", // @i18n-ignore model
  APPROXIMATE: "大致的位置", // @i18n-ignore model
};

/** 地址里的城市、省、国家连成一段（逆地理编码用） */
function areaOf(components: unknown): string | undefined {
  const parts: string[] = [];
  for (const want of ["locality", "administrative_area_level_1", "country"]) {
    const c = arr(components).map(obj).find((x) => arr(x.types).includes(want));
    const name = str(c?.long_name);
    if (name !== "" && !parts.includes(name)) parts.push(name);
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** 一个地理编码结果 */
function geocodedOf(v: unknown): PlaceHit | undefined {
  const g = obj(v);
  const where = fromGoogle(obj(obj(g.geometry).location));
  const name = str(g.formatted_address);
  if (!where || name === "") return undefined;
  const id = str(g.place_id);
  const level = LOCATION_TYPE[str(obj(g.geometry).location_type)];
  const area = areaOf(g.address_components);
  return { ...(id === "" ? {} : { id }), name, ...(area === undefined ? {} : { area }), lat: where.lat, lon: where.lon, ...(level === undefined ? {} : { level }) };
}

/** 车的种类 → 地铁、火车、公交 */
const SUBWAY = new Set(["SUBWAY", "METRO_RAIL", "LIGHT_RAIL", "MONORAIL", "TRAM"]);
const RAIL = new Set(["RAIL", "HEAVY_RAIL", "COMMUTER_TRAIN", "HIGH_SPEED_TRAIN", "LONG_DISTANCE_TRAIN"]);

/** 公交的一个方案（一条 route） */
function transitPlanOf(v: unknown): TransitPlan | undefined {
  const r = obj(v);
  const durationS = seconds(r.duration);
  const distanceM = num(r.distanceMeters);
  if (durationS === undefined || distanceM === undefined) return undefined;
  const legs: TransitLeg[] = [];
  let walked = 0;
  for (const leg of arr(r.legs)) {
    for (const raw of arr(obj(leg).steps)) {
      const step = obj(raw);
      const meters = num(step.distanceMeters) ?? 0;
      const details = obj(step.transitDetails);
      if (str(step.travelMode) === "TRANSIT" || Object.keys(details).length > 0) {
        const line = obj(details.transitLine);
        const stops = obj(details.stopDetails);
        const name = str(line.nameShort) || str(line.name) || str(obj(obj(line.vehicle).name).text);
        const from = str(obj(stops.departureStop).name);
        const to = str(obj(stops.arrivalStop).name);
        const vehicle = str(obj(line.vehicle).type);
        if (RAIL.has(vehicle)) legs.push({ kind: "rail", name, from, to });
        else {
          const count = num(details.stopCount);
          legs.push({ kind: "ride", name, from, to, ...(count === undefined ? {} : { stops: count }), subway: SUBWAY.has(vehicle) });
        }
        continue;
      }
      if (meters <= 0) continue;
      walked += meters;
      // 连着的几段步行并成一段
      const last = legs.at(-1);
      if (last?.kind === "walk") legs[legs.length - 1] = { kind: "walk", meters: last.meters + meters };
      else legs.push({ kind: "walk", meters });
    }
  }
  const fare = obj(obj(r.travelAdvisory).transitFare);
  const units = num(fare.units);
  const yuan = str(fare.currencyCode) === "CNY" && units !== undefined ? units + (num(fare.nanos) ?? 0) / 1e9 : undefined;
  return { durationS, distanceM, walkingM: walked, ...(yuan === undefined ? {} : { fare: Math.round(yuan * 100) / 100 }), legs, line: thinLine(lineOf(r.polyline)) };
}

/** 结果用什么语言（跟着界面的语言） */
const language = () => activeLanguage();

export interface GoogleLookupOptions {
  client: GoogleClient;
  /** 服务端 Key（现取；没填抛 no_key） */
  key(): string | undefined;
}

export function createGoogleLookup(options: GoogleLookupOptions): LookupProvider {
  const keyOf = (): string => {
    const key = options.key();
    if (key === undefined) throw new MapLookupError("no_key", "no server key");
    return key;
  };
  const text = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const reply = await options.client.post("places", "/v1/places:searchText", { languageCode: language(), ...body }, PLACE_FIELDS, keyOf(), "textSearch", signal);
    return arr(reply.places)
      .map(placeOf)
      .filter((p): p is PlaceHit => p !== undefined);
  };
  const route = async (from: LatLon, to: LatLon, travelMode: "DRIVE" | "WALK" | "TRANSIT", signal?: AbortSignal) => {
    const body = {
      origin: { location: { latLng: toGoogle(from) } },
      destination: { location: { latLng: toGoogle(to) } },
      travelMode,
      ...(travelMode === "DRIVE" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
      ...(travelMode === "TRANSIT" ? { computeAlternativeRoutes: true } : {}),
      languageCode: language(),
      units: "METRIC",
    };
    const reply = await options.client.post("routes", "/directions/v2:computeRoutes", body, travelMode === "TRANSIT" ? TRANSIT_FIELDS : ROUTE_FIELDS, keyOf(), travelMode === "DRIVE" ? "routesPro" : "routesEssentials", signal);
    return arr(reply.routes);
  };
  return {
    id: "google",
    name: "谷歌地图", // @i18n-ignore model：工具结果里"谷歌地图找到 3 个"（给人看的来源名走 t()）
    credit: "数据来自 Google 地图（Google Maps），现查的，没存", // @i18n-ignore model：工具结果末尾的那句（谷歌要求写明来自 Google Maps）
    routeModes: ["driving", "transit", "walking"],
    defaultModes: ["driving", "transit"],
    liveTraffic: true,
    browsesNearby: true,
    covers: () => true,
    coverageNote: (p) => (inMainlandChina(p) ? "这里在中国大陆，谷歌在大陆的店名、小路可能不全不新，路况只是大概" : undefined), // @i18n-ignore model
    // @i18n-ignore-start model：出错时给模型的话（谷歌自己的：去哪重新填 Key、哪个开关没开、到上限）
    explain(err) {
      const detail = err.detail === "" ? "" : `（${err.detail}${err.code === undefined ? "" : `，${err.code}`}）`;
      switch (err.failure) {
        case "no_key":
          return "谷歌的服务端 Key 还没填（设置 · 数据源 · 谷歌地图），查不了。";
        case "key":
          return `谷歌不认填的服务端 Key${detail}：如实告诉用户，请用户去 设置 · 数据源 · 谷歌地图 重新填。`;
        case "denied": {
          const why =
            err.code === "SERVICE_DISABLED"
              ? "这个 Google Cloud 项目里没开要用的 API（Places API (New)、Routes API、Geocoding API 要都开）"
              : err.code === "API_KEY_SERVICE_BLOCKED"
                ? "这个 Key 的「API 限制」里没勾这项服务"
                : err.code === "API_KEY_IP_ADDRESS_BLOCKED" || err.code === "API_KEY_HTTP_REFERRER_BLOCKED"
                  ? "这个 Key 的「应用限制」不让这台电脑用（服务端 Key 要按 IP 限制，写电脑的出口 IP）"
                  : err.code === "BILLING_DISABLED"
                    ? "这个 Google Cloud 项目没开结算（谷歌要求有结算账户才能用）"
                    : "可能是没开这个 API、Key 的限制不让、没开结算、到了自己设的每日上限";
          return `谷歌拒绝了${detail}：${why}。如实告诉用户，请用户到 Google Cloud 控制台看看（步骤在 设置 · 数据源 · 谷歌地图 的说明里）。`;
        }
        case "quota":
          return `谷歌说用量到上限了${detail}：多半是用户在 Google Cloud 设的每日上限到了，今天先查不了。如实告诉用户，明天再试。`;
        default:
          return undefined;
      }
    },
    // @i18n-ignore-end

    searchText: (q, signal) =>
      text(
        {
          textQuery: (q.city ? `${q.keyword} ${q.city}` : q.keyword).slice(0, 200),
          pageSize: Math.min(MAX_RESULTS, Math.max(1, q.limit)),
          ...(q.near === undefined ? {} : { locationBias: { circle: { center: toGoogle(q.near), radius: MAX_RADIUS_M } } }),
        },
        signal,
      ).then((hits) => hits.slice(0, q.limit)),

    async searchNear(q, signal) {
      const radius = Math.round(Math.min(MAX_RADIUS_M, Math.max(1, q.radius)));
      const circle = { center: toGoogle(q.center), radius };
      let hits: PlaceHit[];
      if (q.keyword) hits = await text({ textQuery: q.keyword.slice(0, 200), pageSize: MAX_RESULTS, locationBias: { circle }, rankPreference: "DISTANCE" }, signal);
      else {
        const reply = await options.client.post(
          "places",
          "/v1/places:searchNearby",
          { languageCode: language(), maxResultCount: Math.min(MAX_RESULTS, Math.max(1, q.limit)), rankPreference: "DISTANCE", locationRestriction: { circle } },
          PLACE_FIELDS,
          keyOf(),
          "nearbySearch",
          signal,
        );
        hits = arr(reply.places)
          .map(placeOf)
          .filter((p): p is PlaceHit => p !== undefined);
      }
      return hits
        .map((h) => ({ ...h, distanceM: Math.round(distanceMeters(q.center, h)) }))
        .filter((h) => h.distanceM <= radius)
        .toSorted((a, b) => a.distanceM - b.distanceM)
        .slice(0, q.limit);
    },

    async geocode(q, signal) {
      const params: Record<string, string> = { address: (q.city ? `${q.address}, ${q.city}` : q.address).slice(0, 300), language: language() };
      if (q.near !== undefined) {
        // 让结果靠近路线的另一头：它四周一个大约 100 公里见方的框（bounds 只是偏向）
        const c = toGoogle(q.near);
        params.bounds = `${(c.latitude - 0.5).toFixed(6)},${(c.longitude - 0.5).toFixed(6)}|${(c.latitude + 0.5).toFixed(6)},${(c.longitude + 0.5).toFixed(6)}`;
      }
      const results = await options.client.geocode(params, keyOf(), signal);
      return results.map(geocodedOf).filter((p): p is PlaceHit => p !== undefined);
    },

    async reverse(p, signal) {
      const g = toGoogle(p);
      const results = await options.client.geocode({ latlng: `${g.latitude.toFixed(6)},${g.longitude.toFixed(6)}`, language: language() }, keyOf(), signal);
      const first = obj(results[0]);
      const name = str(first.formatted_address);
      if (name === "") return undefined;
      const area = areaOf(first.address_components);
      const id = str(first.place_id);
      return { ...(id === "" ? {} : { id }), name, address: name, ...(area === undefined ? {} : { area }), lat: p.lat, lon: p.lon };
    },

    async route(q, signal): Promise<RouteAnswer> {
      if (q.mode === "transit") {
        const plans = (await route(q.from, q.to, "TRANSIT", signal))
          .slice(0, 3)
          .map(transitPlanOf)
          .filter((p): p is TransitPlan => p !== undefined);
        return { mode: "transit", plans };
      }
      const first = obj((await route(q.from, q.to, q.mode === "driving" ? "DRIVE" : "WALK", signal))[0]);
      const durationS = seconds(first.duration);
      const distanceM = num(first.distanceMeters);
      if (durationS === undefined || distanceM === undefined) throw new MapLookupError("no_route", "no routes");
      const line = thinLine(lineOf(first.polyline));
      return q.mode === "driving" ? { mode: "driving", durationS, distanceM, line } : { mode: "walking", durationS, distanceM, line };
    },
  };
}
