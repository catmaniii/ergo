// 报告页预览 PDF 用的 pdf.js：构建时把 pdfjs-dist 里要用的文件拷进构建产物的 pdfjs/<版本>/（演示页 dist-demo/ 也拷），
// 由守护进程按 /pdfjs/ 同源提供（packages/daemon/src/gateway/pdfjs.ts）；页面只在打开 PDF 时才去取（src/app/pdfjs.ts 动态
// import），不打进单文件的 index.html，平时打开二狗不多下。拷这些：
// - legacy 构建的 pdf.min.mjs 和 pdf.worker.min.mjs：modern 构建用了很新的 JS（Map 的 getOrInsertComputed、Uint8Array 的
//   toHex……），手机 App 的 WebView、鸿蒙 ArkWeb 的内核跟不上；legacy 构建带了补丁、语法到 Chrome 94 左右，和网页的目标一致；
// - cmaps/：中文这类没嵌字体的 PDF 认字要的 CMap；
// - standard_fonts/：没嵌的 Symbol、ZapfDingbats 用的字体（别的标准字体借用系统字体）；
// - wasm/ 里两个图片解码器的纯 JS 版（jbig2_nowasm_fallback.js 管 JBIG2 和 CCITT 传真压缩，openjpeg_nowasm_fallback.js 管
//   JPEG 2000），不拷 .wasm：页面不用 WebAssembly（打开时 useWasm: false）；
// - 许可证：pdf.js 自己的（Apache-2.0）、字体和两个解码器的，一律改成 .txt（网关只发认识的几种文件）。
// 不拷：没压缩的 pdf.mjs、脚本沙箱 pdf.sandbox（PDF 里的脚本不跑）、渲染 worker、iccs/、.wasm、source map、web/（官方阅读器）。
// 构建时核对装着的 pdfjs-dist 和页面里写的版本（src/state/pdf-view.ts 的 PDFJS_VERSION）一样，升级时两处一起改。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { PDFJS_DIR, PDFJS_VERSION } from "../src/state/pdf-view.ts";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 装着的 pdfjs-dist 在哪 */
function pdfjsPackage(): { dir: string; version: string } {
  const pkgJson = createRequire(path.join(WEB_ROOT, "package.json")).resolve("pdfjs-dist/package.json");
  const version = (JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { version: string }).version;
  return { dir: path.dirname(pkgJson), version };
}

/** 许可证文件改名成 .txt：LICENSE → LICENSE.txt，LICENSE_FOXIT → LICENSE_FOXIT.txt */
const asText = (name: string) => (path.extname(name) === "" ? `${name}.txt` : name);

/** 要放进构建产物的文件：产物里的相对路径（pdfjs/<版本>/…，用 /）→ 源文件 */
export function planPdfjs(): ReadonlyMap<string, string> {
  const { dir, version } = pdfjsPackage();
  if (version !== PDFJS_VERSION) throw new Error(`装着的 pdfjs-dist 是 ${version}，页面里写的是 ${PDFJS_VERSION}（src/state/pdf-view.ts 的 PDFJS_VERSION）：两处要一起改`);
  const plan = new Map<string, string>();
  const add = (rel: string, source: string) => {
    if (!fs.existsSync(source)) throw new Error(`pdfjs-dist 里没有 ${path.relative(dir, source)}：升级后文件挪了地方，改 build/pdfjs-plugin.ts`);
    plan.set(`${PDFJS_DIR}${rel}`, source);
  };
  add("LICENSE.txt", path.join(dir, "LICENSE"));
  add("pdf.min.mjs", path.join(dir, "legacy", "build", "pdf.min.mjs"));
  add("pdf.worker.min.mjs", path.join(dir, "legacy", "build", "pdf.worker.min.mjs"));
  for (const sub of ["cmaps", "standard_fonts"]) {
    for (const name of fs.readdirSync(path.join(dir, sub)).toSorted()) add(`${sub}/${asText(name)}`, path.join(dir, sub, name));
  }
  for (const name of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js", "LICENSE_JBIG2", "LICENSE_PDFJS_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_OPENJPEG"]) {
    add(`wasm/${asText(name)}`, path.join(dir, "wasm", name));
  }
  return plan;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export function pdfjsPlugin(): Plugin {
  let plan: ReadonlyMap<string, string> | undefined;
  const files = () => (plan ??= planPdfjs());
  return {
    name: "ergo:pdfjs",
    // 只在真的写盘时拷（test/build.test.ts 不写盘，就不碰这些文件）
    writeBundle(options) {
      const outDir = options.dir ?? path.join(WEB_ROOT, "dist");
      for (const [rel, source] of files()) {
        const dest = path.join(outDir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
      }
    },
    // 开发服务器：/pdfjs/ 直接从 node_modules 里的 pdfjs-dist 取
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const rel = `pdfjs/${decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""))}`;
        const source = files().get(rel);
        const type = CONTENT_TYPES[path.extname(rel)];
        if (!source || !type) return next();
        res.setHeader("Content-Type", type);
        res.end(fs.readFileSync(source));
      });
    },
  };
}
