// 转发本机服务的页面（132 号票）：网关把 /apps/<应用名>/… 交到这里，按转发登记表（registry.ts）转给本机的服务。
// 鉴权在网关里、和二狗自己的页面一样（本机端口照旧；外网端口要配对过的设备凭证），服务自己不用做登录。
// - 只转发登记过的：没登记的、应用名写得不对的回 404 说明页；只写到应用名的（/apps/x）跳到带斜杠的首页（相对地址才解析得对）；
// - 普通请求、流式响应（边收边转，响应头先发出去）、WebSocket 升级（转成原始的 socket 管道）都转；
// - 请求：Host 换成服务自己的（127.0.0.1:<端口>，开发服务器常常只认它）；Origin、Referer 是二狗自己的源，换成服务的源
//   （服务眼里请求就是从它自己的页面发出的，它自己的同源检查、CSRF 检查照常过）；带上 X-Forwarded-Prefix / -Proto / -Host / -For
//   （客户端自己写的这几个和 X-Real-IP 先去掉）；二狗自己的 cookie（设备凭证、配对）不转给服务；
// - 响应：Location 里服务自己的地址（http://127.0.0.1:<端口>/…）和以 / 开头、不在前缀下的路径改写回前缀下；
//   去掉挡嵌入的头（X-Frame-Options、CSP 的 frame-ancestors），内置浏览器的 iframe 才显示得出来；
//   Set-Cookie 的 Path 改到前缀下、去掉 Domain（几个服务的 cookie 互不覆盖），二狗自己的 cookie 名不许服务写；
// - 服务没在跑、连不上：回一页简短的说明（"服务「X」现在没在运行"），不是裸的 502。
// - 正文一律原样转，不改；以后要改（136 号票给 HTML 注入二狗的页面桥）的位置在 serve 里收到响应那一段，见那里的注释。
// 撤销登记、设备被吊销、网关关闭时，开着的 WebSocket 管道和还在流的响应一并断开。
// 同源转发的安全取舍（服务页面的脚本跑在二狗的源上）见 docs/developer-guide.md"转发本机服务的页面"：现在先这样，以后改成独立的源。
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { activeLanguage, APP_PREFIX_HEADER, appUrl, oldNameOf, parseAppPath, t } from "@ergo/protocol";
import { isLoopbackHost, type AppRegistry, type RegisteredApp } from "./registry.ts";

/** 网关交来的：这个请求从哪来 */
export interface AppRequestContext {
  /** 浏览器连二狗用的协议：本机端口 http；外网端口按 nginx 写的 X-Forwarded-Proto（终止 TLS 的是它） */
  proto: "http" | "https";
  /** 来源地址（给服务的 X-Forwarded-For） */
  source: string;
  /** 外网端口上的已配对设备：吊销时断开它开着的 WebSocket */
  deviceId?: string;
}

export interface AppProxy {
  /** 这个路径归转发管吗（/apps 和 /apps/ 下面的一律归它，没登记的由它回 404） */
  handles(pathname: string): boolean;
  /** 转发一个 HTTP 请求（已经被信任） */
  serve(req: http.IncomingMessage, res: http.ServerResponse, ctx: AppRequestContext): void;
  /** 转发一次 WebSocket 升级（已经被信任） */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ctx: AppRequestContext): void;
  /** 断开一台设备开着的 WebSocket 管道（它被吊销了） */
  dropDevice(deviceId: string): void;
  /** 断开全部开着的管道和还在流的响应（网关关闭） */
  close(): void;
}

/** 逐跳的头：只管这一段连接，不往下转（Connection 里列出来的也是） */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
/** 客户端自己写的转发头：一律去掉，换成转发这一层写的（客户端写的不算数） */
const CLIENT_FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-prefix", "x-forwarded-port", "x-real-ip"];
/** 二狗自己的 cookie（设备凭证、配对）都以它开头：不转给服务，也不许服务写（312 号票：旧名字的前缀同样挡着） */
const OWN_COOKIE_PREFIXES = ["__Host-ergo-", oldNameOf("__Host-ergo-")];
const isOwnCookie = (name: string) => OWN_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix));

const hopByHop = (connection: string | string[] | undefined) =>
  new Set([
    ...HOP_BY_HOP,
    ...[connection ?? []]
      .flat()
      .flatMap((v) => v.split(","))
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  ]);

