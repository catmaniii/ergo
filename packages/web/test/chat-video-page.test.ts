// 聊天里的视频在真页面上（ui/conversation/parts.tsx 的 VideoView、ui/video-viewer.tsx、外壳 ui/media-viewer.tsx）。
// 照 vite.config.ts 按生产环境构建一遍演示页，存成临时文件，用 file:// 在真 Chrome 里打开（不经守护进程，走原型的假数据），
// 秘书会话里用户发的两段视频（prototype/fake-media.ts）：投影仪的测试画面（3 秒 H.264，能放）、老摄像机录的（MPEG-4 Part 2，浏览器解不了）：
// - 第一帧滚到附近才取：打开时离得远，还没有取第一帧的播放器；滚过去才取，取到了显示画面和时长；
// - 放不了的退回卡片：写"网页里放不了，下载看"，没有"预览"，点图标是下载；
// - 点开大播放器：自动放、有声音，按比例放到最大；点画面不关，点深色底、×、Esc、App 的返回手势都能关；关掉时停下、放掉；
// - 全屏：浏览器里给全屏按钮，Fullscreen API 真能把视频放进全屏；旧版 App（原生桥没有 videoFullscreen）藏掉全屏按钮，新版 App 照给。
// 纯逻辑（哪些显示成视频、时长怎么写、给不给全屏按钮）在 test/state/chat-video.test.ts、test/app/native-app.test.ts。
// 本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findChrome } from "../build/chrome.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * 滚到离看得见的地方这么近才取第一帧（像素）：和 ui/near-screen.ts 的 NEAR_MARGIN 一样。这里不 import 它——
 * 那个文件带着 React 和 DOM 的类型，测试的类型里没有 DOM
 */
const NEAR_MARGIN = 600;
/** 发视频的那条消息里的话（原型的秘书会话） */
const ASK = "新投影仪投出来的测试画面";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-chat-video-"));
  const file = path.join(tempDir, "index.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 假的原生桥（App 在页面加载前注入的 window.ergoNative）：旧版 App 没有 videoFullscreen，新版有 */
const APP_BRIDGE = (fullscreen: boolean) => `
  window.ergoNative = {
    appVersion: () => ${fullscreen ? '"0.4.4"' : '"0.4.3"'},
    log() {},
    editServer() {},
    setColorMode() {},
    setCanGoBack() {},
    ${fullscreen ? "videoFullscreen: () => true," : ""}
  };
`;

async function newPage(viewport: { width: number; height: number }, touch: boolean, app?: "old" | "new"): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport, hasTouch: touch, deviceScaleFactor: 1 });
  if (app) await context.addInitScript(APP_BRIDGE(app === "new"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pageUrl);
  await page.getByText(ASK).first().waitFor({ timeout: 15_000 });
  return { context, page, errors };
}

const viewerCount = (page: Page) => page.locator(".video-viewer").count();
/** 投影仪那段（聊天里第一个能放的视频）的气泡 */
const thumb = (page: Page) => page.locator(".part-video .video-thumb").first();

/** 滚到发视频的那条消息，等第一帧取到 */
async function scrollToVideos(page: Page) {
  await page.getByText(ASK).first().scrollIntoViewIfNeeded();
  await page.waitForFunction(`(() => { const v = document.querySelector(".part-video .video-thumb video"); return v !== null && v.readyState >= 2 && v.videoWidth > 0; })()`, undefined, { timeout: 15_000 });
}

/** 打开大播放器，等它放起来；在页面上记下这个播放器（window.__opened），关掉后看它放没放掉 */
async function openPlayer(page: Page, touch: boolean) {
  await (touch ? thumb(page).tap() : thumb(page).click());
  await page.locator(".video-viewer video").waitFor();
  await page.waitForFunction(`(() => { const v = document.querySelector(".video-viewer video"); return v !== null && !v.paused && v.currentTime > 0; })()`, undefined, { timeout: 10_000 });
  await page.evaluate(`window.__opened = document.querySelector(".video-viewer video")`);
}

