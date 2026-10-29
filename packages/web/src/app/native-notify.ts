// 鸿蒙 App 的系统通知在网页这一侧的接口（110 号票，用户 2026-10-13 定：先做不用实名认证的 Notification Kit 本地通知，
// App 自己往通知栏发，不经华为服务器；App 的进程要活着，关掉、被系统冻结后发不出，那要靠以后的推送服务）。
// App 里的实现在 frontend/harmony/entry/src/main/ets/notify/NativeNotify.ets，经原生桥 ergoNative 的这一组方法调：
// - notifyState()：通知开没开、问没问过用户（{"enabled", "asked"}）；
// - notifyPrepare(userAction)：还没问过就向用户要通知授权（系统的授权框，只问这一次）；userAction 为真（设置里点"去打开"）
//   而用户拒过时拉起系统的通知设置；回要过之后的状态（同 notifyState）；
// - notifyShow(id, title, body, route)：发一条到系统通知栏（App 在前台时 App 不发：页面顶上已经有了）；
// - notifyTakeOpen()：用户点开了通知栏里的哪一条（{"id", "route"}，取一次就清掉，没有回空串）。
// 点通知把 App 拉起来时（App 在跑），App 调网页登记的 window.__ergoNotifyOpen()（不带参数），网页再来取；
// App 没在跑、被点开的通知拉起来的，网页开场取一次。
// App 回的东西形状不一定对：一律核对，不对就当没有，不抛错。走浏览器还是走 App 在 system-notify.ts。
// 124 号票（Debug 工具集）起新版 App 多了几样，旧版 App 没有的照旧、不报错：
// - notifyShow 回这一条的结果（Promise<string>：{"result": "published" | "foreground" | "disabled" | "failed", "number"?, "message"?}），
//   旧版 App 什么都不回（通知记录里写"App 没回结果"）；第 5 个参数 force 为真时 App 在前台也发（110 号票的"前台不发"在这里绕过去，
//   只有 Debug 工具集用），平常不传，旧版 App 一样认；
// - notifyState 多一项 foreground：App 现在算前台还是后台；
// - notifyResetAsked()：清掉 App 记的"问过用户了"（notify_asked），回清掉之后的状态。有它就是新版 App（canForce）。
import type { NotifyOutcome } from "../state/index.ts";
import type { SystemNotice } from "./system-notify.ts";
import { isNoticeRoute } from "./system-notify.ts";
import { exposeToApp } from "./app-names.ts";
import { t } from "../state/index.ts";

/** App 的通知开没开（系统设置里这个应用的通知开关）、问没问过用户；新版 App 还说现在算不算在前台 */
export interface NativeNotifyState {
  readonly enabled: boolean;
  readonly asked: boolean;
  /** App 现在算前台（true）还是后台；旧版 App 没有 */
  readonly foreground?: boolean;
}

/** App 回的一条通知的结果（新版 App）：已发、前台不发、通知没打开、出错，带上说明（通知编号、出错的原因） */
export interface NativeNotifyShown {
  readonly outcome: Extract<NotifyOutcome, "sent" | "foreground" | "denied" | "error">;
  readonly detail?: string;
}

/** 用户点开的那一条：通知的 id、点了去哪（页面地址） */
export interface NativeNotifyOpened {
  readonly id: string;
  readonly route: string;
}

export interface NativeNotify {
  /** 通知开没开；App 回的不对是 undefined */
  state(): NativeNotifyState | undefined;
  /** 第一次向用户要授权；userAction 为真且用户拒过时拉起系统的通知设置。回要过之后的状态 */
  prepare(userAction: boolean): Promise<NativeNotifyState | undefined>;
  /**
   * 发一条到系统通知栏；force 为真时 App 在前台也发（124 号票的 Debug 工具集，旧版 App 不认、照旧不发）。
   * 回 App 说的结果；旧版 App 不回结果、回的不对是 undefined
   */
  show(notice: SystemNotice, options?: { force?: boolean }): Promise<NativeNotifyShown | undefined>;
  /** 取用户点开的那一条（取了 App 那边就清掉）；没有是 undefined */
  takeOpened(): NativeNotifyOpened | undefined;
  /** 新版 App（124 号票）：认"前台也强制发"、回发送结果、能重置问过了 */
  readonly canForce: boolean;
  /** 清掉 App 记的"问过用户了"（124 号票），回之后的状态；旧版 App 没有 */
  readonly resetAsked?: () => NativeNotifyState | undefined;
}

/** 原生桥上通知这一组方法的名字（NativeBridge.ets 的 NATIVE_BRIDGE_METHODS 里也是这几个） */
export const NATIVE_NOTIFY_METHODS = ["notifyState", "notifyPrepare", "notifyShow", "notifyTakeOpen"] as const;

/** 通知的 id 最长多少（App 那边当通知的标识） */
const OPENED_ID_MAX = 200;

type BridgeObject = Record<string, unknown>;

