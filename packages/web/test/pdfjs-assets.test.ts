// 报告页预览 PDF 用的 pdf.js 拷进构建产物的哪些文件（build/pdfjs-plugin.ts 的 planPdfjs）：
// - 版本和 package.json 里写死的一样、和页面里写的（state/pdf-view.ts 的 PDFJS_VERSION）一样；
// - 主脚本、worker 是 legacy 构建（手机 App 的 WebView、鸿蒙 ArkWeb 跟不上 modern 构建用的新 JS）；cmaps、standard_fonts 齐；
//   两个图片解码器只拷纯 JS 版，不拷 .wasm；不拷脚本沙箱（PDF 里的脚本不跑）、官方阅读器、source map；许可证都在、都是 .txt；
// - 拷进去的脚本里没有 eval、new Function（pdf.js 6 去掉了 isEvalSupported 这个选项；升级后又有了，这里会红，要回头看安全设置）；
// - 页面本身（index.html）里不带 pdf.js：只在打开 PDF 时才加载。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { describe, expect, test, vi } from "vitest";
import { planPdfjs } from "../build/pdfjs-plugin.ts";
import { PDFJS_DIR, PDFJS_VERSION } from "../src/state/index.ts";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const plan = planPdfjs();
const rels = [...plan.keys()].map((rel) => rel.slice(PDFJS_DIR.length));

describe("拷进构建产物的 pdf.js", () => {
  test("版本：package.json 写死的、页面里写的、目录名一样", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["pdfjs-dist"]).toBe(PDFJS_VERSION);
    expect(PDFJS_DIR).toBe(`pdfjs/${PDFJS_VERSION}/`);
    expect([...plan.keys()].every((rel) => rel.startsWith(PDFJS_DIR))).toBe(true);
  });

  test("主脚本、worker 用 legacy 构建；cmaps（中文的 UniGB-UCS2-H 在内）、standard_fonts 齐", () => {
    expect(plan.get(`${PDFJS_DIR}pdf.min.mjs`)).toMatch(/[\\/]legacy[\\/]build[\\/]pdf\.min\.mjs$/);
    expect(plan.get(`${PDFJS_DIR}pdf.worker.min.mjs`)).toMatch(/[\\/]legacy[\\/]build[\\/]pdf\.worker\.min\.mjs$/);
    expect(rels).toContain("cmaps/UniGB-UCS2-H.bcmap");
    expect(rels).toContain("cmaps/Adobe-GB1-UCS2.bcmap");
    expect(rels.filter((r) => r.startsWith("cmaps/") && r.endsWith(".bcmap")).length).toBeGreaterThan(150);
    for (const font of ["FoxitDingbats.pfb", "FoxitSymbol.pfb", "LiberationSans-Regular.ttf"]) expect(rels).toContain(`standard_fonts/${font}`);
  });

  test("不用 WebAssembly：两个图片解码器只拷纯 JS 版；不拷脚本沙箱、官方阅读器、source map、没压缩的", () => {
    expect(rels.filter((r) => r.startsWith("wasm/") && !r.endsWith(".txt")).toSorted()).toEqual(["wasm/jbig2_nowasm_fallback.js", "wasm/openjpeg_nowasm_fallback.js"]);
    expect(rels.filter((r) => /\.wasm$|sandbox|viewer|\.map$|^pdf\.mjs$|renderer|iccs\//.test(r))).toEqual([]);
  });

  test("许可证都在，都改成了 .txt（网关只发认识的几种文件）；只有这几种文件", () => {
    for (const license of ["LICENSE.txt", "cmaps/LICENSE.txt", "standard_fonts/LICENSE_FOXIT.txt", "standard_fonts/LICENSE_LIBERATION.txt", "wasm/LICENSE_JBIG2.txt", "wasm/LICENSE_PDFJS_JBIG2.txt", "wasm/LICENSE_OPENJPEG.txt", "wasm/LICENSE_PDFJS_OPENJPEG.txt"]) {
      expect(rels).toContain(license);
    }
    expect(new Set(rels.map((r) => path.extname(r)))).toEqual(new Set([".mjs", ".js", ".bcmap", ".pfb", ".ttf", ".txt"]));
    expect(fs.readFileSync(plan.get(`${PDFJS_DIR}LICENSE.txt`)!, "utf8")).toContain("Apache License");
  });

  test("拷进去的脚本里没有 eval、new Function（PDF 里的东西不会被当成代码跑）", () => {
    const bad: string[] = [];
    for (const [rel, source] of plan) {
      if (!/\.m?js$/.test(rel)) continue;
      const code = fs.readFileSync(source, "utf8");
      if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});

describe("页面本身不带 pdf.js", () => {
  test("安装版的 index.html 里没有 pdf.js 的代码，只有按需加载的地址", async () => {
    // 和 npm run build:web 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）；不写盘
    vi.stubEnv("NODE_ENV", "production");
    let html: string;
    try {
      const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", build: { write: false } });
      const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
      const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
      if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
      html = String(page.source);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(html).toContain("pdf.min.mjs");
    expect(html).toContain("pdf.worker.min.mjs");
    // pdf.js 自己的代码（worker 的消息处理、字体转换）不在页面里
    expect(html).not.toContain("PDFWorker");
    expect(html).not.toContain("FontLoader");
    expect(html.length).toBeLessThan(4_000_000);
  }, 120_000);
});