/** 路径在前缀下了就原样，不在就接到前缀后面（"/" → "/apps/x/"） */
function underPrefix(path: string, app: RegisteredApp): string {
  const base = app.basePath;
  if (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`)) return path;
  return `${base}${path}`;
}

/** 是不是服务自己的地址（本机、同一个端口） */
function isServiceUrl(url: URL, app: RegisteredApp): boolean {
  return (url.protocol === "http:" || url.protocol === "ws:") && isLoopbackHost(url.hostname) && Number(url.port || 80) === app.port;
}

/**
 * Location 改写回前缀下：服务自己的绝对地址去掉源、接到前缀下；以 / 开头的路径不在前缀下的接到前缀下（服务当自己在根上时
 * 跳的是自己的 /login）；相对地址（浏览器按当前地址解析，本来就在前缀下）和别的网站原样
 */
export function rewriteLocation(location: string, app: RegisteredApp): string {
  const value = location.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    let url: URL;
    try {
      url = new URL(value, `${app.origin}/`);
    } catch {
      return location;
    }
    return isServiceUrl(url, app) ? underPrefix(`${url.pathname}${url.search}${url.hash}`, app) : location;
  }
  return value.startsWith("/") ? underPrefix(value, app) : location;
}

/** 去掉 CSP 里的 frame-ancestors（几条策略用逗号分开，各自去掉）；去完什么都不剩的给 undefined（整个头不要了） */
export function withoutFrameAncestors(csp: string): string | undefined {
  const policies = csp
    .split(",")
    .map((policy) =>
      policy
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d !== "" && d.split(/\s+/)[0]!.toLowerCase() !== "frame-ancestors")
        .join("; "),
    )
    .filter((policy) => policy !== "");
  return policies.length === 0 ? undefined : policies.join(", ");
}

/** Set-Cookie 改写：Path 改到前缀下、去掉 Domain；二狗自己的 cookie 名不许服务写（给 undefined，整条不要） */
export function rewriteSetCookie(header: string, app: RegisteredApp): string | undefined {
  const [pair = "", ...attrs] = header.split(";");
  if (isOwnCookie(pair.split("=")[0]!.trim())) return undefined;
  const out = [pair.trim()];
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    const key = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    if (key === "domain" || key === "") continue;
    if (key === "path") {
      const path = eq < 0 ? "" : attr.slice(eq + 1).trim();
      out.push(`Path=${underPrefix(path.startsWith("/") ? path : "/", app)}`);
      continue;
    }
    out.push(attr.trim());
  }
  return out.join("; ");
}

/** 请求里的 Cookie 去掉二狗自己的；什么都不剩给 undefined */
export function withoutOwnCookies(cookie: string | undefined): string | undefined {
  if (cookie === undefined) return undefined;
  const kept = cookie
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "" && !isOwnCookie(c));
  return kept.length === 0 ? undefined : kept.join("; ");
}

/** Referer 是二狗上这个应用里的页面时换成服务自己的地址（前缀照转发的规矩去掉或留着）；别的去掉 */
function rewriteReferer(referer: string, app: RegisteredApp, ownOrigin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.origin !== ownOrigin) return undefined;
  const parsed = parseAppPath(`${url.pathname}${url.search}`);
  if (parsed?.name !== app.name) return undefined;
  const path = app.prefix === "keep" ? `${url.pathname}${url.search}` : parsed.rest.startsWith("/") ? parsed.rest : `/${parsed.rest}`;
  return `${app.origin}${path}`;
}

/** 转给服务的请求头 */
function forwardHeaders(req: http.IncomingMessage, app: RegisteredApp, ctx: AppRequestContext, upgrading: boolean): http.OutgoingHttpHeaders {
  const drop = hopByHop(req.headers.connection);
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || drop.has(name) || CLIENT_FORWARDED.includes(name)) continue;
    if (name === "host" || name === "cookie" || name === "origin" || name === "referer") continue;
    out[name] = value;
  }
  if (upgrading) {
    out.connection = "Upgrade";
    if (req.headers.upgrade !== undefined) out.upgrade = req.headers.upgrade;
  }
  out.host = app.hostHeader;
  const cookie = withoutOwnCookies(req.headers.cookie);
  if (cookie !== undefined) out.cookie = cookie;
  // 带了 Origin 的已经过了网关的来源校验，就是二狗自己的源：换成服务的源
  if (req.headers.origin !== undefined) out.origin = app.origin;
  const ownHost = req.headers.host ?? "";
  const referer = req.headers.referer === undefined ? undefined : rewriteReferer(req.headers.referer, app, `${ctx.proto}://${ownHost}`);
  if (referer !== undefined) out.referer = referer;
  out[APP_PREFIX_HEADER] = app.basePath;
  out["x-forwarded-proto"] = ctx.proto;
  out["x-forwarded-host"] = ownHost;
  out["x-forwarded-for"] = ctx.source;
  return out;
}

/** 服务的响应头（rawHeaders：名字、值交替）改写成转回浏览器的，同样是名字、值交替 */
function responseHeaders(raw: readonly string[], app: RegisteredApp, upgrading: boolean): string[] {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
  const connection = pairs.filter(([n]) => n.toLowerCase() === "connection").map(([, v]) => v);
  // 101 的 Connection、Upgrade 正是要转回去的
  const drop = upgrading ? new Set<string>() : hopByHop(connection);
  const out: string[] = [];
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (drop.has(lower) || lower === "x-frame-options") continue;
    let next: string | undefined = value;
    if (lower === "content-security-policy") next = withoutFrameAncestors(value);
    else if (lower === "location") next = rewriteLocation(value, app);
    else if (lower === "set-cookie") next = rewriteSetCookie(value, app);
    if (next !== undefined) out.push(name, next);
  }
  return out;
}

