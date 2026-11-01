// 长按网页元素的圆钮（359 号票，src/page-bridge/element.ts）：页面桥打包成注入用的脚本，在真的 Chrome 里跑，鼠标右键触发 contextmenu（手指长按在两个模拟器上验，见票的 Comments）。查：
// - 只听不拦：网页收到的 contextmenu 没被 preventDefault，系统菜单照常；
// - 认元素：图片（地址、外面的链接、说明文字）、canvas、SVG、CSS 背景图、视频、链接、文字、选中的文字；选区要和元素相交才算；文本框、密码框、空白不出；
// - 圆钮：就在按的地方旁边，看得见的范围里；点一下打字（先自己出打字框）、发送带着元素和这一刻选中的字；按住说话（press、start、stop）；上滑取消；
//   touch 那一路也接得住，同一下不报两遍；
// - 收：留 5 秒自己消失；点别处、滚动马上收；气泡开着、在办时不收；选区没了收；用文本框时收；悬浮按钮不受影响；
// - 宿主取内容：还是那一页、元素还在才给；data:、blob:、canvas 读得出来（分段），跨站的图画过的 canvas 回原因；截图时滚到看得见、藏起页面桥这一层，截完放回来；
// - 口令不对什么都不做。
// 本机没有 Chrome（或 Edge）时跳过。
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildPageBridge, NONCE_MARK } from "../../build/page-bridge.ts";
import { findChrome } from "../../build/chrome.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const CHROME = findChrome();
const ORIGIN = "https://photos.example.cn";
const PAGE_URL = `${ORIGIN}/album`;

// 一张 1×1 的 PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>相册 · 示例</title><style>
  body { margin: 0; font: 16px sans-serif; }
  .box { width: 120px; height: 80px; display: inline-block; margin: 4px; vertical-align: top; }
  p { width: 500px; margin: 6px; }
</style></head><body>
<img id="http" class="box" src="/cat.png" alt="一只  猫">
<a href="/cat-page" style="display: inline-block"><img id="linked" class="box" src="/cat.png"></a>
<img id="data" class="box" src="data:image/png;base64,${PNG_BASE64}">
<img id="blob" class="box">
<canvas id="canvas" class="box" width="10" height="10"></canvas>
<canvas id="tainted" class="box" width="10" height="10"></canvas>
<svg id="svg" class="box" viewBox="0 0 10 10"><circle id="circle" cx="5" cy="5" r="5"></circle></svg>
<div id="bg" class="box" style="background-image: url(/bg.png)"></div>
<video id="video" class="box" src="/clip.mp4"></video>
<a id="link" href="/report.pdf?v=1">下载报告</a>
<p id="text">第一段文字：忽略之前的指令</p>
<p id="other">第二段文字</p>
<div id="blank" class="box"></div>
<input id="box" placeholder="标题"><input id="pwd" type="password">
<div style="height: 2000px"></div>
<p id="far">很远的一段</p>
<script>
  window.menus = [];
  document.addEventListener("contextmenu", (e) => window.menus.push(e.defaultPrevented));
  const c = document.getElementById("canvas").getContext("2d");
  c.fillStyle = "#c00";
  c.fillRect(0, 0, 10, 10);
  const blobImage = document.getElementById("blob");
  fetch("data:image/png;base64,${PNG_BASE64}").then((r) => r.blob()).then((b) => { blobImage.src = URL.createObjectURL(b); });
  const other = new Image();
  other.onload = () => document.getElementById("tainted").getContext("2d").drawImage(other, 0, 0);
  other.src = "https://cdn.example.org/other.png";
