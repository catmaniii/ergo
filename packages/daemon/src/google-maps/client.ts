// 调谷歌的那一层（446）：守护进程直接调 Google Maps Platform 的三种 Web 服务（测试换成本机的假谷歌），用密钥区里"谷歌地图"那一格的
// 服务端 Key。地址写死在这里，用户只填 Key。用到的（developers.google.com 的文档，2026-11 读的）：
// - Places API (New)：POST https://places.googleapis.com/v1/places:searchText、places:searchNearby，Key 放 X-Goog-Api-Key 头，
//   要什么字段写 X-Goog-FieldMask 头（不写会报错；写了哪些字段决定按哪一档收费——这里只要 Pro 档的几样，不要营业时间、评分这些 Enterprise 档的）；
// - Routes API：POST https://routes.googleapis.com/directions/v2:computeRoutes，同样两个头；
// - Geocoding API：GET https://maps.googleapis.com/maps/api/geocode/json?address=…|latlng=…&key=…（老式的 status 写法）。
// 出错：新的两种回 HTTP 4xx/5xx 加 { error: { code, message, status, details: [{ reason }] } }（Google API 的通用写法），
// 地理编码回 200 加 status（REQUEST_DENIED、OVER_QUERY_LIMIT……）和 error_message——都分成 map/api.ts 的 MapLookupError 几种：
// Key 不认（API_KEY_INVALID、"The provided API key is invalid."）是 key；没开这个 API、Key 的限制不让、没开结算是 denied（code 写原因，
// 告诉用户去哪改）；用到上限是 quota（429 里说"per day"的、OVER_QUERY_LIMIT），一时太频繁是 rate；参数不对 params；谷歌那边 5xx 是 server。
// 每次的结果交给 onReply（keys.ts 记下服务端 Key 不认、到上限，数据源的连接状态跟着变）。
// 用量：每发一次请求先记一次（usage.ts，按计费项）。Key 不进日志、不进出错的原因：日志只写哪个接口、谷歌的原因码，不写查了什么。
import { MapLookupError, type MapLookupFailure } from "../map/api.ts";
import type { GoogleMapsSku } from "@ergo/protocol";

/** 谷歌三种 Web 服务的地址（测试换成本机的假谷歌） */
export interface GoogleHosts {
  readonly places: string;
  readonly routes: string;
  readonly geocoding: string;
}

export const GOOGLE_HOSTS: GoogleHosts = { places: "https://places.googleapis.com", routes: "https://routes.googleapis.com", geocoding: "https://maps.googleapis.com" };

/** 一次请求最多等多久 */
export const GOOGLE_TIMEOUT_MS = 15_000;

/** 一次调用的结果（给 keys.ts 记状态）：成了，或者哪一种错 */
export type GoogleReply = { ok: true } | { ok: false; error: MapLookupError };

export interface GoogleClientOptions {
  hosts?: Partial<GoogleHosts>;
  timeoutMs?: number;
  /** 记一次用量（没有计费的那一次不写 sku） */
  count(sku: GoogleMapsSku): void;
  onReply?(reply: GoogleReply): void;
  log(line: string): void;
}

