// 部署后打开真的二狗页面看一眼（2026-10-18 用户要求：改了代码起码自己用网页打开看一下）：无头 Chrome 打开本机的守护进程
// （默认 http://127.0.0.1:8810/，本机打开不用配对），手机宽、电脑宽各一遍，等连上、等页面出字，挨个切主导航各页。页面抛出没接住的
// 错误、控制台报错、某一页一个字都没有、一直连不上，就算失败（退出码 1）。只看不动：不点按钮、不发消息（打开页面不写已读）。
// 手动跑，不进测试（测试不碰真的守护进程；界面打不打得开由 test/page-opens.test.ts 在演示页那份构建上查）。
// 那一份打开了"本机来的也要配对"（469）时本机打开也要凭证：带上那一份的本机程序令牌（数据目录按 ERGO_DATA_DIR，没设是 ~/.ergo；
// 守护进程每次起来写进密钥区），只发给要打开的那个地址，发往别处的请求一律拦下（令牌不出这一份二狗）。
//   npm run smoke:page
//   npm run smoke:page -- http://127.0.0.1:8810/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_TOKEN_FILE, LOCAL_TOKEN_HEADER } from "@ergo/protocol";
import { chromium, type Page } from "playwright-core";
import { findChrome } from "./chrome.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8810/";
const origin = new URL(base).origin;

/** 那一份的本机程序令牌：没有（没起来过、旧版本）就不带 */
function localToken(): string | undefined {
  const dataDir = process.env.ERGO_DATA_DIR?.trim() || path.join(os.homedir(), ".ergo");
  try {
    return fs.readFileSync(path.join(dataDir, ...LOCAL_TOKEN_FILE.split("/")), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
const token = localToken();
// 设置里只切两页：设置列表本身，和"角色与声音"（新加的一页，默认角色、角色表、每个 agent 用哪个角色都在这一页上）
const PAGES = ["#/secretary", "#/tasks", "#/projects", "#/inbox", "#/browse", "#/calendar", "#/more", "#/more/usage", "#/more/settings", "#/more/roles", "#/more/memory/curator"];
const DISCONNECTED = "连接断开";

const chrome = findChrome();
if (!chrome) {
  console.log("本机找不到 Chrome / Edge，没法打开页面");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: chrome });
const problems: string[] = [];

async function text(page: Page): Promise<string> {
  return (await page.innerText("body")).trim();
}

try {
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    const page = await browser.newPage({ viewport, ...(token === undefined ? {} : { extraHTTPHeaders: { [LOCAL_TOKEN_HEADER]: token } }) });
    // 带着令牌时只许连要打开的那个地址（二狗的页面本来就不请求外部地址），别处的拦下
    if (token !== undefined) await page.route((url) => (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin, (route) => route.abort());
    page.on("pageerror", (e) => problems.push(`${name}：没接住的错误：${String(e)}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`${name}：控制台报错：${m.text()}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 500) problems.push(`${name}：${r.status()} ${r.url()}`);
    });
    const started = Date.now();
    await page.goto(base, { waitUntil: "load", timeout: 30_000 });
    // 等连上：页面出字、没有"连接断开"（最多 15 秒）
    let connected = false;
    for (let i = 0; i < 30 && !connected; i++) {
      await page.waitForTimeout(500);
      const t = await text(page);
      connected = t !== "" && !t.includes(DISCONNECTED);
    }
    if (!connected) problems.push(`${name}：15 秒还没连上（页面${(await text(page)) === "" ? "一个字都没有" : `写着"${DISCONNECTED}"`}）`);
    // 落在配对页上：那一份要凭证（外网端口，或者开着"本机来的也要配对"却没找到它的令牌），后面切的页都是配对页，不算打开正常
    if ((await page.locator(".pair-page").count()) > 0) {
      problems.push(`${name}：看到的是配对页（${token === undefined ? "没找到这一份的本机程序令牌：ERGO_DATA_DIR 指的是它的数据目录吗" : "带着的令牌不对：这一份二狗重启过的话再跑一次"}）`);
      await page.close();
      continue;
    }
    for (const hash of PAGES) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(400);
      if ((await text(page)) === "") problems.push(`${name}：${hash} 一个字都没有`);
    }
    console.log(`${name}：${connected ? "连上了" : "没连上"}，切了 ${PAGES.length} 页，用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    await page.close();
  }
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.log(`\n有 ${problems.length} 处不对：\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`\n${base} 打开正常`);
}
