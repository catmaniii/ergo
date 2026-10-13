// 页面顶上的通知（105、106 号票，纯函数）：到点的提醒这类"马上告诉用户"的通知（ui-state 的 alerts，来自临时的 notify 事件）
// 不再一条条叠在顶上等用户关——
// - 只有一个框，几条在框里轮播（106 号票）：从先到的那条起，每条露 ALERT_SLIDE_MS 换下一条没露过的，框上标"第几条 / 共几条"；
//   新来的排在后面，不打断正在露的那条；
// - 每条都露完过一段、且总共露了不少于 ALERT_AUTO_HIDE_MS 之后收起（连同框里的全部，它们都在待办里）；都露过了还不够时
//   停在最后一条等够；新来一条从头算；
// - 手指、鼠标或键盘焦点停在上面时不换、不收，离开后接着数剩下的。
// 收起只是不在顶上显示（ui-state 的 alert_seen 把它从 alerts 里拿掉）：待办里那一项、tab 上的红点照旧，浏览器通知照旧。
// 计时器、指针事件在 ui/alerts.tsx，这里只管什么时候换、什么时候收；钟是界面给的（每个输入带上 at）。
import type { NotifyEventPayload } from "./protocol.ts";

/** 每条露多久换下一条（毫秒） */
export const ALERT_SLIDE_MS = 3500;
/** 总共至少露多久才收起（毫秒） */
export const ALERT_AUTO_HIDE_MS = 8000;
/**
 * 剩不到这么多（毫秒）就算到点：钟不是整数时浮点相减会剩一点点（比如 9e-13），不算到点的话这一下不换、
 * 界面再定的还是同一刻，框就卡在一条上了
 */
const ALERT_DUE_SLACK_MS = 1;

/** 框里的轮播：露哪一条、还要露多久（钟是界面的，毫秒） */
export interface AlertCarousel {
  /** 顶上的几条（到的先后） */
  readonly ids: readonly string[];
  /** 框里此刻露的那一条 */
  readonly shownId: string | undefined;
  /** 露完过一段的 */
  readonly seen: readonly string[];
  /** 这一条还要露多久才换（露完了是不到 1 毫秒：都露过了就停在这一条等够总时长） */
  readonly slideLeft: number;
  /** 总共还要露多久才够 ALERT_AUTO_HIDE_MS（新来一条回到满的） */
  readonly hideLeft: number;
  /** 上面两个数到了哪一刻；顶上没有时是 undefined */
  readonly since: number | undefined;
  /** 手指、鼠标或键盘焦点停在上面：不数 */
  readonly held: boolean;
  /** 该收起了：界面把顶上的全部送 alert_seen */
  readonly hidden: boolean;
}

export const ALERT_CAROUSEL_IDLE: AlertCarousel = { ids: [], shownId: undefined, seen: [], slideLeft: 0, hideLeft: 0, since: undefined, held: false, hidden: false };

export type AlertCarouselInput =
  /** 顶上的几条变了（新来的、拿掉的），ids 照到的先后 */
  | { readonly kind: "alerts"; readonly ids: readonly string[]; readonly at: number }
  /** 页面上的计时器到了（过了 alertWait 给的时长） */
  | { readonly kind: "due"; readonly at: number }
  /** 停在上面 */
  | { readonly kind: "hold"; readonly at: number }
  /** 离开 */
  | { readonly kind: "release"; readonly at: number };

export function alertCarousel(state: AlertCarousel, input: AlertCarouselInput): AlertCarousel {
  const s = settle(state, input.at);
  switch (input.kind) {
    case "alerts":
      return arrive(s, input.ids, input.at);
    case "due":
      return counting(s) && due(s.slideLeft) ? slideOver(s) : s;
    case "hold":
      return s.held ? s : { ...s, held: true };
    case "release":
      return s.held ? { ...s, held: false } : s;
  }
}

