// 原型用的假连接：没有守护进程，在浏览器里模拟服务端。
// - 启动时把假事件按频道编上序号，当作服务端已有的事件；连上时按前端带来的序号补发；
// - 发消息：过一会儿推回带同一个幂等键的权威消息，再推一条 agent 的回复；
// - 卡片动作：按版本条件更新（先到先得），推卡片更新事件；版本对不上就回"已被处理"。
// 04 号票起换成真的 WebSocket 连接，这个文件只留给原型。
import type { CardActionRequest, Connection, SendMessageRequest } from "../app/connection.ts";
import { nowIso } from "../model/labels.ts";
import type { Card, EventFrame, MessageEnvelope, UiInput } from "../state/index.ts";
import { FAKE_CARDS, FAKE_HISTORY } from "./fake-conversations.ts";

/** 动作 → 处理结果的文字 */
const OUTCOME: Record<string, string> = {
  confirm: "已确认",
  reject: "已打回",
  approve: "已批准",
  deny: "已拒绝",
  answer: "已回答",
  ack: "知道了",
  execute: "已执行",
  cancel: "已取消",
  start_task: "已发起任务",
  kickoff: "已立项",
  dismiss: "不用了",
  save: "已保存",
  cancel_reminder: "提醒已取消",
  confirm_start: "已确认并开工",
  confirm_later: "已确认，稍后开工",
  dispatch: "已确认派出",
  return: "已退回",
  parallel: "同意并行",
  sequential: "不并行，按顺序做",
  delete: "已删除",
};

/** 这些动作算"关掉不处理"（回避信号），卡片状态记为已关闭 */
const DISMISS_ACTIONS = new Set(["dismiss", "cancel"]);

type CardListener = (card: Card, action: string) => void;

export class FakeConnection implements Connection {
  private readonly log: EventFrame[] = [];
  private readonly seqs: Record<string, number> = {};
  private readonly cards = new Map<string, Card>();
  private deliver: ((input: UiInput) => void) | undefined;
  private readonly cardListeners = new Set<CardListener>();

  constructor() {
    for (const c of FAKE_CARDS) this.cards.set(c.id, c);
    for (const e of FAKE_HISTORY) this.append(e.channel, e.type, e.payload);
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
      this.emit(req.conversation, "message", { message, idempotencyKey: req.idempotencyKey });
    });
    later(1200, () => {
      const reply = req.conversation === "secretary" ? "（原型）收到。这里是假数据，接上守护进程后是秘书的真实回复。" : "（原型）收到，作为插话在下一步之前插入。这里是假数据。";
      const message: MessageEnvelope = { id: `a-${req.idempotencyKey}`, conversation: req.conversation, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: reply }] };
      this.emit(req.conversation, "message", { message });
    });
  }

  cardAction(req: CardActionRequest): void {
    later(450, () => {
      const card = this.cards.get(req.cardId);
      if (!card || card.version !== req.expectedVersion || card.status !== "pending") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "已被处理" });
        return;
      }
      const label = OUTCOME[req.action] ?? req.action;
      const next: Card = {
        ...card,
        version: card.version + 1,
        status: DISMISS_ACTIONS.has(req.action) ? "dismissed" : "handled",
        handledAt: nowIso(),
        outcome: req.note ? `${label}：${req.note}` : label,
      };
      this.cards.set(next.id, next);
      this.emit("cards", "card", { card: next });
      for (const l of this.cardListeners) l(next, req.action);
    });
  }

  /** 原型里别的假数据（看板、项目）跟着卡片动作变，比如点了"立项"就多一个项目 */
  onCardHandled(listener: CardListener): () => void {
    this.cardListeners.add(listener);
    return () => this.cardListeners.delete(listener);
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

export const fakeConnection = new FakeConnection();
