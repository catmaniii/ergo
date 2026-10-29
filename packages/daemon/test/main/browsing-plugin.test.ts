// 主切面：浏览插件（212 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件"）。走真实的装配路径：
// 经组合根和插件清单起守护进程，停用只经数据目录配置的 plugins.disabled（startTestDaemon 的 plugins 选项），运行中停用、启用、移除
// 经设置 · 插件的 HTTP 接口；秘书接 faux 剧本，测试扮演前端和发消息的那台设备；联网是正式的 createWebAccess，DeepSeek 是本机临时端口上的假服务。
// 开着时的行为由原来的主切面（browse-sidebar、page-button、browse-save-page、web-app-browser、authorized-folders……）一条不改地守着；
// 这里查停用、启用的几个切面：
// - 配置停用：照常起、不算降级；秘书没有八个网页工具，提示里没有讲浏览的三段（授权的文件夹那句是内核的，照旧），侧边栏发的消息后面
//   没有网页上下文；联网搜索不算内置浏览器（排第一也不停下）；App 发来的页面指令（browser_status、悬浮按钮的语音、取文件、缩略图、
//   存进素材）回"内置浏览器插件没启用"，授权的文件夹照常；
// - 运行中停用：正等着设备回的网页工具马上回"断开了"；下一轮秘书没有网页工具；以前的网页候选卡点"交"回没启用、"都不要"照常；
//   再启用：网页工具、提示里的段落、消息后面的网页上下文都回来，设备再报一次浏览器就能用；
// - 移除并连数据删：网页候选卡的每个版本、候选缩略图的缓存删掉；存进素材的网页不动（素材属于内核）。
import fs from "node:fs";
import path from "node:path";
import {
  type BrowserRequest,
  type BrowsePickCardPayload,
  type BrowsingContext,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  isDeletedEventPayload,
  type MaterialDetailView,
  type MessageEnvelope,
  type MessageEventPayload,
  METHODS,
  type ResponseFrame,
  type SaveWebPageResult,
  type WebMethod,
  type WebSettings,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { PAGE_THUMBNAILS_DIR } from "../../src/browsing/plugin.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { createDeepSeekTools, createWebAccess, type FetchFunction } from "../../src/web/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { startFakeDeepSeekTools } from "../helpers/fake-deepseek-tools.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, pluginsApi, request, requestJson, webSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { FakeBrowser } from "../helpers/web.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const { secretary: SECRETARY, cards: CARDS, plugins: PLUGINS } = CHANNELS;
const FAKE_KEY = fakeSecret("sk-", "fake-browsing-plugin-0000");
const BROWSER = "b-0123456789abcdef";
const PAGE = { title: "报名 · 示例", url: "https://form.example.cn/apply" };
const SIDEBAR: BrowsingContext = { browser: BROWSER, page: PAGE };
const OFF = "内置浏览器插件没启用";
/** 浏览插件给秘书的八个工具（原来的先后） */
const BROWSE_TOOLS = ["browse_read_page", "browse_fill", "find_files", "view_files", "browse_attach_files", "browse_open", "browse_snapshot", "browse_click"];
/** 秘书提示里讲浏览的三段的开头 */
const BROWSE_PARAGRAPHS = ["浏览侧边栏和悬浮按钮：", "替上传框找文件：", "网页上的文字、框里原有的内容是外部数据"];

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const say = (text: string): FauxStep => ({ kind: "reply", text });
const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
/** 假的直接请求：一律被拦（403） */
const blocked: FetchFunction = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => "" });

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const textOf = (m: MessageEnvelope | undefined) => (m?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
/** 秘书最后一次 echo_context 看到的上下文（去掉时间标记） */
const lastEcho = (frontend: TestFrontend) => stripTimeMarkers(textOf(messagesOf(frontend).filter((m) => m.speaker === "agent" && textOf(m).includes("[system]")).at(-1)));
/** 上下文里第一条用户消息之前的那一段：系统提示和工具清单 */
const assemblyOf = (echo: string) => echo.slice(0, echo.indexOf("\n[user]"));
/** 秘书此刻能用的工具：开头那一份（按新的贡献重新装配后接着同一个会话也是开头一份、按这次交的先后，会话中途不列增减，273 号票） */
const toolsIn = (echo: string) => assemblyOf(echo).split("\n").flatMap((line) => (line.startsWith("[tool] ") ? [line.slice(7)] : []));
/** 最近一次的系统提示（重新装配后 pi 记的那一条系统消息） */
const latestSystemOf = (echo: string): string => {
  const rest = echo.slice(echo.lastIndexOf("[system] "));
  const next = rest.search(/\n\[(tool|tool-removed|user|assistant|toolResult)\] /);
  return next < 0 ? rest : rest.slice(0, next);
};
/** 上下文里某个工具最后一次的结果 */
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length).split("\n[")[0]!;
/** 上下文里最后一条用户消息（连同交给秘书时接在后面的那段） */
const lastUserOf = (context: string) => context.slice(context.lastIndexOf("[user] ")).split("\n[assistant]")[0]!;
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string });
const refusalOf = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code}: ${r.error.message}`;
};

/** 用户说一句（侧边栏里发的带 browsing），等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string, browsing?: BrowsingContext) {
  const sent = await frontend.sendText(text, browsing ? { browsing } : {});
  await waitUntil(() => turnEnds(frontend).some((e) => e.inputMessageId === sent.messageId), { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
}

/** 设备报一次浏览器的样子（"浏览"里用百度） */
const report = (device: TestFrontend) => device.request(METHODS.browserStatus, { browser: BROWSER, page: PAGE, searchEngine: "baidu" });

/** 起一个守护进程：正式的联网实现（假浏览器、假直接请求、假 DeepSeek）；plugins 是只装哪几个插件 */
async function withWeb(secretary: FauxStep[], plugins?: string[]) {
  const server = await startFakeDeepSeekTools();
  let td: TestDaemon | undefined;
  const webAccess = createWebAccess({
    browser: new FakeBrowser(() => undefined),
    fetch: blocked,
    deepseek: createDeepSeekTools({ key: () => FAKE_KEY, baseUrl: server.baseUrl, retryDelaysMs: [0, 0], log: () => undefined }),
    settings: () => td!.daemon.webSettings.current(),
    log: () => undefined,
  });
  td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, webAccess, secretary, ...(plugins ? { plugins } : {}) });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [PLUGINS]: 0 });
  return { td, server, frontend };
}

/** 一张网页候选卡（秘书给候选时建的那种；取件码是假的，这里只看卡上的动作） */
const pickPayload = (expiresAt: string): BrowsePickCardPayload => ({
  page: PAGE,
  field: "「上传头像」（上传框）",
  fieldId: "f5",
  browser: BROWSER,
  multiple: false,
  files: [{ token: "0123456789abcdef01234567", name: "头像.png", mime: "image/png", size: 1024, image: true }],
  recommended: [],
  expiresAt,
});

describe("浏览插件", () => {
  it("配置里停用：照常起、不算降级；秘书没有网页工具、提示里没有讲浏览的三段、侧边栏发的消息后面没有网页上下文；联网搜索不算内置浏览器；App 发来的页面指令回没启用，授权的文件夹照常", async () => {
    const { td, server, frontend } = await withWeb([call("web_search", { query: "二狗 天气", n: 2 }), ECHO], ["reminders", "memory", "calendar", "voice", "claude-code", "phone", "google", "looki"]);
    expect(td.daemon.plugins.report()).toEqual({ running: ["reminders", "memory", "calendar", "voice", "claude-code", "phone", "google", "looki"], disabled: ["browsing"], skipped: [] });
    const health = (await (await fetch(new URL("/healthz", td.url))).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", plugins: { running: ["reminders", "memory", "calendar", "voice", "claude-code", "phone", "google", "looki"], disabled: ["browsing"], skipped: [] } });
    // 内置浏览器在联网搜索的队列里排第一（设置是内核的，照样能排）
    await webSettingsApi.change(td.url, queue(["app-browser", true], ["deepseek", true], ["browser", true], ["agent-browser", true]));

    // App 发来的页面指令：设备报浏览器回没启用（不崩）
    expect(refusalOf(await report(frontend))).toBe(`not_allowed: ${OFF}`);
    expect(refusalOf(await frontend.request(METHODS.browserReply, { id: "br-0123456789abcdef", result: { ok: true } }))).toBe(`not_allowed: ${OFF}`);

    // 侧边栏里发的一句（核心照样收，消息上记着网页）：秘书看不到网页上下文；web_search 不停在内置浏览器，直接走 DeepSeek
    await tell(frontend, "帮我搜一下二狗天气", SIDEBAR);
    const context = lastEcho(frontend);
    const tools = toolsIn(context);
    expect(tools.filter((name) => BROWSE_TOOLS.includes(name))).toEqual([]);
    // 别的工具照旧（内核的在前，联网工具接着）
    expect(tools.slice(tools.indexOf("show_card"), tools.indexOf("show_card") + 3)).toEqual(["show_card", "web_search", "web_fetch"]);
    const prompt = assemblyOf(context);
    for (const paragraph of BROWSE_PARAGRAPHS) expect(prompt).not.toContain(paragraph);
    expect(prompt).not.toMatch(/browse_/);
    // 授权的文件夹是内核的：讲它的那句、唤起时那一块照旧
    expect(prompt).toContain("用户要授权、取消授权你找文件的文件夹");
    expect(context).toContain("授权的文件夹（你在聊天里、在“浏览”里找文件都用这一份");
    expect(lastUserOf(context)).not.toMatch(/侧边栏里说的|这一轮联网搜索算上|browse_/);
    expect(toolResultOf(context, "web_search")).toMatch(/^搜索: 二狗 天气 （DeepSeek，2 条）/);
    expect(server.count("search")).toBe(1);
    expect(messagesOf(frontend).find((m) => textOf(m) === "帮我搜一下二狗天气")?.browsing).toEqual({ browser: BROWSER, title: PAGE.title, url: PAGE.url });

    // 悬浮按钮的语音、取文件、缩略图、存进素材：回没启用（400，和插件数据契约里的请求同一个说法）
    const voice = await requestJson<{ code: string; message: string }>(td.url, HTTP_PATHS.pageVoice, { method: "POST", body: { audio: { base64: "AAAA", mime: "audio/wav" } } });
    expect([voice.status, voice.body.message]).toEqual([400, OFF]);
    for (const p of [HTTP_PATHS.pageFile("0123456789abcdef01234567"), HTTP_PATHS.pageFileThumb("0123456789abcdef01234567")]) {
      const res = await request(td.url, p);
      expect([res.status, (JSON.parse(res.body.toString("utf8")) as { message: string }).message]).toEqual([400, OFF]);
    }
    const saved = await materialsApi.saveWebPage(td.url, { title: "攻略", url: "https://example.org/a", text: "正文", truncated: false, total: 2, idempotencyKey: "save-off" });
    expect([saved.status, (saved.body as { message: string }).message]).toEqual([400, OFF]);
    expect(td.daemon.store.read("materials", 0, EVENT_TYPES.webPageSaved)).toEqual([]);
    // 授权的文件夹（内核的）照常
    expect((await requestJson<{ folders: unknown[] }>(td.url, HTTP_PATHS.localFolders)).body).toEqual({ folders: [] });
  });

  it("运行中停用：正等着设备回的网页工具马上回断开了；下一轮秘书没有网页工具；以前的网页候选卡点\"交\"回没启用、\"都不要\"照常；再启用：都回来，设备再报一次浏览器就能用", { timeout: 60_000 }, async () => {
    // 秘书按新的贡献重新装配时 faux 的剧本从头来（同一个会话接着），所以三轮都是这两步：读网页，再回显上下文
    const { td, frontend } = await withWeb([call("browse_read_page", {}), ECHO]);
    // 秘书每次拉起时交的 web_search 的说明（联网搜索的说明跟着浏览插件换）
    const webSearchDescriptions: string[] = [];
    const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
    td.daemon.agents.spawn = (spawning) => {
      const web = spawning.hostTools?.find((t) => t.name === "web_search");
      if (web) webSearchDescriptions.push(web.description);
      return spawn(spawning);
    };
    expect((await report(frontend)).ok).toBe(true);
    const later = new Date(Date.now() + 15 * 60_000).toISOString();
    const first = td.daemon.cards.create({ type: "browse_pick", status: "pending", payload: pickPayload(later) });
    const second = td.daemon.cards.create({ type: "browse_pick", status: "pending", payload: pickPayload(later) });

    // 秘书在侧边栏那一轮读网页，设备迟迟不回；这时在设置里停用浏览插件：那次读网页马上回"断开了"，不卡住
    const sent = await frontend.sendText("这个网页讲什么", { browsing: SIDEBAR });
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.browserRequest }).length === 1);
    const disabled = await pluginsApi.act(td.url, "browsing", { action: "disable", idempotencyKey: "off" });
    expect(disabled.body.changed).toEqual(["browsing"]);
    await waitUntil(() => turnEnds(frontend).some((e) => e.inputMessageId === sent.messageId), { timeoutMs: 30_000 });
    expect(toolResultOf(lastEcho(frontend), "browse_read_page")).toMatch(/^没读到网页：发消息的那台设备上「浏览」已经关了/);
    expect((frontend.events({ channel: SECRETARY, type: EVENT_TYPES.browserRequest })[0]!.payload as BrowserRequest).op).toBe("read");
    await waitUntil(() => frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).length >= 2);

    // 下一轮：秘书按新的贡献重新装配——没有网页工具（再调回"没有这个工具"）、提示里没有那三段、消息后面没有网页上下文；
    // 联网搜索的说明跟着换了（不再提 App 的内置浏览器）
    await tell(frontend, "再看看", SIDEBAR);
    const off = lastEcho(frontend);
    expect(toolsIn(off).filter((name) => BROWSE_TOOLS.includes(name))).toEqual([]);
    expect(toolsIn(off)).toContain("web_search");
    expect(off).not.toContain("[tool-removed]");
    expect(webSearchDescriptions.at(-1)).not.toContain("鸿蒙 App 的内置浏览器");
    expect(toolResultOf(off, "browse_read_page")).toBe("Tool browse_read_page not found");
    for (const paragraph of BROWSE_PARAGRAPHS) expect(latestSystemOf(off)).not.toContain(paragraph);
    expect(lastUserOf(off)).not.toContain("侧边栏里说的");
    expect(refusalOf(await report(frontend))).toBe(`not_allowed: ${OFF}`);
    // 以前的网页候选卡："交"回没启用（卡不变）；"都不要"照常关掉
    expect(refusalOf(await frontend.cardAction({ cardId: first.id, action: "confirm", expectedVersion: 1, input: { tokens: ["0123456789abcdef01234567"] } }))).toBe(`not_allowed: ${OFF}`);
    expect(td.daemon.cards.get(first.id)).toMatchObject({ status: "pending", version: 1 });
    expect((await frontend.cardAction({ cardId: second.id, action: "dismiss", expectedVersion: 1 })).ok).toBe(true);
    expect(td.daemon.cards.get(second.id)).toMatchObject({ status: "dismissed" });

    // 再启用：设备再报一次浏览器（网页插件重新装上时报），网页工具、提示里的段落、消息后面的网页上下文都回来
    expect((await pluginsApi.act(td.url, "browsing", { action: "enable", idempotencyKey: "on" })).body.changed).toEqual(["browsing"]);
    expect((await report(frontend)).ok).toBe(true);
    const answered = new Set<string>();
    const answering = setInterval(() => {
      for (const frame of frontend.events({ channel: SECRETARY, type: EVENT_TYPES.browserRequest }).slice(1)) {
        const { id } = frame.payload as BrowserRequest;
        if (answered.has(id)) continue;
        answered.add(id);
        void frontend.request(METHODS.browserReply, { id, result: { ok: true, text: "报名须知" } });
      }
    }, 10);
    await tell(frontend, "这个网页讲什么", SIDEBAR);
    clearInterval(answering);
    const on = lastEcho(frontend);
    expect(toolsIn(on).filter((name) => BROWSE_TOOLS.includes(name))).toEqual(BROWSE_TOOLS);
    expect(webSearchDescriptions.at(-1)).toContain("鸿蒙 App 的内置浏览器");
    for (const paragraph of BROWSE_PARAGRAPHS) expect(latestSystemOf(on)).toContain(paragraph);
    expect(lastUserOf(on)).toContain("（这句是用户在「浏览」右边的二狗侧边栏里说的：内置浏览器里开着网页「报名 · 示例」");
    expect(toolResultOf(on, "browse_read_page")).toContain("报名须知");
  });

  it("移除并连数据一起彻底删除：网页候选卡的每个版本、候选缩略图的缓存删掉；存进素材的网页不动（素材属于内核）", async () => {
    const { td, frontend } = await withWeb([say("好")]);
    const view = (await pluginsApi.view(td.url)).body.plugins.find((p) => p.name === "browsing")!;
    expect(view).toMatchObject({ title: "内置浏览器", state: "running", brings: { tools: ["读网页", "填选中的框", "找文件", "看图", "给选中的上传框交文件", "在内置浏览器里开网址", "看网页上能点的东西", "点网页上的一个元素"], cards: ["网页候选卡"] } });
    expect(view.removal!.keeps[0]).toContain("素材属于内核，要删请去 记忆 · 素材 的成批删除");
    // 存一页网页、留一张网页候选卡（处理过一次，两个版本）、缩略图缓存里有一张
    const saved = (await materialsApi.saveWebPage(td.url, { title: "攻略", url: "https://example.org/a", text: "灵隐寺", truncated: false, total: 3, idempotencyKey: "save-1" })).body as SaveWebPageResult;
    const card = td.daemon.cards.create({ type: "browse_pick", status: "pending", payload: pickPayload(new Date(Date.now() + 60_000).toISOString()) });
    expect((await frontend.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: 1 })).ok).toBe(true);
    const thumbs = dataDirLayout(td.dataDir).pageThumbnails;
    expect(path.resolve(td.dataDir, PAGE_THUMBNAILS_DIR)).toBe(path.resolve(thumbs));
    fs.mkdirSync(thumbs, { recursive: true });
    fs.writeFileSync(path.join(thumbs, "a.jpg"), "x");

    const removed = await pluginsApi.act(td.url, "browsing", { action: "remove", purgeData: true, idempotencyKey: "remove-browsing" });
    expect(removed.status).toBe(200);
    expect(removed.body.purged).toEqual({ events: 0, cards: 1, inboxItems: 0, files: 1 });
    // 卡片的每个版本换成删除标记；缩略图缓存没了
    const cardEvents = td.daemon.store.read(CARDS, 0, EVENT_TYPES.card).filter((e) => isDeletedEventPayload(e.payload) || (e.payload as CardEventPayload).card.type === "browse_pick");
    expect(cardEvents.length).toBe(2);
    expect(cardEvents.every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(thumbs)).toBe(false);
    // 存进素材的网页：事件、素材、详情里的正文都在
    expect(td.daemon.store.read("materials", 0, EVENT_TYPES.webPageSaved).map((e) => isDeletedEventPayload(e.payload))).toEqual([false]);
    const detail = (await materialsApi.detail(td.url, saved.materialId)).body as MaterialDetailView;
    expect(detail.segments[0]).toMatchObject({ form: "web_page", saved: { title: "攻略", text: "灵隐寺" } });
    expect(td.daemon.plugins.report()).toMatchObject({ running: ["reminders", "memory", "calendar", "voice", "claude-code", "phone", "google", "looki"], removed: ["browsing"] });
  });

  it("语音插件不在（214 号票，可选依赖 wants）：浏览插件照常装上、不跟着停；悬浮按钮上说话回\"没认出说了什么：语音插件没启用\"，不崩", async () => {
    const VOICE_OFF = "没认出说了什么：语音插件没启用";
    const speak = (url: string) => requestJson<{ ok: boolean; reason?: string }>(url, HTTP_PATHS.pageVoice, { method: "POST", body: { audio: { base64: "AAAA", mime: "audio/wav" } } });
    // 配置里停用语音：浏览插件照样装上（不算缺依赖）
    const off = await withWeb([say("好")], ["reminders", "memory", "calendar", "browsing", "claude-code", "phone", "google", "looki"]);
    expect(off.td.daemon.plugins.report()).toEqual({ running: ["reminders", "memory", "calendar", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["voice"], skipped: [] });
    const first = await speak(off.td.url);
    expect([first.status, first.body]).toEqual([200, { ok: false, reason: VOICE_OFF }]);


    // 运行中停用语音：浏览插件不跟着停，说话现取到的是没有
    const { td } = await withWeb([say("好")]);
    expect((await pluginsApi.act(td.url, "voice", { action: "disable", idempotencyKey: "voice-off" })).body.changed).toEqual(["voice"]);
    expect(td.daemon.plugins.report()).toMatchObject({ running: ["reminders", "memory", "calendar", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["voice"] });
    const second = await speak(td.url);
    expect([second.status, second.body]).toEqual([200, { ok: false, reason: VOICE_OFF }]);
  });
});