/** 过多久该送 due（从 since 起，毫秒）；不在数（顶上没有、停在上面、该收起了）是 undefined */
export function alertWait(state: AlertCarousel): number | undefined {
  if (!counting(state)) return undefined;
  if (!due(state.slideLeft)) return state.slideLeft;
  // 这一段露完了：还有没露过的马上换，都露过了等够总时长
  return unseen(state).length > 0 || due(state.hideLeft) ? 0 : state.hideLeft;
}

/** 框里露的那一条，第几条（从 0 数）、共几条；该收起了、顶上没有时不露 */
export function alertShown(state: AlertCarousel, alerts: readonly NotifyEventPayload[]): { alert: NotifyEventPayload; index: number; total: number } | undefined {
  if (state.hidden) return undefined;
  const index = alerts.findIndex((a) => a.id === state.shownId);
  return index < 0 ? undefined : { alert: alerts[index]!, index, total: alerts.length };
}

/** 框上标的"2/3"（只有一条不标） */
export function alertCountText(index: number, total: number): string | undefined {
  return total > 1 ? `${index + 1}/${total}` : undefined;
}

/** 顶上的几条和轮播里排着的不一样了（界面这时送 alerts） */
export function alertsChanged(state: AlertCarousel, alerts: readonly NotifyEventPayload[]): boolean {
  return state.ids.length !== alerts.length || alerts.some((a, i) => a.id !== state.ids[i]);
}

/** 还剩的这点算不算到点了 */
function due(left: number): boolean {
  return left < ALERT_DUE_SLACK_MS;
}

function counting(state: AlertCarousel): boolean {
  return state.shownId !== undefined && !state.held && !state.hidden;
}

function unseen(state: AlertCarousel): readonly string[] {
  return state.ids.filter((id) => !state.seen.includes(id));
}

/** 把从 since 到 at 这段算进去（停在上面、该收起了的不算） */
function settle(state: AlertCarousel, at: number): AlertCarousel {
  if (state.since === undefined) return state;
  const passed = counting(state) ? at - state.since : 0;
  return { ...state, slideLeft: state.slideLeft - passed, hideLeft: state.hideLeft - passed, since: at };
}

/** 换到这一条，从头露一段 */
function show(state: AlertCarousel, id: string): AlertCarousel {
  return { ...state, shownId: id, slideLeft: ALERT_SLIDE_MS };
}

/** 从第 from 个起（绕回头）第一条没露过的 */
function nextUnseen(state: AlertCarousel, from: number): string | undefined {
  const { ids } = state;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[(from + i) % ids.length]!;
    if (!state.seen.includes(id)) return id;
  }
  return undefined;
}

/** 这一段露完了：记下露过；还有没露过的换过去，都露过了够总时长就收起、不够停在这一条 */
function slideOver(state: AlertCarousel): AlertCarousel {
  const seen = state.seen.includes(state.shownId!) ? state.seen : [...state.seen, state.shownId!];
  const s = { ...state, seen };
  const next = nextUnseen(s, s.ids.indexOf(s.shownId!) + 1);
  if (next !== undefined) return show(s, next);
  return due(s.hideLeft) ? { ...s, hidden: true } : s;
}

/** 顶上的几条变了：新来的排在后面、8 秒从头算；露着的那条拿掉了换后面没露过的 */
function arrive(state: AlertCarousel, ids: readonly string[], at: number): AlertCarousel {
  // 顶上没有了：停在上面的也算离开了（点"关闭"时框一拿掉，离开的事件就不来了）
  if (ids.length === 0) return ALERT_CAROUSEL_IDLE;
  const fresh = ids.some((id) => !state.ids.includes(id));
  const s: AlertCarousel = {
    ...state,
    ids,
    seen: state.seen.filter((id) => ids.includes(id)),
    ...(fresh ? { hideLeft: ALERT_AUTO_HIDE_MS, hidden: false } : {}),
  };
  // 框里原来是空的：从先到的那条起，开始数
  if (state.shownId === undefined) return show({ ...s, since: at }, ids[0]!);
  if (ids.includes(state.shownId)) return s;
  const from = state.ids.indexOf(state.shownId) % ids.length;
  return show(s, nextUnseen(s, from) ?? ids[from]!);
}