function parseObject(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "string" || json === "") return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** App 回的通知状态（JSON 字符串 {"enabled": 布尔, "asked": 布尔, "foreground"?: 布尔}）；不对就是 undefined */
export function parseNotifyState(json: unknown): NativeNotifyState | undefined {
  const value = parseObject(json);
  if (!value || typeof value.enabled !== "boolean" || typeof value.asked !== "boolean") return undefined;
  return { enabled: value.enabled, asked: value.asked, ...(typeof value.foreground === "boolean" ? { foreground: value.foreground } : {}) };
}

/** App 报的结果 → 通知记录里的结果 */
const SHOWN_OUTCOMES: Readonly<Record<string, NativeNotifyShown["outcome"]>> = { published: "sent", foreground: "foreground", disabled: "denied", failed: "error" };

/** App 回的一条通知的结果（JSON 字符串 {"result", "number"?, "message"?}，新版 App）；不对就是 undefined */
export function parseNotifyShown(json: unknown): NativeNotifyShown | undefined {
  const value = parseObject(json);
  const outcome = value && typeof value.result === "string" ? SHOWN_OUTCOMES[value.result] : undefined;
  if (!value || !outcome) return undefined;
  const detail = typeof value.message === "string" && value.message ? value.message : typeof value.number === "number" ? t("app.nativeNotify.number", { number: value.number }) : undefined;
  return { outcome, ...(detail === undefined ? {} : { detail }) };
}

/** App 的方法回的是不是 Promise（新版 App 的 notifyShow） */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * App 交回来的、用户点开的那一条（JSON 字符串 {"id", "route"}）。地址只认页面地址（#/ 开头）：
 * App 的入口谁都能拉起、能带参数，带来的不是二狗发的通知也只是换一页，不会去别的网站
 */
export function parseNotifyOpened(json: unknown): NativeNotifyOpened | undefined {
  const value = parseObject(json);
  if (!value || typeof value.id !== "string" || value.id === "" || value.id.length > OPENED_ID_MAX || !isNoticeRoute(value.route)) return undefined;
  return { id: value.id, route: value.route };
}

/** 调 App 的一个方法；没有这个方法、App 拒绝或出错都当没调 */
function call(bridge: BridgeObject, method: string, ...args: (string | boolean)[]): unknown {
  try {
    return (bridge[method] as (...a: (string | boolean)[]) => unknown).apply(bridge, args);
  } catch {
    return undefined;
  }
}

/** 原生桥上有通知这一组方法（新版 App）就包一层；旧版 App 缺哪一个都当没有（网页照旧走浏览器通知） */
export function wrapNativeNotify(bridge: BridgeObject): NativeNotify | undefined {
  if (!NATIVE_NOTIFY_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  return {
    state: () => parseNotifyState(call(bridge, "notifyState")),
    async prepare(userAction) {
      try {
        return parseNotifyState(await call(bridge, "notifyPrepare", userAction));
      } catch {
        return undefined;
      }
    },
    async show(notice, options = {}) {
      // 平常只给 4 个参数（和 110 号票一样）；强制发才多给一个
      const args = [notice.id, notice.title, notice.body, notice.route, ...(options.force ? [true] : [])];
      const reply = call(bridge, "notifyShow", ...args);
      if (!isThenable(reply)) return undefined;
      try {
        return parseNotifyShown(await reply);
      } catch (err) {
        return { outcome: "error", detail: err instanceof Error ? err.message : String(err) };
      }
    },
    takeOpened: () => parseNotifyOpened(call(bridge, "notifyTakeOpen")),
    canForce: typeof bridge.notifyResetAsked === "function",
    ...(typeof bridge.notifyResetAsked === "function" ? { resetAsked: () => parseNotifyState(call(bridge, "notifyResetAsked")) } : {}),
  };
}

/** App 拉起来时调的函数挂在页面的全局对象上 */
export interface NotifyOpenScope {
  __ergoNotifyOpen?: () => void;
}

/**
 * 通知接到 App 上（110 号票）：开场取一次点开的那一条（App 没在跑、被点开的通知拉起来的），登记 window.__ergoNotifyOpen
 * 等 App 推（App 在跑时点了通知），每取到一条交给 open；还没问过用户、页面在前台时向用户要一次通知授权
 * （系统的授权框要 App 在前台；App 在后台时才发通知，所以不能等到第一条要发的时候再问）。返回停下
 */
export function followNotifyInApp(notify: NativeNotify, scope: NotifyOpenScope, open: (opened: NativeNotifyOpened) => void, visible: () => boolean): () => void {
  const take = () => {
    const opened = notify.takeOpened();
    if (opened) open(opened);
  };
  take();
  // 312 号票：新旧两个名字都挂（旧 App 调的是旧名字）
  const unexpose = exposeToApp(scope, "__ergoNotifyOpen", take);
  const state = notify.state();
  if (state && !state.enabled && !state.asked && visible()) void notify.prepare(false);
  return unexpose;
}
