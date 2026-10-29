// 内置浏览器（132 号票）在页面这一侧的那一半：打开、关掉、顶栏的几个按钮、地址和标题跟着框里的页面走。
// 打开的是守护进程转发的本机服务的页面（/apps/<应用名>/…，和二狗同源，框里的地址、标题读得到）；外部网站的链接不归它，照旧新窗口打开。
// - openInAppBrowser(url, title)：哪里都能调（卡片、项目页、秘书的消息……133 号票的服务入口），地址写进 hash 路由
//   （#/apps/<应用名>/<path>，app/route-hash.ts），App.tsx 认到这一页就在原来的页面上盖一层内置浏览器（ui/in-app-browser.tsx）；
// - 关掉：右上角 ×、电脑上 Esc（框里的页面有焦点时也认）直接关，回到盖住之前的那一页。
//   框里点过链接时浏览器的历史里多了框的记录，history.back() 只退框里的一步，所以有 Navigation API 时直接回到打开之前那一条记录，
//   没有时框里没走过就后退一步（照 ‹ 的规矩），走过了就把这一条换成原来那一页；
// - 鸿蒙的返回手势（挂一层返回栈 overlay）和顶栏的 ‹ 一致：框里能后退（判法同 ‹ 的亮灭）就退一页，退不了了才关掉（主会话 2026-10-18 定）。
//   电脑上浏览器的后退键、Alt+←、鼠标的后退键不用接：浏览器自己先退框里的记录，退到头再退掉内置浏览器那一条，hashchange 把它关掉；
// - 顶栏：后退（框里的上一页；框里还没走过时灰着）、刷新、在新窗口打开（鸿蒙 App 里不给：新窗口会落到 App 的主页面上）、关闭；
// - 框里每加载一页，标题取它的 <title>（取不到用打开时给的名字，再没有用应用名），地址换进 hash（不压新记录），刷新、发给别的设备还是这一页。
// - 160 号票：能渲染的文件（markdown、纯文本、JSON、CSV、代码……，哪些由 state/file-view.ts 的 fileRenderOf 定）不让框显示原始文本、
//   不下载，盖一层二狗的渲染（ui/file-view.tsx，内容按同源地址直接取）：
//   · 框里点同一个转发服务里的文件链接（按扩展名认）：拦下来，框留在原来那一页，渲染层盖在上面；‹、返回手势收起它回到框里那一页；
//   · 框加载完的那一页响应类型是能渲染的（服务端回 text/markdown、text/plain……，没有扩展名的地址也算）：框里就是这个文件，
//     渲染层盖着它，‹ 照旧是框里后退，框走开了渲染层跟着收；
//   · 直接打开文件的地址（刷新、发给别的设备）：框先空着（免得开那个文件触发下载），直接渲染，‹ 关掉内置浏览器；
//   · 渲染层里点链接：同一个服务里能渲染的换一个文件看，别的同一服务的地址框跳过去，外部网站、二狗自己的页面新窗口打开；
//   · 取到的其实是网页（.md 地址回的 HTML）：框照旧打开它。地址照样换进 hash，标题是文件名；刷新、在新窗口打开对这个文件。
// 这里不碰浏览器的全局变量：页面、框、返回栈都换成接口，测试在 Node 里跑（test/app/in-app-browser.test.ts）；接到页面的 window 上的在 page-in-app-browser.ts。
import { appUrl, fileNameOf, fileRenderOf, parseAppPath } from "../state/index.ts";
import type { BackRegistry } from "./back-registry.ts";
import type { LinkClick, LinkLike } from "./browser-shell.ts";
import { backStep, cameFrom, type HistoryEnv, pushHash } from "./history-nav.ts";
import { type Route, toHash } from "./route-hash.ts";

/** 按键事件里用到的 */
export interface KeyLike {
  readonly key: string;
  preventDefault(): void;
}

/** 能挂按键监听的（页面的 window、框里的 window） */
export interface KeyTarget {
  addEventListener(type: "keydown", listener: (e: KeyLike) => void): void;
  removeEventListener(type: "keydown", listener: (e: KeyLike) => void): void;
}

/** 页面的 window 里用到的那一点 */
export interface BrowserPage extends HistoryEnv, KeyTarget {
  readonly location: HistoryEnv["location"] & { readonly origin: string };
  readonly history: HistoryEnv["history"] & { replaceState(data: unknown, unused: string, url?: string): void };
  /** Navigation API（有的浏览器没有） */
  readonly navigation?: {
    readonly currentEntry: { readonly key: string; readonly index: number } | null;
    entries(): ReadonlyArray<{ readonly key: string; readonly url: string | null }>;
    traverseTo(key: string): { committed?: Promise<unknown>; finished?: Promise<unknown> };
  };
  open(url: string, target: string, features: string): unknown;
}

