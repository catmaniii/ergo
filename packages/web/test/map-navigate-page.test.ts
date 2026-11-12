// "用手机地图导航"（434）在真页面上：照 vite.config.ts 按生产环境构建一遍演示页，存成临时文件，用 file:// 在真 Chrome 里打开
// （不经守护进程，走原型的假数据），原型的秘书会话里三张地图卡：从公司到西湖边（高德查的路线）、周末想去的三处（秘书标的点）、
// 附近的 hawker centre（谷歌查的，新加坡）。按这一页开在哪看按钮怎么交出去：
// - 手机浏览器：路线卡上一个新窗口打开的高德导航网址（终点 GCJ-02、callnative=1）；hawker centre 的先弹菜单，四处都是谷歌的网址；
// - 安卓 App（原生桥没有 openNavigation，浏览器标识是安卓）：geo: 链接，不开新窗口；
// - 新版鸿蒙 App（原生桥有 openNavigation）：按钮，点了把 GCJ-02 的坐标、名字、走法交给 App；App 说没拉起来时退回高德的网址；
// - 旧版鸿蒙 App（没有 openNavigation）：照浏览器打开网址；
// - 地图页看着这张卡时标题栏上也有一个（小图标）。
// 不连外网：页面发出去的 http(s) 请求一律拦下（点了链接也不真去高德、谷歌）。纯逻辑在 test/plugins/map-navigate.test.ts。
// 本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findChrome } from "../build/chrome.ts";
import { demoMapDrawing } from "../src/prototype/fake-map.ts";
import { wgsToGcj } from "../src/state/index.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const HARMONY_UA = "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile";

