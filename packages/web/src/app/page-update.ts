// 服务端的页面更新了（116 号票）在页面上的那一半：页面自己是哪一版、什么时候问服务端、忙不忙、有没有会丢的东西、点"刷新"前留住
// 输入框里的字。该提示、该直接刷新还是什么都不做由状态层算（state/page-update.ts 的 pageUpdateAction）。
// - 页面自己是哪一版：构建时写进 index.html <head> 的 <meta name="ergou-web-version">（build/web-version-plugin.ts）；开发服务器的页面没有；
// - 切到后台（visibilitychange → hidden）报 page_hidden；切回前台报 page_foreground，经 HTTP 问一次服务端现在是哪一版（不等 WebSocket 推：
//   在后台时连接可能冻住了；最多等 5 秒），问到、问不到之后再过 1 秒报 page_settled——这段时间里知道的新版本（问到的、冻住的连接重连上
//   订阅响应里带的）都算在后台时来的；问着的时候又切到后台了，问完也不报（不然后台状态被清掉，之后在后台来的新版本回来时只提示）。
//   窗口拿回焦点（浏览器里从别的窗口切回来）也问一次，不算切回前台。鸿蒙 App 的外壳不用改：
//   App 切到后台、回到前台时 ArkWeb 里的页面照样报 visibilitychange（不一定马上，所以不靠它决定发不发系统通知，这里只是晚一点问）；
// - 忙（busy）：正在录音（VoiceInput）、输入框上方有附件（Composer，在传、或传好了等着发），各自 useHoldPageUpdate 报上来；
// - 有没有会丢的东西（idle 的反面）：开着的输入框里打了字（useKeptText 登记的）、引用了卡片（ui.quotes）、返回栈里挂着 overlay
//   （弹窗、对话框、选择器、详情页、抽屉、会话缩小着，page-back.ts）；页面上任何一个文本框里有字（直接扫 DOM：问题卡的"自己写"、
//   计划卡的修改意见和假设、宽屏下不算弹层的详情里的输入……，状态层的 fieldsHaveText）；有没发出去的消息和卡片操作（断网时排着的，
//   状态层的 unsentWork）；
// - 直接刷新、点"刷新"都是 location.reload()（鸿蒙 App 的 ArkWeb 里一样）。点"刷新"前把输入框里打的字存进这个标签页的
//   sessionStorage，刷新后同一个会话的输入框挂上时放回去（reload-drafts.ts）。
import { type Dispatch, type SetStateAction, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { type ConversationId, fieldsHaveText, pageUpdateAction, type TextField, type UiState, unsentWork, WEB_VERSION_META } from "../state/index.ts";
import { pageBack } from "./page-back.ts";
import { createComposerDrafts, reloadDraftsIn } from "./reload-drafts.ts";
import { usePageVisible } from "./secretary-unread.ts";
import { useStore } from "./store.tsx";

/** 切回前台时问服务端最多等多久 */
const ASK_TIMEOUT_MS = 5000;
/** 问完之后再过多久算"回到前台了"（这之前知道的新版本还算在后台时来的；冻住的连接重连上也赶得上） */
const RETURN_GRACE_MS = 1000;

/** 页面自己是哪一版（构建时写进 index.html 的）；开发服务器的页面、读不到是 undefined */
const PAGE_WEB_VERSION: string | undefined = typeof document === "undefined" ? undefined : (document.querySelector(`meta[name="${WEB_VERSION_META}"]`)?.getAttribute("content") ?? undefined);

/** 刷新前后留住输入框里的字：这个标签页的 sessionStorage */
const reloadDrafts = reloadDraftsIn(() => sessionStorage);
/** 开着的输入框里打的字 */
const composers = createComposerDrafts();

/** 先别刷新的（正在录音、输入框上方有附件）：各自一个 id */
const holds = new Set<string>();
const holdListeners = new Set<() => void>();

function changedHolds(): void {
  for (const l of holdListeners) l();
}

/** active 时页面在忙：先不提示、不直接刷新（刷新会丢掉录着的语音、输入框上方的附件） */
export function useHoldPageUpdate(active: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    holds.add(id);
    changedHolds();
    return () => {
      holds.delete(id);
      changedHolds();
    };
  }, [id, active]);
}

