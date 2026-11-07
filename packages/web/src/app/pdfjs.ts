// 报告页预览 PDF 用的 pdf.js（pdfjs-dist，Apache-2.0）：只在打开 PDF 时才加载——动态 import 构建产物里 pdfjs/<版本>/ 下的
// 文件（build/pdfjs-plugin.ts 拷进去，守护进程按 /pdfjs/ 同源发，外网端口要设备凭证），不打进页面，平时打开二狗不多下。
// worker 用同一个目录里的 pdf.worker.min.mjs（同源的 module worker）。
//
// 打开 PDF 时的设置（安全和体积）：
// - PDF 的字节由报告页从媒体接口取来（data），pdf.js 自己不发请求取 PDF；它只按下面的地址取同源的几样：cmaps、标准字体、
//   两个图片解码器的纯 JS 版；
// - 不加载 pdf.js 的脚本沙箱（pdf.sandbox），PDF 里的 JavaScript 不执行；报告页不画表单层、链接层（AnnotationLayer），
//   表单、链接只按外观画在页上，点了没反应（链接不跳）；enableXfa: false，XFA 表单不画；
// - pdf.js 6 自己已经没有 eval 了：PostScript 函数不再拼成 JS 代码执行，getDocument 也没有 isEvalSupported 这个选项了
//   （test/pdfjs-assets.test.ts 查拷进产物的脚本里没有 eval、new Function）；worker 的响应头另带 CSP，不许 eval；
// - useWasm: false，不用 WebAssembly：JBIG2、CCITT（黑白扫描件常见）、JPEG 2000 的图改用 pdf.js 自带的纯 JS 解码器
//   （wasmUrl 指向的目录里只放这两个 *_nowasm_fallback.js），慢一些、画得一样；ICC 色彩配置不做转换，按 PDF 里写的备用
//   色彩空间画（颜色可能略有偏差）。
import type * as PdfJs from "pdfjs-dist";
import { PDFJS_DIR } from "../state/index.ts";

export type PdfJsLib = typeof PdfJs;
export type PdfDocument = PdfJs.PDFDocumentProxy;
export type PdfPage = PdfJs.PDFPageProxy;
export type PdfLoadingTask = PdfJs.PDFDocumentLoadingTask;

/** pdf.js 的文件在哪：绝对地址（worker 里的相对地址按 worker 自己的地址解析，给绝对的才对） */
function assetBase(): string {
  return new URL(PDFJS_DIR, document.baseURI).href;
}

let loading: Promise<PdfJsLib> | undefined;

/** 加载 pdf.js（只加载一次；没加载上的下次再试） */
export function loadPdfJs(): Promise<PdfJsLib> {
  if (!loading) {
    const base = assetBase();
    const script = `${base}pdf.min.mjs`;
    loading = (import(/* @vite-ignore */ script) as Promise<PdfJsLib>).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
      return lib;
    });
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

/** 打开一份 PDF（字节交给 pdf.js 的 worker，这块 ArrayBuffer 之后就不能再用了） */
export function openPdf(lib: PdfJsLib, data: ArrayBuffer): PdfLoadingTask {
  const base = assetBase();
  return lib.getDocument({
    data: new Uint8Array(data),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    useWasm: false,
    enableXfa: false,
    disableWorkerRendering: true,
    verbosity: lib.VerbosityLevel.ERRORS,
  });
}
