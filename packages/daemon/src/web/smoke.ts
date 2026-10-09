// 联网搜索、读网页的冒烟脚本（70 号票）：真的起浏览器、真的联网，手动跑，不进测试（npm test 不跑它）。
//   npm run smoke:web                                  # 默认搜"Node.js 最新版本"，读 https://example.com
//   npm run smoke:web -- "查询词" "https://某个网址"
//   npm run smoke:web -- "查询词" "https://某个网址" --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"
//   npm run smoke:web -- "查询词" --engine google --region cn-zh --time w
//   npm run smoke:web -- "查询词" --tavily              # 走 Tavily：key 从环境变量 TAVILY_API_KEY 取（和守护进程一样）
// 浏览器按守护进程同样的顺序找（web/browser-path.ts）：--browser 相当于配置里的 web.browserPath。
// 搜索和读网页都走正式的实现（createWebAccess + playwright-core），打印选了哪个浏览器、结果、正文的开头。
import os from "node:os";
import { tavilyKey } from "../config/secrets.ts";
import { createBrowserLocator, createWebAccess, playwrightDriver, SEARCH_ENGINES, SEARCH_TIMES, type SearchEngine, type SearchTime, searchResultText } from "./index.ts";

const args = process.argv.slice(2);
/** 带值的选项：--browser、--engine、--region、--time */
const valued = ["--browser", "--engine", "--region", "--time"];
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
const query = positional[0] ?? "Node.js 最新版本";
const url = positional[1] ?? "https://example.com";
const engine = option("--engine");
const time = option("--time");

const log = (line: string) => console.error(`[smoke] ${line}`);
const locator = createBrowserLocator({ configured: option("--browser"), homeDir: os.homedir(), env: process.env, log });
console.log(`浏览器：${locator.path() ?? `没找到——${locator.missingReason()}`}`);
const access = createWebAccess({
  browser: playwrightDriver({ executablePath: () => locator.path(), missing: () => locator.missingReason() }),
  tavilyKey: () => tavilyKey(process.env),
  log,
});

let failed = false;
const started = Date.now();
try {
  const found = await access.search({
    query,
    n: 5,
    ...(engine && (SEARCH_ENGINES as readonly string[]).includes(engine) ? { engine: engine as SearchEngine } : {}),
    ...(time && (SEARCH_TIMES as readonly string[]).includes(time) ? { time: time as SearchTime } : {}),
    region: option("--region"),
    tavily: args.includes("--tavily"),
  });
  console.log(`\n== 联网搜索（${found.engine}，${Date.now() - started} ms）==\n${searchResultText(query, found, args.includes("--json"))}`);
} catch (err) {
  failed = true;
  console.log(`\n== 联网搜索失败 ==\n${err instanceof Error ? err.message : String(err)}`);
}
const fetchStarted = Date.now();
try {
  const page = await access.fetch({ url, max: 1500 });
  console.log(`\n== 读网页（${page.via === "direct" ? "直接请求" : "浏览器"}，${Date.now() - fetchStarted} ms）==\n${page.text}`);
} catch (err) {
  failed = true;
  console.log(`\n== 读网页失败 ==\n${err instanceof Error ? err.message : String(err)}`);
}
process.exitCode = failed ? 1 : 0;
