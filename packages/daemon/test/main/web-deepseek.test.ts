// 主切面（154 号票起；162 号票改成按设置里的队列）：联网搜索、读网页接 DeepSeek 的 Search / Fetch 接口和浏览器。真的守护进程，
// 秘书接 faux 剧本，测试扮演前端；联网是正式的 createWebAccess，但浏览器是假的、直接请求是假的、DeepSeek 是本机临时端口上的假服务
// （不连真网络、key 是假的）。
// 182 号票起队列是四种（多鸿蒙 App 的内置浏览器，秘书页签里发的普通一轮跳过它；侧边栏那一轮见 web-app-browser.test.ts）。
// - 设置接口：GET 看存着的队列、实际用的顺序、key 配没配（响应里没有 key 的内容）；POST 整份存，不合规（形状不对、一个启用的都没留、
//   多出来的字段、154 号票的旧写法）回 400；没配 key 时实际的顺序里没有 DeepSeek；154 号票的旧设置文件读成队列；
// - 初始顺序：秘书的 web_search 走 DeepSeek，web_fetch 直接请求被拦后走 DeepSeek 读网页；成了的调用记进账本（秘书的是系统开销），
//   消耗页的 web 一节看得到次数和花费；改成浏览器排第一以后下一次搜索走浏览器、不调 DeepSeek、不记账（秘书按新的装配重新拉起）；
// - 回退顺序：浏览器排第一而浏览器没搜到时换 DeepSeek 并写明；停用了的方式重新装配后参数里没有、硬写过不了参数校验，不发请求；
//   只启用了 agent-browser 时 web_search 回"只用 agent-browser"。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type WebMethod, type WebSettings } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { createDeepSeekTools, createWebAccess, type FetchFunction } from "../../src/web/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeDeepSeekTools } from "../helpers/fake-deepseek-tools.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { request, usageApi, webSettingsApi } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FakeBrowser } from "../helpers/web.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const FAKE_KEY = fakeSecret("sk-", "fake-web-deepseek-0000");
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ALL_TIME = { from: "2000-01-01", to: "2100-12-31" };
/** 假的直接请求：一律被拦（403），读网页就会交给后面的 */
const blocked: FetchFunction = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => "" });
const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
const INITIAL = queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]);
/** 假浏览器：DDG 的结果页有两条（标题里有查询词，过得了相关性的门槛）；dead 时什么都打不开 */
const ddgBrowser = (dead = false) =>
  new FakeBrowser((u) =>
    !dead && new URL(u).hostname === "duckduckgo.com"
      ? {
          results: [
            { title: "DeepSeek V4 一", url: "https://a.example/1", snippet: "" },
            { title: "DeepSeek V4 二", url: "https://a.example/2", snippet: "" },
          ],
        }
      : undefined,
  );

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);
}

/** 秘书最后一条消息的文字（echo_context 回的上下文） */
const lastEcho = (frontend: TestFrontend): string =>
  frontend
    .events({ channel: CHANNELS.secretary, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");

/** 起一个守护进程：正式的联网实现（假浏览器、假直接请求、假 DeepSeek），设置取自守护进程自己的设置 */
async function withWeb(options: { browser: FakeBrowser; secretary: FauxStep[]; fetch?: FetchFunction; reuse?: { dataDir: string; homeDir: string } }) {
  const server = await startFakeDeepSeekTools();
  let td: TestDaemon | undefined;
  const webAccess = createWebAccess({
    browser: options.browser,
    fetch: options.fetch ?? blocked,
    deepseek: createDeepSeekTools({ key: () => FAKE_KEY, baseUrl: server.baseUrl, retryDelaysMs: [0, 0], log: () => undefined }),
    settings: () => td!.daemon.webSettings.current(),
    log: () => undefined,
  });
  td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, webAccess, secretary: options.secretary, ...(options.reuse ? { reuse: options.reuse } : {}) });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [CHANNELS.secretary]: 0 });
  return { td, server, frontend };
}

