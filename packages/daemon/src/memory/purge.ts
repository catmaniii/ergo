// 彻底删除（规格第 14、15 节，21 号票）要改写哪些事件、改成什么（改成什么由改写函数表定，见 rewriters.ts）：
// - 素材的原始事件：按素材记下的频道和序号找（不用全局序号：ergo.db 换成更早的版本后全局序号会对不上），类型、消息 id 对得上
//   才改写；找不到的（会话事件已经删了，素材只在原文副本里）不用改写，素材和原文副本照样删；
// - 删除类记忆命令（忘掉、彻底删除、别推断）的事件不改写：里面没有原话，而且它是"这些素材被删了"的记录，改写了重建时素材会回来；
// - "记住"的素材：记忆命令事件之外，它的快速动作卡（每个版本）、操作记录里也有原话；提议"记住"的那次工具调用的记录
//   （按快速动作卡上记的工具调用 id 找）和紧跟着的效果日志也有；
// - 素材的卡片上用户写的说明（关掉卡片、拒绝审批时写的，卡片处理结果的 note）；审批决定的那次工具调用的记录
//   （守卫接入把"你拒绝了：<说明>"写进了结果摘要，按审批记录里的工具调用 id 找）；
// - 检索素材的工具调用记录（结果摘要里有素材的摘录，按素材 id 找）和紧跟着的效果日志；效果日志里提到素材 id 的；
//   读素材（166 号票）的同样（参数里就是素材 id，返回里有全文，存的网页还有存下的正文），而且会话文件里它的参数和结果整个换掉
//   （检索的结果在会话文件里按行换：提到被删素材的那一行，存的网页那一段正文也写在同一行里）；
// - 问记忆（ask_memory，265 号票）的调用记录和完整内容：返回里按证据编号引着原话——调用记忆的部分列着被删素材的（263 号票起），
//   或者结果摘要、完整返回里引着被删素材的证据编号的（证据编号由调用方给的 evidenceOf 从推理库里查）；会话文件里它的结果按证据编号换行；
//   问记忆管理员（ask_curator，272 号票）的同样：回答里引着被删素材的证据编号、或者提到它的素材 id 的；
// - 改写的工具调用另存的完整参数和返回（53 号票），全文里提到被删素材的检索调用的完整返回（摘要只有开头）；
//   改写了完整内容的调用的效果日志（56 号票起按记下的调用 id 找，之前的按紧跟在完整内容后面找；改写时调用 id 一起去掉）；
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
  type ToolCallDetail,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { isConversationChannel } from "../conversation/history.ts";
import { isToolCallRecord } from "../conversation/purge.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import type { PurgeContext } from "../events/purge.ts";
import { approvalDeniedNoticeKey } from "../guard-runtime/approval-waits.ts";
import { effectCallOf, effectEventsOfCall, legacyEffectEventAfter } from "../guard-runtime/effect-log.ts";
import { type ApprovalRequestedPayload, GUARD_CHANNEL, GUARD_EVENTS, type ToolCallStartedPayload } from "../guard-runtime/events.ts";
import { executionEventsOfCall } from "../guard-runtime/executions.ts";
import { detailEventsMentioning, detailEventsOfCall, detailEventsOfToolMentioning, TOOL_CALL_DETAIL_EVENT } from "../guard-runtime/tool-call-details.ts";
import type { Material } from "../materials/index.ts";
import { operationRecordKey } from "../quick-actions/index.ts";
import { mentionsId } from "../util/mentions.ts";
import type { PurgeRewriters } from "./rewriters.ts";
import { ASK_CURATOR, ASK_MEMORY, READ_MATERIAL, SEARCH_MATERIALS } from "./tool-names.ts";

export interface PurgeDeps {
  store: EventStore;
  cards: CardService;
  rewriters: PurgeRewriters;
  /** 现在（协议时间） */
  now?: () => string;
  /**
   * 被删素材在推理库里的证据编号（265 号票，purged-evidence.ts 的 purgedEvidenceIds）：问记忆的结果按证据编号引原话，
   * 263 号票以前的记录、命中超过上限的只能按证据编号找。不给就只按素材 id 找（263 号票起记录的调用记忆部分列着命中的素材）
   */
  evidenceOf?: (materialIds: readonly string[]) => readonly string[];
}