function usePageBusy(): boolean {
  return useSyncExternalStore(
    (l) => {
      holdListeners.add(l);
      return () => void holdListeners.delete(l);
    },
    () => holds.size > 0,
  );
}

/** 输入框里打的字（用法同 useState("")）：点"刷新"前存下，刷新后同一个会话的输入框挂上时放回去 */
export function useKeptText(conversation: ConversationId): [string, Dispatch<SetStateAction<string>>] {
  const [text, setText] = useState(() => reloadDrafts.take(conversation) ?? "");
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  });
  useEffect(() => composers.open(conversation, () => latest.current), [conversation]);
  return [text, setText];
}

/** 页面上的文本框：textarea、input、可编辑的元素 */
function pageTextFields(): TextField[] {
  return [...document.querySelectorAll<HTMLElement>("textarea, input, [contenteditable]")].map((el): TextField => {
    if (el instanceof HTMLTextAreaElement) return { type: "textarea", text: el.value, editable: !el.readOnly && !el.disabled };
    if (el instanceof HTMLInputElement) return { type: el.type, text: el.value, editable: !el.readOnly && !el.disabled };
    return { type: "editable", text: el.textContent ?? "", editable: el.isContentEditable };
  });
}

/**
 * 页面上没有会丢的东西：输入框都是空的、没引用卡片、没开着弹层这些，页面上别的文本框也都是空的，没有没发出去的消息和卡片操作
 */
function pageIdle(ui: UiState): boolean {
  return Object.keys(composers.current()).length === 0 && Object.keys(ui.quotes).length === 0 && !pageBack().overlayOpen() && !unsentWork(ui) && !fieldsHaveText(pageTextFields());
}

/**
 * 有新版本时（主框架里一份）：切到后台、切回前台时报给状态层、切回前台时问服务端；在后台时来的、回到前台没有会丢的东西就直接刷新。
 * 返回要不要出提示，和提示上的"刷新""等会儿"
 */
export function usePageUpdate(): { prompt: boolean; refresh(): void; later(): void } {
  const { ui, http, notePageUpdate } = useStore();
  const visible = usePageVisible();
  const busy = usePageBusy();

  useEffect(() => {
    if (PAGE_WEB_VERSION === undefined) return;
    let asking = false;
    let settle = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (asking) return;
      asking = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
      http
        .webVersion(controller.signal)
        .then(
          (view) => notePageUpdate({ kind: "web_version", version: view.version }),
          () => {
            // 问不到（网还没回来、守护进程正在重启）：等连接重连上，订阅的响应里有
          },
        )
        .finally(() => {
          clearTimeout(timer);
          asking = false;
          if (!settle) return;
          settle = false;
          settleTimer = setTimeout(() => notePageUpdate({ kind: "page_settled" }), RETURN_GRACE_MS);
        });
    };
    const onVisibility = () => {
      clearTimeout(settleTimer);
      if (document.visibilityState !== "visible") {
        // 问着服务端的时候又切走了：问完不报"问完了"（还在后台）
        settle = false;
        return notePageUpdate({ kind: "page_hidden" });
      }
      notePageUpdate({ kind: "page_foreground" });
      settle = true;
      ask();
    };
    // 打开时就在后台（后台标签页里打开的）
    if (document.visibilityState !== "visible") notePageUpdate({ kind: "page_hidden" });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", ask);
    return () => {
      clearTimeout(settleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", ask);
    };
  }, [http, notePageUpdate]);

  const action = pageUpdateAction(ui.webVersion, PAGE_WEB_VERSION, { visible, busy, idle: pageIdle(ui) });
  useEffect(() => {
    if (action === "reload") window.location.reload();
  }, [action]);

  const refresh = useCallback(() => {
    reloadDrafts.keep(composers.current());
    window.location.reload();
  }, []);
  const later = useCallback(() => notePageUpdate({ kind: "update_later" }), [notePageUpdate]);
  return { prompt: action === "prompt", refresh, later };
}
