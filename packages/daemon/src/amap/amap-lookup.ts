// 高德 Web 服务（432）：查地点、地址、路线，照 lookup.ts 的 LookupProvider。守护进程直接调 restapi.amap.com（测试换成本机的假高德），
// 用密钥区里"高德地图"那一格的 Web 服务 Key（serviceKey，429 填的）。
// 用到的接口（lbs.amap.com 的 Web 服务文档，2026-11 读的）：
// - 搜地点 2.0：/v5/place/text（关键字，region + city_limit 限城市）、/v5/place/around（周边，location + radius，按距离排）；
// - 地理编码 / 逆地理编码：/v3/geocode/geo、/v3/geocode/regeo（extensions=base）；
// - 路线规划 2.0：/v5/direction/driving（show_fields=cost,tmcs,polyline：用时、红绿灯、过路费、分段路况、折线）、
//   /v5/direction/walking（cost,polyline）、/v5/direction/transit/integrated（cost,polyline；要 city1/city2 两头的城市编码，
//   不知道的先逆地理编码查一下）。
// 坐标：进去之前 WGS-84 → GCJ-02（只转大陆里的），回来的 GCJ-02 → WGS-84（protocol 的 geo.ts）；经度在前，最多 6 位小数。
// 高德的老毛病：没有值的字段回空数组 []，数字也写成字符串——读的时候一律按"不是字符串就当没有"处理；
// 文档没给 JSON 样例，字段照文档的说明读，几处两种写法都认（折线是字符串或 { polyline }、用时在 cost.duration 或 duration）。
// 出错：status 不是 "1" 时按 infocode 分成 lookup.ts 的几种（Key 不认、到上限、太频繁、点在国外、找不到路……）；
// 每个回应都交给 onReply（amap.ts 记下 Web 服务 Key 不认 / 到上限，数据源的连接状态跟着变）。
// 用量：每发一次请求记一次（amap-usage.ts，搜地点和地址路线分开数）。
// Key 不进日志、不进出错的原因：日志只写哪个接口、高德的错误码，不写查了什么。
import { gcjToWgs, inMainlandChina, type LatLon, t, wgsToGcj } from "@ergo/protocol";
import type { DataSourceSecrets } from "../data-sources/api.ts";
import { AMAP_HOSTS, AMAP_SECRET, AMAP_TIMEOUT_MS, type AmapHosts } from "./amap.ts";
import type { AmapUsage, AmapUsageKind } from "./amap-usage.ts";
import { type LookupProvider, MapLookupError, type MapLookupFailure, type PlaceHit, type RouteAnswer, type RouteEnd, thinLine, type TrafficJam, type TransitLeg, type TransitPlan } from "../map/api.ts";

export interface AmapLookupOptions {
  hosts?: Partial<AmapHosts>;
  timeoutMs?: number;
  /** 密钥区里高德那一格（现取） */
  secrets: () => DataSourceSecrets;
  usage: AmapUsage;
  /** 高德每次的回应（JSON 和 HTTP 状态）：amap.ts 记下 Key 不认、到上限 */
  onReply?: (body: unknown, httpStatus: number) => void;
  log: (line: string) => void;
}

export interface AmapLookup extends LookupProvider {
  /** 存着 Web 服务 Key 没有 */
  hasKey(): boolean;
}

/** infocode → 哪一种出错（没列的看 info，再没有算 other） */
const FAILURES: Readonly<Record<string, MapLookupFailure>> = {
  "10001": "key",
  "10005": "key",
  "10006": "key",
  "10007": "key",
  "10009": "key",
  "10013": "key",
  "10002": "denied",
  "10012": "denied",
  "10041": "denied",
  "10026": "denied",
  "10003": "quota",
  "10044": "quota",
  "10045": "quota",
  "40000": "quota",
  "40002": "quota",
  "40003": "quota",
  "10010": "quota",
  "10004": "rate",
  "10014": "rate",
  "10015": "rate",
  "10019": "rate",
  "10020": "rate",
  "10021": "rate",
  "10029": "rate",
  "10016": "server",
  "10017": "server",
  "20003": "server",
  "20011": "abroad",
  "20800": "abroad",
  "20801": "no_route",
  "20802": "no_route",
  "20803": "too_far",
  "20000": "params",
  "20001": "params",
  "20002": "params",
  "20012": "params",
};