/** 框里那一页的 document 用到的：标题；160 号票起还有响应类型、点击监听（认能渲染的文件链接） */
export interface FrameDocumentLike {
  readonly title: string;
  readonly contentType?: string;
  addEventListener?(type: "click", listener: (e: LinkClick) => void, capture: boolean): void;
  removeEventListener?(type: "click", listener: (e: LinkClick) => void, capture: boolean): void;
}

/** 框里的 window（同源时读得到；跨源时读 location、document、history 会抛错） */
export interface FrameWindowLike extends KeyTarget {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string; readonly href: string; reload(): void };
  readonly document: FrameDocumentLike;
  readonly history: { back(): void };
  readonly navigation?: { readonly canGoBack: boolean };
}

/** 框本身（iframe 元素） */
export interface FrameHandle {
  src: string;
  readonly contentWindow: FrameWindowLike | null;
}

/** 用二狗的渲染看着的文件（160 号票） */
export interface InAppFile {
  /** 文件的完整地址（同源，/apps/<应用名>/…） */
  readonly url: string;
  /** 文件名（标题栏、渲染层上面一行） */
  readonly name: string;
  /** 框里就是这个文件（框加载完按响应类型认出来的）；false 是点链接、直接打开时盖在框上面的一层（框还在原来那一页或空着） */
  readonly inFrame: boolean;
  /** 第几次打开（刷新也算一次）：渲染层据此重新取 */
  readonly seq: number;
}

/** 顶栏显示的 */
export interface InAppBrowserView {
  readonly title: string;
  /** 框里能不能后退；渲染层盖在框上面时是 true（‹ 收起它） */
  readonly canGoBack: boolean;
  /** 用二狗的渲染看着的文件（160 号票，框藏起来）；没有就没这一项 */
  readonly file?: InAppFile;
}

/** 直接打开文件的地址时框先空着 */
const BLANK = "about:blank";

/** 点到的元素往上找 <a href>：框里的元素是另一个 window 的，不能用 instanceof，按形状认 */
function linkIn(target: unknown): LinkLike | undefined {
  const el = target as { closest?: unknown } | null | undefined;
  if (!el || typeof el.closest !== "function") return undefined;
  const a = (el.closest as (selector: string) => unknown).call(el, "a[href]") as Partial<LinkLike> | null | undefined;
  return a && typeof a.href === "string" && typeof a.hasAttribute === "function" ? (a as LinkLike) : undefined;
}

/** 打开时给的名字（标题栏先显示它，框里的页面没有 <title> 时一直用它）：按应用名记着，刷新后没有了就用应用名 */
const titleHints = new Map<string, string>();

/** 相对地址按什么解析：二狗的源；直接打开构建产物（原型，file://）时源是 "null"，按 file:/// 解析（原型里也能看内置浏览器的渲染层） */
function baseOf(origin: string): string {
  return origin === "null" ? "file:///" : `${origin}/`;
}

/** 一个地址是不是二狗转发的应用页（同源、在 /apps/<应用名>/ 下）：是就给出内置浏览器的那一页 */
export function appRouteOf(url: string, origin: string): Extract<Route, { tab: "app" }> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, baseOf(origin));
  } catch {
    return undefined;
  }
  if (parsed.origin !== origin) return undefined;
  const app = parseAppPath(`${parsed.pathname}${parsed.search}`);
  if (!app) return undefined;
  const path = `${app.rest.replace(/^\//, "")}${parsed.hash}`;
  return { tab: "app", app: app.name, ...(path ? { path } : {}) };
}

/**
 * 在内置浏览器里打开二狗转发的地址（url 可以是 /apps/<应用名>/… 或同源的完整地址）；title 是标题栏先显示的名字。
 * 不是转发的地址（外部网站）照旧在新窗口打开，返回 false。
 * 134 号票：在鸿蒙 App 里（有原生的内置浏览器，nativeOpen）一律交给它——切到"浏览"页签打开，转发的地址、外部网站都是；
 * 它打不开（不是 http(s)）才照旧
 */
export function openInAppBrowserIn(page: BrowserPage, url: string, title?: string, nativeOpen?: (url: string) => boolean): boolean {
  if (nativeOpen?.(url)) return true;
  const route = appRouteOf(url, page.location.origin);
  if (!route) {
    page.open(url, "_blank", "noopener,noreferrer");
    return false;
  }
  if (title?.trim()) titleHints.set(route.app, title.trim());
  pushHash(page, toHash(route));
  return true;
}

