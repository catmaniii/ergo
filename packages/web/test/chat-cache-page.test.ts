// 手机本机存的聊天记录（457），真 Chrome 里的页面：照 vite.config.ts 构建安装版，由假守护进程（test/chat-cache/fake-daemon.ts，127.0.0.1 上
// 系统挑的端口）提供页面、/ws 和往上翻的接口，秘书会话的事件日志照守护进程的规矩补发、分页：
// - 往上翻到头（向电脑要）、关掉重开再往上翻：第二次一次都不向电脑要，看到的一样；
// - 断网（往上翻的接口不通、WebSocket 断了连不上）时往上翻：存着的照样看得到；
// - 在电脑上回退过：旧分支上的不出现，看到的和一台新设备全部向电脑要的一样；
// - 设备被吊销、回到配对页：本机存的聊天记录整份删掉。
// 设了 ERGO_CHAT_CACHE_SHOTS（一个目录）时顺带截一张 Debug 工具集"连接"里"本机存的聊天记录"那一行。
// 不碰真的守护进程、~/.ergo、固定端口。本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findChrome } from "../build/chrome.ts";
import { type ChatFakeDaemon, startChatFakeDaemon } from "./chat-cache/fake-daemon.ts";
import { ConversationLog } from "./chat-cache/history-log.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = process.env.ERGO_CHAT_CACHE_SHOTS;

let html = "";
let browser: Browser | undefined;
const daemons: ChatFakeDaemon[] = [];

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

/** n 条消息，文字是"第 N 句" */
function chat(log: ConversationLog, n: number): void {
  const base = log.frames.filter((f) => f.type === "message").length;
  for (let i = 1; i <= n; i++) log.say(`m${base + i}`, `第 ${base + i} 句`, { speaker: i % 2 ? "user" : "agent" });
}

async function newPage(): Promise<{ page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { page, errors };
}

const shown = (page: Page, text: string, timeout = 15_000) => page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout });

/** 往上翻到头：点"更早的消息"直到没有（自动往上翻的也算） */
async function loadAll(page: Page): Promise<void> {
  const older = page.locator(".older-btn");
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    if ((await older.count()) === 0) return;
    if (await older.isDisabled().catch(() => true)) continue;
    await older.click({ timeout: 2000 }).catch(() => undefined);
  }
}

/** 会话里看到的每一条（文字，去掉气泡角上的时刻） */
const texts = (page: Page) => page.$$eval(".conv .msg", (els) => els.map((e) => (e.textContent ?? "").trim().replace(/\d{1,2}:\d{2}$/, "")));

/** 本机存的聊天记录里存了几条消息（库还没建出来是 null；先看有没有，免得这一下把空库建出来）。字符串：在页面里跑，不经 TypeScript */
const storedMessages = async (page: Page): Promise<number | null> =>
  (await page.evaluate(`(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "ergo-chat")) return null;
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("ergo-chat");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains("meta")) return null;
      const all = await new Promise((resolve, reject) => {
        const r = db.transaction("meta").objectStore("meta").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return all.reduce((n, m) => n + (m.count ?? 0), 0);
    } finally {
      db.close();
    }
  })()`)) as number | null;

describe.skipIf(!CHROME)("往上翻：手机本机存着的直接用，没有才向电脑要（457）", () => {
  test("往上翻一次、关掉重开再往上翻：第二次不向电脑要、内容一样；断网时往上翻照样看得到存着的", async () => {
    const log = new ConversationLog();
    chat(log, 160);
    const daemon = await startChatFakeDaemon(html, log);
    daemons.push(daemon);
    const { page, errors } = await newPage();
    await page.goto(daemon.url);
    await shown(page, "第 160 句");
    await loadAll(page);
    await shown(page, "第 1 句");
    const asked = daemon.historyRequests.length;
    expect(asked).toBeGreaterThanOrEqual(2);
    const first = await texts(page);
    expect(first.filter((t) => /^第 \d+ 句$/.test(t))).toHaveLength(160);
    await expect.poll(() => storedMessages(page), { timeout: 15_000, interval: 300 }).toBe(160);

    // 关掉重开（热打开）：往上翻到头一次都不向电脑要，看到的一样
    await page.reload();
    await shown(page, "第 160 句");
    await loadAll(page);
    await shown(page, "第 1 句");
    expect(daemon.historyRequests).toHaveLength(asked);
    expect(await texts(page)).toEqual(first);

    // 断网：往上翻的接口不通、WebSocket 也连不上了，往上翻照样看得到存着的
    await page.reload();
    await shown(page, "第 160 句");
    daemon.setOffline(true);
    await loadAll(page);
    await shown(page, "第 1 句");
    expect(await texts(page)).toEqual(first);
    expect(daemon.historyRequests).toHaveLength(asked);
    daemon.setOffline(false);

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.goto(`${daemon.url}#/more/about`);
      const version = page.locator(".about-version");
      for (let i = 0; i < 8; i++) await version.click();
      await page.goto(`${daemon.url}#/more/debug`);
      const row = page.getByText("本机存的聊天记录", { exact: true });
      await row.waitFor({ timeout: 10_000 });
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(SHOTS, "debug-chat-cache.png") });
    }
    expect(errors).toEqual([]);
  }, 180_000);

  test("在电脑上回退过：旧分支上的不出现，看到的和一台新设备全部向电脑要的一样", async () => {
    const log = new ConversationLog();
    chat(log, 150);
    const daemon = await startChatFakeDaemon(html, log);
    daemons.push(daemon);
    const { page, errors } = await newPage();
    await page.goto(daemon.url);
    await shown(page, "第 150 句");
    await loadAll(page);
    await expect.poll(() => storedMessages(page), { timeout: 15_000, interval: 300 }).toBe(150);

    // 关掉期间在电脑上回到第 100 句之前，又说了两句
    const target = log.frames.find((f) => f.type === "message" && (f.payload as { message: { id: string } }).message.id === "m100")!.seq;
    log.rollback(target);
    log.say("n1", "回退之后的第一句");
    log.say("n2", "回退之后的第二句", { speaker: "agent" });
    await page.reload();
    await shown(page, "回退之后的第二句");
    await loadAll(page);
    await shown(page, "第 1 句");
    const after = await texts(page);
    expect(after).toContain("第 99 句");
    expect(after).not.toContain("第 120 句");
    expect(after).not.toContain("第 150 句");

    // 一台新设备（空的浏览器）全部向电脑要：看到的一样
    const other = await newPage();
    await other.page.goto(daemon.url);
    await shown(other.page, "回退之后的第二句");
    await loadAll(other.page);
    await shown(other.page, "第 1 句");
    expect(after).toEqual(await texts(other.page));
    expect(errors).toEqual([]);
    expect(other.errors).toEqual([]);
  }, 180_000);

  test("设备被吊销、回到配对页：本机存的聊天记录整份删掉", async () => {
    const log = new ConversationLog();
    chat(log, 80);
    const daemon = await startChatFakeDaemon(html, log);
    daemons.push(daemon);
    const { page } = await newPage();
    await page.goto(daemon.url);
    await shown(page, "第 80 句");
    await loadAll(page);
    await expect.poll(() => storedMessages(page), { timeout: 15_000, interval: 300 }).toBe(80);
    daemon.revoke();
    await page.locator(".pair-page").waitFor({ timeout: 15_000 });
    await expect.poll(() => storedMessages(page), { timeout: 5000, interval: 200 }).toBe(0);
  }, 180_000);
});
