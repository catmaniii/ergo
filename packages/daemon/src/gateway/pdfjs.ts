// 报告页预览 PDF 用的 pdf.js：Web UI 构建时把 pdfjs-dist 里要用的文件拷进构建产物的 pdfjs/<版本>/
// （packages/web/build/pdfjs-plugin.ts：主脚本、worker、cmaps、standard_fonts、两个图片解码器的纯 JS 版、许可证）。
// 网关按 /pdfjs/ 原样提供这些文件，页面只在打开 PDF 时才去取（动态 import），平时打开二狗不多下。两个端口都给，
// 外网端口和别的地址一样要设备凭证（gateway.ts 的门在前面）。
// - 只给 pdfjs/ 目录里认识的几种文件：脚本（.mjs、.js）、cmap（.bcmap）、字体（.pfb、.ttf）、许可证（.txt）；跑出目录、别的类型一律 404；
// - 地址带着 pdf.js 的版本，同一个地址内容不变：让浏览器长期缓存（private：经隧道来的也不让中间的代理存）；
// - 脚本带一份 CSP：只对 worker 起作用（worker 的安全策略看它自己脚本的响应头），只许连二狗自己、不许 eval、不许编译
//   WebAssembly——PDF 交给 pdf.js 解析时出了什么岔子，worker 里也跑不了别的代码。页面本身的响应头不动。
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { t } from "@ergo/protocol";

/** pdf.js 的文件在网关上的地址前缀，也是构建产物里的目录名 */
export const PDFJS_PREFIX = "/pdfjs/";

/** worker 的安全策略：同源的脚本、同源的 fetch（cmap、字体），别的一概不许（没有 'unsafe-eval'、'wasm-unsafe-eval'） */
export const PDFJS_SCRIPT_CSP = "default-src 'self'";

const SCRIPT = "text/javascript; charset=utf-8";
const TYPES: Readonly<Record<string, string>> = {
  ".mjs": SCRIPT,
  ".js": SCRIPT,
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** 回一个 /pdfjs/ 下的请求（已经确认是 GET 或 HEAD、已经被信任） */
export function servePdfjs(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string, pathname: string): void {
  const file = pdfjsFile(webRoot, pathname);
  const type = file === undefined ? undefined : TYPES[path.extname(file).toLowerCase()];
  let stat: fs.Stats | undefined;
  try {
    stat = file === undefined ? undefined : fs.statSync(file);
  } catch {
    stat = undefined;
  }
  if (!file || !type || !stat?.isFile()) return notFound(res);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(stat.size),
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(type === SCRIPT ? { "Content-Security-Policy": PDFJS_SCRIPT_CSP } : {}),
  });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** 地址对应的文件；解不开、跑出 pdfjs/ 目录的给 undefined */
function pdfjsFile(webRoot: string, pathname: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(PDFJS_PREFIX.length));
  } catch {
    return undefined;
  }
  if (rel === "" || rel.includes("\0")) return undefined;
  const dir = path.resolve(webRoot, "pdfjs");
  const file = path.resolve(dir, rel);
  return file.startsWith(dir + path.sep) ? file : undefined;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(`${t("gateway.noSuchPath")}\n`);
}
