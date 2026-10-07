// 回避信号的计时（规格第 13 节的内部作业、第 15 节）：建议卡（"建议发起任务"、"建议立项"）和提问卡
// 7 天（默认，可配置）没处理，就在卡片频道追加一条 card_stale 事件，素材模块再从事件日志把它采成回避信号。
// - 计时从建卡的时间算起；期间卡被处理了（不再是待处理）就取消，不产生；
// - 计时器挂在调度器上（时钟可注入）；要做的事就是卡片视图里那些待处理的卡，守护进程启动时重新登记，
//   启动时已经过了点的马上补（规格第 13 节"错过的内部作业开机后补一次"）；
// - card_stale 带幂等键（每张卡一个），重启后重复补也只有一条。
import { type CardEventPayload, type CardStaleEventPayload, CHANNELS, EVENT_TYPES } from "@ergou/protocol";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { getCard, listPendingCards } from "../cards/views.ts";
import type { EventStore } from "../events/event-store.ts";

/** 默认多少天没处理算回避 */
export const DEFAULT_STALE_CARD_DAYS = 7;

/** 长期没处理算回避的卡：建议发起任务、建议立项、提问卡 */
export const STALE_WATCHED_CARD_TYPES: readonly string[] = ["suggest_task", "suggest_project", "questions"];

const keyOf = (cardId: string) => `materials:card-stale:${cardId}`;

export function startStaleCardWatch(options: { store: EventStore; scheduler: Scheduler; clock: Clock; staleAfterMs: number }): () => void {
  const { store, scheduler, clock, staleAfterMs } = options;

  const fire = (cardId: string) => {
    const card = getCard(store.reader, cardId);
    if (!card || card.status !== "pending") return;
    const payload: CardStaleEventPayload = { cardId: card.id, cardType: card.type, pendingSince: card.createdAt, time: clockIso(clock) };
    store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.cardStale, payload, idempotencyKey: `card-stale:${card.id}` });
  };

  const arm = (card: { id: string; createdAt: string }) => {
    scheduler.schedule(keyOf(card.id), Date.parse(card.createdAt) + staleAfterMs, () => fire(card.id));
  };

  const unsubscribe = store.onAppend((event) => {
    if (event.channel !== CHANNELS.cards || event.type !== EVENT_TYPES.card) return;
    const { card } = event.payload as CardEventPayload;
    if (!STALE_WATCHED_CARD_TYPES.includes(card.type)) return;
    if (card.status === "pending") arm(card);
    else scheduler.cancel(keyOf(card.id));
  });
  for (const card of listPendingCards(store.reader, STALE_WATCHED_CARD_TYPES)) arm(card);

  return () => {
    unsubscribe();
    for (const { key } of scheduler.pending()) if (key.startsWith("materials:card-stale:")) scheduler.cancel(key);
  };
}
