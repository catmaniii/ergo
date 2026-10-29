// 主切面（182 号票）：联网搜索队列的第四种"鸿蒙 App 的内置浏览器"。真的守护进程，秘书接 faux 剧本，测试扮演前端和发消息的那台设备
// （报浏览器的样子，连同"浏览"里在用的搜索引擎；收秘书的网页工具转来的事）；联网是正式的 createWebAccess，浏览器是假的、
// DeepSeek 是本机临时端口上的假服务（不连真网络、key 是假的）。
// - 设置接口：初始是四种、内置浏览器排最后、启用；162 号票存的三项的设置文件读成四项（内置浏览器加在最后）；
// - 内置浏览器排第一：从侧边栏来的那一轮，交给秘书的输入后面写着"这一轮联网搜索算上内置浏览器"，web_search 一种都不试、停下，
//   给出那台设备的搜索引擎（百度）搜这个查询的结果页地址，让秘书先用 browse_*；秘书页签里发的普通一轮没有那句，web_search 跳过它
//   走 DeepSeek；
// - 停用内置浏览器：侧边栏那一轮 web_search 不拿它搜（直接走 DeepSeek），那句也不写；用户要的网页操作（browse_open）照旧能做。
import fs from "node:fs";
import path from "node:path";
import {
  type BrowserOutcome,
  type BrowserRequest,
  type BrowsingContext,
  CHANNELS,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  METHODS,
  type ResponseFrame,
  type WebMethod,
  type WebSettings,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { createDeepSeekTools, createWebAccess, type FetchFunction } from "../../src/web/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { startFakeDeepSeekTools } from "../helpers/fake-deepseek-tools.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { webSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FakeBrowser } from "../helpers/web.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const SECRETARY = CHANNELS.secretary;
const FAKE_KEY = fakeSecret("sk-", "fake-web-app-browser-0000");
const BROWSER = "b-0123456789abcdef";
const PAGE = { title: "报名 · 示例", url: "https://form.example.cn/apply" };
const SIDEBAR: BrowsingContext = { browser: BROWSER, page: PAGE };

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
/** 假的直接请求：一律被拦（403） */
const blocked: FetchFunction = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => "" });

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const textOf = (m: MessageEnvelope | undefined) => (m?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
/** 秘书最后一次 echo_context 看到的上下文（去掉时间标记） */
const lastEcho = (frontend: TestFrontend) => stripTimeMarkers(textOf(messagesOf(frontend).filter((m) => m.speaker === "agent" && textOf(m).includes("[system]")).at(-1)));
/** 上下文里某个工具最后一次的结果 */
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length).split("\n[")[0]!;
/** 上下文里最后一条用户消息（连同交给秘书时加在后面的那段） */
const lastUserOf = (context: string) => context.slice(context.lastIndexOf("[user] ")).split("\n[assistant]")[0]!;
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

/** 用户说一句（侧边栏里发的带 browsing），等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string, browsing?: BrowsingContext) {
  const sent = await frontend.sendText(text, browsing ? { browsing } : {});
  await waitUntil(() => turnEnds(frontend).some((e) => e.inputMessageId === sent.messageId), { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
}

/** 假的设备：报浏览器的样子（"浏览"里用百度），收推给它的事、一律回办成了；记下收到的 */
function fakeDevice(device: TestFrontend, answer: (request: BrowserRequest) => BrowserOutcome) {
  const requests: BrowserRequest[] = [];
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of device.events({ channel: SECRETARY, type: EVENT_TYPES.browserRequest })) {
      const req = frame.payload as BrowserRequest;
      if (seen.has(req.id)) continue;
      seen.add(req.id);
      requests.push(req);
      void device.request(METHODS.browserReply, { id: req.id, result: answer(req) });
    }
  }, 10);
  return {
    requests,
    report: async () => ok(await device.request(METHODS.browserStatus, { browser: BROWSER, page: PAGE, searchEngine: "baidu" })),
    stop: () => clearInterval(timer),
  };
}

/** 起一个守护进程：正式的联网实现（假浏览器、假直接请求、假 DeepSeek），设置取自守护进程自己的设置 */
async function withWeb(secretary: FauxStep[], reuse?: { dataDir: string; homeDir: string }) {
  const server = await startFakeDeepSeekTools();
  const browser = new FakeBrowser(() => undefined);
  let td: TestDaemon | undefined;
  const webAccess = createWebAccess({
    browser,
    fetch: blocked,
    deepseek: createDeepSeekTools({ key: () => FAKE_KEY, baseUrl: server.baseUrl, retryDelaysMs: [0, 0], log: () => undefined }),
    settings: () => td!.daemon.webSettings.current(),
    log: () => undefined,
  });
  td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, webAccess, secretary, ...(reuse ? { reuse } : {}) });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [SECRETARY]: 0 });
  return { td, server, browser, frontend };
}

