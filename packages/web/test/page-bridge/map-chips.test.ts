// 选中的地址用地图（447，src/page-bridge/map-chips.ts、element.ts）：页面桥打包成注入用的脚本，在真的 Chrome 里跑，右键触发圆钮。查：
// - 二狗的网页随 texts 交来 map 才给：没交来、交的是别的时选中地址也只有圆钮；
// - 选中的字像地址、地名（中文门牌、英文街名、短短的地名）圆钮旁边多一行"在地图上看""怎么去"，摆在圆钮右边、看得见的范围里；
//   一大段话、网址不给；没选中只是长按一段字不给；
// - 点"在地图上看"：报 element-map（show，带元素和这一刻选中的字），这一行收起，先自己出"在办"的气泡，选区不丢；
// - 手指点"怎么去"只报一遍（route）；按圆钮（打字）这一行收起；换了语言字跟着换；靠右边时摆到圆钮左边；
// - 开了 Trusted Types 的网页（不许给 innerHTML 塞字符串）上照样出来、图标是 SVG、点了照样报。
// 本机没有 Chrome（或 Edge）时跳过。
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildPageBridge, NONCE_MARK } from "../../build/page-bridge.ts";
import { findChrome } from "../../build/chrome.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const CHROME = findChrome();
const ORIGIN = "https://shop.example.cn";
const PAGE_URL = `${ORIGIN}/store`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>门店 · 示例</title><style>
  body { margin: 0; font: 16px sans-serif; }
  p { margin: 10px; width: 420px; }
  #edge { position: absolute; right: 4px; top: 300px; width: 150px; margin: 0; text-align: right; }
</style></head><body>
<p>门店地址：<span id="addr">浙江省杭州市西湖区示例路 478 号</span></p>
<p>Visit us at <span id="en">1600 Example Street, Springfield</span> anytime.</p>
<p>附近有 <span id="name">西湖</span> 可以逛逛。</p>
<p id="long">这是一大段介绍文字，讲的是这家店的历史。它开了很多年，老板很热情。周末人很多，建议早点来。停车不太方便，最好坐地铁。</p>
<p>官网：<span id="url">https://shop.example.cn/about</span></p>
<p id="plain">只是长按这一段字，没有选中</p>
<p id="edge"><span id="edgeAddr">示例路 9 号</span></p>
</body></html>`;

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

/** csp：网页响应带的 Content-Security-Policy（被拦的记在 window.cspViolations） */
async function open(options: { hasTouch?: boolean; map?: boolean; csp?: string } = {}): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 800, height: 600 }, ...(options.hasTouch ? { hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => void seen.push(`${e.violatedDirective} ${e.sample}`));
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
  await page.route(`${ORIGIN}/**`, (route) => (route.request().url() === PAGE_URL ? route.fulfill({ contentType: "text/html", ...(options.csp ? { headers: { "Content-Security-Policy": options.csp } } : {}), body: HTML }) : route.fulfill({ status: 404, body: "" })));
  await page.goto(PAGE_URL);
  if (options.map !== false) await callJson(page, "texts", JSON.stringify({ map: true }));
  return page;
}

const postedOf = async (page: Page): Promise<Posted[]> => (await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).map((json) => JSON.parse(json) as Posted);
const callJson = async (page: Page, method: string, ...args: string[]) =>
  JSON.parse(await page.evaluate(({ name, params }) => (window as unknown as { __ergoPage: Record<string, (...a: string[]) => string> }).__ergoPage[name]!(...params), { name: method, params: [NONCE, ...args] })) as Record<string, unknown>;

/** 选中这个元素里的字，再右键点它（圆钮出来） */
async function selectAndPress(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(sel)!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, selector);
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForTimeout(40);
}

/** 圆钮、地图那一行：显示没有、在哪、上面的字 */
const look = (page: Page) =>
  page.evaluate(() => {
    const root = (window as unknown as { peekRoot: ShadowRoot }).peekRoot;
    const fab = root.querySelectorAll(".fab")[1] as HTMLElement;
    const chips = root.querySelector(".map-chips") as HTMLElement;
    const f = fab.getBoundingClientRect();
    const c = chips.getBoundingClientRect();
    return {
      fab: { on: fab.classList.contains("on"), left: f.left, top: f.top, right: f.right, bottom: f.bottom },
      chips: { on: chips.classList.contains("on"), left: c.left, top: c.top, right: c.right, bottom: c.bottom, labels: [...chips.querySelectorAll(".map-chip")].map((x) => x.textContent) },
      bubbleOn: root.querySelector(".bubble")!.classList.contains("on"),
      selection: String(getSelection()),
    };
  });

