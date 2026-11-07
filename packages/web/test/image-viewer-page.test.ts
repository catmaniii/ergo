// 图片查看器在真页面上（ui/image-viewer.tsx）：放大后能双指缩放、拖动看细节。照 vite.config.ts 按生产环境构建一遍演示页，
// 存成临时文件，用 file:// 在真 Chrome 里打开（不经守护进程，走原型的假数据），点开素材详情里那张假图（原型里能真的画出来的图，
// 和会话里的图片是同一个组件画的）：
// - 手机宽（390×844，触屏）：CDP 的 Input.dispatchTouchEvent 两根手指捏合放大（落在图上、落在图外面的深色底上都行），
//   捏小松手弹回 1 倍；双击以点的位置放大到 2.5 倍、再双击还原；放大后单指拖、拖不出图的边；捏合、拖动、双击之后松手都不关；
//   × 和下面一行放大后仍在最上面；点图外面照样关；再打开从 1 倍开始；
// - 电脑宽（1280×800，鼠标）：滚轮以鼠标位置为中心放大、按住拖（抓手）、双击放大和还原；从深色底上拖了松手不关、
//   点深色底关；放大着按 Esc、点 × 都能关。
// 算术本身（范围、居中、弹回）在 test/state/image-zoom.test.ts。本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findChrome } from "../build/chrome.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 素材详情里记下来的那张图（原型的 FAKE_MATERIAL_IMAGES：640×400 的橘猫） */
const IMAGE_PAGE = "#/more/memory/materials/mat-fake-recent-17";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-image-viewer-"));
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
interface Pt {
  x: number;
  y: number;
}

const center = (r: Rect): Pt => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** 图现在画在哪（算上 transform） */
const imageRect = (page: Page): Promise<Rect> =>
  page.locator(".image-viewer img").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

const viewerCount = (page: Page) => page.locator(".image-viewer").count();

/** 这个元素正中那一点上面没有别的东西盖着（放大的图没盖住它）。测试的类型里没有 DOM，在页面里跑的写成字符串 */
const onTop = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  })()`);

/** 鼠标在图上是什么样子 */
const imageCursor = (page: Page): Promise<string> => page.evaluate(`getComputedStyle(document.querySelector(".image-viewer img")).cursor`);

/** 等图停到比例 scale（相对打开时的大小），中心在 at（给了时），差一两像素算到 */
async function expectView(page: Page, base: Rect, scale: number, at?: Pt) {
  await expect
    .poll(
      async () => {
        const r = await imageRect(page);
        const c = center(r);
        return Math.abs(r.width / base.width - scale) < 0.01 && (!at || (Math.abs(c.x - at.x) < 1.5 && Math.abs(c.y - at.y) < 1.5));
      },
      { timeout: 3000 },
    )
    .toBe(true);
}

/** 打开素材详情，点开那张图，等查看器里的图加载好；返回打开时（1 倍）图画在哪 */
async function openViewer(page: Page, touch: boolean): Promise<Rect> {
  const link = page.locator(".part-image a").first();
  await link.waitFor({ timeout: 15_000 });
  await (touch ? link.tap() : link.click());
  await page.locator(".image-viewer img").waitFor();
  await page.waitForFunction(`document.querySelector(".image-viewer img")?.complete === true`);
  return imageRect(page);
}

async function newPage(viewport: { width: number; height: number }, touch: boolean): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport, hasTouch: touch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${pageUrl}${IMAGE_PAGE}`);
  return { context, page, errors };
}

/** 两根手指：以 at 为中点，左右各从 from 拉到 to（像素，小于 from 就是捏小），分几步挪，再一起松开 */
async function pinch(cdp: CDPSession, at: Pt, from: number, to: number, steps = 6) {
  const points = (d: number) => [
    { x: at.x - d, y: at.y, id: 0 },
    { x: at.x + d, y: at.y, id: 1 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * i) / steps) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * 一根手指从 from 拖到 to，停一下再松开。不停就松手是一次"甩"：Chrome 会接着算惯性滑动，这时候紧跟着的一下点
 * 被它当成"按住停下滑动"吞掉、不派 click（和网页上甩完滚动马上点一下一样），查看器的"点图外面关"就等不到 click
 */
async function drag(cdp: CDPSession, from: Pt, to: Pt, steps = 6) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 0 }] });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: 0 }] });
  }
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** 松手之后浏览器要派的 click 早就派完了，查看器还开着 */
async function expectStillOpen(page: Page) {
  await page.waitForTimeout(400);
  expect(await viewerCount(page)).toBe(1);
}

