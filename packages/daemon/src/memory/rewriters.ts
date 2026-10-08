// 彻底删除的改写函数表（规格第 14、15 节，21 号票）：按事件类型登记，一类事件一个改写函数，由拥有这类事件的模块写
// （改写的规矩见 events/purge.ts：消息整条换成"已删除"标记，别的只换带原话的文本字段、状态不变）。
// 现在登记的（daemon.ts）：消息、时间线记录（conversation/purge.ts）、卡片（cards/cards.ts 的 cardPurge，负载按卡片类型的 purge）、
// 卡片被关闭和长期没处理（materials/sources.ts）、"记住"的记忆命令（materials/commands.ts）、审批决定
// （approvals/material-source.ts）、效果日志（guard-runtime/effect-log.ts）、操作记录（quick-actions/quick-actions.ts）、
// 语音对象（voice/material-source.ts，31 号票：连带改写这条语音的消息和别的 voice 事件）、范围记录（scope-review/purge.ts，
// 18 号票：连带改写它的时间线记录和越界通知，改写后追加一条新版本）。
// **以后的票接入新的素材来源时，要给它的事件类型登记一个改写函数**：没登记的事件类型彻底删除时整个删除被拒，
// 宁可删不成也不胡乱改坏状态。
// 别的模块的事件里引着某类事件的原话时，由引用方另外登记"引用"（registerQuotes）：改写被引用的事件时连带改写引用它的。
// 现在登记的：范围记录引着用户在维护者会话里的消息、审批卡上的批准（scope-review/purge.ts，18 号票）。
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { PurgeContext, PurgeQuotes, PurgeRewriter } from "../events/purge.ts";

export class PurgeRewriters {
  private readonly rewriters = new Map<string, PurgeRewriter>();
  private readonly quotes: PurgeQuotes[] = [];

  /** 登记一类事件的改写函数；同一类型登记两次报错 */
  register(...rewriters: readonly PurgeRewriter[]): void {
    for (const rewriter of rewriters) {
      if (this.rewriters.has(rewriter.eventType)) throw new Error(`事件类型 ${rewriter.eventType} 的改写函数已经登记过了`);
      this.rewriters.set(rewriter.eventType, rewriter);
    }
  }

  /** 登记别的事件里引着某类事件的原话（同一类事件可以有好几处引用） */
  registerQuotes(...quotes: readonly PurgeQuotes[]): void {
    this.quotes.push(...quotes);
  }

  /** 一条事件改写后的负载；这类事件没登记改写函数就报错 */
  rewrite(event: StoredEvent, context: PurgeContext): unknown {
    const rewriter = this.rewriters.get(event.type);
    if (!rewriter) throw new Error(`彻底删除：事件类型 ${event.type}（${event.channel}#${event.seq}）没有登记改写函数，不知道怎么改才不改坏状态`);
    return rewriter.rewrite(event, context);
  }

  /** 改写这条事件时要连带改写的事件：这类事件的改写函数声明了的，和登记过引用它的 */
  related(event: StoredEvent, store: EventStore): StoredEvent[] {
    const own = this.rewriters.get(event.type)?.related?.(event, store) ?? [];
    return [...own, ...this.quotes.filter((q) => q.eventType === event.type).flatMap((q) => q.quotedIn(event, store))];
  }

  /** 这条事件改写了（负载变了）之后要追加的新版本（这类事件的改写函数声明了的话） */
  newVersion(event: StoredEvent, rewritten: unknown): NewEvent[] {
    const next = this.rewriters.get(event.type)?.newVersion?.(event, rewritten);
    return next ? [next] : [];
  }
}
