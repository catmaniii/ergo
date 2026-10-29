// 主切面里"像浏览器一样"的 HTTP 请求：对测试守护进程的某个端口发一个请求，拿回状态码、响应头、正文（文本）和 Set-Cookie。
// 用 node:http 直接发，Host、Origin、Cookie、X-Real-IP 这些头想怎么写就怎么写（测"写成本机地址也不享受本机信任"）。
// 上传、下载、翻历史用 http.ts（09）。
import http from "node:http";

export interface SetCookie {
  name: string;
  value: string;
  /** 小写的属性名 → 值（没有值的属性，比如 HttpOnly，值是 ""） */
  attributes: Record<string, string>;
}

export interface BrowserHttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  setCookies: SetCookie[];
  json<T = unknown>(): T;
}

export interface BrowserHttpOptions {
  method?: string;
  headers?: Record<string, string | undefined>;
  /** 对象按 JSON 发 */
  body?: unknown;
}

export function httpRequest(base: string, pathname: string, options: BrowserHttpOptions = {}): Promise<BrowserHttpResult> {
  const url = new URL(pathname, base);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) if (v !== undefined) headers[k] = v;
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: options.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          setCookies: (res.headers["set-cookie"] ?? []).map(parseSetCookie),
          json: <T>() => JSON.parse(body) as T,
        });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export function parseSetCookie(header: string): SetCookie {
  const [pair = "", ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attributes: Record<string, string> = {};
  for (const a of attrs) {
    const i = a.indexOf("=");
    if (i < 0) attributes[a.toLowerCase()] = "";
    else attributes[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}
