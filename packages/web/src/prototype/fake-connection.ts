// 原型用的假连接：没有守护进程，在浏览器里模拟服务端。
// - 启动时把假事件按频道编上序号，当作服务端已有的事件；连上时按前端带来的序号补发；
// - 发消息：过一会儿推回带同一个幂等键的权威消息，再推一条 agent 的回复；
// - 卡片动作：按版本条件更新（先到先得），推卡片更新事件；版本对不上就回"已被处理"；
// - 待我处理：假事项也走 inbox_item 事件；标已读、归档、删除、处理通知照守护进程的规矩（卡着任务的处理之前不能归档或删除）。
// 由守护进程提供页面时，接了真数据的频道（秘书会话、卡片、待我处理……）走 WebSocket，这里的假数据只给其余页面用。
import type { CardActionRequest, Connection, InboxActionRequest, SendMessageRequest } from "../app/connection.ts";
import {
  BLOCKING_URGENCIES,
  type Card,
  type CardAction,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type EventFrame,
  type InboxItem,
  type InboxItemEventPayload,
  isInboxItemProcessed,
  type MessageEnvelope,
  type MessageEventPayload,
  type UiInput,
  type Urgency,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { FAKE_CARDS, FAKE_HISTORY } from "./fake-conversations.ts";
import { FAKE_INBOX } from "./fake-data.ts";

/** 这些动作算"关掉不处理"（回避信号），卡片状态记为已关闭 */
const DISMISS_ACTIONS = new Set<CardAction>(["dismiss", "cancel"]);

export class FakeConnection implements Connection {
  private readonly log: EventFrame[] = [];
  private readonly seqs: Record<string, number> = {};
  private readonly cards = new Map<string, Card>();
  private readonly inbox = new Map<string, InboxItem>();
  private deliver: ((input: UiInput) => void) | undefined;

  constructor() {
    for (const c of FAKE_CARDS) this.cards.set(c.id, c);
    for (const e of FAKE_HISTORY) this.append(e.channel, e.type, e.payload);
    for (const item of FAKE_INBOX) {
      this.inbox.set(item.id, item);
      this.append(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
    }
  }

  /** 是不是原型里的假卡片（过渡期的分流连接据此把卡片动作交给假连接） */
  hasCard(cardId: string): boolean {
    return this.cards.has(cardId);
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    this.deliver = deliver;
    for (const frame of this.log) if (frame.seq > (cursors[frame.channel] ?? 0)) deliver({ kind: "frame", frame });
    return () => {
      if (this.deliver === deliver) this.deliver = undefined;
    };
  }

  sendMessage(req: SendMessageRequest): void {
    const time = nowIso();
    later(350, () => {
      const message: MessageEnvelope = { id: `u-${req.idempotencyKey}`, conversation: req.conversation, speaker: "user", time, parts: req.parts };
      this.emit(req.conversation, EVENT_TYPES.message, { message, idempotencyKey: req.idempotencyKey } satisfies MessageEventPayload);
    });
    later(1200, () => {
      const reply = req.conversation === CHANNELS.secretary ? "（原型）收到。这里是假数据，接上守护进程后是秘书的真实回复。" : "（原型）收到，作为插话在下一步之前插入。这里是假数据。";
      const message: MessageEnvelope = { id: `a-${req.idempotencyKey}`, conversation: req.conversation, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: reply }] };
      this.emit(req.conversation, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  cardAction(req: CardActionRequest): void {
    later(450, () => {
      const card = this.cards.get(req.cardId);
      if (!card || card.version !== req.expectedVersion || card.status !== "pending") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "已被处理" });
        return;
      }
      const next: Card = {
        ...card,
        version: card.version + 1,
        status: DISMISS_ACTIONS.has(req.action) ? "dismissed" : "handled",
        handledAt: nowIso(),
        outcome: { action: req.action, note: req.note },
      };
      this.cards.set(next.id, next);
      this.emit(CHANNELS.cards, EVENT_TYPES.card, { card: next } satisfies CardEventPayload);
    });
  }

  inboxAction(req: InboxActionRequest): void {
    later(200, () => {
      const items = req.itemIds.map((id) => this.inbox.get(id)).filter((x): x is InboxItem => x !== undefined && !x.deleted);
      const changes: InboxItem[] = [];
      for (const item of items) {
        const processed = isInboxItemProcessed(item, item.kind === "card" ? this.cards.get(item.cardId)?.status : undefined);
        if ((req.action === "archive" || req.action === "delete") && (BLOCKING_URGENCIES as readonly Urgency[]).includes(item.urgency) && !processed) {
          const verb = req.action === "archive" ? "归档" : "删除";
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: `「${item.title}」卡着任务，处理之前不能${verb}：先在卡片上处理它（或者取消那个任务）` });
          return;
        }
        const next: InboxItem | undefined =
          req.action === "read"
            ? { ...item, read: true }
            : req.action === "unread"
              ? { ...item, read: false }
              : req.action === "archive"
                ? { ...item, archived: true, read: true }
                : req.action === "unarchive"
                  ? { ...item, archived: false }
                  : req.action === "delete"
                    ? { ...item, deleted: true }
                    : item.kind === "notice" && req.choice !== undefined
                      ? { ...item, handled: req.choice, handledAt: nowIso(), read: true }
                      : undefined;
        if (next) changes.push({ ...next, version: item.version + 1 });
      }
      for (const item of changes) {
        this.inbox.set(item.id, item);
        this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
      }
    });
  }

  private append(channel: string, type: string, payload: unknown): EventFrame {
    const seq = (this.seqs[channel] ?? 0) + 1;
    this.seqs[channel] = seq;
    const frame = { channel, seq, type, payload };
    this.log.push(frame);
    return frame;
  }

  private emit(channel: string, type: string, payload: unknown): void {
    const frame = this.append(channel, type, payload);
    this.deliver?.({ kind: "frame", frame });
  }
}

function later(ms: number, f: () => void): void {
  setTimeout(f, ms);
}
