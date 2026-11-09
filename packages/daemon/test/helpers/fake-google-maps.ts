// 本机的假谷歌（只在测试里，446）：Places API (New) 的 places:searchText、places:searchNearby，Routes API 的 directions/v2:computeRoutes，
// Geocoding API 的 /maps/api/geocode/json 都发到这里（createGoogleMapsPlugin 的 hosts），从不连真的 *.googleapis.com，不用真 Key
// （Key 是运行时拼的、明显编的）。
// 回的样子照谷歌文档的样例和字段说明（2026-11 读的）：
// - Places：{ places: [{ id, displayName: { text, languageCode }, formattedAddress, shortFormattedAddress, location: { latitude, longitude },
//   primaryTypeDisplayName: { text } }] }，只回字段掩码里要的那几样（掩码不写回 400，和真的一样）；
// - Routes：{ routes: [{ distanceMeters, duration: "165s", staticDuration, polyline: { encodedPolyline } }] }，公交的每一步 travelMode、
//   distanceMeters、transitDetails（stopDetails 的上下车站、headsign、stopCount、transitLine 的 name / nameShort / vehicle.type）；
// - Geocoding：{ results: [{ formatted_address, geometry: { location: { lat, lng }, location_type }, place_id, address_components, types }], status }；
// - 出错：新的两种回 HTTP 状态加 { error: { code, message, status, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain }] } }，
//   Key 不认 400 INVALID_ARGUMENT API_KEY_INVALID（"API key not valid. Please pass a valid API key."），没开 API 403 SERVICE_DISABLED，
//   到上限 429 RESOURCE_EXHAUSTED；地理编码回 200 加 status REQUEST_DENIED（"The provided API key is invalid."）、OVER_QUERY_LIMIT。
// 数据是编的：新加坡牛车水一带的几个 hawker centre（和 fake-osm-lookup.ts 同一批，坐标是大概的），大陆里一处（杭州，坐标按 GCJ-02 回，
// 测转换）。测试能拨：
// - fail：之后发到某个接口（"places" / "routes" / "geocoding"，不写是全部）的请求一律回这个错；
// - replies：某个路径回的东西换掉；
// 记下每个请求：路径、头（Key 在 X-Goog-Api-Key 或查询串的 key 里）、字段掩码、请求体、查询串。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { encodePolyline } from "../../src/google-maps/polyline.ts";
import { TINY_PNG } from "./fake-map.ts";
import { fakeSecret } from "./fake-secrets.ts";

/** 测试用的两个 Key（运行时拼：源码里看不出完整的 Key 样子；39 个字，和真的一样长） */
export const GOOGLE_TEST_BROWSER_KEY = fakeSecret("AIza", `SyFAKE-browser-${"0".repeat(18)}x1`);
export const GOOGLE_TEST_SERVER_KEY = fakeSecret("AIza", `SyFAKE-server-${"1".repeat(19)}x2`);

/** 一个假谷歌地点（Places API (New) 的 Place） */
export function fakeGooglePlace(id: string, name: string, lat: number, lon: number, extra: { address?: string; short?: string; type?: string } = {}) {
  return {
    id,
    displayName: { text: name, languageCode: "en" },
    formattedAddress: extra.address ?? `${extra.short ?? name}, Singapore`,
    shortFormattedAddress: extra.short ?? name,
    location: { latitude: lat, longitude: lon },
    primaryTypeDisplayName: { text: extra.type ?? "Food Court", languageCode: "en" },
    // 字段掩码里没要的（营业时间、评分这些 Enterprise 档的），真的不会回；这里放着，看二狗有没有多要
    rating: 4.3,
    userRatingCount: 1200,
  };
}

/** 牛车水一带的 hawker centre（故意不按远近排；最后一个在 1 公里以外） */
export const GOOGLE_HAWKERS = [
  fakeGooglePlace("ChIJfake-chinatown-complex", "Chinatown Complex Food Centre", 1.2826, 103.8429, { short: "335 Smith St" }),
  fakeGooglePlace("ChIJfake-maxwell", "Maxwell Food Centre", 1.28036, 103.84476, { short: "1 Kadayanallur St" }),
  fakeGooglePlace("ChIJfake-lau-pa-sat", "Lau Pa Sat", 1.28069, 103.85036, { short: "18 Raffles Quay" }),
  fakeGooglePlace("ChIJfake-amoy", "Amoy Street Food Centre", 1.2794, 103.8465, { short: "7 Maxwell Rd" }),
  fakeGooglePlace("ChIJfake-tiong-bahru", "Tiong Bahru Market", 1.2851, 103.8327, { short: "30 Seng Poh Rd" }),
];
/** 杭州的一处（GCJ-02 的坐标：谷歌在大陆回的和它的大陆街道图一样是 GCJ-02） */
export const GOOGLE_WEST_LAKE_GCJ = { lat: 30.2436, lon: 120.1487 };
export const GOOGLE_WEST_LAKE = fakeGooglePlace("ChIJfake-west-lake", "West Lake", GOOGLE_WEST_LAKE_GCJ.lat, GOOGLE_WEST_LAKE_GCJ.lon, { address: "West Lake, Xihu District, Hangzhou, Zhejiang, China", type: "Lake" });