/**
 * 一次快速动作留下的：操作记录（按动作 id）、它的卡片（每个版本）、提议它的那次工具调用（卡上记着的调用 id）在哪个会话里。
 * "记住"的素材（记忆命令里记着）和个人档案里经秘书写进来的值（281 号票，档案的留痕里记着）彻底删除时都按它找
 */
export interface QuickActionTrace {
  actionId: string;
  cardId: string;
  conversation: string;
}

/** 正文里引着某段原话的工具调用（281 号票：彻底删除档案里的值时，读过它的调用、参数里带着它的调用） */
export interface ToolCallMention {
  text: string;
  /** 只找这几个工具的调用；不给是任何工具 */
  tools?: readonly string[];
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

/**
 * 有副作用的调用的执行记录（23 号票），连同同一段调用摘要出现的别处：被中断时待我处理里的"中断不确定"、任务等我的说明、
 * 维护者会话里的系统说明和给它的通知（"用户确认过了：X 已经执行了"）。彻底删除、删除项目（66 号票）改写一次调用时连带。
 * 给了 agent 的只认这个 agent 的（不同 agent 的调用 id 可能撞上）
 */
export function executionTraces(store: EventStore, toolCallId: string, agentId?: string): StoredEvent[] {
  const executions = executionEventsOfCall(store, toolCallId, agentId);
  const traces = [...executions];
  for (const event of store.mentioning(EVENT_TYPES.inboxItem, toolCallId)) {
    const data = interruptedNoticeData((event.payload as InboxItemEventPayload).item);
    if (data?.toolCallId === toolCallId && (agentId === undefined || data.agentId === agentId)) traces.push(event);
  }
  const started = executions.find((e) => e.type !== GUARD_EVENTS.toolCallFinished);
  const execution = started && (started.payload as ToolCallStartedPayload).execution;
  if (!execution || execution.call === PURGED_TEXT) return traces;
  const { taskId, conversation } = execution.origin;
  // 负载是 JSON：按 JSON 里的写法找（调用摘要里常有引号、反斜杠）
  const inJson = JSON.stringify(execution.call).slice(1, -1);
  if (taskId !== null) {
    for (const event of store.mentioning(EVENT_TYPES.task, inJson)) {
      const { task } = event.payload as TaskEventPayload;
      if (task.id === taskId && task.waitNote?.includes(execution.call)) traces.push(event);
    }
  }
  if (conversation !== null) {
    for (const event of store.mentioning(EVENT_TYPES.message, inJson)) {
      if (event.channel === conversation && (event.payload as MessageEventPayload).message.speaker === "system") traces.push(event);
    }
  }
  return traces;
}

/** 消息里引用的媒体（附件） */
function mediaOf(event: StoredEvent): string[] {
  return (event.payload as MessageEventPayload).message.parts.flatMap((p) => ("mediaId" in p && typeof p.mediaId === "string" ? [p.mediaId] : []));
}

/**
 * 会话里被改写的消息另在各会话频道追加的 messages_purged（前端据此换掉手里的原话，拉起 agent 的模块据此改写会话文件）：
 * 整条删掉的（用户的消息）只留"已删除"，字段级改写的（工具调用记录）给出改写后的样子；toolCallIds 是各会话里会话文件也要改的
 * 工具调用。彻底删除和删除项目（66 号票：项目之外读过这个项目的调用）共用
 */
export function messagesPurgedEvents(
  rewritten: ReadonlyArray<{ event: StoredEvent; payload: unknown }>,
  toolCallIds: ReadonlyMap<string, ReadonlySet<string>>,
  context: PurgeContext,
): NewEvent[] {
  const perConversation = new Map<string, Pick<MessagesPurgedEventPayload, "messages" | "mediaIds">>();
  for (const { event, payload } of rewritten) {
    if (event.type !== EVENT_TYPES.message || !isConversationChannel(event.channel)) continue;
    const entry = perConversation.get(event.channel) ?? { messages: [], mediaIds: [] };
    const messageId = (event.payload as MessageEventPayload).message.id;
    if (isDeletedEventPayload(payload)) {
      entry.messages.push({ seq: event.seq, messageId });
      entry.mediaIds.push(...mediaOf(event));
    } else entry.messages.push({ seq: event.seq, messageId, replacement: (payload as MessageEventPayload).message });
    perConversation.set(event.channel, entry);
  }
  return [...new Set([...perConversation.keys(), ...toolCallIds.keys()])].map((conversation): NewEvent => {
    const entry = perConversation.get(conversation) ?? { messages: [], mediaIds: [] };
    const payload: MessagesPurgedEventPayload = {
      messages: entry.messages,
      materialIds: [...context.materialIds],
      toolCallIds: [...(toolCallIds.get(conversation) ?? [])],
      mediaIds: [...new Set(entry.mediaIds)],
      deletedAt: context.deletedAt,
    };
    return { channel: conversation, type: EVENT_TYPES.messagesPurged, payload };
  });
}

/**
 * 彻底删除这些素材要改写的事件和同一事务追加的事件。
 * exceptCard：这张卡的旧版本照样改写，但不追加新版本（记忆删除卡自己的动作会追加）；
 * extraTargets：另外要改写的原始事件（没有素材的语音）；
 * skip：调用方在同一事务里已经改写了的事件（全局序号；删除项目时随项目删素材，66 号票）——不再改第二遍，也不为它们追加
 * messages_purged、新版本（找连带的照样从它们找）
 */
export function purgePlan(
  deps: PurgeDeps,
  materials: readonly Material[],
  options: {
    exceptCard?: string;
    extraTargets?: readonly StoredEvent[];
    skip?: ReadonlySet<number>;
    /** 另外要连带改写的快速动作（281 号票）：操作记录、卡片、提议它的那次调用 */
    quickActions?: readonly QuickActionTrace[];
    /** 另外要改写的、引着某段原话的工具调用（281 号票） */
    toolCallsMentioning?: readonly ToolCallMention[];
  } = {},
): PurgePlan {
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

  /** 这次调用在会话文件里的参数和结果整个换掉 */
  const rewriteInSession = (conversation: string, toolCallId: string) => toolCallIds.set(conversation, (toolCallIds.get(conversation) ?? new Set()).add(toolCallId));

  /** 工具调用记录连同紧跟着的效果日志；inSession：会话文件里这次调用也整个换掉（读素材，166） */
  const targetToolCalls = (text: string, match: (call: { callId: string; tool: string }) => boolean, inSession = false) => {
    for (const event of store.mentioning(EVENT_TYPES.message, text)) {
      const call = toolCallOf(event);
      if (!call || !match(call)) continue;
      target(event);
      if (inSession) rewriteInSession(event.channel, call.callId);
      // 紧跟着的旧效果日志（没有调用 id 的；记了调用 id 的在下面按完整内容找）：哪个 agent 看这次调用的完整内容，
      // 没有完整内容的看记录上写的（子 agent 的），都没有的不限定
      const detail = detailEventsOfCall(store, call.callId)
        .map((e) => e.payload as ToolCallDetail)
        .findLast((d) => d.conversation === event.channel);
      const agentId = detail?.agentId ?? (event.payload as MessageEventPayload).agentId;
      const effect = legacyEffectEventAfter(store, event, { ...call, agentId, conversation: event.channel });
      if (effect) target(effect);
      targetExecution(call.callId);
    }
  };

  /** 一次调用另存的完整参数和返回（53 号票），有副作用的调用的执行记录和同一段调用摘要出现的别处（executionTraces） */
  const targetExecution = (toolCallId: string) => {
    for (const event of detailEventsOfCall(store, toolCallId)) target(event);
    for (const event of executionTraces(store, toolCallId)) target(event);
  };

  /** 一次快速动作：操作记录、卡片的每个版本、提议它的那次工具调用（"记住"的命令、281 号票档案里经秘书写进来的值共用） */
  const targetQuickAction = (from: QuickActionTrace) => {
    const record = store.eventByIdempotencyKey(operationRecordKey(from.actionId));
    if (record) target(record);
    for (const version of versionsOf(from.cardId)) target(version);
    refreshed.add(from.cardId);
    const payload = cards.get(from.cardId)?.payload as (Partial<QuickActionCardPayload> & { items?: readonly { id?: string; toolCallId?: string }[] }) | undefined;
    // 284 号票：一张卡上几条动作的（访谈的档案核对卡）按动作编号找那一条记着的调用
    const toolCallId = payload?.toolCallId ?? payload?.items?.find((item) => item.id === from.actionId)?.toolCallId;
    if (toolCallId === undefined) return;
    targetToolCalls(toolCallId, (call) => call.callId === toolCallId);
    targetExecution(toolCallId);
    rewriteInSession(from.conversation, toolCallId);
  };

  /**
   * "记住"的命令：操作记录、快速动作卡的每个版本、提议它的那次工具调用。
   * 337 号票：秘书按用户的话记的（`from.kind: "secretary"`）没有卡、没有快速动作，原话在记它的那次工具调用里——改写那次调用
   * （记录、完整内容、执行记录，会话文件里的参数和结果整个换掉）；没有工具调用 id 的（不是经工具记的）没有别的要改
   */
  const targetRemember = (command: Extract<MemoryCommandEventPayload, { command: "remember" }>) => {
    const from = command.from;
    if (from.kind === "chat") {
      targetQuickAction(from);
      return;
    }
    const callId = from.toolCallId;
    if (callId === undefined) return;
    targetToolCalls(callId, (call) => call.callId === callId);
    targetExecution(callId);
    rewriteInSession(from.conversation, callId);
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
    // 检索素材、读素材（166）的记录、效果日志里提到它的、列出过它的卡片；检索的完整返回里列出过它的（结果摘要只有开头，记录里不一定有它）
    targetToolCalls(material.id, (call) => call.tool === SEARCH_MATERIALS);
    targetToolCalls(material.id, (call) => call.tool === READ_MATERIAL, true);
    // 问记忆（265 号票）：调用记忆的部分（263 号票起）列着命中的素材——那次调用的记录、完整内容（返回里引着原话）一起改写；
    // 会话文件里它的结果按证据编号换行（after-purge.ts）
    targetToolCalls(material.id, (call) => call.tool === ASK_MEMORY);
    // 问记忆管理员（272 号票）：回答是管理员自己写的话，可能提到素材 id（要忘掉哪一条）——记录、完整内容里提到它的一起改写
    targetToolCalls(material.id, (call) => call.tool === ASK_CURATOR);
    for (const event of detailEventsOfToolMentioning(store, ASK_CURATOR, material.id)) {
      if (!mentionsId((event.payload as ToolCallDetail).result, material.id)) continue;
      target(event);
      targetToolCalls((event.payload as ToolCallDetail).callId, (c) => c.callId === (event.payload as ToolCallDetail).callId);
    }
    for (const event of detailEventsOfToolMentioning(store, SEARCH_MATERIALS, material.id)) target(event);
    for (const event of detailEventsOfToolMentioning(store, READ_MATERIAL, material.id)) {
      target(event);
      const detail = event.payload as ToolCallDetail;
      if (detail.conversation !== null) rewriteInSession(detail.conversation, detail.callId);
    }
    for (const effect of store.mentioning(GUARD_EVENTS.effectRecorded, material.id)) if (effect.channel === GUARD_CHANNEL) target(effect);
    for (const event of store.mentioning(EVENT_TYPES.card, material.id)) {
      const card = (event.payload as CardEventPayload).card;
      if (cards.registry.get(card.type)?.definition.purge === undefined) continue;
      target(event);
      refreshed.add(card.id);
    }
  }

  // 问记忆按证据编号找（265 号票）：263 号票以前的记录没有调用记忆的部分、命中超过上限的没列全，只能看结果摘要和完整返回里
  // 引着的证据编号（按整段认）；找到完整内容的，那次调用的记录也改写（结果摘要是同一份简报的开头），会话里因此有 messages_purged
  // 问记忆管理员（272 号票）的回答照同样的找法：管理员照提示词引证据编号（inspect_memory 把编号和原话写在一起）
  const quoting = new Set([ASK_MEMORY, ASK_CURATOR]);
  const evidenceIds = deps.evidenceOf?.(materials.map((m) => m.id)) ?? [];
  for (const evidenceId of evidenceIds) {
    for (const event of store.mentioning(EVENT_TYPES.message, evidenceId)) {
      const call = toolCallOf(event);
      if (call !== undefined && quoting.has(call.tool) && mentionsId(JSON.stringify(event.payload), evidenceId)) targetToolCalls(call.callId, (c) => c.callId === call.callId);
    }
    for (const tool of quoting) {
      for (const event of detailEventsOfToolMentioning(store, tool, evidenceId)) {
        const detail = event.payload as ToolCallDetail;
        if (!mentionsId(detail.result, evidenceId) && !mentionsId(JSON.stringify(detail.args), evidenceId)) continue;
        target(event);
        targetToolCalls(detail.callId, (c) => c.callId === detail.callId);
      }
    }
  }

  // 每条消息的记忆简报（266 号票）只在秘书的会话文件里引原话（事件日志里的 MemoryBriefPart 只有编号和哈希）：被删素材背后有证据时，
  // 秘书的会话上一条没改也追加一条 messages_purged，秘书据此按证据编号改会话文件（272 号票合 266 时补上，和一次性补抹同一个规矩）
  if (evidenceIds.length > 0 && !toolCallIds.has(CHANNELS.secretary)) toolCallIds.set(CHANNELS.secretary, new Set());

  for (const event of options.extraTargets ?? []) target(event);
  // 调用方另给的快速动作（281 号票：档案里经秘书写进来的值）和引着某段原话的工具调用（读过档案的、参数里带着这个值的）：
  // 调用记录连同完整内容、效果日志，会话文件里这次调用的参数和结果整个换掉
  for (const trace of options.quickActions ?? []) targetQuickAction(trace);
  for (const mention of options.toolCallsMentioning ?? []) {
    const matches = (tool: string) => mention.tools === undefined || mention.tools.includes(tool);
    // 负载是 JSON：按 JSON 里的写法找（原话里有引号、反斜杠时）
    targetToolCalls(JSON.stringify(mention.text).slice(1, -1), (call) => matches(call.tool), true);
    for (const event of detailEventsMentioning(store, mention.text, mention.tools)) {
      const detail = event.payload as ToolCallDetail;
      target(event);
      targetToolCalls(detail.callId, (call) => call.callId === detail.callId);
      if (detail.conversation !== null) rewriteInSession(detail.conversation, detail.callId);
    }
  }

  // 改写了完整内容的那些调用，它们的效果日志：56 号票起记了调用 id 的按调用 id 和 agent 找（通用 bash 拆出来的也找得到）；
  // 之前的旧记录按紧跟在完整内容（跨过工具调用记录）后面找（effect-log.ts 的 legacyEffectEventAfter，和上面记录那条路同一份）
  const details = [...targets.values()].filter((e) => e.type === TOOL_CALL_DETAIL_EVENT);
  for (const event of details) for (const effect of effectEventsOfCall(store, effectCallOf(event.payload as ToolCallDetail), [event])) target(effect);

  // 连带改写的（改写函数声明的 related：语音的消息和它的别的 voice 事件，31 号票）；连带出来的再看它连带的
  for (const pending = [...targets.values()]; pending.length > 0; ) {
    for (const extra of rewriters.related(pending.pop()!, store)) {
      if (targets.has(extra.globalSeq)) continue;
      target(extra);
      pending.push(extra);
      // 连带出来的卡片版本（84 号票：退回时结论卡上你写的说明）：和上面的卡一样追加改写后的新版本，开着的页面据此换掉手里的卡
      if (extra.channel === CHANNELS.cards && extra.type === EVENT_TYPES.card) refreshed.add((extra.payload as CardEventPayload).card.id);
    }
  }

  const purge = [...targets.values()]
    .filter((event) => options.skip?.has(event.globalSeq) !== true)
    .toSorted((a, b) => a.globalSeq - b.globalSeq)
    .map((event) => ({ event, payload: rewriters.rewrite(event, context) }));

  const events: NewEvent[] = messagesPurgedEvents(purge, toolCallIds, context);
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
