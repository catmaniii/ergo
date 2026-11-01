// 向导"能力"那一步端到端：真的 Chrome 打开真的守护进程给的页面，下载是本机的假下载站，服务管家是替身，语音服务是假的，不联网。
// - 勾语音合成：确认框出来之前一个字节都不下；同意了后台下载、登记、启动、健康检查，那一行变成已装；再进向导能看到已装的和版本；
// - 不勾语音：只下向量模型，语音相关的一个请求都没有；下载失败能跳过，接着走下一步。
// **要本机的 Chrome / Edge 和构建好的网页（npm run build:web）**，缺一样就跳过，原因写进测试报告。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpTransport, loadManifest, parseManifest } from "../../src/components/index.ts";
import { DEFAULT_WEB_ROOT } from "../../src/daemon.ts";
import { createBrowserLocator } from "../../src/web/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { blob, type FakeDownloads, fakeProbes, makeZip, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { startFakeSpeechService } from "../helpers/tts.ts";

const executable = createBrowserLocator({ homeDir: os.homedir(), env: process.env, log: () => undefined }).path();
const built = fs.existsSync(path.join(DEFAULT_WEB_ROOT, "index.html"));

const PROGRAM = makeZip([{ name: "audiocpp_server.exe", body: blob(5000, 81) }]);
const MODEL = blob(90_000, 82);
const VECTOR = blob(70_000, 83);

/** 随程序发布的清单：向量模型、语音程序、语音合成模型的文件换成假下载站上的小文件，端口换成假语音服务的 */
function testManifest(fake: FakeDownloads, port: number) {
  const shipped = loadManifest().manifest;
  fake.put("vector.bin", VECTOR);
  fake.put("bin.zip", PROGRAM);
  fake.put("model.gguf", MODEL);
  const sources = [{ id: "a", title: "镜像 A", url: fake.source("a") }];
  return {
    signed: false,
    manifest: parseManifest({
      ...shipped,
      components: shipped.components.map((c) => {
        if (c.id === "bge-m3") return { ...c, sources, variants: [{ id: "q8", parts: [{ files: [{ path: "vector.bin", size: VECTOR.length, sha256: sha256(VECTOR) }] }] }] };
        if (c.id === "audiocpp") return { ...c, sources, service: { ...c.service!, port }, variants: [{ id: "cpu", parts: [{ files: [{ path: "bin.zip", size: PROGRAM.length, sha256: sha256(PROGRAM), extract: { format: "zip" as const, to: "bin" } }] }] }] };
        if (c.id === "tts") return { ...c, sources, serve: { ...c.serve!, file: "model.gguf" }, variants: [{ id: "q8", parts: [{ files: [{ path: "model.gguf", size: MODEL.length, sha256: sha256(MODEL) }] }] }] };
        return c;
      }),
    }),
  };
}

const ticked = (page: Page, key: string) => page.locator(`[data-capability="${key}"] input`).isChecked();