/** 新加坡的一段路线（编的几个点） */
const SG_LINE = [
  { lat: 1.2805, lon: 103.845 },
  { lat: 1.2812, lon: 103.8478 },
  { lat: 1.2826, lon: 103.8531 },
  { lat: 1.2834, lon: 103.8607 },
];

/** 公交的一个方案：步行 → 地铁 → 步行 */
function transitRoute(minutes: number, line: string) {
  return {
    duration: `${minutes * 60}s`,
    distanceMeters: 4200,
    polyline: { encodedPolyline: encodePolyline(SG_LINE) },
    legs: [
      {
        steps: [
          { travelMode: "WALK", distanceMeters: 180 },
          { travelMode: "WALK", distanceMeters: 60 },
          {
            travelMode: "TRANSIT",
            distanceMeters: 3600,
            transitDetails: {
              stopDetails: { departureStop: { name: "Maxwell" }, arrivalStop: { name: "Bayfront" } },
              headsign: "Woodlands North",
              stopCount: 3,
              transitLine: { name: `${line} Line`, nameShort: line, vehicle: { type: "SUBWAY", name: { text: "Subway" } } },
            },
          },
          { travelMode: "WALK", distanceMeters: 350 },
        ],
      },
    ],
    travelAdvisory: { transitFare: { currencyCode: "SGD", units: "1", nanos: 590000000 } },
  };
}

/** 各个接口默认回的 */
export const FAKE_GOOGLE_REPLIES: Readonly<Record<string, unknown>> = {
  "/v1/places:searchText": { places: GOOGLE_HAWKERS },
  "/v1/places:searchNearby": { places: GOOGLE_HAWKERS.slice(0, 3) },
  "/directions/v2:computeRoutes": { routes: [{ distanceMeters: 4100, duration: "780s", staticDuration: "660s", polyline: { encodedPolyline: encodePolyline(SG_LINE) } }] },
  "/maps/api/geocode/json": {
    results: [
      {
        address_components: [
          { long_name: "10", short_name: "10", types: ["street_number"] },
          { long_name: "Bayfront Avenue", short_name: "Bayfront Ave", types: ["route"] },
          { long_name: "Singapore", short_name: "Singapore", types: ["locality", "political"] },
          { long_name: "Singapore", short_name: "SG", types: ["country", "political"] },
        ],
        formatted_address: "10 Bayfront Ave, Singapore 018956",
        geometry: { location: { lat: 1.2834, lng: 103.8607 }, location_type: "ROOFTOP" },
        place_id: "ChIJfake-mbs",
        types: ["street_address"],
      },
    ],
    status: "OK",
  },
};

/** 公交（computeRoutes 里 travelMode TRANSIT 时）默认回的 */
export const FAKE_GOOGLE_TRANSIT = { routes: [transitRoute(26, "DT"), transitRoute(31, "CC")] };

/** 一种出错：新式接口的（HTTP 状态 + error）或者地理编码的（status） */
export interface FakeGoogleFailure {
  readonly http: number;
  readonly status: string;
  readonly reason?: string;
  readonly message: string;
}

