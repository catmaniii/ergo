// 本机的假 OpenStreetMap 免费服务（只在测试里，433）：Nominatim 的 /search、/reverse 和 OSRM 演示服务的 /routed-car/、/routed-foot/
// 发到这里（createMapPlugin 的 osmHosts、createOsmLookup 的 hosts），从不连真的 nominatim.openstreetmap.org、routing.openstreetmap.de。
// 回的样子照官方文档（2026-11 读的）：Nominatim 的 format=jsonv2（lat、lon 是字符串，带 osm_type、osm_id、category、type、addresstype、
// name、display_name、addressdetails=1 的 address），找不到地址回 { error: "Unable to geocode" }；OSRM 的 route/v1（code "Ok"、
// routes[0] 的 distance 米、duration 秒、geometries=geojson 的 [经度, 纬度]），出错回 HTTP 400 加 { code, message }。
// 数据是编的：新加坡牛车水一带的几个 hawker centre（坐标是大概的，只为测远近）、滨海湾金沙，还有一个在杭州的"西湖"（大陆里的点，测去掉）。
// 测试能拨：
// - fail：之后发到某家（nominatim / osrm，不写是两家）的请求一律回这个 HTTP 状态（429、403、503）；
// - osrmCode：OSRM 回 400 加这个错误码（NoRoute、NoSegment、TooBig）；
// - replies：某个路径（"/search""/reverse"）回的东西换掉；
// - down：关掉服务（测连不上）。
// 记下每个请求：哪家、路径、查询串、User-Agent、Referer、到达的时刻（测每秒最多 1 次）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 新加坡牛车水一带"当前位置"（编的） */
export const SG_HERE = { lat: 1.2805, lon: 103.845 };

/** Nominatim jsonv2 的一条（编的） */
export function fakeNominatimPlace(id: number, name: string, lat: number, lon: number, extra: { type?: string; category?: string; road?: string; house?: string; suburb?: string; city?: string; country?: string; addresstype?: string } = {}) {
  const address = {
    ...(extra.house === undefined ? {} : { house_number: extra.house }),
    ...(extra.road === undefined ? {} : { road: extra.road }),
    ...(extra.suburb === undefined ? {} : { suburb: extra.suburb }),
    city: extra.city ?? "Singapore",
    country: extra.country ?? "Singapore",
    country_code: extra.country === undefined ? "sg" : "cn",
  };
  return {
    place_id: id,
    licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
    osm_type: "way",
    osm_id: id,
    lat: String(lat),
    lon: String(lon),
    category: extra.category ?? "amenity",
    type: extra.type ?? "food_court",
    place_rank: 30,
    importance: 0.0001,
    addresstype: extra.addresstype ?? "amenity",
    name,
    display_name: [name, extra.house, extra.road, extra.suburb, extra.city ?? "Singapore", extra.country ?? "Singapore"].filter((s) => s !== undefined).join(", "),
    address,
    boundingbox: [String(lat - 0.0005), String(lat + 0.0005), String(lon - 0.0005), String(lon + 0.0005)],
  };
}

/** 牛车水一带的 hawker centre（故意不按远近排：二狗自己按距离排；最后一个在 1 公里以外） */
export const FAKE_HAWKERS = [
  fakeNominatimPlace(2003, "Chinatown Complex Food Centre", 1.2826, 103.8429, { house: "335", road: "Smith Street", suburb: "Chinatown" }),
  fakeNominatimPlace(2001, "Maxwell Food Centre", 1.28036, 103.84476, { house: "1", road: "Kadayanallur Street", suburb: "Chinatown" }),
  fakeNominatimPlace(2004, "Lau Pa Sat", 1.28069, 103.85036, { house: "18", road: "Raffles Quay", suburb: "Downtown Core" }),
  fakeNominatimPlace(2002, "Amoy Street Food Centre", 1.2794, 103.8465, { road: "Telok Ayer Street", suburb: "Tanjong Pagar" }),
  fakeNominatimPlace(2005, "Tiong Bahru Market", 1.2851, 103.8327, { house: "30", road: "Seng Poh Road", suburb: "Tiong Bahru" }),
];
export const FAKE_MBS = fakeNominatimPlace(3001, "滨海湾金沙", 1.2834, 103.8607, { type: "hotel", category: "tourism", road: "Bayfront Avenue", suburb: "Marina Bay", addresstype: "tourism" });
/** 大陆里的点（OpenStreetMap 搜到了也要去掉，交给高德） */
export const FAKE_WEST_LAKE = fakeNominatimPlace(4001, "西湖", 30.246, 120.142, { type: "water", category: "natural", city: "杭州市", country: "中国", addresstype: "natural" });

export interface FakeOsmRequest {
  service: "nominatim" | "osrm";
  path: string;
  query: URLSearchParams;
  ua: string | undefined;
  referer: string | undefined;
  /** 到达的时刻（毫秒，真的时钟） */
  at: number;
}

