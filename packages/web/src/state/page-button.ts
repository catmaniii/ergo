// 悬浮按钮背后就是秘书本人（"干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）在状态层这一侧：
// - buttonTurnOf：悬浮按钮上发的那句（发消息请求的幂等键）走到哪了——还在发、排在队里（秘书正忙着一轮）、秘书在办、
//   秘书这一轮说完了（这一轮里它最后说的那句，就是按钮旁边气泡里的回话）、没发出去（被拒）。都从秘书会话的权威事件里认：
//   这条消息在会话里（或排队的队里）、会话频道上这一轮的结束（ui-state 的 turnEnds：这一轮交给秘书的几条输入里有它）；
// - turnAround、turnInputText（461）：秘书会话里某一条（序号）所在的那一轮走到哪了、这一轮是因为用户说了哪句——地图页窄屏时
//   二狗这一轮在地图上画了东西，聊天窗收起，悬浮按钮的气泡里接着显示这一轮（在想，说完了是它最后说的那句）；
// - browsePicksOf：秘书给这台设备上这个浏览器的网页候选卡（browse_pick），网页上的挑图片窗口照它弹、预备文件。
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
  return endedTurn(conv, entry.seq, end);
}

/** 一轮结束了：from 之后、结束之前秘书的消息里最后一句有字的；没说话的按结局写 */
function endedTurn(conv: NonNullable<UiState["conversations"][string]>, from: number, end: NonNullable<UiState["turnEnds"][string]>[number]): ButtonTurn {
  const said = conv.messages.flatMap((m) => ("message" in m && m.seq > from && m.seq < end.seq && m.message.speaker === "agent" ? [textOf(m.message)] : [])).filter((s) => s !== "");
  const last = said.at(-1);
  if (last) return { phase: "replied", text: last };
  if (end.outcome === "error") return { phase: "failed", reason: end.error ? t("state.pageButton.errorWith", { error: end.error }) : t("state.pageButton.error") };
  if (end.outcome === "aborted") return { phase: "failed", reason: t("state.pageButton.aborted") };
  if (end.outcome === "interrupted") return { phase: "failed", reason: t("state.pageButton.interrupted") };
  return { phase: "replied", text: t("state.pageButton.done") };
}

/** 秘书会话里这个序号的事件所在的那一轮：开始的序号（实时收到、补发的回合开始里，它之前最近的那个；没有是 -1）、结束（还没结束没有） */
function turnOfSeq(ui: UiState, seq: number): { start: number; end: NonNullable<UiState["turnEnds"][string]>[number] | undefined } {
  const start = (ui.turnStarts[CHANNELS.secretary] ?? []).findLast((s) => s < seq) ?? -1;
  const end = (ui.turnEnds[CHANNELS.secretary] ?? []).find((e) => e.seq > seq && e.seq > start);
  return { start, end };
}

/**
 * 秘书会话里序号是 seq 的那条（地图卡片那条消息，461）所在的这一轮走到哪了：还没结束是在想；结束了是这一轮秘书最后说的那句
 * （从这一轮开始算：画之前说的、画之后说的都算），没说话的按结局写（和 buttonTurnOf 一样）
 */
export function turnAround(ui: UiState, seq: number): ButtonTurn {
  const conv = ui.conversations[CHANNELS.secretary];
  if (!conv) return { phase: "thinking" };
  const { start, end } = turnOfSeq(ui, seq);
  return end ? endedTurn(conv, start, end) : { phase: "thinking" };
}

/** 序号是 seq 的那条所在的这一轮是因为用户说了哪句（这一轮交给秘书的第一条输入的字）；认不出、没有字是 undefined */
export function turnInputText(ui: UiState, seq: number): string | undefined {
  const conv = ui.conversations[CHANNELS.secretary];
  if (!conv) return undefined;
  const { end } = turnOfSeq(ui, seq);
  const input = end?.inputIds[0] ?? conv.openTurn;
  if (input === undefined) return undefined;
  const entry = conv.messages.find((m) => "message" in m && m.message.id === input);
  const text = entry && "message" in entry ? textOf(entry.message) : "";
  return text === "" ? undefined : text;
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
