// 联网搜索、读网页的冒烟脚本（70 号票）：真的起浏览器、真的联网，手动跑，不进测试（npm test 不跑它）。
//   npm run smoke:web                                  # 默认搜"Node.js 最新版本"，读 https://example.com
//   npm run smoke:web -- "查询词" "https://某个网址"
//   npm run smoke:web -- "查询词" "https://某个网址" --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"
//   npm run smoke:web -- "查询词" --engine google --region cn-zh --time w
//   npm run smoke:web -- "查询词" --tavily              # 走 Tavily：key 从环境变量 TAVILY_API_KEY 取（和守护进程一样）
//   npm run smoke:web -- "查询词" "https://某个网址" --deepseek
//                                                       # 154 号票：真的调 DeepSeek 的搜索、读网页接口（按次计费，每次 0.005 元）。
//                                                       # key 从环境变量 DEEPSEEK_API_KEY 取（和守护进程、模型共用同一份）；
//                                                       # 搜索指定 engine=deepseek，读网页直接调 DeepSeek 读网页（不先直接请求）
// 浏览器按守护进程同样的顺序找（web/browser-path.ts）：--browser 相当于配置里的 web.browserPath。
// 搜索和读网页都走正式的实现（createWebAccess + playwright-core + DeepSeek 客户端），打印选了哪个浏览器、结果、正文的开头。
import os from "node:os";
import { deepseekKey, tavilyKey } from "../config/secrets.ts";
import {
  createBrowserLocator,
  createDeepSeekTools,
  createWebAccess,
  playwrightDriver,
  SEARCH_TIMES,
  type SearchTime,
  searchResultText,
  truncate,
  WEB_SEARCH_ENGINES,
  type WebSearchEngine,
} from "./index.ts";

const args = process.argv.slice(2);
/** 带值的选项：--browser、--engine、--region、--time */
const valued = ["--browser", "--engine", "--region", "--time"];
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
const query = positional[0] ?? "Node.js 最新版本"; // @i18n-ignore log：命令行冒烟脚本的默认查询
const url = positional[1] ?? "https://example.com";
const useDeepseek = args.includes("--deepseek");
const engine = useDeepseek ? "deepseek" : option("--engine");
const time = option("--time");

const log = (line: string) => console.error(`[smoke] ${line}`);
const locator = createBrowserLocator({ configured: option("--browser"), homeDir: os.homedir(), env: process.env, log });
console.log(`浏览器：${locator.path() ?? `没找到——${locator.missingReason()}`}`);
const deepseek = createDeepSeekTools({ key: () => deepseekKey(process.env), log });
console.log(`DeepSeek 的 key：${deepseek.available() ? "配了（环境变量 DEEPSEEK_API_KEY）" : "没配（环境变量 DEEPSEEK_API_KEY 没有值）"}`);
const access = createWebAccess({
  browser: playwrightDriver({ executablePath: () => locator.path(), missing: () => locator.missingReason() }),
  tavilyKey: () => tavilyKey(process.env),
  deepseek,
  // 冒烟时不指定 engine 走浏览器（和改动前一样，读网页直接请求 → 浏览器）；--deepseek 时指定 engine=deepseek，所以队列里 DeepSeek 要启用着
  // （排在浏览器后面：不指定 engine 时照旧先浏览器）
  settings: () => ({
    queue: [
      { method: "browser", enabled: true },
      { method: "deepseek", enabled: useDeepseek },
      { method: "agent-browser", enabled: false },
      { method: "app-browser", enabled: false },
    ],
  }),
  log,
});

let failed = false;
const started = Date.now();
try {
  const found = await access.search({
    query,
    n: 5,
    ...(engine && (WEB_SEARCH_ENGINES as readonly string[]).includes(engine) ? { engine: engine as WebSearchEngine } : {}),
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
  if (useDeepseek) {
    const page = await deepseek.fetch(url);
    console.log(`\n== 读网页（DeepSeek 读网页，${Date.now() - fetchStarted} ms）==\n${truncate(`URL: ${url}\n标题: ${page.title}\n\n${page.content}`, 1500)}`);
  } else {
    const page = await access.fetch({ url, max: 1500 });
    console.log(`\n== 读网页（${page.via === "direct" ? "直接请求" : page.via === "deepseek" ? "DeepSeek" : "浏览器"}，${Date.now() - fetchStarted} ms）==\n${page.text}`);
  }
} catch (err) {
  failed = true;
  console.log(`\n== 读网页失败 ==\n${err instanceof Error ? err.message : String(err)}`);
}
process.exitCode = failed ? 1 : 0;