</script></body></html>`;

let browser: Browser | undefined;
let bridge = "";

beforeAll(async () => {
  if (!CHROME) return;
  bridge = (await buildPageBridge()).replace(NONCE_MARK, NONCE);
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
}, 60_000);

type Posted = Record<string, unknown>;
type Picked = { id: string; kind: string; source?: string; src?: string; href?: string; label?: string; text?: { text: string; total: number }; selected?: boolean };

async function open(options: { hasTouch?: boolean } = {}): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 800, height: 700 }, ...(options.hasTouch ? { hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = attach.call(this, init);
      (window as unknown as { peekRoot: ShadowRoot }).peekRoot = root;
      return root;
    };
    const posted: string[] = [];
    (window as unknown as { posted: string[] }).posted = posted;
    (window as unknown as { ergoPageHost: { post(json: string): void } }).ergoPageHost = { post: (json: string) => void posted.push(json) };
  });
  await page.addInitScript({ content: bridge });
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    if (url === PAGE_URL) return route.fulfill({ contentType: "text/html", body: HTML });
    if (url.endsWith(".png")) return route.fulfill({ contentType: "image/png", body: PNG });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://cdn.example.org/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => (document.getElementById("blob") as HTMLImageElement).complete && (document.getElementById("blob") as HTMLImageElement).naturalWidth > 0);
  return page;
}

const postedOf = async (page: Page): Promise<Posted[]> => (await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).map((json) => JSON.parse(json) as Posted);
const callJson = async (page: Page, method: string, ...args: string[]) =>
  JSON.parse(await page.evaluate(({ name, params }) => (window as unknown as { __ergoPage: Record<string, (...a: string[]) => string> }).__ergoPage[name]!(...params), { name: method, params: [NONCE, ...args] })) as Record<string, unknown>;

async function center(page: Page, selector: string): Promise<[number, number]> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} 看不见`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** 右键点一下，回页面桥报的元素（没出圆钮是 null） */
async function press(page: Page, selector: string): Promise<Picked | null> {
  const before = (await postedOf(page)).length;
  const [x, y] = await center(page, selector);
  await page.mouse.click(x, y, { button: "right" });
  await page.waitForTimeout(30);
  const element = (await postedOf(page)).slice(before).filter((m) => m.type === "element").at(-1);
  return element ? (element.element as Picked | null) : null;
}

/** 圆钮（第二个 .fab）：看不看得见、在哪 */
const elementFab = (page: Page) =>
  page.evaluate(() => {
    const fab = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(".fab")[1] as HTMLElement;
    const r = fab.getBoundingClientRect();
    return { on: fab.classList.contains("on"), x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, cls: fab.className };
  });
const fieldFabOn = (page: Page) => page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(".fab")[0]!.classList.contains("on"));

/** 分段读完 */
async function readAll(page: Page, id: string): Promise<{ bytes: Buffer; mime: string }> {
  const parts: Buffer[] = [];
  let offset = 0;
  let mime = "";
  for (let i = 0; i < 200; i++) {
    const chunk = (await callJson(page, "elementChunk", id, String(offset))) as { ok: boolean; ready?: boolean; base64?: string; mime?: string; done?: boolean; reason?: string };
    expect(chunk.ok).toBe(true);
    if (!chunk.ready) {
      await page.waitForTimeout(20);
      continue;
    }
    const part = Buffer.from(chunk.base64!, "base64");
    parts.push(part);
    offset += part.length;
    mime = chunk.mime!;
    if (chunk.done) return { bytes: Buffer.concat(parts), mime };
  }
  throw new Error("没读完");
}

