// 彻底删除的改写函数表（规格第 14、15 节，21 号票）：按事件类型登记，一类事件一个改写函数，由拥有这类事件的模块写
// （改写的规矩见 events/purge.ts：消息整条换成"已删除"标记，别的只换带原话的文本字段、状态不变）。
// 现在登记的（daemon.ts）：消息（conversation/purge.ts）、卡片（cards/cards.ts 的 cardPurge，负载按卡片类型的 purge）、
// 卡片被关闭和长期没处理（materials/sources.ts）、"记住"的记忆命令（materials/commands.ts）、审批决定
// （approvals/material-source.ts）、效果日志（guard-runtime/effect-log.ts）、操作记录（quick-actions/quick-actions.ts）。
// **以后的票接入新的素材来源时，要给它的事件类型登记一个改写函数**：没登记的事件类型彻底删除时整个删除被拒，
// 宁可删不成也不胡乱改坏状态。
import type { StoredEvent } from "../events/event-store.ts";
import type { PurgeContext, PurgeRewriter } from "../events/purge.ts";

export class PurgeRewriters {
  private readonly rewriters = new Map<string, PurgeRewriter>();

  /** 登记一类事件的改写函数；同一类型登记两次报错 */
  register(...rewriters: readonly PurgeRewriter[]): void {
    for (const rewriter of rewriters) {
      if (this.rewriters.has(rewriter.eventType)) throw new Error(`事件类型 ${rewriter.eventType} 的改写函数已经登记过了`);
      this.rewriters.set(rewriter.eventType, rewriter);
    }
  }

  /** 一条事件改写后的负载；这类事件没登记改写函数就报错 */
  rewrite(event: StoredEvent, context: PurgeContext): unknown {
    const rewriter = this.rewriters.get(event.type);
    if (!rewriter) throw new Error(`彻底删除：事件类型 ${event.type}（${event.channel}#${event.seq}）没有登记改写函数，不知道怎么改才不改坏状态`);
    return rewriter.rewrite(event, context);
  }
}