/** 高德的 infocode（和 info）→ 哪一种出错（静态地图 451 也用） */
export function amapFailureOf(infocode: string, info: string): MapLookupFailure {
  return FAILURES[infocode] ?? (/^3\d{4}$/.test(infocode) ? "server" : info === "INVALID_USER_KEY" ? "key" : "other");
}

/** 高德的值：字符串原样（去掉首尾空白），别的（[]、对象、没有）当没有 */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** 高德写成字符串的数：认不出是 undefined */
const num = (v: unknown): number | undefined => {
  const s = typeof v === "number" ? String(v) : str(v);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 送给高德的坐标："经度,纬度"（GCJ-02，6 位小数） */
export function amapLocation(p: LatLon): string {
  const g = wgsToGcj(p);
  return `${g.lon.toFixed(6)},${g.lat.toFixed(6)}`;
}

/** 高德的 "经度,纬度"（GCJ-02）→ WGS-84；认不出是 undefined */
export function fromAmapLocation(text: unknown): LatLon | undefined {
  const parts = str(text).split(",");
  if (parts.length !== 2) return undefined;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return gcjToWgs({ lat, lon });
}

/** 折线可能是字符串，也可能是 { polyline: "..." } */
const polyText = (v: unknown): string => (typeof v === "string" ? v : str(obj(v).polyline));

/** 高德的折线（"经,纬;经,纬"，也认 "|" 分段、全用逗号连着写的）→ WGS-84 的点 */
export function parseAmapPolyline(text: string): LatLon[] {
  const out: LatLon[] = [];
  for (const piece of text.split(/[;|]/)) {
    const nums = piece
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const lon = nums[i]!;
      const lat = nums[i + 1]!;
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push(gcjToWgs({ lat, lon }));
    }
  }
  return out;
}

/** 省市区连成一段（直辖市的 city 是空的；重复的去掉） */
function areaOf(...parts: unknown[]): string | undefined {
  const seen: string[] = [];
  for (const p of parts.map(str)) if (p !== "" && !seen.includes(p)) seen.push(p);
  return seen.length === 0 ? undefined : seen.join("");
}

/** 一个 POI（搜地点 2.0 的 pois 里的一项） */
function poiOf(v: unknown): PlaceHit | undefined {
  const p = obj(v);
  const where = fromAmapLocation(p.location);
  const name = str(p.name);
  if (!where || name === "") return undefined;
  const id = str(p.id);
  const address = str(p.address);
  const area = areaOf(p.pname, p.cityname, p.adname);
  const type = str(p.type).split(";").filter((s) => s !== "").at(-1);
  const distanceM = num(p.distance);
  const cityCode = str(p.citycode);
  return {
    ...(id === "" ? {} : { id }),
    name,
    ...(address === "" ? {} : { address }),
    ...(area === undefined ? {} : { area }),
    ...(type === undefined ? {} : { type }),
    ...(distanceM === undefined ? {} : { distanceM }),
    lat: where.lat,
    lon: where.lon,
    ...(cityCode === "" ? {} : { cityCode }),
  };
}

/** 路况的说法 → 三档（畅通、未知不算堵）。高德回的是中文的"畅通、缓行、拥堵、严重拥堵、未知" */
function jamOf(status: string): TrafficJam["status"] | undefined {
  if (status.includes("严重")) return "severe"; // @i18n-ignore data：认高德回的路况
  if (status.includes("拥堵")) return "jam"; // @i18n-ignore data：认高德回的路况
  if (status.includes("缓行")) return "slow"; // @i18n-ignore data：认高德回的路况
  if (/severe/i.test(status)) return "severe";
  if (/congest|jam/i.test(status)) return "jam";
  if (/slow/i.test(status)) return "slow";
  return undefined;
}