/** 写到原始 socket 上的状态行和响应头（WebSocket 升级用） */
function rawHead(status: number, message: string | undefined, headers: readonly string[]): string {
  const lines = [`HTTP/1.1 ${status} ${message ?? http.STATUS_CODES[status] ?? ""}`];
  for (let i = 0; i + 1 < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 简短的说明页（没登记、服务没在跑）：内置浏览器里显示的就是它，标题栏取它的 <title> */
export function infoPage(title: string, lines: readonly string[]): string {
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(activeLanguage())}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    "<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "font:15px/1.7 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;box-sizing:border-box}",
    "main{max-width:28em}h1{font-size:18px;margin:0 0 8px}p{margin:4px 0;opacity:.75}</style></head>",
    `<body><main><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</main></body></html>`,
  ].join("\n");
}

/** 说明页的响应头：只许二狗自己的页面嵌（内置浏览器的 iframe 里显示），不跑脚本、不缓存 */
const INFO_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
};

function sendInfo(res: http.ServerResponse, status: number, title: string, lines: readonly string[]): void {
  res.writeHead(status, INFO_HEADERS);
  res.end(res.req.method === "HEAD" ? undefined : infoPage(title, lines));
}

/** 没登记（或者应用名写得不对） */
function notRegistered(res: http.ServerResponse, name: string | undefined): void {
  sendInfo(res, 404, name === undefined ? t("apps.noApp") : t("apps.noAppNamed", { name }), [t("apps.noAppHint")]);
}

/** 服务没在跑、连不上 */
function serviceDown(res: http.ServerResponse, app: RegisteredApp): void {
  sendInfo(res, 502, t("apps.down", { title: app.title }), [t("apps.downHint", { port: app.port })]);
}

/** 转给服务时的路径：strip 去掉前缀（只写到应用名的当首页），keep 原样 */
const upstreamPath = (app: RegisteredApp, url: string, rest: string) => (app.prefix === "keep" ? url : rest.startsWith("/") ? rest : `/${rest}`);

