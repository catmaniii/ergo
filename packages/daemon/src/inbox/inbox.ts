// 待我处理（规格第 5 节）：汇集要用户处理的卡片和通知类事项。
// - 紧急度三档：卡住任务且有时限、卡住任务、不卡任务；前端按紧急度排序，置顶的（到点的提醒）排在最前；
// - 可标已读 / 未读、归档 / 取消归档、删除；通知类事项点了它的某个动作就算处理了；
// - 卡着任务（紧急度前两档）的事项，处理之前归档或删除会被拒，并说明原因；
// - 卡片事项处理没处理看卡片本身的状态：在聊天里处理了，这里同步（同一张卡只有一份状态）。
//   判断用共享协议包的 isInboxItemProcessed（Web 状态层、原型的假连接用的是同一个）；
// - 已读、归档、删除和通知的处理结果在待我处理频道推送（inbox_item 事件是事项的最新状态），多个前端之间实时同步；
// - alert：要马上告诉用户的事项（到点的提醒），另推一条临时的 notify 事件：前端给出页面内提示，用户允许时再发浏览器通知。
// 具体的通知（错过的提醒、中断不确定、越界通知……）由产生它们的票用 add / buildAdd 放进来。
import { randomUUID } from "node:crypto";
import {
  BLOCKING_URGENCIES,
  type CardInboxItem,
  CHANNELS,
  EVENT_TYPES,
  type InboxAction,
  type InboxActionResult,
  type InboxItem,
  type InboxItemEventPayload,
  isInboxItemProcessed,
  type NoticeInboxItem,
  type NoticeType,
  type NotifyEventPayload,
  type Urgency,
} from "@ergou/protocol";
import { getCard } from "../cards/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EphemeralBus } from "../events/ephemeral.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { getInboxItem, inboxActionByKey, listInboxItems, listInboxItemsForCard } from "./views.ts";

/** 由这里生成的字段（id 和置顶可以由调用方给） */
type Generated = "id" | "version" | "createdAt" | "read" | "archived" | "deleted" | "pinned";

/**
 * 新的待我处理事项：协议里的两种事项（CardInboxItem / NoticeInboxItem）去掉由这里生成的字段。
 * 通知类事项的 notice 取 NOTICE_TYPES；actions 不给就是没有处理动作；处理结果（handled）只能由用户的动作产生。
 */
export type NewInboxItem =
  | (Omit<CardInboxItem, Generated> & { id?: string; pinned?: boolean })
  | (Omit<NoticeInboxItem, Generated | "notice" | "actions" | "handled" | "handledAt"> & { id?: string; pinned?: boolean; notice: NoticeType; actions?: string[] });

/** 系统改一条事项（比如新的一次提醒到点时，上一次的取消置顶） */
export type InboxItemChange = Partial<Pick<InboxItem, "title" | "urgency" | "pinned" | "archived" | "read">>;

export interface InboxActionRequest {
  itemIds: string[];
  action: InboxAction;
  choice?: string;
  idempotencyKey: string;
}

export interface InboxService {
  /** 新事项和它的 inbox_item 事件（不追加）：调用方和别的事件一起放进 appendBatch */
  buildAdd(input: NewInboxItem): { item: InboxItem; event: NewEvent };
  /** 放进一条事项并在待我处理频道推送 */
  add(input: NewInboxItem): InboxItem;
  /** 系统改一条事项后的样子和它的 inbox_item 事件（不追加）；版本加 1 */
  buildUpdate(item: InboxItem, change: InboxItemChange): { item: InboxItem; event: NewEvent };
  get(itemId: string): InboxItem | undefined;
  /** 没删掉的事项 */
  list(): InboxItem[];
  /** 和某张卡有关的、没删掉的事项（卡片事项，或者相关的卡是它的通知） */
  itemsForCard(cardId: string): InboxItem[];
  /** 处理过了：卡片不再是待处理（在哪里处理都算），通知类点过某个动作 */
  isProcessed(item: InboxItem): boolean;
  /** 对事项做动作（网关调用）：要么全部生效、要么全部不生效 */
  act(request: InboxActionRequest): InboxActionResult;
  /** 马上告诉用户这条事项（临时的 notify 事件：页面内提示，用户允许时再发浏览器通知） */
  alert(item: InboxItem): void;
}

export interface InboxServiceOptions {
  store: EventStore;
  notifications: EphemeralBus;
  now: () => string;
}

const ACTION_VERB: Record<"archive" | "delete", string> = { archive: "归档", delete: "删除" };

