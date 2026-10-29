// 悬浮按钮背后就是秘书本人（149 号票，用户 2026-10-18："干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）在状态层这一侧：
// - buttonTurnOf：悬浮按钮上发的那句（发消息请求的幂等键）走到哪了——还在发、排在队里（144 号票：秘书正忙着一轮）、秘书在办、
//   秘书这一轮说完了（这一轮里它最后说的那句，就是按钮旁边气泡里的回话）、没发出去（被拒）。都从秘书会话的权威事件里认：
//   这条消息在会话里（或排队的队里）、会话频道上这一轮的结束（ui-state 的 turnEnds：这一轮交给秘书的几条输入里有它）；
// - browsePicksOf：秘书给这台设备上这个浏览器的网页候选卡（147 号票的 browse_pick），网页上的挑图片窗口照它弹、预备文件。
// 不碰 DOM，测试在 Node 里跑；接到页面上的在 app/page-browse.ts（usePageButtonSync）。
import { CHANNELS, t } from "./protocol.ts";
import type { BrowsePickCardPayload, Card, MessageEnvelope } from "./protocol.ts";
import type { CardState, UiState } from "./ui-state.ts";

/** 悬浮按钮上发的那句走到哪了 */
export type ButtonTurn =
  | { readonly phase: "sending" }
  | { readonly phase: "queued" }
  | { readonly phase: "thinking" }
  | { readonly phase: "replied"; readonly text: string }
  | { readonly phase: "failed"; readonly reason: string };

const textOf = (message: MessageEnvelope): string =>
  message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();

/** 悬浮按钮上发的那句（key 是发消息请求的幂等键）现在走到哪了 */
export function buttonTurnOf(ui: UiState, key: string): ButtonTurn {
  const failure = ui.failures.find((f) => f.idempotencyKey === key);
  if (failure) return { phase: "failed", reason: failure.error };
  const conv = ui.conversations[CHANNELS.secretary];
  if (!conv) return { phase: "sending" };
  const pending = conv.tail.find((p) => p.idempotencyKey === key);
  if (pending?.status === "failed") return { phase: "failed", reason: pending.error };
  if (conv.queue.some((q) => q.idempotencyKey === key)) return { phase: "queued" };
  const entry = conv.messages.find((m) => "message" in m && m.idempotencyKey === key);
  if (!entry || !("message" in entry)) return { phase: "sending" };
  const id = entry.message.id;
  const end = (ui.turnEnds[CHANNELS.secretary] ?? []).find((e) => e.seq > entry.seq && e.inputIds.includes(id));
  if (!end) return { phase: "thinking" };
  // 这一轮秘书说的：这条之后、这一轮结束之前秘书的消息里最后一句有字的
  const said = conv.messages.flatMap((m) => ("message" in m && m.seq > entry.seq && m.seq < end.seq && m.message.speaker === "agent" ? [textOf(m.message)] : [])).filter((s) => s !== "");
  const last = said.at(-1);
  if (last) return { phase: "replied", text: last };
  if (end.outcome === "error") return { phase: "failed", reason: end.error ? t("state.pageButton.errorWith", { error: end.error }) : t("state.pageButton.error") };
  if (end.outcome === "aborted") return { phase: "failed", reason: t("state.pageButton.aborted") };
  if (end.outcome === "interrupted") return { phase: "failed", reason: t("state.pageButton.interrupted") };
  return { phase: "replied", text: t("state.pageButton.done") };
}

/** 一张网页候选卡（这台设备的浏览器的）：卡片、负载、本地点了还没回的动作 */
export interface BrowsePickView {
  readonly card: Card;
  readonly payload: BrowsePickCardPayload;
  readonly pending?: CardState["pending"];
}

/** 秘书给这个浏览器（这台设备上这一页二狗网页的编号）的网页候选卡，按建出来的先后 */
export function browsePicksOf(ui: UiState, browser: string): BrowsePickView[] {
  return Object.values(ui.cards)
    .filter((c) => c.card.type === "browse_pick" && (c.card.payload as BrowsePickCardPayload | undefined)?.browser === browser)
    .map((c) => ({ card: c.card, payload: c.card.payload as BrowsePickCardPayload, ...(c.pending ? { pending: c.pending } : {}) }))
    .toSorted((a, b) => a.card.createdAt.localeCompare(b.card.createdAt));
}
