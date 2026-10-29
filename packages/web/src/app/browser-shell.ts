// 二狗的网页在鸿蒙 App 里时，网页一侧怎么用 App 的原生内置浏览器（134 号票）——"浏览"页签之外的那几处：
// - watchNativeBrowser：开场 attach 一次（告诉 App 网页有"浏览"页签了，App 之后把主页面上点的外链交到浏览器里打开），
//   之后跟着 App 推的变；加载完的页记进最近访问；App 说它打开了一个链接时切到"浏览"；
// - openInNativeBrowser：132 号票的 openInAppBrowser 在壳里走这里——切到"浏览"页签、让浏览器打开这个地址（二狗转发的服务页面
//   /apps/… 拼成完整地址，带着 App 里的设备凭证 cookie）；
// - followExternalLinks：页面里点外部网站的链接（聊天里 agent 给的、附件预览里的、target=_blank 的）在壳里改到"浏览"里打开，
//   不再跳系统浏览器（App 的 interceptLoad 也会兜住主页面的外链跳转，这里先在网页里拦下，不用绕一圈）。
// 不在壳里（电脑、手机浏览器）这几处都不调：openInAppBrowser 照旧嵌入框叠层，外链照旧新开标签页。
// 不碰浏览器的全局变量：页面、文档换成接口，测试在 Node 里跑（test/app/browser-shell.test.ts）；接到页面上的在 page-browse.ts、page-in-app-browser.ts。
import { BLANK_BROWSER, type BrowserState, isExternalWebUrl, type NativeBrowser } from "./native-browser.ts";

/** 浏览器的样子，变了通知 */
export interface BrowserWatch {
  state(): BrowserState;
  subscribe(listener: () => void): () => void;
}

/**
 * 接上 App 的原生浏览器：马上 attach（取一次现在的样子），之后跟着推的变；不在加载了、有地址的那一刻记进最近访问（visited）；
 * App 在浏览器里打开了一个链接（主页面上点的外链被它接住）时调 onOpen（切到"浏览"）
 */
export function watchNativeBrowser(browser: NativeBrowser, recents: { visited(url: string, title: string): void }, onOpen: (url: string) => void): BrowserWatch {
  let state = browser.attach() ?? BLANK_BROWSER;
  const listeners = new Set<() => void>();
  browser.subscribe((event) => {
    if (event.type === "open") {
      onOpen(event.url);
      return;
    }
    // 页面桥报的话、拦下的选文件对话框由 page-commands.ts 接
    if (event.type !== "state") return;
    const next = event.state;
    if (!next.loading && next.url !== "" && (next.url !== state.url || next.title !== state.title || state.loading)) recents.visited(next.url, next.title);
    state = next;
    for (const listener of listeners) listener();
  });
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * 在 App 的原生浏览器里打开 url（可以是 /apps/<应用名>/… 这样的二狗上的路径，按 origin 拼成完整地址）：让浏览器打开、切到"浏览"页签。
 * 不是 http(s) 的打不开，返回 false
 */
export function openInNativeBrowser(browser: NativeBrowser, url: string, origin: string, showBrowse: () => void): boolean {
  let href: string;
  try {
    href = new URL(url, `${origin}/`).href;
  } catch {
    return false;
  }
  if (!/^https?:\/\//i.test(href)) return false;
  browser.load(href);
  showBrowse();
  return true;
}

/** 点击事件里用到的 */
export interface LinkClick {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: unknown;
  preventDefault(): void;
}

/** 链接元素里用到的（<a href>、SVG 里的 <a> 不管） */
export interface LinkLike {
  readonly href: string;
  readonly target?: string;
  hasAttribute(name: string): boolean;
}

/** 能挂点击监听的（页面的 document） */
export interface ClickTarget {
  addEventListener(type: "click", listener: (e: LinkClick) => void, capture: boolean): void;
  removeEventListener(type: "click", listener: (e: LinkClick) => void, capture: boolean): void;
}

/**
 * 页面里点外部网站的链接改到"浏览"里打开：捕获阶段看点的是不是 <a href>（closestLink 从点到的元素往上找），是外部的 http(s) 链接、
 * 没被别人处理过、不是带下载的、是普通的左键单击，就拦下来交给 open。返回停下
 */
export function followExternalLinks(doc: ClickTarget, origin: string, closestLink: (target: unknown) => LinkLike | undefined, open: (url: string) => void): () => void {
  const onClick = (e: LinkClick) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = closestLink(e.target);
    if (!link || link.hasAttribute("download") || !isExternalWebUrl(link.href, origin)) return;
    e.preventDefault();
    open(link.href);
  };
  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}