/** 地图那一行上的一个按钮的正中间 */
const chipCenter = (page: Page, act: "show" | "route") =>
  page.evaluate((a) => {
    const r = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(`.map-chip[data-act="${a}"]`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, act);

describe.skipIf(!CHROME)("选中的地址旁边地图的两个按钮（在真的 Chrome 里）", () => {
  test("二狗的网页没交来 map：选中地址也只有圆钮", async () => {
    const page = await open({ map: false });
    await selectAndPress(page, "#addr");
    const now = await look(page);
    expect(now.fab.on).toBe(true);
    expect(now.chips.on).toBe(false);
    await page.context().close();
  });

  test("中文地址、英文街名、短短的地名给，摆在圆钮右边、看得见的范围里；一大段话、网址、没选中的不给", async () => {
    const page = await open();
    for (const selector of ["#addr", "#en", "#name"]) {
      await selectAndPress(page, selector);
      const now = await look(page);
      expect({ selector, fab: now.fab.on, chips: now.chips.on }).toEqual({ selector, fab: true, chips: true });
      expect(now.chips.labels).toEqual(["在地图上看", "怎么去"]);
      // 圆钮右边、竖着居中
      expect(now.chips.left).toBeGreaterThanOrEqual(now.fab.right);
      expect(now.chips.left - now.fab.right).toBeLessThan(12);
      expect(Math.abs((now.chips.top + now.chips.bottom) / 2 - (now.fab.top + now.fab.bottom) / 2)).toBeLessThan(2);
      expect(now.chips.right).toBeLessThanOrEqual(800);
    }
    for (const selector of ["#long", "#url"]) {
      await selectAndPress(page, selector);
      const now = await look(page);
      expect({ selector, fab: now.fab.on, chips: now.chips.on }).toEqual({ selector, fab: true, chips: false });
    }
    await page.evaluate(() => getSelection()!.removeAllRanges());
    const box = (await page.locator("#plain").boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: "right" });
    await page.waitForTimeout(40);
    const plain = await look(page);
    expect(plain.fab.on).toBe(true);
    expect(plain.chips.on).toBe(false);
    await page.context().close();
  });

  test("点在地图上看：报 element-map（带元素和选中的字），这一行收起，先自己出在办的气泡，选区不丢", async () => {
    const page = await open();
    await selectAndPress(page, "#addr");
    const element = (await postedOf(page)).filter((m) => m.type === "element").at(-1)!.element as { id: string };
    const at = await chipCenter(page, "show");
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(40);
    const sent = (await postedOf(page)).filter((m) => m.type === "element-map");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "show", element: { id: element.id, kind: "text", selected: true, text: { text: "浙江省杭州市西湖区示例路 478 号" } }, page: { title: "门店 · 示例", url: PAGE_URL } });
    const now = await look(page);
    expect(now.chips.on).toBe(false);
    expect(now.bubbleOn).toBe(true);
    expect(now.fab.on).toBe(true);
    expect(now.selection).toBe("浙江省杭州市西湖区示例路 478 号");
    await page.context().close();
  });

  test("手指点怎么去只报一遍（route）", async () => {
    const page = await open({ hasTouch: true });
    const cdp = await page.context().newCDPSession(page);
    await selectAndPress(page, "#en");
    const at = await chipCenter(page, "route");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(60);
    const sent = (await postedOf(page)).filter((m) => m.type === "element-map");
    expect(sent.map((m) => m.action)).toEqual(["route"]);
    expect(sent[0]).toMatchObject({ element: { text: { text: "1600 Example Street, Springfield" } } });
    await page.context().close();
  });

  test("按圆钮打字：这一行收起；换了语言字跟着换；靠右边时摆到圆钮左边", async () => {
    const page = await open();
    await selectAndPress(page, "#name");
    const before = await look(page);
    await page.mouse.click((before.fab.left + before.fab.right) / 2, (before.fab.top + before.fab.bottom) / 2);
    await page.waitForTimeout(40);
    expect((await look(page)).chips.on).toBe(false);
    expect((await postedOf(page)).filter((m) => m.type === "element-open")).toHaveLength(1);
    await callJson(page, "bubble", JSON.stringify({ kind: "none" }));
    await callJson(page, "texts", JSON.stringify({ map: true, "bridge.map.show": "Show on map", "bridge.map.route": "Directions" }));
    await selectAndPress(page, "#edgeAddr");
    const edge = await look(page);
    expect(edge.chips.on).toBe(true);
    expect(edge.chips.labels).toEqual(["Show on map", "Directions"]);
    expect(edge.chips.right).toBeLessThanOrEqual(edge.fab.left);
    expect(edge.chips.left).toBeGreaterThanOrEqual(0);
    await page.context().close();
  });

  test("开了 Trusted Types 的网页（require-trusted-types-for 'script'）：圆钮、这一行照样出来，两个按钮上是 SVG 图标，点了照样报；页面桥没有一处被拦", async () => {
    const page = await open({ csp: "require-trusted-types-for 'script'" });
    await selectAndPress(page, "#addr");
    const now = await look(page);
    expect(now.fab.on).toBe(true);
    expect(now.chips).toMatchObject({ on: true, labels: ["在地图上看", "怎么去"] });
    const icons = await page.evaluate(() =>
      Array.from((window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(".map-chip svg")).map((svg) => {
        const r = svg.getBoundingClientRect();
        return { svg: svg.namespaceURI === "http://www.w3.org/2000/svg", size: [r.width, r.height], hidden: svg.getAttribute("aria-hidden") };
      }),
    );
    expect(icons).toEqual([
      { svg: true, size: [15, 15], hidden: "true" },
      { svg: true, size: [15, 15], hidden: "true" },
    ]);
    const at = await chipCenter(page, "show");
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(40);
    expect((await postedOf(page)).filter((m) => m.type === "element-map").map((m) => m.action)).toEqual(["show"]);
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
    await page.context().close();
  });
});
