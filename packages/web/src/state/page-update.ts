// 服务端的页面更新了（116 号票）：开着的页面（鸿蒙 App、浏览器）怎么办——提示"二狗有新版本 · 刷新"，或者回到前台时直接刷新。
// - 页面自己是哪一版：构建时写进 index.html 的版本号（构建产物内容的哈希，协议包 web-version.ts），页面那一半读出来交进来；
//   开发服务器（vite dev）的页面没有，一律什么都不做；
// - 服务端现在是哪一版（server）：连上（含重连）时订阅的响应里带着、index.html 换了时活动状态频道上推来的临时事件 web_version、
//   切回前台时经 HTTP 问到的（GET /api/web-version），三处都是 web_version 输入；守护进程没说（旧版守护进程、index.html 里没有版本号）
//   是不知道，什么都不做；
// - 在前台时来的新版本只提示（用户可能正在看、正在写），不静默刷新；
// - 在后台时来的（用户 2026-10-13 同意）：页面在后台、或者刚切回前台还在问服务端的这段时间里（away：page_hidden 到 page_settled）
//   才知道的新版本，回到前台时页面上没有会丢的东西——输入框是空的（没打字、没引用卡片）、没在录音、没有附件、没开着弹层，
//   页面上别的文本框也都是空的（问题卡的"自己写"、计划卡的修改意见、宽屏详情里的输入……，fieldsHaveText）、没有没发出去的消息和
//   卡片操作（unsentWork）——就直接刷新，不提示；有的照旧提示。问服务端的那几秒里又切到后台的，晚到的"问完了"（page_settled）不算数；
// - 正在录音、输入框上方有附件（在传、或传好了等着发）时先不提示（刷新会丢掉它们），完了再提示；输入框里打的字点"刷新"前存下、
//   刷新后放回（app/reload-drafts.ts）；
// - "等会儿"（update_later）记下这时服务端的那一版，同一版不再提示；切回前台（page_foreground）、或者服务端又换了一版时再提示。
// 纯函数，不依赖 React 和 DOM；页面那一半在 app/page-update.ts。
import type { UiState } from "./ui-state.ts";

export interface WebVersionState {
  /** 服务端现在是哪一版；不知道是 undefined */
  readonly server: string | undefined;
  /** 点"等会儿"时服务端的那一版：同一版不再提示，切回前台时清掉 */
  readonly later: string | undefined;
  /** 页面在后台，或者刚切回前台、还在问服务端（page_hidden 到 page_settled） */
  readonly away: boolean;
  /** 页面在后台（page_hidden 到 page_foreground）：这时到的"问完了"是上一次切回前台时问的，不算数 */
  readonly hidden: boolean;
  /** 在 away 的时候才知道的那一版（在后台时来的）：回到前台、页面上没有会丢的东西就直接刷新 */
  readonly cameAway: string | undefined;
}

export const initialWebVersionState: WebVersionState = { server: undefined, later: undefined, away: false, hidden: false, cameAway: undefined };

/** 服务端说现在是这一版（订阅的响应、推来的、问到的）；undefined 是不知道。换了一版时记下是不是在后台时知道的 */
export function withServerWebVersion(state: WebVersionState, version: string | undefined): WebVersionState {
  if (state.server === version) return state;
  return { ...state, server: version, cameAway: state.away ? version : undefined };
}

/** 点了"等会儿"：这一版先不提示 */
export function webVersionLater(state: WebVersionState): WebVersionState {
  return state.later === state.server ? state : { ...state, later: state.server };
}

/** 切到后台 */
export function webVersionHidden(state: WebVersionState): WebVersionState {
  return state.away && state.hidden ? state : { ...state, away: true, hidden: true };
}

/** 切回前台：之前的"等会儿"不算了；还算在后台，直到问完服务端（webVersionSettled） */
export function webVersionForeground(state: WebVersionState): WebVersionState {
  return state.later === undefined && state.away && !state.hidden ? state : { ...state, later: undefined, away: true, hidden: false };
}

/**
 * 切回前台后问完了服务端（问到了、问不到）：之后再来的新版本算在前台时来的。
 * 问着的时候又切到后台了（还在 hidden）：不算数，还在后台
 */
export function webVersionSettled(state: WebVersionState): WebVersionState {
  return state.away && !state.hidden ? { ...state, away: false } : state;
}

/**
 * 有没有没发出去的东西（刷新就丢了）：会话末尾还没收到权威消息的（在路上、断网时排着、失败了留着原文等重发），
 * 在路上的卡片操作（被拒了的卡片上写着原因、用户再点，不用留）
 */
export function unsentWork(state: UiState): boolean {
  return Object.values(state.conversations).some((c) => c.tail.length > 0) || Object.values(state.cards).some((c) => c.pending?.status === "sending");
}

/** 页面上的一个文本框：类型（input 的 type，或者 textarea、editable：可编辑的元素）、里面的字、能不能编辑（只读、禁用的不能） */
export interface TextField {
  readonly type: string;
  readonly text: string;
  readonly editable: boolean;
}

/** 这些 input 里没有"写了的字" */
const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set(["checkbox", "radio", "hidden", "file", "range", "color", "button", "submit", "reset", "image"]);

/** 页面上有没有打了字的文本框（只有空白的不算） */
export function fieldsHaveText(fields: Iterable<TextField>): boolean {
  for (const f of fields) if (f.editable && !NOT_TEXT_INPUTS.has(f.type) && f.text.trim() !== "") return true;
  return false;
}

/** 页面此刻的样子：看得见吗、在忙吗（录音、有附件）、有没有会丢的东西（输入框里的字、引用的卡片、开着的弹层） */
export interface PageNow {
  readonly visible: boolean;
  /** 正在录音、输入框上方有附件（在传、或传好了等着发） */
  readonly busy: boolean;
  /**
   * 页面上没有会丢的东西：输入框都是空的（没打字、没引用卡片），别的文本框也都是空的（fieldsHaveText），没开着弹层、对话框、详情这些，
   * 没有没发出去的消息和卡片操作（unsentWork）
   */
  readonly idle: boolean;
}

/** 怎么办：什么都不做、提示"有新版本 · 刷新"、直接刷新 */
export type PageUpdateAction = "none" | "prompt" | "reload";

/**
 * 页面自己的（own）和服务端的都知道、对不上时：在后台时来的、页面看得见了（回到前台）、没在忙、没有会丢的东西，直接刷新；
 * 别的提示，除非正在忙、这一版点过"等会儿"
 */
export function pageUpdateAction(state: WebVersionState, own: string | undefined, page: PageNow): PageUpdateAction {
  const { server, later } = state;
  if (own === undefined || server === undefined || server === own) return "none";
  if (page.busy) return "none";
  if (page.visible && state.away && state.cameAway === server && page.idle) return "reload";
  return server === later ? "none" : "prompt";
}
