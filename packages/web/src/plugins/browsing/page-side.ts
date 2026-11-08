// 浏览侧边栏的侧边栏模式（side-remote.ts）接到这个页面上：App 给的 window.ergoSide、App 推样子用的 window.__ergoSide。
// 单独一个文件，side-remote.ts 就不碰浏览器的全局变量，能在 Node 里测。
// 样子里带着"浏览"页那一份现在的外观，交给这一页的外观（pageTheme().adopt：马上换风格、深浅色、主色，不写存储）。
// 这一页里点了二狗自己的页面（卡片的"看大地图"这类 #/… 链接，447）：交给主页面打开、侧边栏收起（side-handoff.ts，useSideLinks）。
import { useEffect, useSyncExternalStore } from "react";
import { appObject, exposeToApp } from "../../app/app-names.ts";
import { pageTheme } from "../../app/page-theme.ts";
import type { BrowseSideView } from "./browse-side.ts";
import { isAppHash, sideLinkHash, writeSideGoto } from "./side-handoff.ts";
import { RemoteSide, type SideHostObject } from "./side-remote.ts";

/** 这一页是侧边栏模式（由外壳认：app/side-mode.ts），照旧转出 */
export { SIDE_MODE } from "../../app/side-mode.ts";

interface SideScope {
  ergoSide?: SideHostObject;
  __ergoSide?: (json: string) => void;
}

let remote: RemoteSide | undefined;

/** 侧边栏模式这一页的那一份：第一次用到时登记 App 推样子的回调、告诉 App 起来了 */
export function pageRemoteSide(): RemoteSide {
  if (remote) return remote;
  const scope = window as unknown as SideScope;
  const created = new RemoteSide(() => appObject(scope, "ergoSide") as SideHostObject | undefined, { onAppearance: (appearance) => pageTheme().adopt(appearance) });
  exposeToApp(scope, "__ergoSide", (json: string) => {
    const message = created.receive(json);
    // 窄屏整屏盖住时延伸到了手势条底下：底部让开的那一截照"浏览"页的
    if (message?.safeBottom) document.documentElement.style.setProperty("--safe-bottom", message.safeBottom);
  });
  created.ready();
  remote = created;
  return created;
}

export function useRemoteSide(): BrowseSideView {
  const r = pageRemoteSide();
  return useSyncExternalStore(r.subscribe, r.snapshot);
}

/** 记下要主页面去的地址、收起侧边栏（App 把收起转给主页面，主页面照记下的跳过去） */
function handToMain(hash: string): void {
  try {
    writeSideGoto(window.localStorage, hash, Date.now());
  } catch {
    // 存储用不了（隐私模式）：照样收起，主页面不跳
  }
  pageRemoteSide().setOpen(false);
}

/**
 * 侧边栏这一页里点了二狗自己的页面（<a href="#/…">：卡片的"看大地图"、别的卡片里的链接）：这一页不认地址里的 #，交给主页面打开。
 * 代码里直接改地址的（卡片按钮里 window.location.hash = …）：地址改回去，同样交给主页面
 */
export function useSideLinks(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      const hash = sideLinkHash(e, a.getAttribute("href"));
      if (hash === undefined) return;
      e.preventDefault();
      handToMain(hash);
    };
    const onHash = () => {
      const hash = window.location.hash;
      if (!isAppHash(hash)) return;
      history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
      handToMain(hash);
    };
    // 冒泡阶段：组件自己处理了（preventDefault）的不管
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
}