/** 框里打开的地址 */
export function frameSrc(route: Extract<Route, { tab: "app" }>): string {
  return appUrl(route.app, route.path ?? "");
}

/**
 * 关掉内置浏览器，回到盖住之前的那一页 to（它的 hash）：有 Navigation API 时直接回到打开之前那一条记录（跳过框里的记录）；
 * 没有时框里没走过就照 ‹ 的规矩（上一条就是它就后退一步），走过了就把这一条换成它
 */
export function leaveInAppBrowser(page: BrowserPage, to: string, frameNavigated: boolean): void {
  const nav = page.navigation;
  const current = nav?.currentEntry;
  if (nav && current) {
    const previous = nav.entries()[current.index - 1];
    const previousHash = previous?.url ? new URL(previous.url).hash : undefined;
    if (previous && previousHash !== undefined && backStep(to, previousHash) === "back") {
      const done = nav.traverseTo(previous.key);
      // 走不成（页面正在卸载之类）不报未处理的拒绝；hashchange 照常把页面换回去
      done.committed?.catch(() => {});
      done.finished?.catch(() => {});
      return;
    }
    return page.location.replace(to);
  }
  if (!frameNavigated && backStep(to, cameFrom(page)) === "back") return page.history.back();
  page.location.replace(to);
}