/** 驾车：第一条路线（v5 的 paths[0]） */
function drivingOf(route: Record<string, unknown>): RouteAnswer {
  const path = obj(arr(route.paths)[0]);
  const cost = obj(path.cost);
  const distanceM = num(path.distance);
  const durationS = num(cost.duration) ?? num(path.duration);
  if (distanceM === undefined || durationS === undefined) throw new MapLookupError("no_route", "no paths");
  const line: LatLon[] = [];
  const jams = new Map<string, TrafficJam>();
  let hasTraffic = false;
  const addTmcs = (tmcs: unknown, road: string) => {
    for (const tmc of arr(tmcs)) {
      hasTraffic = true;
      const status = jamOf(str(obj(tmc).tmc_status));
      const meters = num(obj(tmc).tmc_distance) ?? 0;
      if (status === undefined || meters <= 0) continue;
      const key = `${road}|${status}`;
      const before = jams.get(key);
      jams.set(key, { road, status, meters: (before?.meters ?? 0) + meters });
    }
  };
  for (const step of arr(path.steps)) {
    const s = obj(step);
    line.push(...parseAmapPolyline(polyText(s.polyline)));
    addTmcs(s.tmcs, str(s.road_name));
  }
  addTmcs(path.tmcs, "");
  if (line.length === 0) line.push(...parseAmapPolyline(polyText(path.polyline)));
  const order = { severe: 0, jam: 1, slow: 2 } as const;
  const traffic = [...jams.values()].toSorted((a, b) => order[a.status] - order[b.status] || b.meters - a.meters);
  const tolls = num(cost.tolls) ?? num(path.tolls);
  const lights = num(cost.traffic_lights) ?? num(path.traffic_lights);
  const taxiCost = num(route.taxi_cost);
  return {
    mode: "driving",
    durationS,
    distanceM,
    ...(tolls === undefined ? {} : { tolls }),
    ...(lights === undefined ? {} : { lights }),
    ...(taxiCost === undefined ? {} : { taxiCost }),
    ...(hasTraffic ? { traffic } : {}),
    line: thinLine(line),
  };
}

/** 步行：第一条 */
function walkingOf(route: Record<string, unknown>): RouteAnswer {
  const path = obj(arr(route.paths)[0]);
  const distanceM = num(path.distance);
  const durationS = num(obj(path.cost).duration) ?? num(path.duration);
  if (distanceM === undefined || durationS === undefined) throw new MapLookupError("no_route", "no paths");
  const line = parseAmapPolyline(polyText(path.polyline));
  if (line.length === 0) for (const step of arr(path.steps)) line.push(...parseAmapPolyline(polyText(obj(step).polyline)));
  return { mode: "walking", durationS, distanceM, line: thinLine(line) };
}

/** 一个站名（{ name }） */
const stopName = (v: unknown) => str(obj(v).name);

/** 公交：每个方案（最多 3 个） */
function transitOf(route: Record<string, unknown>): RouteAnswer {
  const plans: TransitPlan[] = [];
  for (const raw of arr(route.transits).slice(0, 3)) {
    const plan = obj(raw);
    const cost = obj(plan.cost);
    const durationS = num(cost.duration) ?? num(plan.duration);
    const distanceM = num(plan.distance);
    if (durationS === undefined || distanceM === undefined) continue;
    const legs: TransitLeg[] = [];
    const line: LatLon[] = [];
    let walked = 0;
    for (const segRaw of arr(plan.segments)) {
      const seg = obj(segRaw);
      const walking = obj(seg.walking);
      const walkM = num(walking.distance);
      if (walkM !== undefined && walkM > 0) {
        legs.push({ kind: "walk", meters: walkM });
        walked += walkM;
        for (const step of arr(walking.steps)) line.push(...parseAmapPolyline(polyText(obj(step).polyline)));
      }
      const bus = obj(arr(obj(seg.bus).buslines)[0]);
      const busName = str(bus.name);
      if (busName !== "") {
        const stops = num(bus.via_num);
        const type = str(bus.type);
        legs.push({
          kind: "ride",
          name: busName,
          from: stopName(bus.departure_stop),
          to: stopName(bus.arrival_stop),
          ...(stops === undefined ? {} : { stops: stops + 1 }),
          subway: type.includes("地铁") || /subway|metro/i.test(type) || /地铁|号线/.test(busName), // @i18n-ignore data：认高德回的线路种类、线路名
        });
        line.push(...parseAmapPolyline(polyText(bus.polyline)));
      }
      const rail = obj(seg.railway);
      const railName = str(rail.name) || str(rail.trip);
      if (railName !== "") legs.push({ kind: "rail", name: railName, from: stopName(rail.departure_stop), to: stopName(rail.arrival_stop) });
      const taxi = obj(seg.taxi);
      const taxiM = num(taxi.distance);
      if (taxiM !== undefined && taxiM > 0) {
        legs.push({ kind: "taxi", meters: taxiM });
        line.push(...parseAmapPolyline(polyText(taxi.polyline)));
      }
    }
    const fare = num(cost.transit_fee) ?? num(plan.cost);
    const walkingM = num(plan.walking_distance) ?? walked;
    plans.push({ durationS, distanceM, walkingM, ...(fare === undefined ? {} : { fare }), legs, line: thinLine(line) });
  }
  return { mode: "transit", plans };
}