describe("设置里的联网搜索队列（接口）", () => {
  it("配了 key：初始 DeepSeek → 浏览器 → agent-browser；整份存、写成 format 2；不合规回 400；响应里没有 key 的内容", async () => {
    const { url, daemon } = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY } });
    const view = await webSettingsApi.view(url);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ settings: INITIAL, effective: ["deepseek", "browser", "agent-browser", "app-browser"], deepseekKey: { configured: true, envVar: "DEEPSEEK_API_KEY" } });
    expect((await request(url, "/api/web-settings")).body.toString("utf8")).not.toContain(FAKE_KEY);
    const next = queue(["agent-browser", true], ["browser", true], ["deepseek", false], ["app-browser", false]);
    const saved = await webSettingsApi.change(url, next);
    expect(saved.body).toMatchObject({ settings: next, effective: ["agent-browser", "browser"] });
    expect(JSON.parse(fs.readFileSync(daemon.layout.webSettingsFile, "utf8"))).toEqual({ format: 2, ...next });
    const bad: Record<string, unknown>[] = [
      { search: "browser", deepseekFetch: true },
      { ...queue(["deepseek", true], ["deepseek", true], ["browser", true], ["agent-browser", true]) },
      { ...queue(["deepseek", false], ["browser", false], ["agent-browser", false], ["app-browser", false]) },
      { ...INITIAL, extra: 1 },
    ];
    for (const body of bad) {
      const res = await webSettingsApi.change(url, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/^联网设置的参数不对：/);
    }
    expect((await webSettingsApi.view(url)).body.settings).toEqual(next);
  });

  it("没配 key：实际的顺序里没有 DeepSeek；只启用 DeepSeek 存不进去", async () => {
    const { url } = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    expect((await webSettingsApi.view(url)).body).toMatchObject({ settings: INITIAL, effective: ["browser", "agent-browser", "app-browser"], deepseekKey: { configured: false } });
    const res = await webSettingsApi.change(url, queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("联网设置的参数不对：至少要留一种启用的方式（没配 DeepSeek 的 key，只启用它不算）");
  });

  it("154 号票的旧设置文件（默认浏览器、不用 DeepSeek 读网页）读成队列：浏览器排第一、DeepSeek 第二", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const file = dataDirLayout(dataDir).webSettingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ format: 1, search: "browser", deepseekFetch: false }));
    const { url } = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, reuse: { dataDir, homeDir: makeTempDir("ergo-home-") } });
    expect((await webSettingsApi.view(url)).body).toMatchObject({ settings: queue(["browser", true], ["deepseek", true], ["agent-browser", true], ["app-browser", true]), effective: ["browser", "deepseek", "agent-browser", "app-browser"] });
    expect((await webSettingsApi.view(url)).body.settingsFileError).toBeUndefined();
  });
});

