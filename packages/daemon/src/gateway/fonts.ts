// 视觉风格的字体（39 号票）：Web UI 构建时把风格要用的字体拷进构建产物的 fonts/（packages/web/build/visual-styles-plugin.ts）：
// 每套有字体的风格一份样式表 <风格 id>.css，woff2 放在带包版本号的目录（<包>@<版本>/）里，旁边是许可证。
// 网关按 /fonts/ 原样提供这些文件（字体不内联进单文件的页面；运行时不请求外部 CDN）。两个端口都给，
// 外网端口和别的地址一样要设备凭证（gateway.ts 的门在前面）。
// - 只给 fonts/ 目录里的三种文件：.css、.woff2、.txt（许可证）；跑出目录、别的类型一律 404；
// - woff2 的地址带版本号，同一个地址内容不变：让浏览器长期缓存（private：经隧道来的也不让中间的代理存）；
// - 样式表、许可证每次都问一下有没有变（ETag，没变回 304）。
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { t } from "@ergo/protocol";

/** 字体在网关上的地址前缀，也是构建产物里的目录名 */
export const FONTS_PREFIX = "/fonts/";

const TYPES: Readonly<Record<string, { type: string; cache: string }>> = {
  ".css": { type: "text/css; charset=utf-8", cache: "no-cache" },
  ".woff2": { type: "font/woff2", cache: "private, max-age=31536000, immutable" },
  ".txt": { type: "text/plain; charset=utf-8", cache: "no-cache" },
};

/** 回一个 /fonts/ 下的请求（已经确认是 GET 或 HEAD、已经被信任） */
export function serveFont(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string, pathname: string): void {
  const file = fontFile(webRoot, pathname);
  const kind = file === undefined ? undefined : TYPES[path.extname(file)];
  let stat: fs.Stats | undefined;
  try {
    stat = file === undefined ? undefined : fs.statSync(file);
  } catch {
    stat = undefined;
  }
  if (!file || !kind || !stat?.isFile()) return notFound(res);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": kind.type,
    "Cache-Control": kind.cache,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return void res.end();
  }
  res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** 地址对应的文件；解不开、跑出 fonts/ 目录的给 undefined */
function fontFile(webRoot: string, pathname: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(FONTS_PREFIX.length));
  } catch {
    return undefined;
  }
  if (rel === "" || rel.includes("\0")) return undefined;
  const dir = path.resolve(webRoot, "fonts");
  const file = path.resolve(dir, rel);
  return file.startsWith(dir + path.sep) ? file : undefined;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(`${t("gateway.noSuchPath")}\n`);
}