describe.skipIf(!CHROME)("图片查看器：手机宽（390，触屏）", () => {
  test("双指捏合放大（图上、图外的深色底上都行），捏小松手弹回 1 倍；捏完松手不关", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true);
    const cdp = await context.newCDPSession(page);
    const base = await openViewer(page, true);
    const c = center(base);
    // 横图按宽放进框里，上下是深色底
    expect(base.width).toBeGreaterThan(300);
    expect(base.y).toBeGreaterThan(200);

    // 落在图上面的深色底上捏：两指距离 60 → 120，放大到 2 倍
    await pinch(cdp, { x: c.x, y: base.y - 80 }, 30, 60);
    await expectView(page, base, 2);
    await expectStillOpen(page);

    // 在图中间捏小到比 1 倍还小，松手弹回 1 倍、居中
    await pinch(cdp, c, 80, 10);
    await expectView(page, base, 1, c);
    await expectStillOpen(page);

    // 在图中间捏大：60 → 150 是 2.5 倍，两指中点（图中心）下面的图不动
    await pinch(cdp, c, 30, 75);
    await expectView(page, base, 2.5, c);
    await expectStillOpen(page);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  test("双击以点的位置放大到 2.5 倍，再双击还原；双击不关", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true);
    const base = await openViewer(page, true);
    const c = center(base);
    // 点在图的右边四分之一处：放大后那一点还在手指底下（图中心往左挪 1.5 倍的偏移）
    const p = { x: c.x + base.width / 4, y: c.y };
    await page.touchscreen.tap(p.x, p.y);
    await page.touchscreen.tap(p.x, p.y);
    await expectView(page, base, 2.5, { x: p.x - 2.5 * (p.x - c.x), y: c.y });
    await expectStillOpen(page);

    await page.touchscreen.tap(p.x, p.y);
    await page.touchscreen.tap(p.x, p.y);
    await expectView(page, base, 1, c);
    await expectStillOpen(page);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  test("放大后单指拖着看、拖不出图的边，松手不关；× 和下面一行在最上面；点图外面照样关，再打开从 1 倍开始", async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 }, true);
    const cdp = await context.newCDPSession(page);
    const base = await openViewer(page, true);
    const c = center(base);

    // 1 倍时单指拖不动图
    await drag(cdp, c, { x: c.x + 80, y: c.y + 60 });
    await expectView(page, base, 1, c);
    await expectStillOpen(page);

    await page.touchscreen.tap(c.x, c.y);
    await page.touchscreen.tap(c.x, c.y);
    await expectView(page, base, 2.5, c);

    // 往右拖 100：图跟着挪；竖着图比框矮，保持居中
    await drag(cdp, c, { x: c.x + 100, y: c.y + 50 });
    await expectView(page, base, 2.5, { x: c.x + 100, y: c.y });
    await expectStillOpen(page);

    // 再往右拖很远：拖到图的左边贴着框的左边（查看器左右各留 12）为止
    await drag(cdp, c, { x: c.x + 360, y: c.y });
    await expect.poll(async () => Math.round((await imageRect(page)).x), { timeout: 3000 }).toBe(12);
    await expectStillOpen(page);

    // 从图外面的深色底上拖（2.5 倍时图上面还露着一截深色底）：一样能拖（往左拖回 200），松手不关
    const dark = { x: c.x, y: 100 };
    expect((await imageRect(page)).y).toBeGreaterThan(dark.y + 20);
    await drag(cdp, dark, { x: dark.x - 200, y: dark.y });
    await expect.poll(async () => Math.round((await imageRect(page)).x), { timeout: 3000 }).toBe(-188);
    await expectStillOpen(page);

    // × 和下面一行（下载）在放大的图上面，点得到
    expect(await onTop(page, ".media-viewer-close")).toBe(true);
    expect(await onTop(page, ".media-viewer-bar a")).toBe(true);

    // 点图外面的深色底：关
    await page.touchscreen.tap(dark.x, dark.y);
    await expect.poll(() => viewerCount(page), { timeout: 3000 }).toBe(0);

    // 再打开：从 1 倍开始
    const again = await openViewer(page, true);
    expect(again).toEqual(base);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);
});

