// 彻底删除（规格第 14、15 节，21 号票）要改写哪些事件、改成什么（改成什么由改写函数表定，见 rewriters.ts）：
// - 素材的原始事件：按素材记下的频道和序号找（不用全局序号：ergou.db 换成更早的版本后全局序号会对不上），类型、消息 id 对得上
//   才改写；找不到的（会话事件已经删了，素材只在原文副本里）不用改写，素材和原文副本照样删；
// - 删除类记忆命令（忘掉、彻底删除、别推断）的事件不改写：里面没有原话，而且它是"这些素材被删了"的记录，改写了重建时素材会回来；
// - "记住"的素材：记忆命令事件之外，它的快速动作卡（每个版本）、操作记录里也有原话；提议"记住"的那次工具调用的记录
//   （按快速动作卡上记的工具调用 id 找）和紧跟着的效果日志也有；
// - 素材的卡片上用户写的说明（关掉卡片、拒绝审批时写的，卡片处理结果的 note）；审批决定的那次工具调用的记录
//   （守卫接入把"你拒绝了：<说明>"写进了结果摘要，按审批记录里的工具调用 id 找）；
// - 检索素材的工具调用记录（结果摘要里有素材的摘录，按素材 id 找）和紧跟着的效果日志；效果日志里提到素材 id 的；
// - 改写的工具调用另存的完整参数和返回（53 号票），全文里提到被删素材的检索调用的完整返回（摘要只有开头）；
// - 改写的工具调用对应的执行记录（有副作用的调用开始、结束、被中断时记的调用摘要和结果摘要，23 号票），连同同一段
//   调用摘要出现的别处：被中断时的"中断不确定"事项（标题、正文）、任务等我的说明（waitNote）、维护者会话里的说明和通知；
// - 列出过这些素材的卡片（记忆删除卡的摘录）；
// - 改写函数声明了连带改写的（PurgeRewriter.related）：语音素材（31 号票）的原始事件是识别完成的 voice 事件，
//   连带这条语音的消息（整条换成"已删除"，音频随之删掉）、它的别的 voice 事件、重新识别后交给 agent 的通知；
//   登记过引用的（PurgeQuotes）：引着用户在维护者会话里的话、审批卡上的批准的范围记录（18 号票），连带它的时间线记录和越界通知；
// - 调用方另给的原始事件（extraTargets：设置里彻底删除一个范围时没有素材的语音），同样连带。
// 会话里被改写的消息另外在会话频道追加 messages_purged（前端据此换掉手里的原话，秘书据此改写会话文件），
// 改写过的卡片追加一个改写后的新版本（开着的页面据此换掉手里的卡），改写函数声明了新版本的（范围记录）同样追加。
import {
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  interruptedNoticeData,
  isDeletedEventPayload,
  type MemoryCommandEventPayload,
  type MessageEventPayload,
  type MessagesPurgedEventPayload,
  nowIso,
  PURGED_TEXT,
  type QuickActionCardPayload,
  type TaskEventPayload,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { isConversationChannel } from "../conversation/history.ts";
import { isToolCallRecord } from "../conversation/purge.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import type { PurgeContext } from "../events/purge.ts";
import { approvalDeniedNoticeKey } from "../guard-runtime/approval-waits.ts";
import { type ApprovalRequestedPayload, type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS, type ToolCallStartedPayload } from "../guard-runtime/events.ts";
import { executionEventsOfCall } from "../guard-runtime/executions.ts";
import { detailEventsOfCall, detailEventsOfToolMentioning } from "../guard-runtime/tool-call-details.ts";
import type { Material } from "../materials/index.ts";
import { operationRecordKey } from "../quick-actions/index.ts";
import type { PurgeRewriters } from "./rewriters.ts";
import { SEARCH_MATERIALS } from "./tool-names.ts";

export interface PurgeDeps {
  store: EventStore;
  cards: CardService;
  rewriters: PurgeRewriters;
  /** 现在（协议时间） */
  now?: () => string;
}

export interface PurgePlan {
  /** 要改写的事件和改写后的负载 */
  purge: PurgeRewrite[];
  /** 同一事务追加的事件：各会话的 messages_purged、改写过的卡片的新版本 */
  events: NewEvent[];
}

/** 素材的原始事件（还在、而且对得上才算） */
function sourceEvent(store: EventStore, material: Material): StoredEvent | undefined {
  const { channel, seq, type } = material.ref.event;
  const event = store.eventAt(channel, seq);
  if (!event || event.type !== type || isDeletedEventPayload(event.payload)) return undefined;
  if (type === EVENT_TYPES.message && (event.payload as Partial<MessageEventPayload>).message?.id !== material.ref.messageId) return undefined;
  return event;
}

/** 会话里一条工具调用记录（只有工具调用 part 的消息）的调用 id 和工具 */
function toolCallOf(event: StoredEvent): { callId: string; tool: string } | undefined {
  if (event.type !== EVENT_TYPES.message || !isConversationChannel(event.channel) || isDeletedEventPayload(event.payload)) return undefined;
  const parts = (event.payload as MessageEventPayload).message.parts;
  const part = isToolCallRecord(parts) && parts.length === 1 ? parts[0] : undefined;
  return part ? { callId: part.callId, tool: part.tool } : undefined;
}

/** 紧跟在一条工具调用记录后面的效果日志事件（守卫接入在同一次调用结束时追加的；记的是同一个工具才算） */
function effectAfter(store: EventStore, record: StoredEvent, tool: string): StoredEvent | undefined {
  const next = store.readGlobal(record.globalSeq, 1)[0];
  if (next?.channel !== GUARD_CHANNEL || next.type !== GUARD_EVENTS.effectRecorded) return undefined;
  const { records } = next.payload as EffectRecordedPayload;
  return records.length > 0 && records.every((r) => r.tool === tool) ? next : undefined;
}

/** 消息里引用的媒体（附件） */
function mediaOf(event: StoredEvent): string[] {
  return (event.payload as MessageEventPayload).message.parts.flatMap((p) => ("mediaId" in p && typeof p.mediaId === "string" ? [p.mediaId] : []));
}

/**
 * 彻底删除这些素材要改写的事件和同一事务追加的事件。
 * exceptCard：这张卡的旧版本照样改写，但不追加新版本（记忆删除卡自己的动作会追加）；
 * extraTargets：另外要改写的原始事件（没有素材的语音）
 */
export function purgePlan(deps: PurgeDeps, materials: readonly Material[], options: { exceptCard?: string; extraTargets?: readonly StoredEvent[] } = {}): PurgePlan {
  const { store, cards, rewriters } = deps;
  const context: PurgeContext = { deletedAt: (deps.now ?? nowIso)(), materialIds: new Set(materials.map((m) => m.id)) };
  const targets = new Map<number, StoredEvent>();
  const target = (event: StoredEvent) => targets.set(event.globalSeq, event);
  /** 要追加改写后新版本的卡片 */
  const refreshed = new Set<string>();
  /** 各会话里被改写的工具调用（会话文件里也要改） */
  const toolCallIds = new Map<string, Set<string>>();
  const cardEvents = store.read(CHANNELS.cards, 0, EVENT_TYPES.card).filter((e) => !isDeletedEventPayload(e.payload));
  const versionsOf = (cardId: string) => cardEvents.filter((e) => (e.payload as CardEventPayload).card.id === cardId);

  /** 工具调用记录连同紧跟着的效果日志 */
  const targetToolCalls = (text: string, match: (call: { callId: string; tool: string }) => boolean) => {
    for (const event of store.mentioning(EVENT_TYPES.message, text)) {
      const call = toolCallOf(event);
      if (!call || !match(call)) continue;
      target(event);
      const effect = effectAfter(store, event, call.tool);
      if (effect) target(effect);
      targetExecution(call.callId);
    }
  };

  /**
   * 一次调用另存的完整参数和返回（53 号票）；有副作用的调用的执行记录（23 号票），连同同一段调用摘要出现的别处：
   * 被中断时待我处理里的"中断不确定"、任务等我的说明、维护者会话里的系统说明和给它的通知（"用户确认过了：X 已经执行了"）
   */
  const targetExecution = (toolCallId: string) => {
    for (const event of detailEventsOfCall(store, toolCallId)) target(event);
    const executions = executionEventsOfCall(store, toolCallId);
    for (const event of executions) target(event);
    for (const event of store.mentioning(EVENT_TYPES.inboxItem, toolCallId)) {
      if (interruptedNoticeData((event.payload as InboxItemEventPayload).item)?.toolCallId === toolCallId) target(event);
    }
    const started = executions.find((e) => e.type !== GUARD_EVENTS.toolCallFinished);
    const execution = started && (started.payload as ToolCallStartedPayload).execution;
    if (!execution || execution.call === PURGED_TEXT) return;
    const { taskId, conversation } = execution.origin;
    // 负载是 JSON：按 JSON 里的写法找（调用摘要里常有引号、反斜杠）
    const inJson = JSON.stringify(execution.call).slice(1, -1);
    if (taskId !== null) {
      for (const event of store.mentioning(EVENT_TYPES.task, inJson)) {
        const { task } = event.payload as TaskEventPayload;
        if (task.id === taskId && task.waitNote?.includes(execution.call)) target(event);
      }
    }
    if (conversation !== null) {
      for (const event of store.mentioning(EVENT_TYPES.message, inJson)) {
        if (event.channel === conversation && (event.payload as MessageEventPayload).message.speaker === "system") target(event);
      }
    }
  };

  /** "记住"的命令：操作记录、快速动作卡的每个版本、提议它的那次工具调用 */
  const targetRemember = (command: Extract<MemoryCommandEventPayload, { command: "remember" }>) => {
    const record = store.eventByIdempotencyKey(operationRecordKey(command.from.actionId));
    if (record) target(record);
    for (const version of versionsOf(command.from.cardId)) target(version);
    refreshed.add(command.from.cardId);
    const toolCallId = (cards.get(command.from.cardId)?.payload as Partial<QuickActionCardPayload> | undefined)?.toolCallId;
    if (toolCallId === undefined) return;
    targetToolCalls(toolCallId, (call) => call.callId === toolCallId);
    targetExecution(toolCallId);
    toolCallIds.set(command.from.conversation, (toolCallIds.get(command.from.conversation) ?? new Set()).add(toolCallId));
  };

  for (const material of materials) {
    const source = sourceEvent(store, material);
    if (source?.type === EVENT_TYPES.memoryCommand) {
      const command = source.payload as MemoryCommandEventPayload;
      if (command.command === "remember") {
        target(source);
        targetRemember(command);
      }
    } else if (source) target(source);
    // 卡片上用户写的说明（关掉卡片、拒绝审批时写的）
    if (material.ref.cardId !== undefined) {
      for (const version of versionsOf(material.ref.cardId)) {
        if ((version.payload as CardEventPayload).card.outcome?.note === undefined) continue;
        target(version);
        refreshed.add(material.ref.cardId);
      }
    }
    // 审批决定：那次工具调用的记录（结果摘要里有用户拒绝时写的说明）、会话文件里那次调用的结果（模型收到的
    // "用户拒绝了这次调用：<说明>"）；挂起之后才拒绝的，还有递给 agent 的那条通知
    if (material.kind === "approval_decision" && material.ref.recordId !== undefined) {
      const approvalId = material.ref.recordId;
      for (const requested of store.mentioning(GUARD_EVENTS.approvalRequested, approvalId)) {
        const { approval } = requested.payload as ApprovalRequestedPayload;
        if (approval.approvalId !== approvalId) continue;
        targetToolCalls(approval.toolCallId, (call) => call.callId === approval.toolCallId);
        // 批准后执行、被杀时还在执行的：没有工具调用记录，执行记录和"中断不确定"要单独找
        targetExecution(approval.toolCallId);
        const conversation = approval.origin.conversation;
        if (conversation !== null) toolCallIds.set(conversation, (toolCallIds.get(conversation) ?? new Set()).add(approval.toolCallId));
      }
      const notice = store.eventByIdempotencyKey(approvalDeniedNoticeKey(approvalId));
      if (notice) target(notice);
    }
    // 检索素材的记录、效果日志里提到它的、列出过它的卡片；检索的完整返回里列出过它的（结果摘要只有开头，记录里不一定有它）
    targetToolCalls(material.id, (call) => call.tool === SEARCH_MATERIALS);
    for (const event of detailEventsOfToolMentioning(store, SEARCH_MATERIALS, material.id)) target(event);
    for (const effect of store.mentioning(GUARD_EVENTS.effectRecorded, material.id)) if (effect.channel === GUARD_CHANNEL) target(effect);
    for (const event of store.mentioning(EVENT_TYPES.card, material.id)) {
      const card = (event.payload as CardEventPayload).card;
      if (cards.registry.get(card.type)?.definition.purge === undefined) continue;
      target(event);
      refreshed.add(card.id);
    }
  }

  for (const event of options.extraTargets ?? []) target(event);

  // 连带改写的（改写函数声明的 related：语音的消息和它的别的 voice 事件，31 号票）；连带出来的再看它连带的
  for (const pending = [...targets.values()]; pending.length > 0; ) {
    for (const extra of rewriters.related(pending.pop()!, store)) {
      if (targets.has(extra.globalSeq)) continue;
      target(extra);
      pending.push(extra);
    }
  }

  const purge = [...targets.values()].toSorted((a, b) => a.globalSeq - b.globalSeq).map((event) => ({ event, payload: rewriters.rewrite(event, context) }));

  // 会话里被改写的消息：整条删掉的（用户的消息）只留"已删除"，字段级改写的（工具调用记录）给出改写后的样子
  const perConversation = new Map<string, Pick<MessagesPurgedEventPayload, "messages" | "mediaIds">>();
  for (const { event, payload } of purge) {
    if (event.type !== EVENT_TYPES.message || !isConversationChannel(event.channel)) continue;
    const entry = perConversation.get(event.channel) ?? { messages: [], mediaIds: [] };
    const messageId = (event.payload as MessageEventPayload).message.id;
    if (isDeletedEventPayload(payload)) {
      entry.messages.push({ seq: event.seq, messageId });
      entry.mediaIds.push(...mediaOf(event));
    } else entry.messages.push({ seq: event.seq, messageId, replacement: (payload as MessageEventPayload).message });
    perConversation.set(event.channel, entry);
  }
  const events: NewEvent[] = [];
  for (const conversation of new Set([...perConversation.keys(), ...toolCallIds.keys()])) {
    const entry = perConversation.get(conversation) ?? { messages: [], mediaIds: [] };
    const payload: MessagesPurgedEventPayload = {
      messages: entry.messages,
      materialIds: [...context.materialIds],
      toolCallIds: [...(toolCallIds.get(conversation) ?? [])],
      mediaIds: [...new Set(entry.mediaIds)],
      deletedAt: context.deletedAt,
    };
    events.push({ channel: conversation, type: EVENT_TYPES.messagesPurged, payload });
  }
  // 改写函数声明了新版本的（范围记录，18 号票）：这次真的改了的，追加改写后的新版本
  for (const { event, payload } of purge) {
    if (JSON.stringify(payload) !== JSON.stringify(event.payload)) events.push(...rewriters.newVersion(event, payload));
  }
  // 改写过的卡片：追加改写后的新版本（开着的页面据此换掉手里的卡）
  for (const cardId of refreshed) {
    if (cardId === options.exceptCard) continue;
    const latest = cards.get(cardId);
    if (!latest) continue;
    const purged = cards.purged(latest, context);
    events.push(cards.buildUpdate(cardId, { payload: purged.payload, ...(purged.outcome === undefined ? {} : { outcome: purged.outcome }) }).event);
  }
  return { purge: purge.map(({ event, payload }) => ({ globalSeq: event.globalSeq, payload })), events };
}
