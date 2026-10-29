// 卡片（规格第 5 节）：卡片是独立实体，消息里只放引用；同一张卡在聊天、待我处理（以后还有时间线）里只有一份状态。
// - 建卡、系统改卡：负载按卡片类型注册表的 schema 校验，生成纯文本降级版本，在卡片频道推送（card 事件就是最新版本）；
// - 按钮闭环：前端发"对卡片做动作" {卡片 id, 动作, 期望版本, 幂等键} → 按版本条件更新（先到先得）→ 回 ack →
//   卡片频道推送更新。后到的得到"已被处理"；同一幂等键重发拿到第一次的结果，不会做两次。
//   卡片动作只接受来自前端的请求：秘书没有任何对卡片做动作的工具。
// - 用户关掉一张卡（动作之后状态为已关闭）时，同一事务里追加"卡片被关闭"事件（回避信号的素材，08 号票采集）。
//
// 存储是同步的（node:sqlite），一次动作从检查版本到追加事件在同一段同步代码里完成，两个前端同时点不会都生效。
// 要和别的事件一起原子追加（比如提醒到点：提醒、卡片、待我处理一起变），用 buildCreate / buildUpdate 拿到事件自己放进 appendBatch。
// 彻底删除（21 号票）时卡片事件的改写（cardPurge）：负载按卡片类型登记的 purge 改写，用户在卡上写的说明换成删除标记，
// 版本、状态、处理结果的动作不变。
import { randomUUID } from "node:crypto";
import {
  type Card,
  type CardAction,
  type CardActionResult,
  type CardDismissedEventPayload,
  type CardEventPayload,
  type CardType,
  CHANNELS,
  EVENT_TYPES,
  PURGED_TEXT,
  t,
  type Urgency,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { PurgeContext, PurgeRewriter } from "../events/purge.ts";
import type { CardActionEffect, CardTypeRegistry, RegisteredCardType } from "./registry.ts";
import { cardActionByKey, getCard } from "./views.ts";

export interface NewCard {
  type: CardType;
  payload: unknown;
  urgency?: Urgency;
  /** 不给就生成一个 */
  id?: string;
  /** 出来就已经处理了的卡（比如用户点明了的快速动作，卡片出来就是"已执行"）：状态和处理结果；不给就是待处理 */
  status?: Card["status"];
  outcome?: Card["outcome"];
}

/** 系统对卡片的改动（不是用户动作，比如提醒到点、秘书改了提醒） */
export interface CardChange {
  payload?: unknown;
  status?: Card["status"];
  outcome?: Card["outcome"];
  /** 系统让它作废时的说明（status 为 expired，84 号票）：再点旧按钮回这句 */
  expiredNote?: string;
}

export interface CardActionRequest {
  cardId: string;
  action: CardAction;
  expectedVersion: number;
  note?: string;
  input?: unknown;
  idempotencyKey: string;
}

export interface CardService {
  readonly registry: CardTypeRegistry;
  /** 新卡和它的 card 事件（不追加）：调用方和别的事件一起放进 appendBatch */
  buildCreate(input: NewCard): { card: Card; event: NewEvent };
  /** 建一张卡并在卡片频道推送 */
  create(input: NewCard): Card;
  /** 系统改一张卡后的样子和它的 card 事件（不追加）；版本加 1 */
  buildUpdate(cardId: string, change: CardChange): { card: Card; event: NewEvent };
  get(cardId: string): Card | undefined;
  /** 用户对卡片做动作（只由网关调用：卡片动作只接受来自前端的请求） */
  /** 动作要先等一件事的（CardActionSpec.run 返回 Promise）晚一点才有结果 */
  act(request: CardActionRequest): CardActionResult | Promise<CardActionResult>;
  /**
   * 彻底删除：一版卡片改写后的样子。负载按卡片类型的 purge 改写（没写的不变），用户在卡上写的说明（处理结果的 note）
   * 换成删除标记；版本、状态、处理结果的动作不变，纯文本降级按新负载重算
   */
  purged(card: Card, context: PurgeContext): Card;
}

export interface CardServiceOptions {
  store: EventStore;
  registry: CardTypeRegistry;
  /** 现在（协议时间）；跟着可注入的时钟走 */
  now: () => string;
}

export function newCardId(): string {
  return `c-${randomUUID()}`;
}

function checkedPayload(registered: RegisteredCardType, payload: unknown): unknown {
  const error = registered.checkPayload(payload);
  if (error !== undefined) throw new Error(`${registered.definition.type} 卡的负载不合 schema：${error}`); // @i18n-ignore log：编程错误
  return payload;
}

function cardEvent(card: Card, idempotencyKey?: string): NewEvent {
  const payload: CardEventPayload = { card };
  return { channel: CHANNELS.cards, type: EVENT_TYPES.card, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

export function createCardService(options: CardServiceOptions): CardService {
  const { store, registry, now } = options;

  const typeOf = (type: string): RegisteredCardType => {
    const registered = registry.get(type);
    if (!registered) throw new Error(`卡片类型 ${type} 还没登记`); // @i18n-ignore log：编程错误
    return registered;
  };

  const buildCreate = (input: NewCard): { card: Card; event: NewEvent } => {
    const registered = typeOf(input.type);
    const payload = checkedPayload(registered, input.payload);
    const createdAt = now();
    const status = input.status ?? "pending";
    const card: Card = {
      id: input.id ?? newCardId(),
      type: input.type,
      typeVersion: registered.definition.version,
      version: 1,
      status,
      payload,
      text: registered.definition.toText(payload),
      ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
      createdAt,
      ...(status === "pending" ? {} : { handledAt: createdAt }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    };
    return { card, event: cardEvent(card) };
  };

  /** 卡片的下一个版本 */
  const nextVersion = (card: Card, change: CardChange): Card => {
    const registered = typeOf(card.type);
    const payload = change.payload === undefined ? card.payload : checkedPayload(registered, change.payload);
    const status = change.status ?? card.status;
    const next: Card = { ...card, version: card.version + 1, status, payload, text: registered.definition.toText(payload) };
    if (status !== "pending" && card.status === "pending") next.handledAt = now();
    if (change.outcome !== undefined) next.outcome = change.outcome;
    if (change.expiredNote !== undefined) next.expiredNote = change.expiredNote;
    return next;
  };

  return {
    registry,
    buildCreate,
    create(input) {
      const { card, event } = buildCreate(input);
      store.append(event);
      return card;
    },
    buildUpdate(cardId, change) {
      const card = getCard(store.reader, cardId);
      if (!card) throw new Error(`没有卡片 ${cardId}`); // @i18n-ignore log：编程错误
      const next = nextVersion(card, change);
      return { card: next, event: cardEvent(next) };
    },
    get: (cardId) => getCard(store.reader, cardId),
    purged(card, context) {
      const registered = typeOf(card.type);
      const hook = registered.definition.purge;
      const payload = hook ? checkedPayload(registered, hook(card.payload, context)) : card.payload;
      const outcome = card.outcome?.note === undefined ? card.outcome : { ...card.outcome, note: PURGED_TEXT };
      return { ...card, payload, text: registered.definition.toText(payload), ...(outcome === undefined ? {} : { outcome }) };
    },
    act(request) {
      // 同一个幂等键重发：直接回第一次的结果
      const done = cardActionByKey(store.reader, request.idempotencyKey);
      if (done) {
        if (done.cardId !== request.cardId) throw new RequestRejected("bad_params", t("cards.keyReused"));
        return done;
      }
      const card = getCard(store.reader, request.cardId);
      if (!card) throw new RequestRejected("not_found", t("cards.noCard", { cardId: request.cardId }));
      const registered = registry.get(card.type);
      if (!registered) throw new RequestRejected("not_allowed", t("cards.unknownType", { type: card.type }));
      const spec = registered.definition.actions[request.action];
      if (!spec) throw new RequestRejected("bad_params", t("cards.noAction", { action: request.action }));
      // 按版本条件更新，先到先得
      if (card.status !== "pending") throw new RequestRejected("conflict", card.expiredNote ?? t("cards.handled"));
      if (card.version !== request.expectedVersion) throw new RequestRejected("conflict", t("cards.changedElsewhere"));
      const inputError = spec.input ? registered.checkInput(request.action, request.input) : undefined;
      if (inputError !== undefined) throw new RequestRejected("bad_params", t("cards.badInput", { action: request.action, error: inputError }));

      const time = now();
      const ran = spec.run({
        card,
        payload: card.payload,
        action: request.action,
        ...(request.note === undefined ? {} : { note: request.note }),
        input: spec.input ? request.input : undefined,
        now: time,
        idempotencyKey: request.idempotencyKey,
      });
      if (!(ran instanceof Promise)) return finish(card, request, ran, time);
      // 晚一点才有结果的动作（84 号票）：等到了再核一遍卡片，期间被别处处理过、改过的不落盘
      return ran.then((effect) => {
        const fresh = getCard(store.reader, card.id);
        if (fresh?.status !== "pending" || fresh.version !== card.version) {
          effect.abandon?.();
          throw new RequestRejected("conflict", fresh?.expiredNote ?? (fresh?.status === "pending" ? t("cards.changedElsewhere") : t("cards.handled")));
        }
        return finish(card, request, effect, time);
      });
    },
  };

  /** 动作的结果落盘：卡片的新版本连同动作要追加的事件同一事务；没落盘时叫 abandon */
  function finish(card: Card, request: CardActionRequest, effect: CardActionEffect<unknown>, time: string): CardActionResult {
    try {
      return commitEffect(card, request, effect, time);
    } catch (err) {
      effect.abandon?.();
      throw err;
    }
  }

  function commitEffect(card: Card, request: CardActionRequest, effect: CardActionEffect<unknown>, time: string): CardActionResult {
    const finished = effect.status !== "pending";
    const note = effect.note ?? request.note;
    const next = nextVersion(card, {
      ...(effect.payload === undefined ? {} : { payload: effect.payload }),
      status: effect.status,
      ...(finished ? { outcome: { action: request.action, ...(note === undefined ? {} : { note }) } } : {}),
    });
    const events: NewEvent[] = [...(effect.events ?? []), cardEvent(next, request.idempotencyKey)];
    if (effect.status === "dismissed") {
      const dismissed: CardDismissedEventPayload = {
        cardId: card.id,
        cardType: card.type,
        action: request.action,
        ...(request.note === undefined ? {} : { note: request.note }),
        cardText: card.text,
        time,
      };
      events.push({ channel: CHANNELS.cards, type: EVENT_TYPES.cardDismissed, payload: dismissed, idempotencyKey: `${request.idempotencyKey}#dismissed` });
    }
    const results = store.appendBatch(events, effect.purge === undefined ? undefined : { purge: effect.purge });
    const appended = results[(effect.events ?? []).length];
    if (appended?.duplicate && appended.event.type !== EVENT_TYPES.card) throw new RequestRejected("bad_params", t("cards.keyReused"));
    effect.afterCommit?.();
    return { cardId: next.id, version: next.version };
  }
}

/** 彻底删除时卡片频道上 card 事件的改写函数（登记进记忆模块的改写函数表） */
export function cardPurge(cards: CardService): PurgeRewriter {
  return {
    eventType: EVENT_TYPES.card,
    rewrite: (event, context) => ({ ...(event.payload as CardEventPayload), card: cards.purged((event.payload as CardEventPayload).card, context) }),
  };
}