/** 读框里的东西：跨源（框里跳到了别的网站）时读不到，给 undefined */
function read<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** 对框做一件事：跨源时做不了，给 false */
function attempt(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次打开的内置浏览器（ui/in-app-browser.tsx 一个组件一份）：挂返回栈和 Esc、读框里的标题和地址、顶栏按钮的动作。
 * mount 时把框交进来，返回拿下的函数
 */
export class InAppBrowserSession {
  readonly app: string;
  /** 框一开始打开的地址（直接打开文件的地址时是 about:blank） */
  readonly src: string;
  private readonly page: BrowserPage;
  private readonly origin: string;
  private readonly back: BackRegistry;
  /** 盖住之前的那一页（关掉时回去） */
  private readonly leaveTo: string;
  private readonly onChange: (view: InAppBrowserView) => void;
  private frame: FrameHandle | undefined;
  /** 框里加载过几页（框没有 Navigation API 时据此判断能不能后退） */
  private loads = 0;
  /** 框里最后一次读得到的同源地址（跨源了刷新回到它） */
  private lastUrl: string;
  private current: InAppBrowserView;
  private closed = false;
  /** 框里那一页的 Esc 监听（每加载一页换一次） */
  private frameKeys: (() => void) | undefined;
  /** 框里那一页的点击监听（160 号票：认能渲染的文件链接，每加载一页换一次） */
  private frameClicks: (() => void) | undefined;
  /** 用二狗的渲染看着的文件（160 号票） */
  private file: InAppFile | undefined;
  /** 打开过几次文件（InAppFile.seq） */
  private fileSeq = 0;
  /** 框里加载过真的页面（不是一开始的空框）：直接打开文件时收起渲染层就关掉内置浏览器 */
  private frameUsed = false;

  constructor(options: { route: Extract<Route, { tab: "app" }>; page: BrowserPage; back: BackRegistry; leaveTo: string; onChange(view: InAppBrowserView): void }) {
    this.app = options.route.app;
    this.page = options.page;
    this.origin = options.page.location.origin;
    const src = frameSrc(options.route);
    const url = this.absolute(src);
    // 直接打开的是能渲染的文件：框先空着，免得开那个文件（服务端当下载发的会触发下载），直接渲染
    if (url && fileRenderOf({ url })) this.file = { url, name: fileNameOf(url), inFrame: false, seq: ++this.fileSeq };
    this.src = this.file ? BLANK : src;
    this.back = options.back;
    this.leaveTo = options.leaveTo;
    this.onChange = options.onChange;
    this.lastUrl = this.src;
    this.current = this.file ? { title: this.file.name, canGoBack: true, file: this.file } : { title: titleHints.get(this.app) ?? this.app, canGoBack: false };
  }

  /** 相对二狗的地址换成完整的；写错的是 undefined */
  private absolute(url: string): string | undefined {
    try {
      return new URL(url, baseOf(this.origin)).href;
    } catch {
      return undefined;
    }
  }

  view(): InAppBrowserView {
    return this.current;
  }

  /** 挂上：返回栈一层 overlay（鸿蒙的返回手势：框里先退，退不了才关）、页面上的 Esc；返回拿下的函数 */
  mount(frame: FrameHandle): () => void {
    this.frame = frame;
    const closeLayer = this.back.open("overlay", () => this.backGesture());
    const onKey = this.onKey;
    this.page.addEventListener("keydown", onKey);
    return () => {
      closeLayer();
      this.page.removeEventListener("keydown", onKey);
      this.frameKeys?.();
      this.frameKeys = undefined;
      this.frameClicks?.();
      this.frameClicks = undefined;
      this.frame = undefined;
    };
  }

  /**
   * 框里加载完一页：标题、能不能后退、地址换进 hash；框里那一页也认 Esc，点能渲染的文件链接拦下来（160 号票）。
   * 160 号票：盖在框上面的渲染层这时收起（框走到别处了）；这一页的响应类型是能渲染的（text/markdown……），渲染层盖着它（框里就是这个文件）。
   * 直接打开文件时一开始的空框加载完不算
   */
  frameLoaded(): void {
    const win = this.frame?.contentWindow;
    const location = win ? read(() => ({ pathname: win.location.pathname, search: win.location.search, hash: win.location.hash, href: win.location.href })) : undefined;
    if (location?.href === BLANK) return;
    this.loads += 1;
    this.frameUsed = true;
    this.frameKeys?.();
    this.frameKeys = undefined;
    const onKey = this.onKey;
    if (win && attempt(() => win.addEventListener("keydown", onKey))) this.frameKeys = () => void attempt(() => win.removeEventListener("keydown", onKey));
    this.frameClicks?.();
    this.frameClicks = undefined;
    const doc = win ? read(() => win.document) : undefined;
    const onClick = this.onFrameClick;
    // 冒泡阶段：页面自己处理了的链接（单页应用的路由 preventDefault 过）不抢
    if (doc?.addEventListener && attempt(() => doc.addEventListener!("click", onClick, false))) this.frameClicks = () => void attempt(() => doc.removeEventListener?.("click", onClick, false));
    const mime = doc ? read(() => doc.contentType) : undefined;
    this.file = location && mime && fileRenderOf({ url: location.href, mime }) ? { url: location.href, name: fileNameOf(location.href), inFrame: true, seq: ++this.fileSeq } : undefined;
    if (location) {
      this.lastUrl = location.href;
      const app = parseAppPath(`${location.pathname}${location.search}`);
      if (app) {
        const path = `${app.rest.replace(/^\//, "")}${location.hash}`;
        const hash = toHash({ tab: "app", app: app.name, ...(path ? { path } : {}) });
        // 换掉这一条的地址，不压新记录、不触发 hashchange（来处记号留着）
        if (!this.closed && this.page.location.hash !== hash) this.page.history.replaceState(this.page.history.state, "", hash);
      }
    }
    this.refreshView();
  }

  /**
   * 开着的时候地址又换成这个应用的另一页（又点了一个入口、改了地址栏）：框里不在那一页就换过去。
   * 框里自己走的不会走到这里（地址是换进去的，不触发 hashchange）
   */
  show(route: Extract<Route, { tab: "app" }>): void {
    const target = frameSrc(route);
    // 160 号票：换成的是能渲染的文件，渲染它（框不动）；换成网页的收起盖着的渲染层
    const url = this.absolute(target);
    if (url && fileRenderOf({ url })) {
      if (this.file?.url !== url) this.openFile(url);
      return;
    }
    if (this.file && !this.file.inFrame) {
      this.file = undefined;
      this.refreshView();
    }
    const win = this.frame?.contentWindow;
    const here = win ? read(() => `${win.location.pathname}${win.location.search}${win.location.hash}`) : undefined;
    if (here !== target && this.frame) this.frame.src = target;
  }

  /** 框里的标题变了（单页应用自己改 document.title） */
  titleChanged(): void {
    this.refreshView();
  }

  /** 顶栏的后退：框里退一页；渲染层盖在框上面时收起它（160 号票） */
  goBack(): void {
    if (this.file && !this.file.inFrame) return this.closeFile();
    if (!this.current.canGoBack) return;
    const win = this.frame?.contentWindow;
    if (win && attempt(() => win.history.back())) return;
    // 跨源（框里跳到了别的网站）退不了：回到最后一次在二狗这边的那一页
    if (this.frame) this.frame.src = this.lastUrl;
  }

  /** 顶栏的刷新；渲染层盖在框上面时重新取这个文件（160 号票） */
  reload(): void {
    if (this.file && !this.file.inFrame) {
      this.file = { ...this.file, seq: ++this.fileSeq };
      this.refreshView();
      return;
    }
    const win = this.frame?.contentWindow;
    if (win && attempt(() => win.location.reload())) return;
    if (this.frame) this.frame.src = this.lastUrl;
  }

  /** 顶栏的"在新窗口打开"：框里现在这一页；看着文件时是这个文件（160 号票） */
  openOutside(): void {
    if (this.file) {
      this.page.open(this.file.url, "_blank", "noopener");
      return;
    }
    const win = this.frame?.contentWindow;
    this.page.open((win && read(() => win.location.href)) || this.lastUrl, "_blank", "noopener");
  }

  /** 返回手势（鸿蒙 App 经返回栈调来）：和顶栏的 ‹ 一致，框里能后退就退一页，退不了了才关掉 */
  backGesture(): void {
    if (this.current.canGoBack) this.goBack();
    else this.close();
  }

  /** ×、Esc、返回手势退到头：回到盖住之前的那一页（只做一次） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    leaveInAppBrowser(this.page, this.leaveTo, this.loads > 1);
  }

  /**
   * 渲染层里点了链接（160 号票，href 已经按文件的地址解析成完整的）：同一个转发服务里能渲染的换一个文件看；
   * 同一服务别的地址框跳过去、收起渲染层；外部网站、二狗自己的页面新窗口打开
   */
  followLink(href: string): void {
    const url = this.absolute(href);
    if (!url) return;
    if (!appRouteOf(url, this.origin)) {
      this.page.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (fileRenderOf({ url })) return this.openFile(url);
    this.file = undefined;
    if (this.frame) this.frame.src = url;
    this.refreshView();
  }

  /**
   * 渲染层取到的其实不是能渲染的文本（.md 地址回的网页这类，160 号票）：框照旧打开它，收起渲染层。
   * seq 是取的那一次（InAppFile.seq），已经换了文件、刷新过的不管
   */
  fileIsPage(seq: number): void {
    const file = this.file;
    if (!file || file.seq !== seq) return;
    this.file = undefined;
    // 框里本来就是它（按响应类型认出来的）：露出来就行
    if (!file.inFrame && this.frame) this.frame.src = file.url;
    this.refreshView();
  }

  /** 盖一层渲染看这个文件（框不动），地址换成文件的（不压新记录，刷新、发给别的设备还是它） */
  private openFile(url: string): void {
    this.file = { url, name: fileNameOf(url), inFrame: false, seq: ++this.fileSeq };
    this.replaceHash(url);
    this.refreshView();
  }

  /** 收起盖在框上面的渲染层，地址换回框里那一页；框一直空着（直接打开的文件）就关掉内置浏览器 */
  private closeFile(): void {
    if (!this.frameUsed) return this.close();
    this.file = undefined;
    this.replaceHash(this.lastUrl);
    this.refreshView();
  }

  /** 这一条的地址换成 url 对应的内置浏览器那一页（不压新记录、不触发 hashchange）；不是转发的地址不换 */
  private replaceHash(url: string): void {
    const route = appRouteOf(url, this.origin);
    if (!route || this.closed) return;
    const hash = toHash(route);
    if (this.page.location.hash !== hash) this.page.history.replaceState(this.page.history.state, "", hash);
  }

  private readonly onKey = (e: KeyLike) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    this.close();
  };

  /** 框里那一页上点了链接（160 号票）：同一个转发服务里能渲染的文件（按扩展名认）拦下来，盖一层渲染；普通的左键单击、没带 download、页面自己没处理过才拦 */
  private readonly onFrameClick = (e: LinkClick) => {
    if (this.closed || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = linkIn(e.target);
    if (!link || link.hasAttribute("download")) return;
    const url = this.absolute(link.href);
    if (!url || !appRouteOf(url, this.origin) || !fileRenderOf({ url })) return;
    e.preventDefault();
    this.openFile(url);
  };

  private refreshView(): void {
    const win = this.frame?.contentWindow;
    const file = this.file;
    const docTitle = win ? read(() => win.document.title.trim()) : undefined;
    const frameBack = (win ? read(() => win.navigation?.canGoBack) : undefined) ?? this.loads > 1;
    const next: InAppBrowserView = {
      title: file ? file.name : docTitle || titleHints.get(this.app) || this.app,
      canGoBack: file && !file.inFrame ? true : frameBack,
      ...(file ? { file } : {}),
    };
    if (next.title === this.current.title && next.canGoBack === this.current.canGoBack && next.file === this.current.file) return;
    this.current = next;
    this.onChange(next);
  }
}
