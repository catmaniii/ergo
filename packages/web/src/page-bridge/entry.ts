// 页面桥注入到网页里的入口（134 号票）：构建成一段独立的脚本（build/page-bridge.ts 打包成 IIFE），宿主注入前把下面的口令占位换成
// 随机的口令（鸿蒙 App：frontend/harmony/entry/src/main/ets/browser/PageHost.ets）。只在主框架里装、只装一次；宿主的 post 和口令在
// 注入的那一刻拿到、只留在闭包里；入口 window.__ergoPage 冻结、不能改不能删。口令没换（不是 32 个十六进制字）、宿主没给 post 就什么都不装。
import { installPageBridge, type BridgeWindow } from "./bridge.ts";
import { PAGE_BRIDGE_API, PAGE_BRIDGE_HOST } from "./protocol.ts";

/** 宿主注入前换掉（只在这里出现一次，别处不要写这个占位） */
const NONCE = "__ERGO_PAGE_NONCE__";

function start(): void {
  const w = window as BridgeWindow;
  if (w.top !== w || !/^[0-9a-f]{32}$/.test(NONCE)) return;
  if (Object.prototype.hasOwnProperty.call(w, PAGE_BRIDGE_API)) return;
  const host = (w as unknown as Record<string, unknown>)[PAGE_BRIDGE_HOST] as { post?: unknown } | undefined;
  const postFn = host?.post;
  if (typeof postFn !== "function") return;
  const post = (json: string) => void postFn.call(host, json);
  const api = installPageBridge(w, NONCE, post);
  Object.defineProperty(w, PAGE_BRIDGE_API, { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
}

function tryStart(): void {
  try {
    start();
  } catch {
    // 装不上不碍网页的事
  }
}

tryStart();
// 宿主的对象在文档开始时还没挂上的（不同宿主注入的时机不一样），等 DOM 建好再试一次（装过的不再装）
if (!Object.prototype.hasOwnProperty.call(window, PAGE_BRIDGE_API)) window.addEventListener("DOMContentLoaded", tryStart, { once: true });