export const GOOGLE_FAILURES = {
  keyInvalid: { http: 400, status: "INVALID_ARGUMENT", reason: "API_KEY_INVALID", message: "API key not valid. Please pass a valid API key." },
  serviceDisabled: { http: 403, status: "PERMISSION_DENIED", reason: "SERVICE_DISABLED", message: "Places API (New) has not been used in project 0 before or it is disabled." },
  quota: { http: 429, status: "RESOURCE_EXHAUSTED", reason: "RATE_LIMIT_EXCEEDED", message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per day' of service." },
} as const satisfies Record<string, FakeGoogleFailure>;

export interface FakeGoogleRequest {
  readonly api: "places" | "routes" | "geocoding" | "static";
  readonly path: string;
  readonly key: string | undefined;
  readonly fieldMask: string | undefined;
  readonly body: Record<string, unknown> | undefined;
  readonly query: URLSearchParams;
}

/** 只留字段掩码里要的（"places.id,places.displayName" → 每个 place 只留 id、displayName） */
function masked(reply: unknown, mask: string): unknown {
  const fields = mask.split(",").map((f) => f.trim());
  if (fields.includes("*")) return reply;
  const r = reply as { places?: Array<Record<string, unknown>> };
  if (!Array.isArray(r.places)) return reply;
  const wanted = new Set(fields.filter((f) => f.startsWith("places.")).map((f) => f.slice("places.".length).split(".")[0]!));
  return { ...r, places: r.places.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => wanted.has(k)))) };
}

/** 回一个 JSON */
function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=UTF-8" });
  res.end(JSON.stringify(value));
}

/** 起一个假谷歌：hosts 交给插件，一个服务扮三个地址 */
export async function startFakeGoogleMaps() {
  const requests: FakeGoogleRequest[] = [];
  // staticOff：Maps Static API 没开（回 403 和谷歌的那句话，451）
  const state: { fail?: { api?: FakeGoogleRequest["api"]; failure: FakeGoogleFailure } | undefined; replies: Record<string, unknown>; staticOff?: boolean } = { replies: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const api: FakeGoogleRequest["api"] = url.pathname.startsWith("/v1/places") ? "places" : url.pathname.startsWith("/directions") ? "routes" : url.pathname.startsWith("/maps/api/staticmap") ? "static" : "geocoding";
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | undefined;
      try {
        body = text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        body = undefined;
      }
      const key = api === "geocoding" || api === "static" ? (url.searchParams.get("key") ?? undefined) : (req.headers["x-goog-api-key"] as string | undefined);
      const fieldMask = req.headers["x-goog-fieldmask"] as string | undefined;
      requests.push({ api, path: url.pathname, key, fieldMask, body, query: url.searchParams });
      const apiError = (f: FakeGoogleFailure) => sendJson(res, f.http, { error: { code: f.http, message: f.message, status: f.status, details: f.reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: f.reason, domain: "googleapis.com" }] : [] } });
      const fail = state.fail && (state.fail.api === undefined || state.fail.api === api) ? state.fail.failure : undefined;
      // 静态地图（451）：Key 不对、没开这个 API 回 403 和一句话（谷歌回的是字，不是 JSON）；对的回一张 1×1 的 PNG
      if (api === "static") {
        if (key !== GOOGLE_TEST_SERVER_KEY || state.staticOff) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8" });
          return void res.end(key !== GOOGLE_TEST_SERVER_KEY ? "The provided API key is invalid." : "This API project is not authorized to use this API.");
        }
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        return void res.end(TINY_PNG);
      }
      if (api === "geocoding") {
        if (key !== GOOGLE_TEST_SERVER_KEY) return sendJson(res, 200, { error_message: "The provided API key is invalid. ", results: [], status: "REQUEST_DENIED" });
        if (fail) return sendJson(res, 200, { error_message: fail.message, results: [], status: fail.http === 429 ? "OVER_QUERY_LIMIT" : "REQUEST_DENIED" });
        return sendJson(res, 200, state.replies[url.pathname] ?? FAKE_GOOGLE_REPLIES[url.pathname] ?? { results: [], status: "ZERO_RESULTS" });
      }
      if (req.method !== "POST") return sendJson(res, 404, { error: { code: 404, message: "Not Found", status: "NOT_FOUND" } });
      if (key !== GOOGLE_TEST_SERVER_KEY) return apiError(GOOGLE_FAILURES.keyInvalid);
      if (fieldMask === undefined || fieldMask === "") return sendJson(res, 400, { error: { code: 400, message: "FieldMask is a required parameter. See https://cloud.google.com/apis/docs/system-parameters on how to provide it.", status: "INVALID_ARGUMENT" } });
      if (fail) return apiError(fail);
      const reply = state.replies[url.pathname] ?? (url.pathname === "/directions/v2:computeRoutes" && body?.travelMode === "TRANSIT" ? FAKE_GOOGLE_TRANSIT : FAKE_GOOGLE_REPLIES[url.pathname]) ?? {};
      return sendJson(res, 200, masked(reply, fieldMask));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { hosts: { places: base, routes: base, geocoding: base }, requests, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
