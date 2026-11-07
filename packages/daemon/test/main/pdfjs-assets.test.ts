// 主切面：报告页预览 PDF 用的 pdf.js。Web UI 构建时把 pdfjs-dist 里要用的文件拷进构建产物的 pdfjs/<版本>/（主脚本、worker、
// cmaps、standard_fonts、两个图片解码器的纯 JS 版、许可证），网关按 /pdfjs/ 提供，页面打开 PDF 时才去取：
// - 本机端口直接给；外网端口和别的接口一样要设备凭证；
// - 地址带版本、内容不变，让浏览器长期缓存；脚本带 CSP（default-src 'self'：只对 worker 起作用，不许 eval、WebAssembly）；
// - 只给 pdfjs/ 目录里认识的几种文件（脚本、cmap、字体、许可证），跑出目录、别的类型（.wasm、.html）一律 404；
// - 页面本身的响应头不变（没有因为 pdf.js 加 CSP、改 X-Frame-Options）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFJS_SCRIPT_CSP } from "../../src/gateway/pdfjs.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const DIR = "pdfjs/9.9.9";
const MAIN = "export const version = '9.9.9';\n";
const WORKER = "self.onmessage = () => {};\n";
const BCMAP = "\u0000\u0001cmap";
const PFB = "\u0080\u0001font";
const TTF = "\u0000\u0001\u0000\u0000ttf";

/** 构建产物的样子：页面本身，加上 pdfjs/<版本>/ 里的脚本、cmap、字体、许可证；还有几个不该被取到的 */
function webRootWithPdfjs(): string {
  const dir = makeTempDir("ergo-web-");
  const at = (rel: string, content: string) => {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "latin1");
  };
  at("index.html", TEST_PAGE);
  at("secret.txt", "不该被取到");
  at(`${DIR}/pdf.min.mjs`, MAIN);
  at(`${DIR}/pdf.worker.min.mjs`, WORKER);
  at(`${DIR}/cmaps/UniGB-UCS2-H.bcmap`, BCMAP);
  at(`${DIR}/standard_fonts/FoxitDingbats.pfb`, PFB);
  at(`${DIR}/standard_fonts/LiberationSans-Regular.ttf`, TTF);
  at(`${DIR}/wasm/jbig2_nowasm_fallback.js`, "export default function () {}\n");
  at(`${DIR}/LICENSE.txt`, "Apache License\n");
  at(`${DIR}/wasm/openjpeg.wasm`, "\u0000asm");
  at(`${DIR}/viewer.html`, "<script>alert(1)</script>");
  return dir;
}

describe("本机端口提供 pdf.js", () => {
  it("脚本、cmap、字体、许可证：类型对，长期缓存，nosniff；脚本带 CSP（只许同源，不许 eval、WebAssembly）", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithPdfjs() });
    for (const [rel, type, body] of [
      ["pdf.min.mjs", "text/javascript; charset=utf-8", MAIN],
      ["pdf.worker.min.mjs", "text/javascript; charset=utf-8", WORKER],
      ["wasm/jbig2_nowasm_fallback.js", "text/javascript; charset=utf-8", undefined],
      ["cmaps/UniGB-UCS2-H.bcmap", "application/octet-stream", undefined],
      ["standard_fonts/FoxitDingbats.pfb", "application/octet-stream", undefined],
      ["standard_fonts/LiberationSans-Regular.ttf", "font/ttf", undefined],
      ["LICENSE.txt", "text/plain; charset=utf-8", "Apache License\n"],
    ] as const) {
      const res = await httpRequest(url, `/${DIR}/${rel}`);
      expect({ rel, status: res.status, type: res.headers["content-type"] }).toEqual({ rel, status: 200, type });
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe(type.startsWith("text/javascript") ? PDFJS_SCRIPT_CSP : undefined);
      expect(body === undefined || res.body === body).toBe(true);
    }
    expect(PDFJS_SCRIPT_CSP).toBe("default-src 'self'");
    const head = await httpRequest(url, `/${DIR}/pdf.min.mjs`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("没有的、不认识的类型（.wasm、.html）、跑出 pdfjs/ 目录的：一律 404；不是 GET 的 405", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithPdfjs() });
    for (const pathname of [
      `/${DIR}/nope.mjs`,
      `/${DIR}/wasm/openjpeg.wasm`,
      `/${DIR}/viewer.html`,
      "/pdfjs/",
      `/${DIR}`,
      "/pdfjs/..%2Fsecret.txt",
      "/pdfjs/..%5Csecret.txt",
      "/pdfjs/%2e%2e%2Fsecret.txt",
      `/${DIR}/..%2F..%2Fsecret.txt`,
      "/pdfjs/%E0%A4%A.mjs",
      `/${DIR}/LICENSE.txt%00.mjs`,
    ]) {
      const res = await httpRequest(url, pathname);
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 404 });
      expect(res.body).not.toContain("不该被取到");
      expect(res.body).not.toContain("alert(1)");
    }
    expect((await httpRequest(url, `/${DIR}/pdf.min.mjs`, { method: "POST", body: {} })).status).toBe(405);
  });

  it("页面本身的响应头不变：没有 CSP，照旧不许嵌框", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithPdfjs() });
    const page = await httpRequest(url, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });

  it("构建产物里没有 pdfjs/（还没构建）：404，页面照常", async () => {
    const { url } = await startTestDaemon();
    expect((await httpRequest(url, `/${DIR}/pdf.min.mjs`)).status).toBe(404);
    expect((await httpRequest(url, "/")).status).toBe(200);
  });
});

describe("外网端口上的 pdf.js 和页面一样要设备凭证", () => {
  it("没配对：401；配对过的设备：照常取到", async () => {
    const { url, externalUrl } = await startTestDaemon({ webRoot: webRootWithPdfjs() });
    for (const pathname of [`/${DIR}/pdf.min.mjs`, `/${DIR}/pdf.worker.min.mjs`, `/${DIR}/cmaps/UniGB-UCS2-H.bcmap`]) {
      const res = await httpRequest(externalUrl, pathname);
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 401 });
      expect(res.body).not.toContain("version");
    }

    const pc = await TestFrontend.connect(url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(externalUrl, pc, { name: "我的手机" });
    const script = await phone.request(`/${DIR}/pdf.min.mjs`);
    expect(script.status).toBe(200);
    expect(script.body).toBe(MAIN);
    expect(script.headers["content-security-policy"]).toBe(PDFJS_SCRIPT_CSP);
  });
});
