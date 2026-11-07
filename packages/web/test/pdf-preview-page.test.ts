// PDF 附件在报告页预览（ui/pdf-view.tsx）：在真 Chrome 里打开。照 vite.config.ts 按生产环境构建一遍演示页（不写盘），
// 连同要拷进产物的 pdf.js 文件（build/pdfjs-plugin.ts 的 planPdfjs）由一个只在 127.0.0.1 上、系统挑端口的静态服务器发出
// （pdf.js 是动态 import 的模块和 module worker，file:// 下浏览器不让加载）；脚本带和守护进程一样的 CSP（default-src 'self'）。
// 走原型的假数据：三份 PDF 是现场生成的（prototype/fake-pdf.ts）——三页的周会纪要（中文用不嵌的 STSong-Light，要 cmaps；
// 勾用 ZapfDingbats，要 standard_fonts；标题前的小方块是 CCITT 压缩的图，要纯 JS 的解码器）、加了密码的合同、传了一半的扫描件。
// - 手机宽（390×844，触屏）：报告页画出第一页（画布上有字、有主色的小方块），文字层有字，写明 3 页；没请求 .wasm；
//   两指捏合放大，停下来按新倍数重画（画布更大、补画看得到的那一块），中点下面那一处不动；坏的、加密的 PDF 各有提示和下载；
//   聊天里的 PDF 卡片写 PDF、点"预览"进报告页；
// - 电脑宽（1280×800，鼠标）：Ctrl + 滚轮放大、普通滚轮照常滚动不缩放；双击放大到 2.5 倍、再双击还原；拖选能选中文字。
// 算术本身在 test/state/pdf-view.test.ts。本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findChrome } from "../build/chrome.ts";
import { planPdfjs } from "../build/pdfjs-plugin.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MEETING = "sha256:fake-meeting-pdf";
const LOCKED = "sha256:fake-locked-pdf";
const BROKEN = "sha256:fake-broken-pdf";

const TYPES: Readonly<Record<string, string>> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

let browser: Browser | undefined;
let server: http.Server | undefined;
let base = "";

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:demo 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）
  vi.stubEnv("NODE_ENV", "production");
  let html: string;
  try {
    const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", mode: "demo", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
    if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
    html = String(page.source);
  } finally {
    vi.unstubAllEnvs();
  }
  const files = planPdfjs();
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname).replace(/^\//, "");
    if (rel === "" || rel === "index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(html);
    }
    const source = files.get(rel);
    const type = TYPES[path.extname(rel)];
    if (!source || !type) {
      res.writeHead(404);
      return void res.end();
    }
    res.writeHead(200, { "Content-Type": type, ...(type.startsWith("text/javascript") ? { "Content-Security-Policy": "default-src 'self'" } : {}) });
    res.end(fs.readFileSync(source));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
}, 60_000);

const reportOf = (mediaId: string) => `${base}#/report/${encodeURIComponent(mediaId)}`;

async function newPage(viewport: { width: number; height: number }, touch: boolean, url: string): Promise<{ context: BrowserContext; page: Page; errors: string[]; requests: string[] }> {
  const context = await browser!.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  await page.goto(url);
  return { context, page, errors, requests };
}

/** 等第 n 页的整页图画好（换上了 canvas） */
const waitPage = (page: Page, n: number) => page.waitForSelector(`.pdf-page[data-page="${n}"] .pdf-page-base canvas`, { timeout: 30_000 });

/** 测试的类型里没有 DOM，在页面里跑的写成字符串 */
const evaluate = <T,>(page: Page, code: string): Promise<T> => page.evaluate(code) as Promise<T>;

/** 第一页整页那张图：像素大小，和画布上不是白色的像素占多少、主色（青绿）的像素有没有 */
const firstPageInk = (page: Page) =>
  evaluate<{ width: number; height: number; ink: number; teal: number }>(
    page,
    `(() => {
      const c = document.querySelector('.pdf-page[data-page="1"] .pdf-page-base canvas');
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let ink = 0, teal = 0;
      for (let i = 0; i < d.length; i += 16) {
        if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
        if (d[i] < 80 && d[i + 1] > 110 && d[i + 2] > 110 && d[i + 1] - d[i] > 60) teal++;
      }
      return { width: c.width, height: c.height, ink: ink / (d.length / 16), teal };
    })()`,
  );

