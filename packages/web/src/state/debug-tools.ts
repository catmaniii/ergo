// 设置里的"关于二狗"和 Debug 工具集（124 号票，用户 2026-10-14 提）在状态层的那一半（纯函数，不碰页面）：
// - 连点关于页上的版本号 8 次打开 Debug 工具集：两次之间超过 2 秒就重新数，第 4 次起底部提示还差几次，第 8 次打开；
//   已经打开时再点提示"已经打开了"。打开后 1 小时有效，只记在页面内存里（不写本机存储）：刷新、重开 App 就没了
//   （用户选的：入口有时限）。正停在 Debug 页里的到期不踢出去，返回后设置列表里就没有这一项了；
// - Debug 工具集的几样记录只留最近的几条：页面日志 200 条、通知记录 20 条（appendCapped）；console 的参数怎么写成一行字（logText）；
// - 连接断开的原因（closeReasonText：WebSocket 的关闭码）、本机存储列出来的样子（storageRows：只列二狗记的键，敏感的只写"有"）、
//   守护进程已运行多久的写法（uptimeText）。
// 关于页的更新日志在 changelog.ts。
import { describeDuration, t, tTable, WS_CLOSE_UNPAIRED } from "@ergo/protocol";

/** 连点几次打开 */
export const DEBUG_UNLOCK_TAPS = 8;
/** 两次之间最多隔多久（毫秒），再久就重新数 */
export const DEBUG_TAP_GAP_MS = 2000;
/** 第几次起提示还差几次 */
export const DEBUG_HINT_FROM = 4;
/** 打开后多久有效（毫秒） */
export const DEBUG_OPEN_MS = 60 * 60 * 1000;

/** 连点的计数和打开的时刻（毫秒时钟，页面上是 Date.now()） */
export interface DebugUnlock {
  /** 这一轮连点了几次 */
  readonly taps: number;
  /** 上一次点的时刻 */
  readonly lastTapAt?: number;
  /** 打开的时刻；没打开过（或者收起了）没有 */
  readonly openedAt?: number;
}

export const DEBUG_LOCKED: DebugUnlock = { taps: 0 };


/** 现在开着吗（打开了、没到期） */
export function debugOpen(state: DebugUnlock, now: number): boolean {
  return state.openedAt !== undefined && now - state.openedAt < DEBUG_OPEN_MS;
}

/** 还剩几分钟（往上取整）；没开着是 0 */
export function debugMinutesLeft(state: DebugUnlock, now: number): number {
  if (!debugOpen(state, now)) return 0;
  return Math.ceil((state.openedAt! + DEBUG_OPEN_MS - now) / 60_000);
}

/** 点了一下版本号：数到第几次、该提示什么（不提示是 undefined） */
export function debugTap(state: DebugUnlock, now: number): { state: DebugUnlock; hint?: string } {
  if (debugOpen(state, now)) return { state, hint: t("state.debugTools.alreadyOpen") };
  const continued = state.lastTapAt !== undefined && now - state.lastTapAt <= DEBUG_TAP_GAP_MS;
  const count = continued ? state.taps + 1 : 1;
  if (count >= DEBUG_UNLOCK_TAPS) return { state: { taps: 0, openedAt: now }, hint: t("state.debugTools.opened") };
  const next: DebugUnlock = { taps: count, lastTapAt: now };
  return count >= DEBUG_HINT_FROM ? { state: next, hint: t("state.debugTools.tapsLeft", { count: DEBUG_UNLOCK_TAPS - count }) } : { state: next };
}

/** 页面日志留最近多少条 */
export const PAGE_LOG_MAX = 200;
/** 通知记录留最近多少条 */
export const NOTIFY_LOG_MAX = 20;
/** 页面日志一条最多多少字（堆栈很长的截短） */
const LOG_TEXT_MAX = 4000;

