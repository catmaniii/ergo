// 浏览侧边栏的侧边栏模式（147 号票，side-remote.ts）接到这个页面上：App 给的 window.ergoSide、App 推样子用的 window.__ergoSide。
// 单独一个文件，side-remote.ts 就不碰浏览器的全局变量，能在 Node 里测。
// 275 号票：样子里带着"浏览"页那一份现在的外观，交给这一页的外观（pageTheme().adopt：马上换风格、深浅色、主色，不写存储）。
import { useSyncExternalStore } from "react";
import { appObject, exposeToApp } from "../../app/app-names.ts";
import { pageTheme } from "../../app/page-theme.ts";
import type { BrowseSideView } from "./browse-side.ts";
import { RemoteSide, type SideHostObject } from "./side-remote.ts";

/** 这一页是侧边栏模式（212 号票起由外壳认：app/side-mode.ts），照旧转出 */
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
  // 312 号票：App 给的对象新名字优先、没有用旧名字的；推样子的回调新旧两个名字都挂（旧 App 用的是旧名字）
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
