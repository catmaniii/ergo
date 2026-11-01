// 老提问不再一直挂着（369 号票）：秘书在聊天里随口问的提问卡（正卡着工作的不算，见 card-waits.ts 的 cardWaitGoesStale）超过 materials.staleCardDays（默认 7 天）没答，标题不再说"等你回答提问"（card-waits.ts 按时间算，
// 这里到点叫它重新算），待办里的事项也不再算要紧：降到不卡任务、算看过，标上 stale（秘书会话的"等你处理"栏不再列）。
// 卡本身不动：还在聊天历史里，照样能答。
// 这里是内核的：回避信号的计时（materials/avoidance.ts 的 card_stale）归记忆插件，停用时不跑；两边各算各的，回避信号不变。
// 计时器挂在调度器上（时钟可注入），要做的事就是卡片视图里那些待处理的提问卡，守护进程启动时重新登记，已经过了点的马上补。
// 启动时顺带补上：这一版之前秘书出的提问卡不进待办，还没放久的补一条事项（标题说在等你的卡，待办里一定有一条）；放久了的不补。
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type QuestionsCardPayload } from "@ergo/protocol";
import { getCard, listPendingCards } from "../cards/views.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { inboxHasCard } from "../inbox/views.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { secretaryQuestionsInboxItem } from "../tasks/cards.ts";
import { cardWaitGoesStale, cardWaitStaleAt } from "./card-waits.ts";

const KEY_PREFIX = "activity:question-stale:";

export function startQuestionStaleWatch(options: { store: EventStore; scheduler: Scheduler; inbox: InboxService; staleAfterMs: number; now: () => string; onStale: () => void }): () => void {
  const { store, scheduler, inbox, staleAfterMs, now, onStale } = options;

  const fire = (cardId: string) => {
    if (getCard(store.reader, cardId)?.status !== "pending") return;
    const events = inbox
      .itemsForCard(cardId)
      .filter((item) => !item.stale)
      .map((item) => inbox.buildUpdate(item, { urgency: "non_blocking", read: true, stale: true }).event);
    if (events.length > 0) store.appendBatch(events);
    onStale();
  };

  const arm = (card: Card) => scheduler.schedule(`${KEY_PREFIX}${card.id}`, cardWaitStaleAt(card, staleAfterMs), () => fire(card.id));

  const unsubscribe = store.onAppend((event) => {
    if (event.channel !== CHANNELS.cards || event.type !== EVENT_TYPES.card) return;
    const { card } = event.payload as CardEventPayload;
    if (card.type !== "questions") return;
    if (card.status === "pending" && cardWaitGoesStale(card)) arm(card);
    else scheduler.cancel(`${KEY_PREFIX}${card.id}`);
  });

  const nowMs = Date.parse(now());
  for (const card of listPendingCards(store.reader, ["questions"])) {
    const payload = card.payload as QuestionsCardPayload;
    if (payload.askedBy === undefined && nowMs < cardWaitStaleAt(card, staleAfterMs) && !inboxHasCard(store.reader, card.id)) inbox.add(secretaryQuestionsInboxItem(card.id, payload));
    if (cardWaitGoesStale(card)) arm(card);
  }

  return () => {
    unsubscribe();
    for (const { key } of scheduler.pending()) if (key.startsWith(KEY_PREFIX)) scheduler.cancel(key);
  };
}