describe("设置里的四种方式", () => {
  it("初始：鸿蒙 App 的内置浏览器排最后、启用；162 号票存的三项的文件读成四项，它加在最后", async () => {
    const { url } = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY } });
    expect((await webSettingsApi.view(url)).body).toMatchObject({
      settings: queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]),
      effective: ["deepseek", "browser", "agent-browser", "app-browser"],
    });
    const dataDir = makeTempDir("ergo-data-");
    const file = dataDirLayout(dataDir).webSettingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ format: 2, ...queue(["browser", true], ["deepseek", false], ["agent-browser", true]) }));
    const old = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, reuse: { dataDir, homeDir: makeTempDir("ergo-home-") } });
    const view = (await webSettingsApi.view(old.url)).body;
    expect(view.settings).toEqual(queue(["browser", true], ["deepseek", false], ["agent-browser", true], ["app-browser", true]));
    expect(view.settingsFileError).toBeUndefined();
  });
});

describe("秘书的联网搜索和内置浏览器", () => {
  it("内置浏览器排第一：侧边栏那一轮写明算上它，web_search 停下、给出那台设备的搜索引擎的结果页地址；秘书页签的普通一轮跳过它走 DeepSeek", async () => {
    const search = call("web_search", { query: "二狗 天气", n: 2 });
    const { td, server, browser, frontend } = await withWeb([search, ECHO, search, ECHO]);
    await webSettingsApi.change(td.url, queue(["app-browser", true], ["deepseek", true], ["browser", true], ["agent-browser", true]));
    const device = fakeDevice(frontend, () => ({ ok: true }));
    await device.report();

    // 普通一轮（秘书页签里发的）：跳过内置浏览器，按 DeepSeek → 浏览器 → agent-browser
    await tell(frontend, "查一下二狗天气");
    const plain = lastEcho(frontend);
    expect(toolResultOf(plain, "web_search")).toMatch(/^搜索: 二狗 天气 （DeepSeek，2 条）/);
    expect(lastUserOf(plain)).not.toContain("内置浏览器");
    expect(server.count("search")).toBe(1);

    // 侧边栏那一轮：交给秘书的输入后面写明这一轮算上内置浏览器；web_search 一种都不试、停下，给出百度的结果页
    await tell(frontend, "帮我搜一下二狗天气", SIDEBAR);
    device.stop();
    const side = lastEcho(frontend);
    expect(lastUserOf(side)).toContain("这一轮联网搜索算上鸿蒙 App 的内置浏览器（设置里的顺序：鸿蒙 App 的内置浏览器 → DeepSeek → 浏览器 → agent-browser）");
    expect(toolResultOf(side, "web_search")).toBe(
      "这一轮联网搜索先用鸿蒙 App 的内置浏览器（用户在设置里把它排在前面）：用 browse_open 打开 https://www.baidu.com/s?wd=%E4%BA%8C%E7%8B%97%20%E5%A4%A9%E6%B0%94（百度搜「二狗 天气」的结果页）或者直接打开目标网站，再用 browse_read_page 读、browse_snapshot 和 browse_click 看和点" +
        "；还不成再调 web_search，engine 依次写 deepseek、browser；再不成用 agent-browser（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜。",
    );
    // 停下来的那一次没调 DeepSeek、没起浏览器，也没替秘书去开网页
    expect([server.count("search"), browser.visited, device.requests]).toEqual([1, [], []]);
  });

  it("停用内置浏览器：侧边栏那一轮 web_search 不拿它搜（直接走 DeepSeek），也不写那句；用户要的网页操作照旧能做", async () => {
    const { td, server, frontend } = await withWeb([call("web_search", { query: "二狗 天气", n: 2 }), call("browse_open", { url: "https://example.org/rules" }), ECHO]);
    await webSettingsApi.change(td.url, queue(["app-browser", false], ["deepseek", true], ["browser", true], ["agent-browser", true]));
    const device = fakeDevice(frontend, () => ({ ok: true }));
    await device.report();
    await tell(frontend, "搜一下二狗天气，再打开规则那一页", SIDEBAR);
    device.stop();
    const context = lastEcho(frontend);
    expect(lastUserOf(context)).not.toContain("这一轮联网搜索算上");
    expect(toolResultOf(context, "web_search")).toMatch(/^搜索: 二狗 天气 （DeepSeek，2 条）/);
    expect(server.count("search")).toBe(1);
    // browse_open 照旧转给了设备
    expect(device.requests.map((r) => r.op)).toEqual(["open"]);
    expect(toolResultOf(context, "browse_open")).not.toMatch(/只在用户从/);
  });
});
