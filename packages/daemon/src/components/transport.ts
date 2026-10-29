// 下载器发请求的那一层（323 号票）：GET 一个地址，可以带 Range（断点续传），跟着重定向走（Hugging Face 会转到 CDN），
// 按 proxyFor 走代理——https 的经 CONNECT 打一条隧道再握 TLS，http 的把完整地址交给代理。用 Node 自带的 http / https / tls，
// 不加依赖（全局 fetch 不认系统代理）。超时只管"连上、拿到响应头"这一段；下载中途卡住由下载器按多久没收到字节判断。
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { ProxyFor } from "./proxy.ts";

export interface TransportResponse {
  status: number;
  /** 响应头（名字小写） */
  headers: http.IncomingHttpHeaders;
  /** 响应体：一块一块的字节 */
  body: AsyncIterable<Buffer>;
  /** 最后实际请求的地址（跟过重定向的） */
  url: string;
  /** 不要了：断开连接（给了错误的，正在读响应体的那边收到这个错误） */
  destroy(error?: Error): void;
}

export interface TransportRequest {
  /** 从第几个字节起要（断点续传）；不给是整个 */
  rangeStart?: number;
  /** 要到第几个字节（含）；只和 rangeStart 一起用（探速取一小段） */
  rangeEnd?: number;
  signal: AbortSignal;
}

export type Transport = (url: string, request: TransportRequest) => Promise<TransportResponse>;

export interface HttpTransportOptions {
  proxyFor?: ProxyFor;
  /** 连上、拿到响应头最多等多久（毫秒）；不给是 30 秒 */
  headersTimeoutMs?: number;
  /** 最多跟几次重定向；不给是 8 次 */
  maxRedirects?: number;
  /** 请求头里的 User-Agent */
  userAgent?: string;
  /** 测试用：http 的地址也经 CONNECT 隧道走代理（https 的本来就是），好在本机测隧道那条路 */
  tunnelHttp?: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** 经代理的 CONNECT 打一条到 host:port 的隧道 */
function connectTunnel(proxy: URL, host: string, port: number, signal: AbortSignal, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const auth = proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {};
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...auth },
      signal,
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 ${proxy.host} 不让连 ${host}:${port}（HTTP ${res.statusCode}）`)); // @i18n-ignore log：下载出错的原因，由上层换成给人看的
        return;
      }
      resolve(socket);
    });
    req.once("timeout", () => req.destroy(new Error(`连代理 ${proxy.host} 超时`))); // @i18n-ignore log：同上
    req.once("error", reject);
    req.end();
  });
}

/** Node 自带的 http / https 实现的 Transport */
export function createHttpTransport(options: HttpTransportOptions = {}): Transport {
  const timeoutMs = options.headersTimeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 8;
  const once = async (target: URL, request: TransportRequest): Promise<http.IncomingMessage> => {
    const headers: http.OutgoingHttpHeaders = { "user-agent": options.userAgent ?? "ergo-components", accept: "*/*", "accept-encoding": "identity" };
    if (request.rangeStart !== undefined) headers.range = `bytes=${request.rangeStart}-${request.rangeEnd ?? ""}`;
    const proxy = options.proxyFor?.(target);
    const secure = target.protocol === "https:";
    const port = Number(target.port || (secure ? 443 : 80));
    let requestOptions: https.RequestOptions;
    if (proxy && (secure || options.tunnelHttp)) {
      const socket = await connectTunnel(proxy, target.hostname, port, request.signal, timeoutMs);
      const conn = secure ? tls.connect({ socket, servername: target.hostname }) : socket;
      // 不给 agent 才会用 createConnection（给 agent: false 时 Node 另建一个 Agent、不理它）
      requestOptions = { host: target.hostname, port, path: `${target.pathname}${target.search}`, headers, createConnection: () => conn as never };
    } else if (proxy) {
      // http 的经代理：完整地址交给代理
      requestOptions = { host: proxy.hostname, port: Number(proxy.port || 80), path: target.href, headers: { ...headers, host: target.host }, agent: false };
    } else {
      requestOptions = { host: target.hostname, port, path: `${target.pathname}${target.search}`, headers, agent: false };
    }
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request({ ...requestOptions, method: "GET", signal: request.signal, timeout: timeoutMs });
      req.once("response", (res) => {
        req.setTimeout(0);
        resolve(res);
      });
      req.once("timeout", () => req.destroy(new Error(`${target.host} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`))); // @i18n-ignore log：下载出错的原因
      req.once("error", reject);
      req.end();
    });
  };
  return async (url, request) => {
    let target = new URL(url);
    for (let hop = 0; ; hop++) {
      const res = await once(target, request);
      const location = res.headers.location;
      if (REDIRECTS.has(res.statusCode ?? 0) && location && hop < maxRedirects) {
        res.resume();
        res.destroy();
        target = new URL(location, target);
        continue;
      }
      return {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        url: target.href,
        destroy: (error?: Error) => res.destroy(error),
      };
    }
  };
}