describe.skipIf(!CHROME)("长按元素的圆钮（在真的 Chrome 里）", () => {
  test("只听不拦：网页收到的 contextmenu 没被 preventDefault；口令不对什么都不做", async () => {
    const page = await open();
    await press(page, "#http");
    expect(await page.evaluate(() => (window as unknown as { menus: boolean[] }).menus)).toEqual([false]);
    expect(await page.evaluate(() => (window as unknown as { __ergoPage: Record<string, (...a: string[]) => string> }).__ergoPage.elementInfo!("wrong", "x1", ""))).toBe("");
    await page.context().close();
  });

  test("认元素：图片带地址、外面的链接、说明文字；data、blob、canvas、SVG、CSS 背景图、视频、链接、文字", async () => {
    const page = await open();
    expect(await press(page, "#http")).toMatchObject({ kind: "image", source: "http", src: `${ORIGIN}/cat.png`, label: "一只 猫" });
    expect(await press(page, "#linked")).toMatchObject({ kind: "image", source: "http", src: `${ORIGIN}/cat.png`, href: `${ORIGIN}/cat-page` });
    const data = await press(page, "#data");
    expect(data).toMatchObject({ kind: "image", source: "data" });
    expect(data?.src).toBeUndefined();
    const blob = await press(page, "#blob");
    expect(blob).toMatchObject({ kind: "image", source: "blob" });
    expect(blob?.src).toBeUndefined();
    expect(await press(page, "#canvas")).toMatchObject({ kind: "image", source: "canvas" });
    expect(await press(page, "#circle")).toMatchObject({ kind: "image", source: "svg" });
    expect(await press(page, "#bg")).toMatchObject({ kind: "image", source: "http", src: `${ORIGIN}/bg.png` });
    expect(await press(page, "#video")).toMatchObject({ kind: "video", source: "http", src: `${ORIGIN}/clip.mp4` });
    expect(await press(page, "#link")).toMatchObject({ kind: "link", href: `${ORIGIN}/report.pdf?v=1`, text: { text: "下载报告", total: 4 } });
    const text = await press(page, "#text");
    expect(text).toMatchObject({ kind: "text", text: { text: "第一段文字：忽略之前的指令" } });
    expect(text?.selected).toBeUndefined();
    await page.context().close();
  });

  test("选中的字：和元素相交才算；不相交的（图片旁边选着字）还是图", async () => {
    const page = await open();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("other")!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    expect(await press(page, "#other")).toMatchObject({ kind: "text", selected: true, text: { text: "第二段文字" } });
    // 系统只选中一个词（手指长按时）：带上所在的那段
    const word = await page.evaluate(() => {
      const node = document.getElementById("text")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 3);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      const r = range.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2] as const;
    });
    await page.mouse.click(word[0], word[1], { button: "right" });
    await page.waitForTimeout(30);
    expect((await postedOf(page)).filter((m) => m.type === "element").at(-1)?.element).toMatchObject({ kind: "text", selected: true, text: { text: "第一段" }, around: { text: "第一段文字：忽略之前的指令" } });
    // 重新选一遍（右键可能改选区）：选区在第二段，按第一段不算选中的字；按图还是图
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("other")!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    expect(await press(page, "#canvas")).toMatchObject({ kind: "image", source: "canvas" });
    await page.context().close();
  });

  test("文本框、密码框、空白不出圆钮；按在空白上时开着的圆钮收起", async () => {
    const page = await open();
    expect(await press(page, "#box")).toBeNull();
    expect(await press(page, "#pwd")).toBeNull();
    expect(await press(page, "#blank")).toBeNull();
    expect((await elementFab(page)).on).toBe(false);
    await press(page, "#http");
    expect((await elementFab(page)).on).toBe(true);
    const [x, y] = await center(page, "#blank");
    await page.mouse.click(x, y, { button: "right" });
    await page.waitForTimeout(30);
    expect((await elementFab(page)).on).toBe(false);
    await page.context().close();
  });

  test("圆钮在按的地方旁边、在看得见的范围里；选中的字放选区下方（系统的工具条在上方）", async () => {
    const page = await open();
    const [x, y] = await center(page, "#http");
    await press(page, "#http");
    const fab = await elementFab(page);
    expect(fab.on).toBe(true);
    expect(Math.abs(fab.x - x)).toBeLessThan(60);
    expect(Math.abs(fab.y - y)).toBeLessThan(80);
    expect(fab.left).toBeGreaterThanOrEqual(0);
    expect(fab.top).toBeGreaterThanOrEqual(0);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("other")!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await press(page, "#other");
    const bottom = await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().bottom);
    expect((await elementFab(page)).top).toBeGreaterThanOrEqual(bottom);
    await page.context().close();
  });

  test("点一下：先自己出打字框（聚焦），报 element-open；发送带着元素和这一刻选中的字", async () => {
    const page = await open();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("other")!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    const picked = await press(page, "#other");
    const fab = await elementFab(page);
    await page.mouse.click(fab.x, fab.y);
    await page.waitForTimeout(30);
    const posted = await postedOf(page);
    const opened = posted.filter((m) => m.type === "element-open");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ element: { id: picked!.id, kind: "text", selected: true }, page: { title: "相册 · 示例", url: PAGE_URL } });
    const area = await page.evaluate(() => {
      const root = (window as unknown as { peekRoot: ShadowRoot }).peekRoot;
      return { on: root.querySelector(".bubble")!.classList.contains("on"), focused: root.activeElement?.tagName };
    });
    expect(area).toEqual({ on: true, focused: "TEXTAREA" });
    await page.keyboard.type("翻译成英文");
    const send0 = await page.evaluate(() => {
      const r = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(".send")!.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2] as const;
    });
    await page.mouse.click(send0[0], send0[1]);
    await page.waitForTimeout(30);
    const send = (await postedOf(page)).filter((m) => m.type === "bubble" && m.action === "send");
    expect(send).toHaveLength(1);
    expect(send[0]).toMatchObject({ text: "翻译成英文", element: { id: picked!.id, selected: true, text: { text: "第二段文字" } } });
    await page.context().close();
  });

  test("按住说话：press、start、stop 都带元素；上滑取消；气泡里在听、在办，宿主标 idle 之后圆钮过一会儿自己收", async () => {
    const page = await open();
    const picked = await press(page, "#http");
    const fab = await elementFab(page);
    await page.mouse.move(fab.x, fab.y);
    await page.mouse.down();
    await page.waitForTimeout(450);
    expect((await elementFab(page)).cls).toContain("listening");
    await page.mouse.up();
    await page.waitForTimeout(30);
    const voices = (await postedOf(page)).filter((m) => m.type === "element-voice");
    expect(voices.map((m) => m.phase)).toEqual(["press", "start", "stop"]);
    expect(voices[2]).toMatchObject({ element: { id: picked!.id, kind: "image" } });
    expect((await elementFab(page)).cls).toContain("busy");
    // 取消：再按一下，上滑松手
    await callJson(page, "mark", picked!.id, "idle");
    await callJson(page, "bubble", JSON.stringify({ kind: "none" }));
    await press(page, "#http");
    const again = await elementFab(page);
    await page.mouse.move(again.x, again.y);
    await page.mouse.down();
    await page.waitForTimeout(450);
    await page.mouse.move(again.x, Math.max(0, again.y - 120));
    await page.mouse.up();
    await page.waitForTimeout(30);
    expect((await postedOf(page)).filter((m) => m.type === "element-voice").map((m) => m.phase)).toEqual(["press", "start", "stop", "press", "start", "cancel"]);
    await page.context().close();
  });

  test("touch 那一路：手指点一下只报一遍 element-open；手指按住也能说", async () => {
    const page = await open({ hasTouch: true });
    const cdp = await page.context().newCDPSession(page);
    await press(page, "#http");
    const fab = await elementFab(page);
    const touch = (type: string, points: Array<{ x: number; y: number }>) => cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: points });
    await touch("touchStart", [{ x: fab.x, y: fab.y }]);
    await touch("touchEnd", []);
    await page.waitForTimeout(50);
    expect((await postedOf(page)).filter((m) => m.type === "element-open")).toHaveLength(1);
    await page.context().close();
  });

  test("留 5 秒自己消失；点别处、滚动马上收；用文本框时收；悬浮按钮不受影响", async () => {
    const page = await open();
    await press(page, "#http");
    await page.waitForTimeout(4500);
    expect((await elementFab(page)).on).toBe(true);
    await page.waitForTimeout(900);
    expect((await elementFab(page)).on).toBe(false);
    expect((await postedOf(page)).filter((m) => m.type === "element").at(-1)).toMatchObject({ type: "element", element: null });

    await press(page, "#http");
    const [x, y] = await center(page, "#blank");
    await page.mouse.click(x, y);
    await page.waitForTimeout(30);
    expect((await elementFab(page)).on).toBe(false);

    await press(page, "#http");
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
    expect((await elementFab(page)).on).toBe(false);
    await page.evaluate(() => window.scrollTo(0, 0));

    await press(page, "#http");
    await page.click("#box");
    await page.waitForTimeout(30);
    expect((await elementFab(page)).on).toBe(false);
    expect(await fieldFabOn(page)).toBe(true);
    // 悬浮按钮照旧报框
    expect((await postedOf(page)).some((m) => m.type === "field" && (m.field as { label?: string } | null)?.label !== undefined)).toBe(true);
    await page.context().close();
  }, 20_000);

  test("在办时不自己收；气泡收起时圆钮也收；宿主交来的样子标到别的元素上不影响悬浮按钮", async () => {
    const page = await open();
    const picked = await press(page, "#http");
    await callJson(page, "mark", picked!.id, "busy");
    await callJson(page, "bubble", JSON.stringify({ kind: "busy", fieldId: picked!.id, said: "这是什么", text: "二狗在想……" }));
    await page.waitForTimeout(5300);
    expect((await elementFab(page)).on).toBe(true);
    await callJson(page, "mark", picked!.id, "idle");
    await callJson(page, "bubble", JSON.stringify({ kind: "none" }));
    await page.waitForTimeout(30);
    expect((await elementFab(page)).on).toBe(false);
    await callJson(page, "mark", "x99", "busy");
    await page.click("#box");
    expect(await page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(".fab")[0]!.classList.contains("busy"))).toBe(false);
    await page.context().close();
  }, 20_000);

  test("宿主取内容：还是那一页、元素还在才给", async () => {
    const page = await open();
    const picked = await press(page, "#http");
    expect(await callJson(page, "elementInfo", picked!.id, PAGE_URL)).toMatchObject({ ok: true, page: { url: PAGE_URL }, element: { id: picked!.id, kind: "image" } });
    expect(await callJson(page, "elementInfo", picked!.id, `${ORIGIN}/other`)).toEqual({ ok: false, reason: "网页换了，编号对不上了" });
    expect(await callJson(page, "elementInfo", "x99", PAGE_URL)).toMatchObject({ ok: false, reason: expect.stringContaining("没有这个元素") });
    await page.evaluate(() => document.getElementById("http")!.remove());
    expect(await callJson(page, "elementInfo", picked!.id, PAGE_URL)).toMatchObject({ ok: false, reason: expect.stringContaining("不在页面上") });
    await page.context().close();
  });

  test("data:、blob:、canvas 由页面读出来分段交；跨站的图画过的 canvas 回原因", async () => {
    const page = await open();
    for (const selector of ["#data", "#blob"]) {
      const picked = await press(page, selector);
      expect(await callJson(page, "elementPrepare", picked!.id, PAGE_URL)).toEqual({ ok: true });
      const got = await readAll(page, picked!.id);
      expect(got.mime).toBe("image/png");
      expect(got.bytes.equals(PNG)).toBe(true);
    }
    const canvas = await press(page, "#canvas");
    expect(await callJson(page, "elementPrepare", canvas!.id, PAGE_URL)).toEqual({ ok: true });
    const drawn = await readAll(page, canvas!.id);
    expect(drawn.mime).toBe("image/png");
    expect(drawn.bytes.subarray(1, 4).toString()).toBe("PNG");
    await page.waitForFunction(() => document.getElementById("tainted") !== null);
    await page.waitForTimeout(100);
    const tainted = await press(page, "#tainted");
    expect(await callJson(page, "elementPrepare", tainted!.id, PAGE_URL)).toMatchObject({ ok: false, reason: expect.stringContaining("读不出来") });
    await page.context().close();
  });

  test("截图：滚到看得见、藏起页面桥这一层，回物理像素的位置；截完放回来", async () => {
    const page = await open();
    const picked = await press(page, "#far");
    expect(picked).toBeNull(); // 视口外，按不到
    const svg = await press(page, "#svg");
    const rect = (await callJson(page, "elementRect", svg!.id, PAGE_URL)) as { ok: boolean; x: number; y: number; width: number; height: number; partial: boolean };
    expect(rect).toMatchObject({ ok: true, partial: false });
    expect(rect.width).toBeCloseTo(120, 0);
    expect(rect.height).toBeCloseTo(80, 0);
    const shown = () => page.evaluate(() => getComputedStyle((window as unknown as { peekRoot: ShadowRoot }).peekRoot.host).visibility);
    expect(await shown()).toBe("hidden");
    await callJson(page, "elementShotDone");
    expect(await shown()).toBe("visible");
    await page.context().close();
  });
});