/** 文档现在排多宽（定下来的倍数）、手势途中的 transform、滚到哪 */
const docState = (page: Page) =>
  evaluate<{ width: number; transform: string; left: number; top: number }>(
    page,
    `(() => {
      const d = document.querySelector(".pdf-doc");
      const v = document.querySelector(".pdf-view");
      return { width: parseFloat(d.style.width), transform: d.style.transform, left: v.scrollLeft, top: v.scrollTop };
    })()`,
  );

describe.skipIf(!CHROME)("PDF 报告页：手机宽（390，触屏）", () => {
  test("画出第一页：画布上有字、有 CCITT 解出来的小方块（纯 JS 解码器），文字层有中文，写明 3 页；没请求 .wasm，只按需取了 pdf.js 的几样", async () => {
    const { context, page, errors, requests } = await newPage({ width: 390, height: 844 }, true, reportOf(MEETING));
    await waitPage(page, 1);
    await expect.poll(() => firstPageInk(page).then((p) => p.teal), { timeout: 10_000 }).toBeGreaterThan(20);
    const ink = await firstPageInk(page);
    // 清晰度按屏幕（2 倍屏）
    expect(ink.width).toBeGreaterThan(600);
    expect(ink.ink).toBeGreaterThan(0.005);
    await expect.poll(() => evaluate<string>(page, `document.querySelector('.pdf-page[data-page="1"] .textLayer').textContent`)).toContain("周会纪要");
    expect(await page.locator(".report-pdf-facts").textContent()).toMatch(/^PDF · 3 页 · /);
    // 取了中文要的 cmap、勾要的标准字体、CCITT 的纯 JS 解码器；没有 .wasm
    const pdfjs = requests.filter((r) => r.startsWith("/pdfjs/"));
    expect(pdfjs).toEqual(expect.arrayContaining([expect.stringMatching(/pdf\.min\.mjs$/), expect.stringMatching(/pdf\.worker\.min\.mjs$/), expect.stringMatching(/cmaps\/UniGB-UCS2-H\.bcmap$/), expect.stringMatching(/standard_fonts\/FoxitDingbats\.pfb$/), expect.stringMatching(/wasm\/jbig2_nowasm_fallback\.js$/)]));
    expect(requests.filter((r) => r.endsWith(".wasm"))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  test("两指捏合放大：途中只写 transform，停下来按新倍数重排、重画（画布更大，补画看得到的那一块），两指中点下面那一处不动", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true, reportOf(MEETING));
    await waitPage(page, 1);
    const before = await firstPageInk(page);
    const start = await docState(page);
    const cdp = await context.newCDPSession(page);
    const at = { x: 200, y: 300 };
    const under = await evaluate<{ x: number; y: number }>(page, `(() => { const r = document.querySelector(".pdf-doc").getBoundingClientRect(); return { x: ${at.x} - r.left, y: ${at.y} - r.top }; })()`);
    const points = (d: number) => [
      { x: at.x - d, y: at.y, id: 0 },
      { x: at.x + d, y: at.y, id: 1 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(30) });
    for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(30 + (60 * i) / 6) });
    // 途中：只写了 transform（3 倍），还没重排
    const during = await docState(page);
    expect(during.width).toBe(start.width);
    expect(Number(/scale\(([\d.]+)\)/.exec(during.transform)?.[1])).toBeCloseTo(3, 6);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect.poll(() => docState(page).then((s) => s.transform === "" && Math.abs(s.width - start.width * 3) < 0.5), { timeout: 5_000 }).toBe(true);
    // 中点下面那一处还在中点下面（差一两个像素算到）
    const after = await evaluate<{ x: number; y: number }>(page, `(() => { const r = document.querySelector(".pdf-doc").getBoundingClientRect(); return { x: ${at.x} - r.left, y: ${at.y} - r.top }; })()`);
    expect(Math.abs(after.x - under.x * 3)).toBeLessThan(2);
    expect(Math.abs(after.y - under.y * 3)).toBeLessThan(2);
    // 停下来重画：整页那张更大（到上限为止），看得到的那一块另外按屏幕清晰度补画
    await expect.poll(() => firstPageInk(page).then((p) => p.width), { timeout: 10_000 }).toBeGreaterThan(before.width);
    await expect.poll(() => page.locator('.pdf-page[data-page="1"] .pdf-page-detail canvas').count(), { timeout: 10_000 }).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  test("坏的 PDF：说文件坏了、给下载；加了密码的：说要密码、给下载；都不白屏", async () => {
    for (const [mediaId, problem, words] of [
      [BROKEN, "broken", "坏了"],
      [LOCKED, "encrypted", "密码"],
    ] as const) {
      const { context, page, errors } = await newPage({ width: 390, height: 844 }, true, reportOf(mediaId));
      const notice = page.locator(".report-pdf-problem");
      await notice.waitFor({ timeout: 30_000 });
      expect(await notice.getAttribute("data-problem")).toBe(problem);
      expect(await notice.textContent()).toContain(words);
      expect(await notice.locator("a[download]").count()).toBe(1);
      expect(await page.locator(".pdf-page").count()).toBe(0);
      expect(errors).toEqual([]);
      await context.close();
    }
  }, 90_000);

  test("聊天里的 PDF 卡片：写 PDF、有预览，点了进报告页画出来", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true, base);
    const card = page.locator(".att-card", { hasText: "周会纪要-第41周.pdf" });
    await card.waitFor({ timeout: 30_000 });
    expect(await card.locator(".att-type").textContent()).toBe("PDF");
    expect(await card.locator(".att-only").count()).toBe(0);
    await card.scrollIntoViewIfNeeded();
    await card.locator(".att-btn", { hasText: "预览" }).tap();
    await waitPage(page, 1);
    expect(page.url()).toContain(`#/report/${encodeURIComponent(MEETING)}`);
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);
});

