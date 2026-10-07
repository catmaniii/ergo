// 回避信号的计时（规格第 13 节的内部作业、第 15 节）：建议卡（"建议发起任务"、"建议立项"）和提问卡
// 若干天（配置 materials.staleCardDays，默认 7）没处理，就在卡片频道追加一条 card_stale 事件，素材模块再从事件日志把它采成回避信号。
// - 计时从建卡的时间算起；期间卡被处理了（不再是待处理）就取消，不产生；
// - 计时器挂在调度器上（时钟可注入）；要做的事就是卡片视图里那些待处理的卡，守护进程启动时重新登记，
//   启动时已经过了点的马上补（规格第 13 节"错过的内部作业开机后补一次"）。补发的 card_stale 时间记到期的时刻，不记补发的时刻；
// - card_stale 带幂等键（每张卡一个），重启后重复补也只有一条。
import { type Card, type CardEventPayload, type CardStaleEventPayload, type CardType, CHANNELS, EVENT_TYPES, nowIso } from "@ergou/protocol";
import { getCard, listPendingCards } from "../cards/views.ts";
import type { EventStore } from "../events/event-store.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";

/** 长期没处理算回避的卡：建议发起任务、建议立项、提问卡 */
const STALE_WATCHED_CARD_TYPES: readonly CardType[] = ["suggest_task", "suggest_project", "questions"];

const KEY_PREFIX = "materials:card-stale:";

const watched = (type: string) => (STALE_WATCHED_CARD_TYPES as readonly string[]).includes(type);

export function startStaleCardWatch(options: { store: EventStore; scheduler: Scheduler; staleAfterMs: number }): () => void {
  const { store, scheduler, staleAfterMs } = options;
  const dueAt = (card: Pick<Card, "createdAt">) => Date.parse(card.createdAt) + staleAfterMs;

  const fire = (cardId: string) => {
    const card = getCard(store.reader, cardId);
    if (!card || card.status !== "pending") return;
    const payload: CardStaleEventPayload = {
      cardId: card.id,
      cardType: card.type,
      pendingSince: card.createdAt,
      time: nowIso(new Date(dueAt(card))),
      cardText: card.text,
    };
    store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.cardStale, payload, idempotencyKey: `card-stale:${card.id}` });
  };

  const arm = (card: Card) => scheduler.schedule(`${KEY_PREFIX}${card.id}`, dueAt(card), () => fire(card.id));

  const unsubscribe = store.onAppend((event) => {
    if (event.channel !== CHANNELS.cards || event.type !== EVENT_TYPES.card) return;
    const { card } = event.payload as CardEventPayload;
    if (!watched(card.type)) return;
    if (card.status === "pending") arm(card);
    else scheduler.cancel(`${KEY_PREFIX}${card.id}`);
  });
  for (const card of listPendingCards(store.reader, STALE_WATCHED_CARD_TYPES)) arm(card);

  return () => {
    unsubscribe();
    for (const { key } of scheduler.pending()) if (key.startsWith(KEY_PREFIX)) scheduler.cancel(key);
  };
}