/** 一句话里的 Key 换成 *** */
const redact = (text: string, key: string) => (key.length >= 4 ? text.split(key).join("***") : text);

/** 大陆外的点高德查不了（公交、路线都只管大陆） */
function inside(p: LatLon): void {
  if (!inMainlandChina(p)) throw new MapLookupError("abroad", "outside mainland China");
}

export function createAmapLookup(options: AmapLookupOptions): AmapLookup {
  const hosts: AmapHosts = { ...AMAP_HOSTS, ...options.hosts };
  const timeoutMs = options.timeoutMs ?? AMAP_TIMEOUT_MS;

  const keyOf = (): string => {
    const key = options.secrets().get(AMAP_SECRET.serviceKey);
    if (key === undefined) throw new MapLookupError("no_key", "no web service key");
    return key;
  };

  /** 调一次：交回高德的 JSON（status 是 "1" 的）；出错抛 MapLookupError */
  const call = async (path: string, params: Readonly<Record<string, string>>, kind: AmapUsageKind, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const key = keyOf();
    const q = new URLSearchParams({ ...params, key, output: "JSON" });
    const timeout = AbortSignal.timeout(timeoutMs);
    options.usage.count(kind);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${hosts.rest}${path}?${q}`, { headers: { Accept: "application/json" }, redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = timeout.aborted ? t("amap.error.timeout") : redact(causeOf(err), key);
      options.log(`高德：${path} 没连上：${reason}`); // @i18n-ignore log
      throw new MapLookupError("network", reason);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      options.log(`高德：${path} 回的不是 JSON（HTTP ${res.status}）`); // @i18n-ignore log
      throw new MapLookupError(res.status >= 500 ? "server" : "other", `HTTP ${res.status}`);
    }
    options.onReply?.(body, res.status);
    const b = obj(body);
    if (str(b.status) === "1") return b;
    const code = str(b.infocode);
    const info = redact(str(b.info), key) || `HTTP ${res.status}`;
    const failure = amapFailureOf(code, info);
    options.log(`高德：${path} 没查成（${code || "?"} ${info}）`); // @i18n-ignore log
    throw new MapLookupError(failure, info, code === "" ? undefined : code);
  };

  const reverse = async (p: LatLon, signal?: AbortSignal): Promise<PlaceHit | undefined> => {
    inside(p);
    const body = await call("/v3/geocode/regeo", { location: amapLocation(p), extensions: "base" }, "lbs", signal);
    const re = obj(body.regeocode);
    const address = str(re.formatted_address);
    if (address === "") return undefined;
    const c = obj(re.addressComponent);
    const street = obj(c.streetNumber);
    const road = `${str(street.street)}${str(street.number)}`;
    const cityCode = str(c.citycode);
    const area = areaOf(c.province, c.city, c.district);
    return {
      name: address,
      address: road === "" ? address : road,
      ...(area === undefined ? {} : { area }),
      lat: p.lat,
      lon: p.lon,
      ...(cityCode === "" ? {} : { cityCode }),
    };
  };

  /** 算公交要两头的城市编码：带着的直接用，没有的逆地理编码查 */
  const cityCodeOf = async (end: RouteEnd, signal?: AbortSignal): Promise<string> => {
    if (end.cityCode) return end.cityCode;
    const hit = await reverse(end, signal);
    if (!hit?.cityCode) throw new MapLookupError("no_route", "no citycode");
    return hit.cityCode;
  };

  return {
    id: "amap",
    name: "高德", // @i18n-ignore model：工具结果里"数据来自高德"（给人看的来源名走 t("amap.lookup.source")）
    credit: "数据来自高德，现查的，没存", // @i18n-ignore model：工具结果末尾的那句
    routeModes: ["driving", "transit", "walking"],
    defaultModes: ["driving", "transit"],
    liveTraffic: true,
    browsesNearby: true,
    covers: inMainlandChina,
    // @i18n-ignore-start model：出错时给模型的话（高德自己的：去哪重新填 Key、到上限）
    explain(err) {
      const detail = err.detail === "" ? "" : `（${err.detail}${err.code === undefined ? "" : `，${err.code}`}）`;
      switch (err.failure) {
        case "no_key":
          return "高德的 Web 服务 Key 还没填（设置 · 数据源 · 高德地图），查不了。";
        case "key":
          return `高德不认填的 Web 服务 Key${detail}：如实告诉用户，请用户去 设置 · 数据源 · 高德地图 重新填。`;
        case "denied":
          return `高德说这个 Key 没有这项服务的权限${detail}：请用户在高德的控制台看看这个 Key 开了哪些服务。`;
        case "quota":
          return `高德说用量到上限了${detail}：今天先查不了（也可能是这个月的免费量用完了）。如实告诉用户，明天再试，或者请用户到高德的控制台看看用量。`;
        case "abroad":
          return "这个地方在中国大陆以外，高德查不了。";
        default:
          return undefined;
      }
    },
    // @i18n-ignore-end
    hasKey: () => options.secrets().has(AMAP_SECRET.serviceKey),

    async searchText(q, signal) {
      const params: Record<string, string> = { keywords: q.keyword.slice(0, 80), page_size: String(Math.min(25, Math.max(1, q.limit))), page_num: "1" };
      if (q.city) {
        params.region = q.city;
        params.city_limit = "true";
      }
      const body = await call("/v5/place/text", params, "search", signal);
      return arr(body.pois)
        .map(poiOf)
        .filter((p): p is PlaceHit => p !== undefined)
        .slice(0, q.limit);
    },

    async searchNear(q, signal) {
      inside(q.center);
      const params: Record<string, string> = {
        location: amapLocation(q.center),
        radius: String(Math.round(Math.min(50_000, Math.max(1, q.radius)))),
        sortrule: "distance",
        page_size: String(Math.min(25, Math.max(1, q.limit))),
        page_num: "1",
      };
      if (q.keyword) params.keywords = q.keyword.slice(0, 80);
      const body = await call("/v5/place/around", params, "search", signal);
      const hits = arr(body.pois)
        .map(poiOf)
        .filter((p): p is PlaceHit => p !== undefined);
      return hits.toSorted((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)).slice(0, q.limit);
    },

    async geocode(q, signal) {
      const params: Record<string, string> = { address: q.address.slice(0, 200) };
      if (q.city) params.city = q.city;
      const body = await call("/v3/geocode/geo", params, "lbs", signal);
      return arr(body.geocodes).flatMap((raw): PlaceHit[] => {
        const g = obj(raw);
        const where = fromAmapLocation(g.location);
        const name = str(g.formatted_address);
        if (!where || name === "") return [];
        const area = areaOf(g.province, g.city, g.district);
        const cityCode = str(g.citycode);
        const level = str(g.level);
        return [{ name, ...(area === undefined ? {} : { area }), lat: where.lat, lon: where.lon, ...(cityCode === "" ? {} : { cityCode }), ...(level === "" ? {} : { level }) }];
      });
    },

    reverse,

    async route(q, signal) {
      inside(q.from);
      inside(q.to);
      const origin = amapLocation(q.from);
      const destination = amapLocation(q.to);
      if (q.mode === "driving") {
        const body = await call("/v5/direction/driving", { origin, destination, show_fields: "cost,tmcs,polyline" }, "lbs", signal);
        return drivingOf(obj(body.route));
      }
      if (q.mode === "walking") {
        const body = await call("/v5/direction/walking", { origin, destination, show_fields: "cost,polyline" }, "lbs", signal);
        return walkingOf(obj(body.route));
      }
      const city1 = await cityCodeOf(q.from, signal);
      const city2 = await cityCodeOf(q.to, signal);
      const body = await call("/v5/direction/transit/integrated", { origin, destination, city1, city2, show_fields: "cost,polyline" }, "lbs", signal);
      return transitOf(obj(body.route));
    },
  };
}

/** fetch 出错时真正的原因（undici 把它放在 cause 里，外面只有 "fetch failed"） */
function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return (cause as { code?: string }).code ?? cause.message;
  return err.message;
}
