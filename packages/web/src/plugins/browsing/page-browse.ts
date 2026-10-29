// "浏览"页签（134 号票）接到这个页面上：设备设置（browse-settings.ts）接到 localStorage；App 的原生浏览器（native-browser.ts）
// 的样子整个页面共用一份（browser-shell.ts 的 watchNativeBrowser）；页面里点的外链在壳里改到"浏览"里打开（followExternalLinks）。
// 134 号票第二部分：网页上下指令（page-commands.ts）整个页面共用一份，开场就接上 App 推过来的（拦下的选文件对话框不能没人接）；
// 146 号票起它的样子画在网页里悬浮按钮旁边的气泡里（page-bubble.ts 交给页面桥）。
// 147 号票：浏览侧边栏（browse-side.ts）整个页面共用一份，开场接上 App 推过来的（浏览器的样子、页面桥报的选中的框）和连接
// （守护进程推来的秘书的网页工具要办的事），报这台设备上浏览器的样子。148 号票：宽屏侧边栏拖到多宽（stage-side-width.ts 的
// BROWSE_SIDE_WIDTH）接到 localStorage。
// 149 号票（悬浮按钮背后就是秘书本人）：悬浮按钮上的话经页面上的 store 发进秘书的主会话、秘书这一轮的回话从 store 的状态里认
// （usePageButtonSync，App.tsx 的 Shell 里挂一次）；挑图片窗口（page-pick.ts）照 store 里这台设备的网页候选卡弹，对卡做动作也经 store；
// 候选文件预备（page-stage.ts）整个页面共用一份，挑图片窗口和浏览侧边栏办守护进程转来的交文件都用它；缩略图凭取件码取守护进程缩好的小图。
// 160 号票：能渲染的文件用二狗的渲染打开（browse-files.ts）整个页面共用一份，开场接上 App 推过来的（加载完的一页、拦下的下载），
// 告诉 App 网页能渲染文件了（browserDoc enable，新版 App 才有）。
// 165 号票（⋮ 菜单）：App 有原生工具（browserTool，新版 App 才有）时，页内查找（browse-find.ts）整个页面共用一份、接上 App 推的
// 查找结果，换了网页收起；按网站记住的文字大小、桌面版（browse-settings.ts）开场交给 App 一次，之后变了再交。
// 181 号票：气泡、挑图片窗口里说到助理用用户起的名字、画成名字标签——usePageButtonSync 把 store 里的名字、换了语言告诉气泡那一层
// 和挑图片窗口，视觉风格（连同主色）变了把名字标签的颜色告诉气泡那一层（随页面桥自己的那几句重交）。
// 212 号票起是浏览插件的（网页插件 plugins/browsing/plugin.tsx）：开场接上（connectBrowsing）由插件第一次装上时做（组合根建插件宿主时把
// 页面的连接和 HTTP 交给插件，ctx.page）；插件装上、停用跟着变（turnBrowsingOn：页面里的外链改不改到"浏览"里打开、132 号票的内置浏览器在
// App 里开不开原生浏览器；停用时 App 接住的主页面外链交给系统浏览器——App 那边 attach 了收不回来，鸿蒙 App 不用改）。
// 设备设置（搜索引擎、最近访问、按网站记住的）留在核心（app/page-browse-settings.ts：设置 · 浏览与填框也用），这里转出。
// 单独一个文件，那几个模块就不碰浏览器的全局变量，能在 Node 里测。
import { useEffect, useSyncExternalStore } from "react";
import type { NameTagColors } from "../../page-bridge/texts.ts";
import {
  assistantNameOf,
  browsePicksOf,
  buttonTurnOf,
  CHANNELS,
  DEFAULT_ASSISTANT_NAME,
  desktopUserAgent,
  localeRevision,
  type PageCommandFile,
  pageUrlForModel,
  type SiteSettings,
  siteTuning,
} from "../../state/index.ts";
import { BrowseFiles, type BrowseFileView } from "./browse-files.ts";
import { BrowseFind, type BrowseFindView } from "./browse-find.ts";
import { pageBrowseSettings } from "../../app/page-browse-settings.ts";
import { setPageNativeOpener } from "../../app/native-open.ts";
import { type BrowserWatch, followExternalLinks, type LinkLike, openInNativeBrowser, watchNativeBrowser } from "../../app/browser-shell.ts";
import { pushHash } from "../../app/history-nav.ts";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { BLANK_BROWSER, type BrowserState, type NativeBrowser } from "../../app/native-browser.ts";
import { BROWSE_SIDE_WIDTH, BrowseSide, type BrowseSideView, newBrowserId } from "./browse-side.ts";
import type { Connection } from "../../app/connection.ts";
import { type BridgeLook, nameTagColors, PageBubbleSync } from "./page-bubble.ts";
import { PageCommands, pageVoiceOver } from "./page-commands.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { pageVoicePlayer } from "../../app/page-voice.ts";
import { PagePickSync } from "./page-pick.ts";
import { PageStage } from "./page-stage.ts";
import { pageTheme } from "../../app/page-theme.ts";
import { type StageSideWidthSetting, stageSideWidthSettingIn } from "../../app/stage-side-width.ts";
import { useStore } from "../../app/store.tsx";
import { browserVoiceEnv } from "../../app/voice-browser.ts";
import { NativeVoiceRecorder } from "../../app/voice-native-recorder.ts";
import { VoiceRecorder } from "../../app/voice-recorder.ts";