describe.skipIf(!CHROME)("PDF 报告页：电脑宽（1280，鼠标）", () => {
  test("Ctrl + 滚轮以鼠标位置为中心放大缩小；不按 Ctrl 的滚轮照常滚动、不缩放", async () => {
    const { context, page, errors } = await newPage({ width: 1280, height: 800 }, false, reportOf(MEETING));
    await waitPage(page, 1);
    const start = await docState(page);
    await page.mouse.move(640, 400);
    // 鼠标滚轮四格（2 倍屏上一格是 50 像素，一格约 1.1 倍）
    await page.keyboard.down("Control");
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await expect.poll(() => docState(page).then((s) => s.transform === "" && s.width > start.width * 1.3), { timeout: 5_000 }).toBe(true);
    const zoomed = await docState(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => docState(page).then((s) => s.top), { timeout: 5_000 }).toBeGreaterThan(zoomed.top + 100);
    expect((await docState(page)).width).toBe(zoomed.width);
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  test("双击放大到 2.5 倍（不选中词），再双击还原；拖选能选中页上的字", async () => {
    const { context, page, errors } = await newPage({ width: 1280, height: 800 }, false, reportOf(MEETING));
    await waitPage(page, 1);
    const start = await docState(page);
    await page.mouse.dblclick(640, 300);
    await expect.poll(() => docState(page).then((s) => s.transform === "" && Math.abs(s.width - start.width * 2.5) < 0.5), { timeout: 5_000 }).toBe(true);
    expect(await evaluate<string>(page, "String(getSelection())")).toBe("");
    await page.mouse.dblclick(640, 300);
    await expect.poll(() => docState(page).then((s) => s.transform === "" && Math.abs(s.width - start.width) < 0.5), { timeout: 5_000 }).toBe(true);

    // 从标题第一个字的左边拖到这一行的右边：选中的是标题
    await expect.poll(() => evaluate<string>(page, `document.querySelector('.pdf-page[data-page="1"] .textLayer').textContent`)).toContain("周会纪要");
    const span = await evaluate<{ x: number; y: number; right: number }>(
      page,
      `(() => {
        const s = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((e) => e.textContent.includes("周会纪要"));
        const r = s.getBoundingClientRect();
        return { x: r.left + 2, y: r.top + r.height / 2, right: r.right + 120 };
      })()`,
    );
    await page.mouse.move(span.x, span.y);
    await page.mouse.down();
    await page.mouse.move(span.right, span.y, { steps: 8 });
    await page.mouse.up();
    expect(await evaluate<string>(page, "String(getSelection())")).toContain("周会纪要");
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);
});