function itemEvent(item: InboxItem, idempotencyKey?: string): NewEvent {
  const payload: InboxItemEventPayload = { item };
  return { channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

/** 系统改一条事项后的样子和它的事件；版本加 1 */
function buildUpdate(item: InboxItem, change: InboxItemChange): { item: InboxItem; event: NewEvent } {
  const next: InboxItem = { ...item, ...change, version: item.version + 1 };
  return { item: next, event: itemEvent(next) };
}

/** 卡着任务（紧急度前两档） */
function blocksTask(item: InboxItem): boolean {
  return (BLOCKING_URGENCIES as readonly Urgency[]).includes(item.urgency);
}

export function createInboxService(options: InboxServiceOptions): InboxService {
  const { store, notifications, now } = options;

  const buildAdd = (input: NewInboxItem): { item: InboxItem; event: NewEvent } => {
    const base = {
      id: input.id ?? `i-${randomUUID()}`,
      version: 1,
      title: input.title,
      source: input.source,
      urgency: input.urgency,
      pinned: input.pinned ?? false,
      createdAt: now(),
      read: false,
      archived: false,
      deleted: false,
    };
    const item: InboxItem =
      input.kind === "card"
        ? { ...base, kind: "card", cardId: input.cardId }
        : {
            ...base,
            kind: "notice",
            notice: input.notice,
            ...(input.body === undefined ? {} : { body: input.body }),
            actions: input.actions ?? [],
            ...(input.cardId === undefined ? {} : { cardId: input.cardId }),
            ...(input.data === undefined ? {} : { data: input.data }),
          };
    return { item, event: itemEvent(item) };
  };


  const isProcessed = (item: InboxItem): boolean => isInboxItemProcessed(item, item.kind === "card" ? getCard(store.reader, item.cardId)?.status : undefined);

  /** 动作之后事项的样子（版本还没加）；没有变化返回 undefined */
  const applyAction = (item: InboxItem, request: InboxActionRequest): InboxItem | undefined => {
    switch (request.action) {
      case "read":
        return item.read ? undefined : { ...item, read: true };
      case "unread":
        return item.read ? { ...item, read: false } : undefined;
      case "archive":
      case "delete": {
        if (blocksTask(item) && !isProcessed(item)) {
          throw new RequestRejected("not_allowed", `「${item.title}」卡着任务，处理之前不能${ACTION_VERB[request.action]}：先在卡片上处理它（或者取消那个任务）`);
        }
        if (request.action === "archive") return item.archived ? undefined : { ...item, archived: true, read: true };
        return { ...item, deleted: true };
      }
      case "unarchive":
        return item.archived ? { ...item, archived: false } : undefined;
      case "handle": {
        if (item.kind !== "notice") throw new RequestRejected("bad_params", `「${item.title}」是卡片，在卡片上处理`);
        const choice = request.choice;
        if (choice === undefined) throw new RequestRejected("bad_params", "处理通知要选它的一个动作（choice）");
        if (item.actions.length > 0 && !item.actions.includes(choice)) throw new RequestRejected("bad_params", `「${item.title}」没有「${choice}」这个动作`);
        if (item.handled !== undefined) {
          if (item.handled === choice) return undefined;
          throw new RequestRejected("conflict", "已被处理");
        }
        return { ...item, handled: choice, handledAt: now(), read: true };
      }
    }
  };

  return {
    buildAdd,
    add(input) {
      const { item, event } = buildAdd(input);
      store.append(event);
      return item;
    },
    buildUpdate,
    get: (itemId) => getInboxItem(store.reader, itemId),
    list: () => listInboxItems(store.reader),
    itemsForCard: (cardId) => listInboxItemsForCard(store.reader, cardId),
    isProcessed,
    act(request) {
      const itemIds = [...new Set(request.itemIds)];
      const keyOf = (itemId: string) => `${request.idempotencyKey}#${itemId}`;
      // 同一个幂等键重发：已经落过的不再做
      const done = itemIds.map((id) => inboxActionByKey(store.reader, keyOf(id)));
      if (done.some((d) => d !== undefined)) {
        return { items: itemIds.map((id, i) => ({ id, version: done[i]?.version ?? getInboxItem(store.reader, id)?.version ?? 1 })) };
      }
      const items = itemIds.map((id) => {
        const item = getInboxItem(store.reader, id);
        if (!item || item.deleted) throw new RequestRejected("not_found", `没有这条待我处理事项：${id}`);
        return item;
      });
      // 先全部检查一遍（有一条不行就整个拒绝），再一起追加
      const changes = items.map((item) => ({ item, change: applyAction(item, request) }));
      const events: NewEvent[] = [];
      const result: InboxActionResult = { items: [] };
      for (const { item, change } of changes) {
        if (!change) {
          result.items.push({ id: item.id, version: item.version });
          continue;
        }
        const next: InboxItem = { ...change, version: item.version + 1 };
        events.push(itemEvent(next, keyOf(item.id)));
        result.items.push({ id: item.id, version: next.version });
      }
      if (events.length > 0) store.appendBatch(events);
      return result;
    },
    alert(item) {
      const body = item.kind === "notice" ? item.body : undefined;
      const payload: NotifyEventPayload = { id: `n-${item.id}`, title: item.title, ...(body === undefined ? {} : { body }), itemId: item.id };
      notifications.publish({ channel: CHANNELS.inbox, seq: store.lastSeq(CHANNELS.inbox), type: EVENT_TYPES.notify, payload });
    },
  };
}