const playerRect = (page: Page): Promise<Rect> =>
  page.locator(".video-viewer video").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

/**
 * 关掉之后：播放器停了、地址拿掉了、手里没有数据（readyState 0），也不在取（networkState 是 NETWORK_EMPTY 或 NETWORK_NO_SOURCE，
 * 不是 IDLE、LOADING）
 */
async function expectReleased(page: Page) {
  await expect.poll(() => viewerCount(page), { timeout: 3000 }).toBe(0);
  const v = (await page.evaluate(`(() => { const v = window.__opened; return { paused: v.paused, src: v.getAttribute("src"), ready: v.readyState, network: v.networkState }; })()`)) as { paused: boolean; src: string | null; ready: number; network: number };
  expect({ paused: v.paused, src: v.src, ready: v.ready }).toEqual({ paused: true, src: null, ready: 0 });
  expect([0, 3]).toContain(v.network);
}

describe.skipIf(!CHROME)("聊天里的视频：手机宽（390，触屏）", () => {
  test("滚到附近才取第一帧；取到了显示画面和时长；放不了的退回卡片，写网页里放不了、只给下载", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true);
    // 打开时停在会话最后，两段视频离看得见的地方远着：一个取第一帧的播放器都没有
    const far = await page.evaluate(`(() => {
      const el = document.querySelector(".part-video");
      let s = el.parentElement;
      while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
      const box = s.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return Math.max(box.top - r.bottom, r.top - box.bottom);
    })()`);
    expect(far).toBeGreaterThan(NEAR_MARGIN + 100);
    expect(await page.locator(".part-video").count()).toBe(2);
    expect(await page.locator(".part-video video").count()).toBe(0);

    await scrollToVideos(page);
    // 第一帧：256×144 的测试画面按原大画（不超过图片的上限 320），停在 0.1 秒；角上写 0:03
    const shown = await page.evaluate(`(() => {
      const v = document.querySelector(".part-video .video-thumb video");
      return { w: v.videoWidth, h: v.videoHeight, at: v.currentTime, width: Math.round(v.getBoundingClientRect().width), paused: v.paused, muted: v.muted };
    })()`);
    expect(shown).toEqual({ w: 256, h: 144, at: 0.1, width: 256, paused: true, muted: true });
    expect(await page.locator(".part-video .video-duration").first().textContent()).toBe("0:03");

    // 老摄像机那段浏览器解不了：退回卡片，标题下面写"网页里放不了，下载看"；没有"预览"，图标写仅下载、点了下载
    const fallback = page.locator(".att-card", { hasText: "老摄像机-生日会.mov" });
    await expect.poll(() => fallback.locator(".att-note").textContent(), { timeout: 10_000 }).toBe("网页里放不了，下载看");
    expect(await page.locator(".part-video").count()).toBe(1);
    expect(await fallback.locator(".att-btn").allTextContents()).toEqual(["下载"]);
    expect(await fallback.locator(".att-only").textContent()).toBe("仅下载");
    expect(await fallback.locator("a.att-icon").getAttribute("download")).toBe("老摄像机-生日会.mov");
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  test("点开大播放器：自动放、有声音，按比例放到最大，给全屏按钮；点画面不关，点深色底关，关掉时停下、放掉", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true);
    await scrollToVideos(page);
    await openPlayer(page, true);
    expect(await page.evaluate(`document.querySelector(".video-viewer video").muted`)).toBe(false);
    // 浏览器里：控件上的全屏按钮照给
    expect(await page.locator(".video-viewer video").getAttribute("controlslist")).toBeNull();
    // 16:9 的画面按宽铺满（左右各留 12）
    const r = await playerRect(page);
    expect(Math.round(r.width)).toBe(390 - 24);
    expect(Math.abs(r.height - (r.width * 144) / 256)).toBeLessThan(1);
    // 下面一行：文件名和下载
    expect(await page.locator(".media-viewer-name").textContent()).toBe("投影仪测试画面.mp4");
    expect(await page.locator(".media-viewer-bar a").textContent()).toBe("下载");

    // 点画面：交给播放器，不关
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await page.waitForTimeout(400);
    expect(await viewerCount(page)).toBe(1);

    // 点画面上面的深色底：关，播放器停下、放掉
    await page.touchscreen.tap(195, r.y - 80);
    await expectReleased(page);
    // 点气泡、点播放器都不会顺带打开这条消息的详情（用户气泡点整条看详情）
    expect(await page.locator(".dp-page.at-detail").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  test("旧版 App（原生桥没有 videoFullscreen）：藏掉全屏按钮；App 的返回手势关播放器。新版 App：照给全屏按钮", async () => {
    const old = await newPage({ width: 390, height: 844 }, true, "old");
    await scrollToVideos(old.page);
    await openPlayer(old.page, true);
    // 不进全屏（controlsList），Chromium 置灰的按钮再用样式拿掉（.no-fullscreen）
    expect(await old.page.locator(".video-viewer video").getAttribute("controlslist")).toBe("nofullscreen");
    expect(await old.page.locator(".video-viewer video").getAttribute("class")).toBe("no-fullscreen");
    // App 按返回键调网页登记的 window.__ergoBack：退一级，就是关掉播放器
    expect(await old.page.evaluate(`window.__ergoBack()`)).toBe(true);
    await expectReleased(old.page);
    expect(old.errors).toEqual([]);
    await old.context.close();

    const fresh = await newPage({ width: 390, height: 844 }, true, "new");
    await scrollToVideos(fresh.page);
    await openPlayer(fresh.page, true);
    expect(await fresh.page.locator(".video-viewer video").getAttribute("controlslist")).toBeNull();
    expect(await fresh.page.locator(".video-viewer video").getAttribute("class")).toBeNull();
    expect(fresh.errors).toEqual([]);
    await fresh.context.close();
  }, 90_000);
});

describe.skipIf(!CHROME)("聊天里的视频：电脑宽（1280，鼠标）", () => {
  test("按比例放到最大（高放满）；浏览器的全屏是真全屏；Esc、×、点深色底都能关", async () => {
    const { context, page, errors } = await newPage({ width: 1280, height: 800 }, false);
    await scrollToVideos(page);
    await openPlayer(page, false);
    // 框是 1256×680（上留 64、下留 56）：16:9 的画面按高放满
    const r = await playerRect(page);
    expect(Math.round(r.height)).toBe(800 - 64 - 56);
    expect(Math.abs(r.width - (r.height * 256) / 144)).toBeLessThan(1);

    // 浏览器自带的全屏（控件上的全屏按钮走的就是它）：视频真的进了全屏；退出来播放器还开着
    const cdp = await context.newCDPSession(page);
    await cdp.send("Runtime.evaluate", { expression: `document.querySelector(".video-viewer video").requestFullscreen()`, userGesture: true, awaitPromise: true });
    expect(await page.evaluate(`document.fullscreenElement === document.querySelector(".video-viewer video")`)).toBe(true);
    await page.evaluate(`document.exitFullscreen()`);
    await expect.poll(() => page.evaluate(`document.fullscreenElement === null`), { timeout: 3000 }).toBe(true);
    expect(await viewerCount(page)).toBe(1);

    // Esc：关
    await page.keyboard.press("Escape");
    await expectReleased(page);

    // ×：关
    await openPlayer(page, false);
    await page.locator(".media-viewer-close").click();
    await expectReleased(page);

    // 点画面不关，点深色底关
    await openPlayer(page, false);
    const again = await playerRect(page);
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 3);
    await page.waitForTimeout(400);
    expect(await viewerCount(page)).toBe(1);
    await page.mouse.click(20, 400);
    await expectReleased(page);
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);
});
