// 地图页的隔离框（453，ADR-0059）：网页构建产物里的 map-frame.html（packages/web/public/ 原样拷进来），网关按 /map-frame.html 给。
// 地图页把别家地图的脚本（谷歌）关在这一页里跑：页面用 <iframe sandbox="allow-scripts"> 打开它，这里的回应头再写一遍
// sandbox allow-scripts（直接打开这个地址也是不透明来源：没有 cookie、本地存储，碰不到二狗的页面）、只许二狗自己的页面嵌它
// （frame-ancestors 'self'，和 X-Frame-Options: SAMEORIGIN 一致）。两个端口都给，外网端口和别的地址一样要设备凭证
// （gateway.ts 的门在前面；框是页面打开的，打开它的请求带着同源的凭证）。框里的页面不再向二狗要任何东西。
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { MAP_FRAME_PATH, t } from "@ergo/protocol";

export { MAP_FRAME_PATH };

/** 隔离框的回应头 */
export const MAP_FRAME_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache",
} as const;

/** 回 /map-frame.html（已经确认是 GET 或 HEAD、已经被信任）；网页还没构建、没有这个文件回 404 */
export function serveMapFrame(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string): void {
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(webRoot, MAP_FRAME_PATH.slice(1)));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    return void res.end(`${t("gateway.noSuchPath")}\n`);
  }
  res.writeHead(200, { ...MAP_FRAME_HEADERS, "Content-Length": String(body.length) });
  res.end(req.method === "HEAD" ? undefined : body);
}
