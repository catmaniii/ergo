// 卡片处理后页面底部那句短提示说什么（app/card-outcome-toasts.tsx 盯着卡片的变化调它）。纯函数。
import { type Card, type CardAction, t } from "./protocol.ts";

/** 处理了这张卡之后提示什么；不用提示的回 undefined */
export function cardOutcomeToast(card: Card, action: CardAction): string | undefined {
  const payload = card.payload as Record<string, unknown>;
  if (card.type === "suggest_project" && action === "kickoff") return t("state.cards.outcome.projectBorn", { name: String(payload.name) });
  if (card.type === "suggest_task" && action === "start_task") return t("state.cards.outcome.taskStarted", { title: String(payload.title) });
  if (card.type === "charter") return t(action === "confirm_start" ? "state.cards.outcome.charterStarted" : "state.cards.outcome.charterConfirmed");
  // 立项要求变更
  if (card.type === "charter_change") return t(action === "confirm" ? "state.cards.outcome.charterChanged" : "state.cards.outcome.charterKept");
  // 规范改写
  if (card.type === "standard_change") return t(action === "confirm" ? "state.cards.outcome.standardChanged" : "state.cards.outcome.standardKept");
  // 补齐规范文档
  if (card.type === "standard_backfill") return t(action === "confirm" ? "state.cards.outcome.backfillStarted" : "state.cards.outcome.backfillDeclined");
  if (card.type === "pairing" && action === "approve") return t("state.cards.outcome.pairingApproved");
  return undefined;
}

/**
 * 早就处理过的卡（处理时间在两分钟以前）：新开的页面补历史时，同一张卡可能先收到待处理的旧样子、再收到处理过的，
 * 不能当成刚处理的弹提示（2026-10-18：新开的浏览侧边栏弹出很早以前批准配对的"已批准，新设备拿到凭证"）。没有处理时间的照弹
 */
export function handledLongAgo(card: Card, now: number): boolean {
  return card.handledAt !== undefined && now - Date.parse(card.handledAt) > 2 * 60_000;
}
