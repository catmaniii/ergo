// 本机的假地图服务（只在测试里，429）：地图插件的瓦片转发、高德的安全密钥代理和测 Key 都发到这里
// （createMapPlugin 的 osmUpstream、amapHosts），从不连真的 tile.openstreetmap.org、restapi.amap.com，不用真 Key。
// - 假 OSM：GET /{z}/{x}/{y}.png 回一张 1×1 的 PNG；缓存头、ETag、状态码由测试拨（tileMode）；记下每个请求的地址和请求头；
//   slowMs 让每个请求等一会儿（测并发）；
// - 假高德：一个服务扮三个地址（/rest、/webapi、/vectormap 三个前缀，对应 restapi、webapi、fmap01），照高德 Web 服务的回法：
//   { status: "1", info: "OK", infocode: "10000" }，Key 不认 10001 INVALID_USER_KEY，安全密钥不对 10008 INVALID_USER_SCODE，
//   拿 Web 端的 Key 不带安全密钥调 Web 服务 10009 USERKEY_PLAT_NOMATCH。带 callback 的回 JSONP。记下每个请求（地址带查询串）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 一张 1×1 的 PNG */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** 测试用的高德 Key（明显是编的：32 位，和真的一样长） */
export const AMAP_TEST_JS_KEY = `jskey${"0".repeat(20)}7f3a9c2`;
export const AMAP_TEST_SECURITY_CODE = `sec${"1".repeat(22)}5b1d4a6`;
export const AMAP_TEST_SERVICE_KEY = `svc${"2".repeat(22)}8e0c3d1`;

export interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** 假 OSM 这一次怎么回 */
export interface TileMode {
  status: number;
  /** 回的头（Cache-Control、Expires、ETag……） */
  headers: Record<string, string>;
  /** 带着这个 ETag 来问（If-None-Match）的回 304 */
  etag?: string;
}

export async function startFakeOsm() {
  const requests: RecordedRequest[] = [];
  const state = { mode: { status: 200, headers: { "Cache-Control": "max-age=3600" } } as TileMode, slowMs: 0, inFlight: 0, maxInFlight: 0 };
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const answer = () => {
      state.inFlight--;
      const mode = state.mode;
      if (!/^\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      if (mode.etag !== undefined && req.headers["if-none-match"] === mode.etag) {
        res.writeHead(304, mode.headers).end();
        return;
      }
      if (mode.status !== 200) {
        res.writeHead(mode.status, { "Content-Type": "text/plain" }).end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(TINY_PNG.length), ...(mode.etag ? { ETag: mode.etag } : {}), ...mode.headers });
      res.end(TINY_PNG);
    };
    if (state.slowMs > 0) setTimeout(answer, state.slowMs);
    else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url, requests, state };
}

export async function startFakeAmap(options: { jsKey?: string; securityCode?: string; serviceKey?: string } = {}) {
  const requests: RecordedRequest[] = [];
  const keys = {
    jsKey: options.jsKey ?? AMAP_TEST_JS_KEY,
    securityCode: options.securityCode ?? AMAP_TEST_SECURITY_CODE,
    serviceKey: options.serviceKey ?? AMAP_TEST_SERVICE_KEY,
    /** 测试拨：高德那边"作废"了 Web 端的 Key（之后一律回 INVALID_USER_KEY） */
    jsRevoked: false,
  };
  const reply = (res: http.ServerResponse, q: URLSearchParams, body: Record<string, unknown>) => {
    const callback = q.get("callback");
    if (callback) {
      res.writeHead(200, { "Content-Type": "application/javascript;charset=UTF-8" });
      res.end(`${callback}(${JSON.stringify(body)})`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
    res.end(JSON.stringify(body));
  };
  const ok = { status: "1", info: "OK", infocode: "10000" };
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams;
    const key = q.get("key");
    if (url.pathname.startsWith("/webapi/v4/map/styles")) return reply(res, q, { ...ok, data: { style: "dark" } });
    if (url.pathname.startsWith("/vectormap/v3/vectormap")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return void res.end(Buffer.from([1, 2, 3]));
    }
    if (!url.pathname.startsWith("/rest/")) return void res.writeHead(404).end();
    const isJs = key === keys.jsKey && !keys.jsRevoked;
    if (key === keys.jsKey && keys.jsRevoked) return reply(res, q, { status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
    if (isJs) {
      // Web 端的 Key：要带对的安全密钥
      if (q.get("jscode") === null) return reply(res, q, { status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" });
      if (q.get("jscode") !== keys.securityCode) return reply(res, q, { status: "0", info: "INVALID_USER_SCODE", infocode: "10008" });
      return reply(res, q, { ...ok, regeocode: { formatted_address: "北京市东城区" } });
    }
    if (key === keys.serviceKey) {
      if (q.get("platform") === "JS") return reply(res, q, { status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" });
      return reply(res, q, { ...ok, regeocode: { formatted_address: "北京市东城区" } });
    }
    return reply(res, q, { status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { hosts: { rest: `${base}/rest`, webapi: `${base}/webapi`, vectormap: `${base}/vectormap` }, requests, keys };
}