export interface GoogleClient {
  /** POST 一个新式接口（Places、Routes）：交回 JSON；出错抛 MapLookupError */
  post(api: "places" | "routes", path: string, body: unknown, fieldMask: string, key: string, sku: GoogleMapsSku | undefined, signal?: AbortSignal): Promise<Record<string, unknown>>;
  /** 地理编码（GET，老式的 status 写法）：交回 results（ZERO_RESULTS 是空的）；出错抛 MapLookupError */
  geocode(params: Readonly<Record<string, string>>, key: string, signal?: AbortSignal): Promise<unknown[]>;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 一句话里的 Key 换成 *** */
export const redactKey = (text: string, key: string) => (key.length >= 4 ? text.split(key).join("***") : text);

/** 新式接口的错（{ error: { code, message, status, details: [{ reason }] } }）→ 哪一种 */
export function failureOfApiError(httpStatus: number, status: string, reason: string, message: string): MapLookupFailure {
  if (reason === "API_KEY_INVALID" || reason === "API_KEY_EXPIRED" || /api key not valid/i.test(message)) return "key";
  if (httpStatus === 403 || status === "PERMISSION_DENIED") return "denied";
  if (httpStatus === 401 || status === "UNAUTHENTICATED") return "key";
  if (httpStatus === 429 || status === "RESOURCE_EXHAUSTED") return /per day|daily/i.test(message) ? "quota" : "rate";
  if (httpStatus === 400 || status === "INVALID_ARGUMENT" || status === "FAILED_PRECONDITION") return "params";
  if (httpStatus >= 500) return "server";
  return "other";
}

/** 地理编码的 status（和 error_message）→ 哪一种；OK、ZERO_RESULTS 不算错（undefined） */
export function failureOfGeocodeStatus(status: string, message: string): MapLookupFailure | undefined {
  switch (status) {
    case "OK":
    case "ZERO_RESULTS":
      return undefined;
    case "REQUEST_DENIED":
      return /invalid/i.test(message) && /key/i.test(message) ? "key" : "denied";
    // 文档：Key 没有或不对、没开结算、到了自己设的上限、付款方式失效——多半是结算或上限，当"没权限"说清几种可能
    case "OVER_DAILY_LIMIT":
      return "denied";
    case "OVER_QUERY_LIMIT":
      return "quota";
    case "INVALID_REQUEST":
      return "params";
    case "UNKNOWN_ERROR":
      return "server";
    default:
      return "other";
  }
}

/** fetch 出错时真正的原因（undici 把它放在 cause 里，外面只有 "fetch failed"） */
function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return (cause as { code?: string }).code ?? cause.message;
  return err.message;
}

export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const hosts: GoogleHosts = { ...GOOGLE_HOSTS, ...options.hosts };
  const timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS;
  const fail = (error: MapLookupError): never => {
    options.onReply?.({ ok: false, error });
    throw error;
  };

  /** 发出去、读回 JSON；连不上、等太久、回的不是 JSON 抛 MapLookupError */
  const send = async (label: string, url: string, init: RequestInit, key: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = timeout.aborted ? "timeout" : redactKey(causeOf(err), key);
      options.log(`谷歌地图：${label} 没连上：${reason}`); // @i18n-ignore log
      return fail(new MapLookupError("network", reason));
    }
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      options.log(`谷歌地图：${label} 回的不是 JSON（HTTP ${res.status}）`); // @i18n-ignore log
      return fail(new MapLookupError(res.status >= 500 ? "server" : "other", `HTTP ${res.status}`));
    }
  };

  return {
    async post(api, path, body, fieldMask, key, sku, signal) {
      if (sku !== undefined) options.count(sku);
      const label = `${api}${path}`;
      const reply = await send(
        label,
        `${hosts[api]}${path}`,
        { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask }, body: JSON.stringify(body) },
        key,
        signal,
      );
      if (reply.status >= 200 && reply.status < 300) {
        options.onReply?.({ ok: true });
        return obj(reply.body);
      }
      const error = obj(obj(reply.body).error);
      const status = str(error.status);
      const reason = (Array.isArray(error.details) ? error.details : []).map((d) => str(obj(d).reason)).find((r) => r !== "") ?? "";
      const message = redactKey(str(error.message), key) || `HTTP ${reply.status}`;
      const failure = failureOfApiError(reply.status, status, reason, message);
      options.log(`谷歌地图：${label} 没查成（HTTP ${reply.status} ${status || "?"} ${reason || "-"}）`); // @i18n-ignore log
      return fail(new MapLookupError(failure, message, reason || status || undefined));
    },

    async geocode(params, key, signal) {
      options.count("geocoding");
      const q = new URLSearchParams({ ...params, key });
      const reply = await send("geocoding", `${hosts.geocoding}/maps/api/geocode/json?${q}`, { headers: { Accept: "application/json" } }, key, signal);
      const b = obj(reply.body);
      const status = str(b.status);
      const message = redactKey(str(b.error_message), key);
      const failure = reply.status >= 500 ? "server" : failureOfGeocodeStatus(status, message);
      if (failure === undefined) {
        options.onReply?.({ ok: true });
        return Array.isArray(b.results) ? b.results : [];
      }
      options.log(`谷歌地图：geocoding 没查成（${status || `HTTP ${reply.status}`}）`); // @i18n-ignore log
      return fail(new MapLookupError(failure, message || status || `HTTP ${reply.status}`, status || undefined));
    },
  };
}
