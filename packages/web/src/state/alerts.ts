// 页面顶上的通知（105 号票，纯函数）：到点的提醒这类"马上告诉用户"的通知（ui-state 的 alerts，来自临时的 notify 事件）
// 不再一条条叠在顶上等用户关——
// - 只露最新到的一条，其余的说一句"还有 N 条，在待办里"；
// - 露出来过 ALERT_AUTO_HIDE_MS 自动收起（连同压在后面的几条，它们都在待办里）；新来一条从头算；
//   手指、鼠标或键盘焦点停在上面时不收，离开后从头算。
// 收起只是不在顶上显示（ui-state 的 alert_seen 把它从 alerts 里拿掉）：待办里那一项、tab 上的红点照旧，浏览器通知照旧。
// 计时器、指针事件在 ui/alerts.tsx，这里只管什么时候该收。
import type { NotifyEventPayload } from "./protocol.ts";

/** 露出来多久自动收起（毫秒） */
export const ALERT_AUTO_HIDE_MS = 8000;

/** 顶上露的：最新到的一条；more 是压在后面的几条 */
export function alertBanner(alerts: readonly NotifyEventPayload[]): { latest: NotifyEventPayload; more: number } | undefined {
  const latest = alerts.at(-1);
  return latest ? { latest, more: alerts.length - 1 } : undefined;
}

/** "还有 N 条，在待办里"（没有压在后面的不说） */
export function alertMoreText(more: number): string | undefined {
  return more > 0 ? `还有 ${more} 条，在待办里` : undefined;
}

/**
 * 自动收起的计时（不碰钟，界面按 round 数 ALERT_AUTO_HIDE_MS）：在数（alertCounting）时，round 每变一次就从头数，
 * 数到了收起顶上的全部
 */
export interface AlertTimer {
  /** 露着的那一条 */
  readonly shownId: string | undefined;
  /** 手指、鼠标或键盘焦点停在上面 */
  readonly held: boolean;
  /** 第几轮：露着的换了一条（新来的）、手指离开时加一，从头数 */
  readonly round: number;
}

export const ALERT_TIMER_IDLE: AlertTimer = { shownId: undefined, held: false, round: 0 };

export type AlertTimerInput =
  /** 露着的换了一条（新来的），id 为 undefined 是顶上没有了 */
  | { readonly kind: "shown"; readonly id: string | undefined }
  /** 停在上面 */
  | { readonly kind: "hold" }
  /** 离开 */
  | { readonly kind: "release" };

export function alertTimer(state: AlertTimer, input: AlertTimerInput): AlertTimer {
  switch (input.kind) {
    case "shown":
      if (input.id === state.shownId) return state;
      // 顶上没有了：停在上面的也算离开了（点"关闭"时提示条一拿掉，离开的事件就不来了）
      if (input.id === undefined) return { shownId: undefined, held: false, round: state.round + 1 };
      return { ...state, shownId: input.id, round: state.round + 1 };
    case "hold":
      return state.held ? state : { ...state, held: true };
    case "release":
      return state.held ? { ...state, held: false, round: state.round + 1 } : state;
  }
}

/** 现在在不在数：顶上有露着的、没停在上面 */
export function alertCounting(state: AlertTimer): boolean {
  return state.shownId !== undefined && !state.held;
}