let browser: Browser | undefined;
let pageUrl = "";
let tempDir = "";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-map-navigate-"));
  const file = path.join(tempDir, "index.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

/**
 * 假的原生桥（App 在页面加载前注入的 window.ergoNative）：navigation 是新版鸿蒙 App 的 openNavigation 回什么（不写是旧版 App、安卓 App，
 * 没有这个方法）；调过的记在 window.__navCalls。window.open 换成记下地址（不真开窗口）
 */
const APP_BRIDGE = (navigation: string | undefined) => `
  window.__navCalls = [];
  window.__opened = [];
  window.open = (url) => { window.__opened.push(String(url)); return null; };
  window.ergoNative = {
    appVersion: () => "0.4.4",
    log() {},
    editServer() {},
    setColorMode() {},
    setCanGoBack() {},
    ${navigation === undefined ? "" : `openNavigation: (...args) => { window.__navCalls.push(args); return Promise.resolve(${JSON.stringify(navigation)}); },`}
  };
`;

async function newPage(options: { userAgent?: string; bridge?: "old" | { navigation: string }; hash?: string }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1, ...(options.userAgent ? { userAgent: options.userAgent } : {}) });
  if (options.bridge) await context.addInitScript(APP_BRIDGE(options.bridge === "old" ? undefined : options.bridge.navigation));
  // 不连外网（演示页本来就不请求外部地址；点了导航网址也不真去）
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${pageUrl}${options.hash ?? "#/secretary"}`);
  return { context, page, errors };
}

/** 秘书会话里标题是它的那张地图卡（取到了） */
async function mapCard(page: Page, title: string) {
  const card = page.locator(".xcard-map[data-state=ready]").filter({ hasText: title }).first();
  await card.waitFor({ timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

/** 原型里那条路线（高德查的、从公司到西湖边）的终点：GCJ-02、小数点后 6 位 */
async function routeEnd() {
  const drawing = await demoMapDrawing("amap-r2");
  const end = drawing.marks.find((m) => m.id === "to") ?? drawing.marks.at(-1)!;
  const gcj = wgsToGcj(end);
  return { lat: gcj.lat.toFixed(6), lon: gcj.lon.toFixed(6), name: end.label ?? "" };
}

describe.skipIf(!CHROME)("用手机地图导航：手机宽（390）", () => {
  test("手机浏览器：路线卡上一个新窗口打开的高德导航网址（终点 GCJ-02、callnative=1）；hawker centre 先弹菜单挑，四处都是谷歌的网址", async () => {
    const { context, page, errors } = await newPage({ userAgent: ANDROID_UA });
    const end = await routeEnd();
    const route = await mapCard(page, "从公司到西湖边");
    const link = route.locator("a.map-nav-btn[data-handoff=web]");
    expect(await link.innerText()).toContain("用手机地图导航");
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await link.getAttribute("href")).toBe(`https://uri.amap.com/navigation?to=${end.lon},${end.lat},${encodeURIComponent(end.name)}&mode=car&src=ergo&callnative=1`);

    const hawker = await mapCard(page, "附近的 hawker centre");
    const button = hawker.locator("button.map-nav-btn");
    expect(await button.getAttribute("aria-haspopup")).toBe("menu");
    await button.click();
    const items = page.locator(".map-nav-menu .map-nav-item");
    await items.first().waitFor();
    expect(await items.count()).toBe(4);
    expect(await items.first().innerText()).toContain("Maxwell Food Centre");
    for (const href of await items.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))) expect(href).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=1\.\d{6},103\.\d{6}&travelmode=driving$/);
    // 点外面收起
    await page.mouse.click(5, 5);
    await expect.poll(() => page.locator(".map-nav-menu").count()).toBe(0);
    await context.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("安卓 App：geo: 链接（大陆里 GCJ-02），不开新窗口；旧版鸿蒙 App（没有 openNavigation）：照浏览器打开高德的网址", async () => {
    const end = await routeEnd();
    const android = await newPage({ userAgent: ANDROID_UA, bridge: "old" });
    const link = (await mapCard(android.page, "从公司到西湖边")).locator("a.map-nav-btn[data-handoff=system]");
    expect(await link.getAttribute("href")).toBe(`geo:${end.lat},${end.lon}?q=${end.lat},${end.lon}(${encodeURIComponent(end.name)})`);
    expect(await link.getAttribute("target")).toBeNull();
    await android.context.close();
    expect(android.errors).toEqual([]);

    const oldHarmony = await newPage({ userAgent: HARMONY_UA, bridge: "old" });
    const web = (await mapCard(oldHarmony.page, "从公司到西湖边")).locator("a.map-nav-btn[data-handoff=web]");
    expect(await web.getAttribute("href")).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?/);
    await oldHarmony.context.close();
    expect(oldHarmony.errors).toEqual([]);
  }, 60_000);

  test("新版鸿蒙 App：一个按钮，点了把 GCJ-02 的坐标、名字、走法交给 App（不开网址）；App 说没拉起来时退回高德的网址", async () => {
    const end = await routeEnd();
    const ok = await newPage({ userAgent: HARMONY_UA, bridge: { navigation: "ok" } });
    const button = (await mapCard(ok.page, "从公司到西湖边")).locator("button.map-nav-btn[data-handoff=panel]");
    await button.click();
    await expect.poll(() => ok.page.evaluate("window.__navCalls.length")).toBe(1);
    expect(await ok.page.evaluate("window.__navCalls[0]")).toEqual([Number(end.lat), Number(end.lon), end.name, "driving"]);
    expect(await ok.page.evaluate("window.__opened")).toEqual([]);
    // 几处的：菜单里挑一处，交的是那一处
    const points = await mapCard(ok.page, "周末想去的三处");
    await points.locator("button.map-nav-btn").click();
    await ok.page.locator(".map-nav-menu button.map-nav-item").nth(1).click();
    await expect.poll(() => ok.page.evaluate("window.__navCalls.length")).toBe(2);
    // 原型里那三处是灵隐寺、龙井村、九溪烟树
    expect(((await ok.page.evaluate("window.__navCalls[1]")) as unknown[])[2]).toBe("龙井村");
    await ok.context.close();
    expect(ok.errors).toEqual([]);

    const failed = await newPage({ userAgent: HARMONY_UA, bridge: { navigation: "failed:16000050" } });
    await (await mapCard(failed.page, "从公司到西湖边")).locator("button.map-nav-btn[data-handoff=panel]").click();
    await expect.poll(() => failed.page.evaluate("window.__opened.length")).toBe(1);
    expect(((await failed.page.evaluate("window.__opened")) as string[])[0]).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?to=/);
    await failed.context.close();
    expect(failed.errors).toEqual([]);
  }, 60_000);

  test("地图页看着这张卡：标题栏上一个导航的小图标（字在 aria-label 里），交的和卡片上一样", async () => {
    const { context, page, errors } = await newPage({ userAgent: ANDROID_UA, hash: "#/more/map/card/c-map-route" });
    const icon = page.locator(".map-card-bar a.map-nav-btn.icon-btn");
    await icon.waitFor({ timeout: 15_000 });
    expect(await icon.getAttribute("aria-label")).toBe("用手机地图导航");
    expect(await icon.getAttribute("href")).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?/);
    await context.close();
    expect(errors).toEqual([]);
  }, 60_000);
});