/** 设备设置（212 号票起在核心的 app/page-browse-settings.ts），照旧从这里转出 */
export { pageBrowseSettings, useRecentVisits, useSearchEngine, useSiteSettings } from "../../app/page-browse-settings.ts";

/** App 的原生浏览器（新版鸿蒙 App 里才有；电脑、手机浏览器里没有） */
export function pageNativeBrowser(): NativeBrowser | undefined {
  return pageNativeApp()?.browser;
}

/** 切到"浏览"页签（压一条记录、记来处，和别的跳转一样） */
function showBrowse(): void {
  pushHash(window, "#/browse");
}

/** 浏览插件在不在用（212 号票：网页插件装上、停用时跟着变，turnBrowsingOn） */
let browsingOn = true;

/**
 * App 在浏览器里打开了一个链接（主页面上点的外链被它接住）：插件在用时切到"浏览"；停用了（没有"浏览"页签）交给系统浏览器打开现在这一页——
 * 开场 attach 之后 App 一直替主页面接外链，收不回来（212 号票，鸿蒙 App 不用改）
 */
function onAppOpened(): void {
  if (browsingOn) showBrowse();
  else pageNativeBrowser()?.nav("outside");
}

let watch: BrowserWatch | undefined;

/**
 * 开场调一次（212 号票起由 connectBrowsing 调：浏览插件第一次装上时）：有原生浏览器就接上——告诉 App 网页有"浏览"页签了、跟着它推的变，
 * App 接住了主页面上的外链时切到"浏览"（插件停用了交给系统浏览器）。页面里点的外链改到"浏览"里打开在 turnBrowsingOn（跟着插件装上、停用）。
 * 没有就什么都不做
 */
