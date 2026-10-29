// 部署后打开真的二狗页面看一眼（2026-10-18 用户要求：改了代码起码自己用网页打开看一下）：无头 Chrome 打开本机的守护进程
// （默认 http://127.0.0.1:8810/，本机打开不用配对），手机宽、电脑宽各一遍，等连上、等页面出字，挨个切主导航各页。页面抛出没接住的
// 错误、控制台报错、某一页一个字都没有、一直连不上，就算失败（退出码 1）。只看不动：不点按钮、不发消息（打开页面不写已读）。
// 手动跑，不进测试（测试不碰真的守护进程；构建产物打不打得开由 test/page-opens.test.ts 在原型假数据上查）。
//   npm run smoke:page
//   npm run smoke:page -- http://127.0.0.1:8810/
import { chromium, type Page } from "playwright-core";
import { findChrome } from "./chrome.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8810/";
// 设置里只切两页：设置列表本身，和"角色与声音"（248 号票新加的一页，默认角色、角色表、每个 agent 用哪个角色都在这一页上）
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
    const page = await browser.newPage({ viewport });
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
