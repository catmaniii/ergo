// 地图（429）在网关上的两处：都是地图插件的服务现取（插件没启用时回"地图插件没启用"），两个端口都给，
// 外网端口和别的地址一样要设备凭证（gateway.ts 的门在前面；<img>、高德脚本发的请求带着同源的 cookie）。
// 455 起地图插件不认识哪一家，转给经插槽登记了的那一家（那一家的插件没启用时回 404"没接上"）：
// - /tiles/<编号>/<z>/<x>/<y>：瓦片转发（GET、HEAD，OpenStreetMap 插件登记的）。浏览器那边断了（划走了）就告诉服务，还在排队的不去取；
// - /_AMapService/…：一家自己的转发口（GET、HEAD，高德插件登记的 JS API 安全密钥代理），原样转回。网关认的前缀只有协议包里的
//   这一个（高德定的地址，插件没启用时也要回"没启用"，所以写在这里）。不加 nosniff：高德的 JSONP 回应的类型
//   不一定是脚本类型，加了浏览器会拒绝执行（同源，ORB 不管）。查询串里有 Key、拼上的安全密钥，这里一律不记。
import type http from "node:http";
import { AMAP_SERVICE_PREFIX, MAP_TILE_PREFIX, parseMapTilePath, t } from "@ergo/protocol";
import type { MapReply, MapService } from "../map/api.ts";

export { AMAP_SERVICE_PREFIX, MAP_TILE_PREFIX };

/** 这个地址归不归地图：瓦片或者一家的转发口 */
export function isMapPath(pathname: string): boolean {
  return pathname.startsWith(MAP_TILE_PREFIX) || pathname === AMAP_SERVICE_PREFIX || pathname.startsWith(`${AMAP_SERVICE_PREFIX}/`);
}

/** 回一个地图的请求（已经确认是 GET 或 HEAD、已经被信任）；map 是现取的地图服务，插件没启用是 undefined */
export function serveMap(req: http.IncomingMessage, res: http.ServerResponse, url: URL, map: MapService | undefined, log: (line: string) => void): void {
  if (!map) return text(res, 404, t("plugins.notEnabled", { title: t("map.plugin.title") }));
  const gone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) gone.abort();
  });
  const pathname = url.pathname;
  let pending: Promise<MapReply>;
  if (pathname.startsWith(MAP_TILE_PREFIX)) {
    const address = parseMapTilePath(pathname);
    if (!address) return text(res, 404, t("gateway.noSuchPath"));
    pending = map.tile(address, gone.signal);
  } else {
    const ua = req.headers["user-agent"];
    pending = map.proxy(pathname, url.search, gone.signal, typeof ua === "string" ? ua : undefined);
  }
  pending.then(
    (reply) => {
      if (res.writableEnded || res.destroyed) return;
      const tile = pathname.startsWith(MAP_TILE_PREFIX);
      res.writeHead(reply.status, {
        ...reply.headers,
        "Content-Length": String(reply.body.length),
        ...(tile ? { "X-Content-Type-Options": "nosniff" } : {}),
        "Referrer-Policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : reply.body);
    },
    (err: unknown) => {
      // 浏览器断了、插件停了：不回应
      if (gone.signal.aborted || res.writableEnded || res.destroyed) return;
      log(`地图转发出错：${err instanceof Error ? err.name : "未知错误"}`);
      text(res, 503, t("map.proxy.failed"));
    },
  );
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(`${body}\n`);
}