export function connectNativeBrowser(): void {
  const browser = pageNativeBrowser();
  if (!browser || watch) return;
  watch = watchNativeBrowser(browser, pageBrowseSettings(), onAppOpened);
  // 能渲染的文件（160 号票）：先接上 App 推的，再告诉 App 网页能渲染文件了（App 这才报文件、拦能渲染的下载）
  const docs = browser.docs;
  if (docs) {
    const created = new BrowseFiles({ docs, back: () => browser.nav("back") });
    created.browserChanged(watch.state());
    browser.subscribe((event) => created.handle(event));
    browseFiles = created;
    docs.enable();
  }
  // ⋮ 菜单用到的原生工具（165 号票）：页内查找接上 App 推的结果、换了网页收起；按网站记住的设置交给 App
  const tools = browser.tools;
  if (tools) {
    const created = new BrowseFind({
      tools,
      later: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    browser.subscribe((event) => created.handle(event));
    const w = watch;
    let url = w.state().url;
    w.subscribe(() => {
      const next = w.state().url;
      if (next === url) return;
      url = next;
      created.pageChanged();
    });
    browseFind = created;
    const device = pageBrowseSettings();
    const ua = desktopUserAgent(navigator.userAgent);
    let sent: SiteSettings | undefined;
    const push = () => {
      const sites = device.sites();
      if (sites === sent) return;
      sent = sites;
      tools.sites(siteTuning(sites, ua));
    };
    push();
    device.subscribe(push);
  }
  // 浏览侧边栏先接上了的：现在的样子（之后跟着 App 推的 state 变）
  side?.browserChanged(watch.state());
}

/** 页面里点的外链改到"浏览"里打开（接上了原生浏览器才有）；返回停下 */
function followPageLinks(): () => void {
  if (!watch) return () => {};
  const browser = pageNativeBrowser();
  if (!browser) return () => {};
  return followExternalLinks(document, window.location.origin, closestLink, (url) => openInNativeBrowser(browser, url, window.location.origin, showBrowse));
}

/** 页面的连接和 HTTP（组合根交给网页插件的，plugins/api.ts 的 WebPluginPage） */
export interface BrowsingPage {
  readonly connection: Pick<Connection, "browserStatus" | "browserReply" | "onBrowserRequest">;
  readonly http: Pick<DaemonHttp, "pageVoice" | "pageFileBytes" | "pageFileThumbUrl">;
  /** 这一页是侧边栏模式（?ergo=side）：只接原生浏览器（和以前 main.tsx 一样），不接悬浮按钮、浏览侧边栏 */
  readonly sideMode: boolean;
}

/**
 * 开场接上（212 号票：浏览插件第一次装上时，网页插件宿主建好就按全开装上，所以还是开场）：原生浏览器（以前 main.tsx 调的），
 * 不是侧边栏模式时再接网页上下指令（悬浮按钮）、浏览侧边栏（以前 App.tsx 调的）。再调不重复接
 */
export function connectBrowsing(page: BrowsingPage): void {
  connectNativeBrowser();
  if (page.sideMode) return;
  connectPageCommands(page.http);
  connectBrowseSide(page.connection, page.http);
}

/** 装上过没有（第一次装上时开场接上的就报过浏览器的样子了） */
let turnedOn = false;

/**
 * 浏览插件装上（212 号票，网页插件的 effect）：页面里的外链改到"浏览"里打开，132 号票的内置浏览器在 App 里改开原生浏览器（核心留的口子
 * app/native-open.ts）；运行中停用后又启用的，再报一次这台设备上浏览器的样子（守护进程那边的设备通路是新的一份）。返回停用时做的
 */
export function turnBrowsingOn(): () => void {
  const again = turnedOn;
  turnedOn = true;
  browsingOn = true;
  const stopLinks = followPageLinks();
  const stopOpener = setPageNativeOpener(openInPageNativeBrowser);
  if (again) side?.reannounce();
  return () => {
    browsingOn = false;
    stopLinks();
    stopOpener();
  };
}

/** 点到的元素往上找 <a href>（HTML 的链接；SVG 里的 <a> 的 href 不是字符串，不管） */
function closestLink(target: unknown): LinkLike | undefined {
  if (!(target instanceof Element)) return undefined;
  const a = target.closest("a[href]");
  return a instanceof HTMLAnchorElement ? a : undefined;
}

/** 在壳里时用 App 的原生浏览器打开（切到"浏览"）；不在壳里返回 false，调用方照旧 */
export function openInPageNativeBrowser(url: string): boolean {
  const browser = pageNativeBrowser();
  return browser !== undefined && openInNativeBrowser(browser, url, window.location.origin, showBrowse);
}

const noWatch: BrowserWatch = { state: () => BLANK_BROWSER, subscribe: () => () => {} };

let browseFiles: BrowseFiles | undefined;
let browseFind: BrowseFind | undefined;

/** 页内查找（165 号票；旧版 App 没有 browserTool 时 undefined） */
export function pageBrowseFind(): BrowseFind | undefined {
  return browseFind;
}

// 没有时每次给同一个对象（useSyncExternalStore 拿到新对象会当成变了、无限重渲）
const FIND_CLOSED: BrowseFindView = { open: false, query: "" };
const noFind = { snapshot: (): BrowseFindView => FIND_CLOSED, subscribe: () => () => {} };

/** 查找栏的样子，变了跟着变 */
export function useBrowseFind(): BrowseFindView {
  const f = browseFind ?? noFind;
  return useSyncExternalStore(f.subscribe, f.snapshot);
}

/** 能渲染的文件（160 号票；旧版 App 没有 browserDoc 时 undefined） */
export function pageBrowseFiles(): BrowseFiles | undefined {
  return browseFiles;
}

const noFiles = { snapshot: (): BrowseFileView | undefined => undefined, subscribe: () => () => {} };

/** 渲染层看着的文件（没有是 undefined），变了跟着变 */
export function useBrowseFile(): BrowseFileView | undefined {
  const f = browseFiles ?? noFiles;
  return useSyncExternalStore(f.subscribe, f.snapshot);
}

/** 浏览器现在的样子（地址、标题、进度、能不能后退前进），变了跟着变 */
export function useBrowserState(): BrowserState {
  const w = watch ?? noWatch;
  return useSyncExternalStore(w.subscribe, w.state);
}

let commands: PageCommands | undefined;
let stage: PageStage | undefined;

/** 候选文件预备（149 号票）：整个页面一份（挑图片窗口、浏览侧边栏办交文件都用它）；没有页面桥时 undefined */
function pageStage(browser: NativeBrowser, http: Pick<DaemonHttp, "pageFileBytes">): PageStage | undefined {
  const page = browser.page;
  if (!page) return undefined;
  stage ??= new PageStage({
    fetch: (token) => http.pageFileBytes(token),
    put: (id, bytes) => page.putFile(id, bytes),
    discard: (ids) => page.discard?.(ids),
    // 交文件的耗时进 hilog（App 的 ErgoApp）：真机上量快了多少
    log: (line) => {
      pageNativeApp()?.log(line);
      console.info(line);
    },
    now: () => Date.now(),
  });
  return stage;
}

/** 气泡那一层（181 号票：名字、语言、风格变了告诉它） */
let bubbleSync: PageBubbleSync | undefined;
/** 助理现在的名字（usePageButtonSync 照 store 改） */
let assistantName = DEFAULT_ASSISTANT_NAME;
/** 名字标签现在的颜色（usePageButtonSync 照视觉风格改；还没算是 undefined，页面桥用经典的） */
let tagColors: NameTagColors | undefined;
/** 上次告诉气泡那一层时的名字和语言 */
let lookKey = "";

/** 语音插件在不在（214 号票；setPageVoiceAvailable 照输入框的语音插槽改）：不在时悬浮按钮只能打字 */
let voiceAvailable = true;

const pageLook = (): BridgeLook => ({ name: assistantName, ...(tagColors ? { tag: tagColors } : {}), ...(voiceAvailable ? {} : { typeOnly: true }) });

/**
 * 语音插件在不在（212、214 号票：浏览插件挂在主框架里的那一个看输入框的语音插槽有没有东西，变了调这里）：不在时悬浮按钮长按不录、
 * 写一句没启用（PageCommands.setVoice），页面桥的按钮说明只说点一下打字；回来了照常
 */
export function setPageVoiceAvailable(on: boolean): void {
  if (on === voiceAvailable) return;
  voiceAvailable = on;
  commands?.setVoice(on);
  bubbleSync?.lookChanged();
}

/**
 * 网页上下指令接上（App.tsx 建好 DaemonHttp 后调一次）：App 有页面桥那一组方法才接；录音用"按住说话"的同一套后端
 * （App 里是原生录音器）；发进秘书主会话的那一头等 store 建好了由 usePageButtonSync 接上
 */
export function connectPageCommands(http: Pick<DaemonHttp, "pageVoice">): void {
  const browser = pageNativeBrowser();
  if (!browser?.page || commands) return;
  const env = browserVoiceEnv();
  const voice = pageVoiceOver(
    () => (env.native ? new NativeVoiceRecorder(env.native, env.now, { log: env.micLog, onTrouble: () => {} }) : new VoiceRecorder(env.media, env.now, { log: env.micLog })),
    env.now,
  );
  const created = new PageCommands({
    page: browser.page,
    recognize: (audio) => http.pageVoice({ audio }),
    voice,
    browserPage: () => {
      const s = watch?.state() ?? BLANK_BROWSER;
      return { title: s.title, url: pageUrlForModel(s.url) };
    },
    // 浏览侧边栏那一份的浏览器编号（守护进程据此把秘书的网页工具转给这一页）
    browserId: () => side?.status().browser,
    // 按下悬浮按钮说话：二狗正在播的语音暂停（209 号票，和聊天窗口里按住说话同一个播放器，悬浮按钮单算一处）
    capture: (on) => pageVoicePlayer().setCapturing(on, "page-button"),
  });
  const bubble = new PageBubbleSync({
    commands: created,
    page: browser.page,
    // 有浏览侧边栏时太长的回话下面给"去侧边栏看"（147 号票）
    sidebar: () => side !== undefined,
    // 助理的名字、名字标签的颜色（181 号票）
    look: pageLook,
  });
  bubbleSync = bubble;
  created.setVoice(voiceAvailable);
  browser.subscribe((event) => {
    created.handle(event);
    bubble.after(event);
  });
  commands = created;
}

/** 凭取件码取守护进程缩好的缩略图（149 号票），base64；不是图片、做不出来（404）是 undefined */
async function thumbnailOf(url: string): Promise<string | undefined> {
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 网页上下指令（没有页面桥时 undefined） */
export function pagePageCommands(): PageCommands | undefined {
  return commands;
}

/** 页面上的 store 对卡做动作、发消息（usePageButtonSync 接上；store 建好之前是 undefined） */
let storeLink: { cardAction(cardId: string, action: "confirm" | "dismiss", input?: unknown): void } | undefined;
let pick: PagePickSync | undefined;

let side: BrowseSide | undefined;

/**
 * 浏览侧边栏接上（建好连接后调一次，147 号票；212 号票起由浏览插件第一次装上时调，connectBrowsing）：App 有页面桥那一组才接。浏览器的编号这一页随机一个；
 * 跟着 App 推的浏览器样子、页面桥报的选中的框变，办守护进程推来的事
 */
export function connectBrowseSide(connection: Pick<Connection, "browserStatus" | "browserReply" | "onBrowserRequest">, http: Pick<DaemonHttp, "pageFileBytes" | "pageFileThumbUrl">): void {
  const browser = pageNativeBrowser();
  // 侧边栏要 App 画在原生网页上面（browserSide，新版 App 才有）；原型的假连接没有报浏览器、收请求那几样：侧边栏照样能开（秘书的网页工具用不了）
  const files = browser ? pageStage(browser, http) : undefined;
  if (!browser?.page || !browser.side || side || !files) return;
  const page = browser.page;
  const created = new BrowseSide({
    browserId: newBrowserId(randomUnit),
    page,
    load: (url) => browser.load(url),
    report: (status) => connection.browserStatus?.(status),
    searchEngine: () => pageBrowseSettings().searchEngine(),
    reply: (id, outcome) => connection.browserReply?.(id, outcome),
    stage: files,
    storage: () => window.localStorage,
    narrow: () => !sideWide,
    now: () => Date.now(),
  });
  browser.subscribe((event) => {
    if (event.type === "state") created.browserChanged(event.state);
    else if (event.type === "page") created.pageEvent(event.event);
    else if (event.type === "side") created.sideAction(event.action);
  });
  connection.onBrowserRequest?.((request) => void created.handle(request));
  if (watch) created.browserChanged(watch.state());
  created.announce();
  // 182 号票：设置里换了搜索引擎再报一次（没变的不报）
  pageBrowseSettings().subscribe(() => created.announce());
  side = created;
  // 挑图片窗口（149 号票）：秘书给这个浏览器的网页候选卡，这一页上弹出来；对卡做动作经页面上的 store
  const pickSync = new PagePickSync({
    page,
    stage: files,
    cardAction: (cardId, action, input) => storeLink?.cardAction(cardId, action, input),
    thumbnail: (file: PageCommandFile) => thumbnailOf(http.pageFileThumbUrl(file.token)),
    currentUrl: () => (watch?.state() ?? BLANK_BROWSER).url || undefined,
    now: () => Date.now(),
    assistantName: () => assistantName,
  });
  browser.subscribe((event) => pickSync.handle(event));
  pick = pickSync;
}

/**
 * 悬浮按钮、挑图片窗口接到页面上的 store（149 号票；App.tsx 的 Shell 里调一次）：悬浮按钮上的话经 store 发进秘书的主会话、
 * 秘书这一轮走到哪了从 store 的状态里认；挑图片窗口照 store 里这台设备的网页候选卡弹、对卡做动作经 store。没有页面桥时什么都不做
 */
export function usePageButtonSync(): void {
  const { ui, sendMessage, cardAction } = useStore();
  useEffect(() => {
    storeLink = { cardAction: (cardId, action, input) => cardAction(cardId, action, undefined, input) };
    commands?.connect({ say: (text, browsing) => sendMessage(CHANNELS.secretary, [{ type: "text", text }], undefined, browsing) });
  }, [sendMessage, cardAction]);
  useEffect(() => {
    // 名字、语言变了（181 号票）：气泡那一层重交页面桥自己的那几句、开着的气泡；挑图片窗口下面照常拿到卡时跟着重算标题
    const name = assistantNameOf(ui);
    const look = `${name}\n${localeRevision()}`;
    if (look !== lookKey) {
      lookKey = look;
      assistantName = name;
      bubbleSync?.lookChanged();
    }
    commands?.secretaryChanged((key) => buttonTurnOf(ui, key));
    if (pick && side) pick.cardsChanged(browsePicksOf(ui, side.status().browser));
  }, [ui]);
  // 视觉风格、主色变了（181 号票）：名字标签的颜色跟着（浅色深色两对一起交，深浅色变了页面桥自己挑）
  useEffect(() => {
    const theme = pageTheme();
    const follow = () => {
      tagColors = nameTagColors(theme.style(), theme.accent());
      bubbleSync?.lookChanged();
    };
    follow();
    return theme.subscribe(follow);
  }, []);
}

/** 0–1 的随机数（浏览器的编号用；有 crypto 用 crypto） */
function randomUnit(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(buf);
  return buf[0] === undefined || buf[0] === 0 ? Math.random() : buf[0] / 0x1_0000_0000;
}

/** "浏览"页现在是宽屏还是窄屏（BrowsePage 告诉这里；窄屏上秘书开了网址就收起侧边栏） */
let sideWide = true;
export function setBrowseSideWide(wide: boolean): void {
  sideWide = wide;
}

/** 浏览侧边栏（没有页面桥时 undefined） */
export function pageBrowseSide(): BrowseSide | undefined {
  return side;
}

// 没有侧边栏时每次给同一个对象：useSyncExternalStore 拿到新对象会当成变了、无限重渲（电脑浏览器、旧版 App 一打开就白屏）
const SIDE_CLOSED: BrowseSideView = { open: false };
const noSide = { snapshot: (): BrowseSideView => SIDE_CLOSED, subscribe: () => () => {} };

/** 浏览侧边栏的样子 */
export function useBrowseSide(): BrowseSideView {
  const s = side ?? noSide;
  return useSyncExternalStore(s.subscribe, s.snapshot);
}

let sideWidth: StageSideWidthSetting | undefined;

/** 宽屏浏览侧边栏拖到的宽度（148 号票）：整个页面共用的一份，这台设备记住 */
export function pageBrowseSideWidth(): StageSideWidthSetting {
  sideWidth ??= stageSideWidthSettingIn(() => window.localStorage, BROWSE_SIDE_WIDTH);
  return sideWidth;
}

/** 这台设备记住的侧边栏宽度（还没按内容区夹回），改了跟着变 */
export function useBrowseSideWidth(): number {
  const s = pageBrowseSideWidth();
  return useSyncExternalStore(s.subscribe, s.width);
}
