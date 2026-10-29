// 内置浏览器（132 号票）：守护进程转发的本机服务的页面（/apps/<应用名>/…），整页盖在原来的页面上。电脑、鸿蒙 App、手机网页都一样用。
// 照图片查看器的做法：挂到 body 上（createPortal），电脑上 Esc、右上角 × 直接关；返回栈挂一层 overlay，鸿蒙的返回手势和顶栏的 ‹ 一致：框里能后退先退一页，退不了才关。
// 顶栏：后退（框里的上一页）、标题（框里页面的 <title>，取不到用打开时给的名字或应用名）、刷新、在新窗口打开（鸿蒙 App 里不给）、关闭；下面是框。
// 窄屏、宽屏都铺满整个窗口（服务的页面要地方；宽屏也不留主导航，关掉就回来）。
// 160 号票：能渲染的文件（markdown 这类）不让框显示原始文本、不下载，框藏起来，盖一层二狗的渲染（ui/file-view.tsx），内容按同源地址直接取。
// 逻辑都在 app/in-app-browser.ts（InAppBrowserSession），这里只把框和按钮接上；哪里要打开它调 app/page-in-app-browser.ts 的 openInAppBrowser。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InAppBrowserSession, type InAppBrowserView } from "../app/in-app-browser.ts";
import { pageBack } from "../app/page-back.ts";
import { pageBrowser } from "../app/page-in-app-browser.ts";
import { pageNativeApp } from "../app/page-native.ts";
import type { Route } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { t } from "../state/index.ts";
import { FileView } from "./file-view.tsx";

export function InAppBrowser({ route, leaveTo }: { route: Extract<Route, { tab: "app" }>; leaveTo: string }) {
  const { http } = useStore();
  const [view, setView] = useState<InAppBrowserView | undefined>(undefined);
  const [session] = useState(() => new InAppBrowserSession({ route, page: pageBrowser(), back: pageBack(), leaveTo, onChange: setView }));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const titleWatch = useRef<MutationObserver | undefined>(undefined);
  useEffect(() => {
    const unmount = session.mount(frameRef.current!);
    return () => {
      titleWatch.current?.disconnect();
      unmount();
    };
  }, [session]);
  // 开着的时候地址又换成这个应用的另一页（hashchange 换来一个新的 route）：框里换过去；打开时的那一页不用换
  const handled = useRef(route);
  useEffect(() => {
    if (handled.current === route) return;
    handled.current = route;
    session.show(route);
  }, [session, route]);

  /** 框里加载完一页：交给 session；单页应用自己改标题，盯着框里 <head> 的变化 */
  const onLoad = () => {
    session.frameLoaded();
    titleWatch.current?.disconnect();
    titleWatch.current = undefined;
    try {
      const head = frameRef.current?.contentDocument?.head;
      if (!head) return;
      const watch = new MutationObserver(() => session.titleChanged());
      watch.observe(head, { subtree: true, childList: true, characterData: true });
      titleWatch.current = watch;
    } catch {
      // 框里跳到了别的网站（跨源）：读不到，标题停在上一页的
    }
  };

  const shown = view ?? session.view();
  // 鸿蒙 App 里没有"新窗口"：新窗口会落到 App 的主页面上，把二狗换掉
  const inApp = pageNativeApp() !== undefined;
  const file = shown.file;
  return createPortal(
    <div className="iab" role="dialog" aria-modal="true" aria-label={shown.title}>
      <header className="topbar iab-bar">
        <button type="button" className="icon-btn" onClick={() => session.goBack()} disabled={!shown.canGoBack} aria-label={t("ui.inAppBrowser.back")} title={t("ui.inAppBrowser.back")}>
          ‹
        </button>
        <div className="title">{shown.title}</div>
        <button type="button" className="icon-btn iab-act" onClick={() => session.reload()} aria-label={t("ui.inAppBrowser.reload")} title={t("ui.inAppBrowser.reload")}>
          ↻
        </button>
        {!inApp && (
          <button type="button" className="icon-btn iab-act" onClick={() => session.openOutside()} aria-label={t("ui.inAppBrowser.openOutside")} title={t("ui.inAppBrowser.openOutside")}>
            ↗
          </button>
        )}
        <button type="button" className="icon-btn iab-close" onClick={() => session.close()} aria-label={t("common.close")} title={t("ui.inAppBrowser.closeHint")}>
          ×
        </button>
      </header>
      {/* 能渲染的文件（160 号票）：盖一层二狗的渲染，框藏起来（留着，收起渲染层回到框里那一页）；换了文件、刷新换 key 重新取 */}
      {file && (
        <FileView
          key={`${file.seq}`}
          url={file.url}
          name={file.name}
          load={(signal) => http.appFileText(file.url, signal)}
          onPage={() => session.fileIsPage(file.seq)}
          onLink={(href) => session.followLink(href)}
          download={{ href: file.url }}
          outside={inApp ? undefined : { label: t("ui.inAppBrowser.openOutside"), run: () => session.openOutside() }}
        />
      )}
      {/* 不加 sandbox：服务的页面要同源（cookie、二狗读它的标题和地址）又要跑脚本，同源加脚本的沙箱形同虚设；同源转发的安全取舍见 docs/developer-guide.md */}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
      <iframe ref={frameRef} className="iab-frame" src={session.src} title={shown.title} onLoad={onLoad} style={file ? { display: "none" } : undefined} />
    </div>,
    document.body,
  );
}