/** 往后接一条，超过上限从最早的丢 */
export function appendCapped<T>(list: readonly T[], entry: T, max: number): readonly T[] {
  const next = [...list, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 页面日志从哪来：console.error / console.warn、没接住的错误（window.onerror）、没接住的 Promise 拒绝 */
export type PageLogSource = "console.error" | "console.warn" | "error" | "unhandledrejection";

export interface PageLogEntry {
  /** 协议时间（带时区偏移的本地 ISO） */
  readonly at: string;
  readonly source: PageLogSource;
  readonly text: string;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** console 的几个参数写成一行字（空格隔开）：字符串原样、出错带堆栈、对象写成 JSON；太长的截短 */
export function logText(values: readonly unknown[]): string {
  const text = values.map(valueText).join(" ");
  return text.length <= LOG_TEXT_MAX ? text : `${text.slice(0, LOG_TEXT_MAX)}…`;
}

/** 时间里的时分秒（"21:03:05"）；不是协议时间的原样 */
function clockSeconds(iso: string): string {
  return /T(\d{2}:\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
}

/** 复制出去的页面日志：每条"时分秒 来源 内容" */
export function pageLogText(entries: readonly PageLogEntry[]): string {
  return entries.map((e) => `${clockSeconds(e.at)} ${e.source} ${e.text}`).join("\n");
}

/** 通知走哪条路：鸿蒙 App 的通知栏、浏览器通知 */
export type NotifyVia = "app" | "browser";

/** 一条通知的结果 */
export type NotifyOutcome = "sent" | "foreground" | "denied" | "duplicate" | "error" | "no_reply" | "unsupported";

export const NOTIFY_OUTCOME_LABEL: Readonly<Record<NotifyOutcome, string>> = tTable({
  sent: "state.debugTools.notify.sent",
  foreground: "state.debugTools.notify.foreground",
  denied: "state.debugTools.notify.denied",
  duplicate: "state.debugTools.notify.duplicate",
  error: "state.debugTools.notify.error",
  no_reply: "state.debugTools.notify.noReply",
  unsupported: "state.debugTools.notify.unsupported",
});

export const NOTIFY_VIA_LABEL: Readonly<Record<NotifyVia, string>> = tTable({ app: "state.debugTools.via.app", browser: "state.debugTools.via.browser" });

/** 通知记录的一条（页面知道多少记多少：App 回了结果的照 App 的，旧版 App 回不了的记"App 没回结果"） */
export interface NotifyRecord {
  readonly at: string;
  readonly id: string;
  readonly title: string;
  /** 走哪条路；浏览器不支持通知时没有 */
  readonly via?: NotifyVia;
  readonly outcome: NotifyOutcome;
  /** 前台也强制发（Debug 工具集里勾的） */
  readonly forced?: boolean;
  /** 补充的说明（出错的原因、App 报的通知编号） */
  readonly detail?: string;
}

/** WebSocket 的关闭码说的是什么；不认识的是 undefined */
function closeCodeText(code: number): string | undefined {
  switch (code) {
    case 1000:
      return t("state.debugTools.close.normal");
    case 1001:
      return t("state.debugTools.close.goingAway");
    case 1006:
      return t("state.debugTools.close.abnormal");
    case 1011:
      return t("state.debugTools.close.daemonError");
    case 1012:
      return t("state.debugTools.close.restarting");
    case WS_CLOSE_UNPAIRED:
      return t("state.debugTools.close.unpaired");
    default:
      return undefined;
  }
}

/** 连接断开的原因：关闭码和它说的是什么，后面接对方给的原因（有的话） */
export function closeReasonText(code: number | undefined, reason: string | undefined): string {
  if (code === undefined) return t("state.debugTools.close.unknown");
  const known = closeCodeText(code);
  const head = known ? `${code} ${known}` : `${code}`;
  return reason ? t("state.debugTools.close.withReason", { head, reason }) : head;
}

/** 本机存储的哪一块 */
export type StorageArea = "localStorage" | "sessionStorage";

export interface StorageRow {
  readonly area: StorageArea;
  readonly key: string;
  /** 值（太长的截短）；敏感的只写"有" */
  readonly value: string;
  readonly masked: boolean;
}

/** 本机存储里一个值最多显示多少字 */
const STORAGE_VALUE_MAX = 80;
/** 敏感的键：凭证、令牌、口令一类，和刷新时留着的草稿（用户打的字）：不显示值 */
const SENSITIVE_KEY = /credential|token|secret|password|cookie|draft/i;

/** 本机存储里二狗记的键（ergo 开头），按键排好；敏感的只写"有"，太长的截短 */
export function storageRows(area: StorageArea, entries: readonly (readonly [string, string])[]): StorageRow[] {
  return entries
    .filter(([key]) => key.startsWith("ergo"))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]): StorageRow => {
      if (SENSITIVE_KEY.test(key)) return { area, key, value: t("state.debugTools.storageMasked"), masked: true };
      return { area, key, value: value.length <= STORAGE_VALUE_MAX ? value : `${value.slice(0, STORAGE_VALUE_MAX - 1)}…`, masked: false };
    });
}

/** 守护进程已运行多久（毫秒 → "3 小时 12 分钟"）；不到一分钟（包括钟差出的负数）写"不到 1 分钟" */
export function uptimeText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? t("state.debugTools.uptimeUnderMinute") : describeDuration(minutes);
}