export interface FakeOsmLookup {
  hosts: { nominatim: string; osrm: string };
  requests: FakeOsmRequest[];
  state: {
    fail: { status: number; service?: "nominatim" | "osrm" } | undefined;
    osrmCode: string | undefined;
    replies: Record<string, unknown>;
  };
  /** 关掉服务（之后连不上） */
  down(): Promise<void>;
}

function reply(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** viewbox="左经度,上纬度,右经度,下纬度" 里有没有这个点 */
function inBox(viewbox: string, p: { lat: string; lon: string }): boolean {
  const [x1, y1, x2, y2] = viewbox.split(",").map(Number) as [number, number, number, number];
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  return lon >= Math.min(x1, x2) && lon <= Math.max(x1, x2) && lat >= Math.min(y1, y2) && lat <= Math.max(y1, y2);
}

/** 按查询的词回编的地方 */
function searchReply(q: URLSearchParams): unknown[] {
  const text = (q.get("q") ?? "").toLowerCase();
  let found: ReturnType<typeof fakeNominatimPlace>[] = [];
  if (text.includes("hawker") || text.includes("food centre")) found = FAKE_HAWKERS;
  else if (text.includes("marina bay sands") || text.includes("滨海湾金沙")) found = [FAKE_MBS];
  else if (text.includes("西湖")) found = [FAKE_WEST_LAKE];
  const viewbox = q.get("viewbox");
  if (viewbox && q.get("bounded") === "1") found = found.filter((p) => inBox(viewbox, p));
  return found.slice(0, Number(q.get("limit") ?? "10"));
}

export async function startFakeOsmLookup(): Promise<FakeOsmLookup> {
  const requests: FakeOsmRequest[] = [];
  const state: FakeOsmLookup["state"] = { fail: undefined, osrmCode: undefined, replies: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const service = url.pathname.startsWith("/nominatim/") ? "nominatim" : url.pathname.startsWith("/osrm/") ? "osrm" : undefined;
    if (!service) return void res.writeHead(404).end();
    const path = url.pathname.slice(service.length + 1);
    const q = url.searchParams;
    const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
    requests.push({ service, path, query: q, ua: header("user-agent"), referer: header("referer"), at: Date.now() });
    if (state.fail && (state.fail.service === undefined || state.fail.service === service)) {
      res.writeHead(state.fail.status, { "Content-Type": "text/html" });
      return void res.end(state.fail.status === 429 ? "Too Many Requests" : state.fail.status === 403 ? "Access blocked" : "Service Unavailable");
    }
    if (service === "nominatim") {
      if (state.replies[path] !== undefined) return reply(res, state.replies[path]);
      if (path === "/search") return reply(res, searchReply(q));
      if (path === "/reverse") {
        const place = fakeNominatimPlace(2001, "Maxwell Food Centre", Number(q.get("lat")), Number(q.get("lon")), { house: "1", road: "Kadayanallur Street", suburb: "Chinatown" });
        return reply(res, { ...place, display_name: "Maxwell Food Centre, 1, Kadayanallur Street, Chinatown, Singapore, 069184, Singapore" });
      }
      return reply(res, { error: { code: 400, message: "unknown endpoint" } }, 400);
    }
    // OSRM：/routed-car/route/v1/driving/<经,纬;经,纬>、/routed-foot/route/v1/foot/<…>
    const m = /^\/routed-(car|foot)\/route\/v1\/[a-z]+\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)$/.exec(path);
    if (!m) return reply(res, { code: "InvalidUrl", message: "URL string malformed" }, 400);
    if (state.osrmCode) return reply(res, { code: state.osrmCode, message: `${state.osrmCode} (fake)` }, 400);
    const [lon1, lat1, lon2, lat2] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
    const car = m[1] === "car";
    return reply(res, {
      code: "Ok",
      routes: [
        {
          geometry: { type: "LineString", coordinates: [[lon1, lat1], [(lon1 + lon2) / 2, lat1], [lon2, lat2]] },
          legs: [{ steps: [], summary: "", weight: car ? 420 : 1380, duration: car ? 420 : 1380, distance: car ? 2400 : 1900 }],
          weight_name: "routability",
          weight: car ? 420 : 1380,
          duration: car ? 420 : 1380,
          distance: car ? 2400 : 1900,
        },
      ],
      waypoints: [
        { hint: "", distance: 3.2, name: "", location: [lon1, lat1] },
        { hint: "", distance: 5.1, name: "", location: [lon2, lat2] },
      ],
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      server.closeAllConnections();
      server.close(() => resolve());
    });
  onTestFinished(close);
  return { hosts: { nominatim: `${base}/nominatim`, osrm: `${base}/osrm` }, requests, state, down: close };
}