/** 拒绝一次 WebSocket 升级 */
const refuse = (socket: Duplex, status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

export function createAppProxy(options: { registry: AppRegistry; log: (line: string) => void }): AppProxy {
  const { registry, log } = options;
  /** 开着的 WebSocket 管道（两头的 socket） */
  const tunnels = new Set<{ app: string; deviceId: string | undefined; sockets: Duplex[] }>();
  /** 还在转的 HTTP 请求（流式响应可能一直开着） */
  const inFlight = new Set<{ app: string; upstream: http.ClientRequest; res: http.ServerResponse }>();

  const dropTunnels = (match: (t: { app: string; deviceId: string | undefined }) => boolean) => {
    for (const tunnel of tunnels) {
      if (!match(tunnel)) continue;
      tunnels.delete(tunnel);
      for (const s of tunnel.sockets) s.destroy();
    }
  };
  // 撤销了登记：这个应用开着的管道断开、还在流的响应断开（之后的请求是 404）
  const offRemoved = registry.onRemoved((name) => {
    dropTunnels((tunnel) => tunnel.app === name);
    for (const flight of inFlight) if (flight.app === name) flight.res.destroy();
  });

  return {
    handles: (pathname) => pathname === "/apps" || pathname.startsWith("/apps/"),

    serve(req, res, ctx) {
      const url = req.url ?? "/";
      const parsed = parseAppPath(url);
      const app = parsed && registry.get(parsed.name);
      if (!parsed || !app) {
        req.resume();
        return notRegistered(res, parsed?.name);
      }
      // 只写到应用名的：跳到带斜杠的首页（页面里的相对地址按它解析才在前缀下）
      if (!parsed.rest.startsWith("/")) {
        req.resume();
        res.writeHead(308, { Location: `${appUrl(app.name)}${parsed.rest}`, "Cache-Control": "no-store" });
        return void res.end();
      }
      const upstream = http.request({ host: app.host, port: app.port, method: req.method, path: upstreamPath(app, url, parsed.rest), headers: forwardHeaders(req, app, ctx, false) });
      const flight = { app: app.name, upstream, res };
      inFlight.add(flight);
      const done = () => inFlight.delete(flight);
      upstream.on("response", (from) => {
        const headers = responseHeaders(from.rawHeaders, app, false);
        // 外网端口上网关先放了续期的设备凭证 cookie：并进去（writeHead 给的同名头会把先放的顶掉）
        const own = res.getHeader("set-cookie");
        if (own !== undefined) {
          res.removeHeader("set-cookie");
          for (const value of [own].flat()) headers.push("Set-Cookie", String(value));
        }
        // 对响应正文做改写的位置（本票不改正文，原样转）：136 号票要在这里给服务的 HTML 注入二狗的页面桥 <script>，
        // CSP 里只为它放行（响应头在上面 responseHeaders 里改，script-src 加它的 nonce 或哈希）。做法是按 Content-Type 选一个可选的改写步骤：
        // - 只改 text/html，而且不是流式的：text/event-stream、没有 Content-Length 又一直不结束的照旧边收边转，不攒；
        // - 压缩过的（Content-Encoding: gzip / br / deflate）：先解压再改，或者转给服务时对这类请求不带 Accept-Encoding；
        // - 改了正文就去掉 Content-Length（交给 Node 分块发）、ETag 跟着变（或去掉），HEAD、204、304 没有正文不改。
        // 不改的一律走下面的原样转。
        res.writeHead(from.statusCode ?? 502, from.statusMessage, headers);
        // 流式响应（SSE、分块下发的进度）：响应头先发出去，之后收到一段转一段
        res.flushHeaders();
        from.on("error", () => res.destroy());
        from.pipe(res);
        from.on("end", done);
      });
      upstream.on("error", (err) => {
        done();
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) return void res.destroy();
        log(`转发到应用 ${app.name}（${app.origin}）失败：${err.message}`);
        serviceDown(res, app);
      });
      // 浏览器那头走了（关了页面、停了流）：服务那头也断开
      res.on("close", () => {
        done();
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    },

    upgrade(req, socket, head, ctx) {
      const url = req.url ?? "/";
      const parsed = parseAppPath(url);
      const app = parsed && registry.get(parsed.name);
      if (!parsed || !app) return refuse(socket, "404 Not Found");
      const tunnel = { app: app.name, deviceId: ctx.deviceId, sockets: [socket] as Duplex[] };
      tunnels.add(tunnel);
      const drop = () => {
        if (!tunnels.delete(tunnel)) return;
        for (const s of tunnel.sockets) s.destroy();
      };
      socket.on("error", drop);
      socket.on("close", drop);
      const upstream = http.request({ host: app.host, port: app.port, method: req.method, path: upstreamPath(app, url, parsed.rest), headers: forwardHeaders(req, app, ctx, true) });
      upstream.on("upgrade", (from, upstreamSocket: Socket, upstreamHead: Buffer) => {
        tunnel.sockets.push(upstreamSocket);
        upstreamSocket.on("error", drop);
        upstreamSocket.on("close", drop);
        if (!tunnels.has(tunnel) || socket.destroyed) return drop();
        upstreamSocket.setNoDelay(true);
        socket.write(rawHead(from.statusCode ?? 101, from.statusMessage, responseHeaders(from.rawHeaders, app, true)));
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      // 服务没接受升级（回了普通响应）：原样转回去
      upstream.on("response", (from) => {
        tunnels.delete(tunnel);
        socket.write(rawHead(from.statusCode ?? 502, from.statusMessage, [...responseHeaders(from.rawHeaders, app, false), "Connection", "close"]));
        from.pipe(socket);
      });
      upstream.on("error", (err) => {
        tunnels.delete(tunnel);
        log(`转发 WebSocket 到应用 ${app.name}（${app.origin}）失败：${err.message}`);
        if (!socket.destroyed) refuse(socket, "502 Bad Gateway");
      });
      upstream.end();
    },

    dropDevice: (deviceId) => dropTunnels((tunnel) => tunnel.deviceId === deviceId),

    close() {
      offRemoved();
      dropTunnels(() => true);
      for (const flight of inFlight) {
        flight.upstream.destroy();
        flight.res.destroy();
      }
      inFlight.clear();
    },
  };
}