describe("秘书的联网搜索、读网页按队列走，DeepSeek 成了的记账", () => {
  it("初始顺序走 DeepSeek（读网页直接请求被拦后走 DeepSeek），记在秘书名下（系统开销），消耗页看得到；浏览器排第一后不调 DeepSeek、不记账，秘书按新的装配重新拉起", async () => {
    const browser = ddgBrowser();
    // faux 的剧本每个子进程从头来：改了设置、秘书重新拉起后同样的三步再走一遍
    const { td, server, frontend } = await withWeb({ browser, secretary: [call("web_search", { query: "DeepSeek V4", n: 2 }), call("web_fetch", { url: "https://a.example/article" }), { kind: "echo_context" }] });
    await tell(frontend, "查一下 DeepSeek V4");
    expect(server.requests.map((r) => [r.kind, r.body])).toEqual([
      ["search", { query: "DeepSeek V4", count: 2 }],
      ["fetch", { url: "https://a.example/article" }],
    ]);
    expect(server.requests.every((r) => r.authorization === `Bearer ${FAKE_KEY}`)).toBe(true);
    expect(lastEcho(frontend)).toContain("[toolResult] web_search: 搜索: DeepSeek V4 （DeepSeek，2 条）");
    expect(browser.visited).toEqual([]);

    const usage = await usageApi.summary(td.url, ALL_TIME);
    expect(usage.status).toBe(200);
    expect(usage.body.web.search.calls).toBe(1);
    expect(usage.body.web.fetch.calls).toBe(1);
    expect(usage.body.web.search.cost + usage.body.web.fetch.cost).toBeCloseTo(0.01, 10);
    expect(usage.body.web.agents.map((a) => [a.agentId, a.role, a.category, a.search.calls, a.fetch.calls])).toEqual([["secretary", "secretary", "system", 1, 1]]);

    const pid = td.daemon.secretary.pid;
    await webSettingsApi.change(td.url, queue(["browser", true], ["deepseek", true], ["agent-browser", true], ["app-browser", true]));
    await tell(frontend, "再查一下");
    // 搜索走浏览器的 DDG，读网页直接请求被拦后也是浏览器：DeepSeek 一次都没再调，不记账
    expect(server.requests).toHaveLength(2);
    expect(browser.visited.map((u) => new URL(u).hostname)).toEqual(["duckduckgo.com", "a.example"]);
    expect(lastEcho(frontend)).toContain("[toolResult] web_search: 搜索: DeepSeek V4 （浏览器 ddg，2 条）");
    expect((await usageApi.summary(td.url, ALL_TIME)).body.web.search.calls).toBe(1);
    // 工具说明跟着队列变：秘书按新的装配重新拉起了
    expect(td.daemon.secretary.pid).not.toBe(pid);
  });

  it("浏览器排第一没搜到：换下一个 DeepSeek 并写明", async () => {
    const { td, server, frontend } = await withWeb({ browser: ddgBrowser(true), secretary: [call("web_search", { query: "DeepSeek V4", n: 2 }), { kind: "echo_context" }] });
    await webSettingsApi.change(td.url, queue(["browser", true], ["deepseek", true], ["agent-browser", false], ["app-browser", false]));
    await tell(frontend, "查一下");
    const seen = lastEcho(frontend);
    expect(seen).toContain("[toolResult] web_search: 搜索: DeepSeek V4 （DeepSeek，2 条）");
    expect(seen).toMatch(/说明: 浏览器没搜到（ddg：.*；bing：.*；google：.*），这次用的是 DeepSeek/);
    expect(server.count("search")).toBe(1);
  });

  it("停用了的方式显式指定：秘书重新装配后参数里没有它，硬写也过不了参数校验，不发请求（还是旧装配时回“这种方式已停用”，见 web/tools、web/access 的单测）", async () => {
    const { td, server, frontend } = await withWeb({ browser: ddgBrowser(), secretary: [call("web_search", { query: "DeepSeek V4", engine: "deepseek" }), { kind: "echo_context" }] });
    await webSettingsApi.change(td.url, queue(["browser", true], ["agent-browser", true], ["deepseek", false], ["app-browser", false]));
    await tell(frontend, "用 DeepSeek 搜");
    expect(lastEcho(frontend)).toContain('[toolResult] web_search: Validation failed for tool "web_search"');
    expect(server.requests).toEqual([]);
  });

  it("只启用了 agent-browser：web_search 回“联网搜索现在只用 agent-browser”，不调 DeepSeek、不起浏览器", async () => {
    const browser = ddgBrowser();
    const { td, server, frontend } = await withWeb({ browser, secretary: [call("web_search", { query: "DeepSeek V4" }), { kind: "echo_context" }] });
    await webSettingsApi.change(td.url, queue(["agent-browser", true], ["deepseek", false], ["browser", false], ["app-browser", false]));
    await tell(frontend, "查一下");
    expect(lastEcho(frontend)).toContain("[toolResult] web_search: 联网搜索现在只用 agent-browser（用户在设置里只启用了它）：用 agent-browser");
    expect([server.requests, browser.visited]).toEqual([[], []]);
  });
});