describe.skipIf(!CHROME)("图片查看器：电脑宽（1280，鼠标）", () => {
  test("滚轮以鼠标位置为中心放大，按住拖（抓手），双击放大和还原；拖完松手不关", async () => {
    const { context, page, errors } = await newPage({ width: 1280, height: 800 }, false);
    const base = await openViewer(page, false);
    const c = center(base);
    // 640×400 的图在宽屏上原大显示（不放大到框）
    expect(base.width).toBe(640);

    const cursor = () => imageCursor(page);
    expect(await cursor()).toBe("default");

    // 鼠标在图中心右下 (100, 50)：往上滚 5 格（每格 100 像素，约 1.22 倍）放大到 e 倍
    const p = { x: c.x + 100, y: c.y + 50 };
    await page.mouse.move(p.x, p.y);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100);
    await expectView(page, base, Math.E);
    // 放大着双击：回到 1 倍
    await page.mouse.dblclick(c.x, c.y);
    await expectView(page, base, 1, c);

    // 图已经比框大了（双击到 2.5 倍，1600×1000）再滚：以鼠标位置为中心，鼠标下面那一点图不动
    await page.mouse.dblclick(c.x, c.y);
    await expectView(page, base, 2.5, c);
    await page.mouse.move(p.x, p.y);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    const k = Math.exp(0.6);
    const zoomed = { x: p.x - k * (p.x - c.x), y: p.y - k * (p.y - c.y) };
    await expectView(page, base, 2.5 * k, zoomed);
    expect(await cursor()).toBe("grab");

    // 按住往右下拖 (150, 80)：图跟着挪，按着时攥紧；松手不关
    await page.mouse.down();
    await page.mouse.move(p.x + 75, p.y + 40, { steps: 3 });
    await page.mouse.move(p.x + 150, p.y + 80, { steps: 3 });
    expect(await cursor()).toBe("grabbing");
    await page.mouse.up();
    await expectView(page, base, 2.5 * k, { x: zoomed.x + 150, y: zoomed.y + 80 });
    await expectStillOpen(page);

    // 放大着双击：回到 1 倍
    await page.mouse.dblclick(c.x, c.y);
    await expectView(page, base, 1, c);
    // 1 倍时双击：以点的位置放大到 2.5 倍
    await page.mouse.dblclick(p.x, p.y);
    await expectView(page, base, 2.5, { x: p.x - 2.5 * 100, y: p.y - 2.5 * 50 });
    await page.mouse.dblclick(p.x, p.y);
    await expectView(page, base, 1, c);
    await expectStillOpen(page);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  test("从深色底上拖了松手不关，点深色底关；放大着按 Esc、点 × 都能关", async () => {
    const { context, page, errors } = await newPage({ width: 1280, height: 800 }, false);
    const base = await openViewer(page, false);
    const dark = { x: 80, y: center(base).y };

    // 在深色底上滚两格放大一点，再从深色底上按住拖一段松手：不算点，不关
    await page.mouse.move(dark.x, dark.y);
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await expectView(page, base, Math.exp(0.4));
    await page.mouse.down();
    await page.mouse.move(dark.x + 200, dark.y + 60, { steps: 5 });
    await page.mouse.up();
    await expectStillOpen(page);
    // 点深色底：关
    await page.mouse.click(dark.x, dark.y);
    await expect.poll(() => viewerCount(page), { timeout: 3000 }).toBe(0);

    // 放大着按 Esc：关
    await openViewer(page, false);
    await page.mouse.dblclick(center(base).x, center(base).y);
    await expectView(page, base, 2.5);
    await page.keyboard.press("Escape");
    await expect.poll(() => viewerCount(page), { timeout: 3000 }).toBe(0);

    // 放大着点 ×：× 在图上面，点了关
    await openViewer(page, false);
    await page.mouse.dblclick(center(base).x, center(base).y);
    await expectView(page, base, 2.5);
    expect(await onTop(page, ".media-viewer-close")).toBe(true);
    await page.locator(".media-viewer-close").click();
    await expect.poll(() => viewerCount(page), { timeout: 3000 }).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);
});
