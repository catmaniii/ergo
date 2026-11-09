// 后台放久了切回来（450）：照 vite.config.ts 构建安装版，由假守护进程（test/open-snapshot/fake-daemon.ts，127.0.0.1 上系统挑的端口）
// 提供页面和 /ws，在真的 Chrome 里打开，把页面"切到后台"（Playwright 的页面总是看得见的：脚本跑之前把 document.visibilityState
// 换成看一个开关，切的时候发 visibilitychange），后台期间守护进程那边出事，再切回来：
// - 连接半开（手机被挂起时断开的消息没到：看着连着、其实不通）：几秒内发现、重连，补上后台时来的消息；原来一直停在旧样子；
// - 断开了、"还被信任吗"又挂着不回（网半死）：切回来马上重连；原来一直不重连；
// - 后台时网页换了一版：还在后台就刷新，切回来已经是新的，不在切回来那一刻白屏重新下页面、从头补。
// 不碰真的守护进程、~/.ergo、固定端口。本机没有 Chrome（或 Edge）时跳过。
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { findChrome } from "../build/chrome.ts";
import { type FakeDaemon, startFakeDaemon } from "./open-snapshot/fake-daemon.ts";
import { syntheticLog, USER_SCALE } from "./open-snapshot/synthetic.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

let html = "";
let browser: Browser | undefined;
const daemons: FakeDaemon[] = [];

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:web 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test）
  vi.stubEnv("NODE_ENV", "production");
  try {
    const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
    if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
    html = String(page.source);
  } finally {
    vi.unstubAllEnvs();
  }
  browser = await chromium.launch({ executablePath: CHROME });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  for (const d of daemons) await d.close();
});

/**
 * 页面脚本跑之前装上：document.visibilityState / hidden 看 sessionStorage 里的开关（刷新之后还在后台）；
 * 记下这一页什么时候开始的（刷新了就换了）
 */
const VISIBILITY_SCRIPT = `(() => {
  const hidden = () => sessionStorage.getItem("t450-hidden") === "1";
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get() { return hidden() ? "hidden" : "visible"; } });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get() { return hidden(); } });
})();`;

async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(`(() => { sessionStorage.setItem("t450-hidden", ${visible ? '"0"' : '"1"'}); document.dispatchEvent(new Event("visibilitychange")); })()`);
}

/** 量级小一点的日志：打开快 */
const SMALL = { ...USER_SCALE, secretaryMessages: 20, tasks: 10, updatesPerTask: 3, cards: 10, inboxItems: 10, activityEvents: 20, readMarks: 10, deviceEvents: 8, projectEvents: 20 };

async function open(): Promise<{ daemon: FakeDaemon; page: Page; errors: string[] }> {
  const daemon = await startFakeDaemon(html, syntheticLog(SMALL));
  daemons.push(daemon);
  const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(VISIBILITY_SCRIPT);
  await page.goto(daemon.url);
  await page.getByText("合成的第 10 句话", { exact: true }).waitFor({ timeout: 30_000 });
  return { daemon, page, errors };
}

/** 秘书会话里来一句（后台时来的） */
function say(daemon: FakeDaemon, text: string): void {
  daemon.push("secretary", "message", { message: { id: `m-${text}`, conversation: "secretary", speaker: "agent", time: "2026-11-09T10:00:00.000+08:00", parts: [{ type: "text", text }] } });
}

describe.skipIf(!CHROME)("后台放久了切回来（450）", () => {
  test("连接半开（看着连着、其实不通）：切回来几秒内发现、重连，补上后台时来的消息；这期间界面照样点得动", async () => {
    const { daemon, page, errors } = await open();
    const before = daemon.connections.length;
    await setVisible(page, false);
    daemon.blackhole();
    say(daemon, "后台时来的一句");
    await setVisible(page, true);
    // 马上点得动：切到任务页
    await page.locator('nav .nav-list [data-nav="tasks"]').click({ timeout: 1000 });
    await page.locator('nav .nav-list [data-nav="tasks"][aria-current="page"]').waitFor({ timeout: 1000 });
    await page.locator('nav .nav-list [data-nav="secretary"]').click({ timeout: 1000 });
    // 4 秒没动静就当它死了、马上重连：8 秒里一定补上（原来一直停在旧样子）
    await page.getByText("后台时来的一句", { exact: true }).waitFor({ timeout: 8000 });
    expect(daemon.connections.length).toBe(before + 1);
    expect(errors).toEqual([]);
  }, 60_000);

  test("后台时断开了、问“还被信任吗”又挂着不回（网半死）：切回来马上重连，补上后台时来的消息", async () => {
    const { daemon, page, errors } = await open();
    await setVisible(page, false);
    daemon.hangAccess(true);
    daemon.dropAll();
    say(daemon, "断开后来的一句");
    // 还在后台：问"还被信任吗"挂着
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await setVisible(page, true);
    await page.getByText("断开后来的一句", { exact: true }).waitFor({ timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    daemon.hangAccess(false);
    expect(errors).toEqual([]);
  }, 60_000);

  test("后台时网页换了一版：还在后台、什么都没打开就先刷新，切回来已经是新的（不在切回来那一刻刷新）；同一版不在后台一遍遍刷新", async () => {
    const { daemon, page, errors } = await open();
    const origin = (await page.evaluate("performance.timeOrigin")) as number;
    await setVisible(page, false);
    const reloaded = page.waitForEvent("load", { timeout: 15_000 });
    daemon.publishWebVersion("0123456789abcdef");
    await reloaded;
    // 刷新出来的还在后台、是新的那一版；为这一版在后台刷新过记在这个标签页里
    expect(await page.evaluate("document.visibilityState")).toBe("hidden");
    expect(await page.evaluate(`document.querySelector('meta[name="ergo-web-version"]').content`)).toBe("0123456789abcdef");
    expect(await page.evaluate(`sessionStorage.getItem("ergo-background-reload")`)).toBe("0123456789abcdef");
    const newOrigin = (await page.evaluate("performance.timeOrigin")) as number;
    expect(newOrigin).not.toBe(origin);
    await page.getByText("合成的第 10 句话", { exact: true }).waitFor({ state: "attached", timeout: 30_000 });
    // 切回来：不再刷新，马上就是补完的样子
    await setVisible(page, true);
    await page.getByText("合成的第 10 句话", { exact: true }).waitFor({ timeout: 2000 });
    await page.waitForTimeout(2500);
    expect(await page.evaluate("performance.timeOrigin")).toBe(newOrigin);
    expect(errors).toEqual([]);
  }, 90_000);
});