describe("向导的能力那一步（要本机的 Chrome / Edge 和构建好的网页，缺了跳过）", () => {
  let browser: Browser;
  beforeAll(async () => {
    if (!executable || !built) return;
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: executable, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach((ctx) => {
    ctx.skip(!executable || !built, "本机找不到 Chrome / Edge，或者网页还没构建（npm run build:web）");
  });

  /** 打开向导的能力那一步，等两份清单都到 */
  async function openStep(url: string, errors: string[]): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${url}/#/more/setup`, { waitUntil: "load" });
    await page.click('.setup-rail [data-step="capabilities"]', { timeout: 30_000 });
    await page.waitForSelector('[data-capability="component:tts"]', { timeout: 30_000 });
    await page.waitForSelector('[data-capability="plugin:memory"]', { timeout: 30_000 });
    return page;
  }

  it("勾语音合成：确认框之前不下载；同意后后台装好、接上服务，再进向导看得到已装的", { timeout: 120_000 }, async () => {
    const fake = await startFakeDownloads();
    const speech = await startFakeSpeechService();
    const port = Number(new URL(speech.url).port);
    await speech.down();
    const lsm = await startLsmStandIn({ owned: true });
    const td = await startTestDaemon({
      webRoot: DEFAULT_WEB_ROOT,
      env: lsm.env,
      speechUrl: speech.url,
      config: { voice: { speech: { probeSeconds: 1 } } },
      components: { manifest: testManifest(fake, port), probes: fakeProbes(), transport: createHttpTransport(), audiocpp: { healthTimeoutMs: 20_000, healthPollMs: 50 } },
    });
    await waitUntil(() => lsm.connections > 0, { timeoutMs: 10_000 });
    const errors: string[] = [];
    const page = await openStep(td.url, errors);

    // 默认：向量模型勾着，语音不勾；记忆运行中（勾着、点不了）
    expect(await ticked(page, "component:bge-m3")).toBe(true);
    expect(await ticked(page, "component:tts")).toBe(false);
    expect(await ticked(page, "component:asr")).toBe(false);
    expect(await ticked(page, "plugin:memory")).toBe(true);
    expect(await page.locator('[data-capability="plugin:memory"] input').isDisabled()).toBe(true);

    await page.locator('[data-capability="component:bge-m3"] input').uncheck();
    await page.locator('[data-capability="component:tts"] input').check();
    // 这个一共要下多大写在按钮上
    expect(await page.locator("[data-capability-start]").innerText()).toContain("要下载");
    await page.click("[data-capability-start]");

    // 确认框：名字、许可、原文；同意之前一个字节都不下
    await page.waitForSelector(".component-license-confirm", { timeout: 10_000 });
    const box = await page.locator(".component-license-confirm").innerText();
    expect(box).toContain("Fish Audio Research License");
    expect(box).toContain("商业使用要另外向 Fish Audio 取得授权");
    expect(fake.requests).toEqual([]);

    await page.locator(".auth-actions .btn.primary").click();
    await lsm.waitFor((m) => m.type === "services.start", "启动语音服务", { timeoutMs: 30_000 });
    await speech.up();
    await page.waitForSelector('[data-capability="component:tts"].capability-on', { timeout: 30_000 });
    expect(new Set(fake.requests.map((q) => q.path))).toEqual(new Set(["bin.zip", "model.gguf"]));

    // 接上了：服务管家里登记、进开机名单；向量模型没勾，没下
    await waitUntil(() => lsm.owned.services.get("audiocpp")?.autostart === true, { timeoutMs: 20_000 });
    expect(td.daemon.components.view().components.find((c) => c.id === "bge-m3")?.state).toBe("missing");

    // 再进向导：看得到已装的和版本，不再让勾
    await page.close();
    const again = await openStep(td.url, errors);
    expect(await again.locator('[data-capability="component:tts"] input').isDisabled()).toBe(true);
    const now = await again.locator(".capability-now").innerText();
    expect(now).toContain("语音合成模型");
    expect(now).toContain(td.daemon.components.view().components.find((c) => c.id === "tts")!.installedVersion!);
    // 确认过的再装别的不用再问：许可记着
    expect(td.daemon.components.view().components.find((c) => c.id === "tts")?.license?.accepted).toBe(true);
    await again.close();
    expect(errors).toEqual([]);
  });

  it("不勾语音：只下向量模型，语音相关的一个请求都没有；下载失败能跳过，接着走下一步", { timeout: 120_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await startTestDaemon({
      webRoot: DEFAULT_WEB_ROOT,
      components: { manifest: testManifest(fake, 1), probes: fakeProbes(), transport: createHttpTransport() },
    });
    fake.behave("a", { kind: "broken" });
    const errors: string[] = [];
    const page = await openStep(td.url, errors);
    await page.click("[data-capability-start]");

    // 下不下来：写原因，有重试、跳过
    const row = page.locator('[data-capability="component:bge-m3"]');
    await row.locator("button", { hasText: "跳过" }).waitFor({ timeout: 30_000 });
    expect(await row.locator(".field-error").count()).toBeGreaterThan(0);
    expect(new Set(fake.requests.map((q) => q.path))).toEqual(new Set(["vector.bin"]));

    // 跳过：写之后去哪重做；接着走下一步
    await row.locator("button", { hasText: "跳过" }).click();
    await row.locator(".capability-skipped").waitFor();
    await page.locator(".setup-page > .setup-actions .btn.primary").click();
    await page.waitForSelector('.setup-rail [data-step="phone"][aria-current="step"]', { timeout: 10_000 });

    // 回到这一步重试：好了就能装上
    fake.behave("a", { kind: "ok" });
    await page.click('.setup-rail [data-step="capabilities"]');
    await page.locator('[data-capability="component:bge-m3"] button', { hasText: "重试" }).click();
    await page.waitForSelector('[data-capability="component:bge-m3"].capability-on', { timeout: 30_000 });
    expect(new Set(fake.requests.map((q) => q.path))).toEqual(new Set(["vector.bin"]));
    await page.close();
    expect(errors).toEqual([]);
  });
});
