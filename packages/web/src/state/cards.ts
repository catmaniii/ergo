// 卡片怎么显示（纯函数）：认识的类型和版本按类型显示；不认识的类型、或负载版本比这个页面新的，
// 显示服务端给的纯文本降级版本，加上"去 Web 处理"的链接（指向 Web 里单独显示这张卡的页面）。
import { CARD_TYPE_VERSIONS, type CardType, isCardType } from "./protocol.ts";
import type { CardState, UiState } from "./ui-state.ts";

export type CardDisplay =
  | { kind: "typed"; type: CardType; state: CardState }
  | {
      kind: "fallback";
      /** 不认识这种卡，或者认识但负载版本比这个页面新 */
      reason: "unknown_type" | "newer_version";
      /** 纯文本降级版本 */
      text: string;
      /** 去 Web 处理的链接（# 路由） */
      webPath: string;
      state: CardState;
    };

export function cardDisplay(state: UiState, cardId: string): CardDisplay | undefined {
  const view = state.cards[cardId];
  if (!view) return undefined;
  const { card } = view;
  const fallback = (reason: "unknown_type" | "newer_version"): CardDisplay => ({ kind: "fallback", reason, text: card.text, webPath: cardWebPath(card.id), state: view });
  if (!isCardType(card.type)) return fallback("unknown_type");
  if (card.typeVersion > CARD_TYPE_VERSIONS[card.type]) return fallback("newer_version");
  return { kind: "typed", type: card.type, state: view };
}

/** Web 里单独显示一张卡的页面 */
export function cardWebPath(cardId: string): string {
  return `#/card/${encodeURIComponent(cardId)}`;
}

/**
 * 快速动作卡上"对象""内容"两行的说法（按动作类型）：秘书转达（103 号票，tell_task / tell_project）写"发给"和"转达的话"，
 * 卡上一眼看出发给谁、发什么；别的动作照旧"对象""内容"
 */
export function quickActionFieldLabels(actionType: string): { target: string; content: string } {
  return actionType === "tell_task" || actionType === "tell_project" ? { target: "发给", content: "转达的话" } : { target: "对象", content: "内容" };
}
