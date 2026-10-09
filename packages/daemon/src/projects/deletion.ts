// 删除项目（规格第 11 节，ADR-0010）：用户在待我处理里的二次确认上选了"确认删除"之后，按这个顺序做：
// 1. 先停维护者（马上不再接输入，之后来的输入也不唤起它），等它的子进程结束（内存里的原文随之没了）；
// 2. 复查：停下来的这段时间里用户取消了归档（或者项目已经不在了）就整个中止，什么都不删，维护者恢复成能唤起；
//    没变就在同一个事务里追加项目的 deleted，并改写属于这个项目的事件：
//    - 维护者会话频道上的事件全部换成"已删除"标记（和彻底删除同一个口子，ADR-0008）；
//    - 立项书正文（charters 频道的事件、立项书卡的每个版本）、这个维护者的审批（审批请求、审批卡、审批决定）和效果日志、
//      这个项目的工单的内容（16 号票）、范围记录的摘要和说明（18 号票）、维护者会话里和属于项目的工具调用另存的完整参数和返回
//      （53 号票）、待我处理里属于这个项目的事项：用记忆模块的改写函数表（memory/rewriters.ts）按事件类型字段级改写，原话换成删除标记，
//      状态不变；改写过的卡片追加一个改写后的新版本（开着的页面据此换掉手里的卡）；
//    - 项目之外读过这个项目的调用（66 号票，outside-reads.ts）：秘书会话里的、跨项目任务自己的维护者和评审子 agent 的——完整内容、
//      效果日志、执行记录、会话里的工具调用记录，照彻底删除的口径字段级改写（调用本身、工具名、结局留着；据此说过的话不改），
//      这些会话（秘书、跨项目任务的维护者）另追加 messages_purged（前端换掉手里的工具调用记录，agent 据此改写会话文件里这几次
//      调用的参数和返回）；
//    - 素材库里这个项目的内部任务由系统记下的记录（66 号票）：照彻底删除的口径删（记忆命令 + 改写原始事件）；
// 3. 最后删项目档案和会话区里维护者的会话文件（项目已经删了，不再回头）。
// 用户本人说过的话（维护者会话里的发言、投喂的材料、记忆命令）作为素材保留（原文副本，ADR-0006），维护者会话也不追加
// messages_purged（整条换成了标记，会话文件整个删掉）。
import {
  type CardDismissedEventPayload,
  type CardEventPayload,
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  inboxItemProjectId,
  isInternalTo,
  type ProjectInternal,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
  type InboxItemEventPayload,
  interruptedNoticeData,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type Project,
  type ScopeRecordEventPayload,
  type ToolCallDetail,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import { purgedInboxItem } from "../inbox/inbox.ts";
import { listInboxItems } from "../inbox/views.ts";
import { deletedMarker, type PurgeContext } from "../events/purge.ts";
import { effectCallOf, effectEventsOfCall, legacyEffectEventAfter, toolCallRecordsOf } from "../guard-runtime/effect-log.ts";
import { type ApprovalDecidedPayload, type ApprovalRequestedPayload, type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { executionEventsOfAgent } from "../guard-runtime/executions.ts";
import { detailEventsOfProject } from "../guard-runtime/tool-call-details.ts";
import type { Material } from "../materials/index.ts";
import { deletionEvents } from "../memory/deletion.ts";
import { executionTraces, messagesPurgedEvents } from "../memory/purge.ts";
import type { PurgeRewriters } from "../memory/rewriters.ts";
import { purgedJobPayload } from "../scheduled-jobs/purge.ts";
import { purgedWorkOrder } from "../work-orders/purge.ts";
import { workOrderInternal } from "../work-orders/views.ts";
import { SUB_AGENTS_CHANNEL } from "../sub-agents/events.ts";
import { purgedParallelPayload } from "../sub-agents/material-source.ts";
import { TASKS_CHANNEL } from "../tasks/events.ts";
import { purgedTask } from "../tasks/material-sources.ts";
import { listTasks } from "../tasks/views.ts";
import { CHARTER_EVENTS, CHARTERS_CHANNEL, type CharterSubmittedPayload } from "./events.ts";
import { outsideReadsOf } from "./outside-reads.ts";
import { type ProjectRecordsPaths, removeProjectRecords } from "./records.ts";
import { getProjectRow } from "./views.ts";

/** 删除时要停、要恢复的项目维护者（项目维护者模块，在 daemon.ts 里接上） */
export interface MaintainerSuspension {
  /** 停掉这个维护者：马上不再接输入，之后来的输入也不唤起它；子进程结束后兑现 */
  suspend(maintainerId: string): Promise<void>;
  /** 恢复成能唤起（删除中止时）：有输入等着就唤起 */
  resume(maintainerId: string): void;
  /** 删掉它在会话区里的会话文件（项目已删除、子进程已结束之后） */
  removeSession(maintainerId: string): void;
}

export interface ProjectDeletionDeps {
  store: EventStore;
  cards: CardService;
  rewriters: PurgeRewriters;
  maintainers: MaintainerSuspension;
  records: (projectId: string) => ProjectRecordsPaths;
  /** 项目列表频道上那条 deleted 事件 */
  deletedEvent: (project: Project) => NewEvent;
  /**
   * 素材库里这个项目的内部任务由系统记下的记录（66 号票：结局、计划和审批的决定、验收、提问卡的回答、建议卡被关掉……；
   * 用户本人说过的话不在里面，memory/internal-records.ts）：随项目彻底删除。不给就不删素材
   */
  internalRecords?: (projectId: string) => readonly Material[];
  now: () => string;
  log: (line: string) => void;
}

/** 删除一个已归档的项目（确认删除之后）：中止了、或者项目已经不在已归档，什么都不删 */
export async function deleteProject(deps: ProjectDeletionDeps, projectId: string): Promise<void> {
  const { store, maintainers, log } = deps;
  const archived = () => {
    const row = getProjectRow(store.reader, projectId);
    return row && !row.deleted && row.project.state === "archived" ? row.project : undefined;
  };
  const project = archived();
  if (!project) {
    log(`项目 ${projectId} 已经不在已归档（或者已经删了），没有删`);
    return;
  }
  // 1. 先停维护者
  await maintainers.suspend(project.maintainerId);
  // 2. 复查：期间取消了归档就整个中止
  const current = archived();
  if (!current) {
    maintainers.resume(project.maintainerId);
    log(`删除项目 ${projectId}「${project.name}」中止了：停维护者的时候项目已经不在已归档，什么都没删`);
    return;
  }
  const plan = deletionPlan(deps, current);
  store.appendBatch([deps.deletedEvent(current), ...plan.events], { purge: plan.purge });
  // 3. 项目已经删了：再删项目档案和会话文件
  if (getProjectRow(store.reader, projectId)?.deleted !== true) return;
  removeProjectRecords(deps.records(projectId));
  maintainers.removeSession(current.maintainerId);
  log(`删除了项目 ${projectId}「${current.name}」：项目档案、维护者会话和立项书正文（用户的话在素材的原文副本里）`);
}

/** 还没被改写成"已删除"标记的 */
const live = (events: readonly StoredEvent[]) => events.filter((e) => !isDeletedEventPayload(e.payload));

/** 卡片事件说的是哪张卡（卡片本身、关掉和长期没处理的记录） */
const cardIdOf = (event: StoredEvent): string | undefined =>
  event.type === EVENT_TYPES.card ? (event.payload as CardEventPayload).card.id : (event.payload as Partial<CardDismissedEventPayload>).cardId;

/**
 * 项目内部的东西（64 号票）随项目一起删掉——带着这个项目的标记（isInternalTo），或者属于它的内部任务：
 * - 内部任务：看板频道上它们的每条事件，任务的文字换成删除标记（tasks 模块的 purgedTask，行留着，新任务的编号接着往下排）；
 *   没结束的（能删的项目没有在做、排队的工单，只会是还没派工单的规划中、计划等确认的）同一事务取消（用户确认了删除项目）；
 * - tasks 频道上它们的任务书、计划、计划的决定……：整条换成"已删除"标记；
 * - sub_agents 频道上它们的并行提议和决定：文字换成删除标记（任务名、为什么并行、子 agent 的工作说明……）；
 * - 它们计划里的定时作业：看板频道上作业的每条事件，文字换成删除标记（作业名、每次做什么、建它的任务名……，行留着）；
 * - 它们的工单、作业每次运行的工单：内容连标题、任务名、原因一起换成删除标记；
 * - 卡片：负载里记着它们的任务编号的（计划卡、计划变更卡、并行确认卡、提问卡……）、项目的维护者给的还没点的建议卡（负载带着标记）、
 *   项目内部的事项的卡（起草段的审批卡这类负载里没有任务编号的）：每个版本换成"已删除"标记；
 * - 待我处理里项目内部的事项（建的时候标上的）和这些卡片的事项：itemIds，由调用方交给通用的事项改写（inboxItemPurge：来源里的
 *   任务名也去掉），再追加一版删掉的（不会一直卡着）。
 */
function internalDeletion(store: EventStore, project: Project, deletedAt: string) {
  const ids = new Set(
    listTasks(store.reader)
      .filter((t) => isInternalTo(t, project.id))
      .map((t) => t.id),
  );
  const purge: PurgeRewrite[] = [];
  const events: NewEvent[] = [];
  const mineTask = (taskId: unknown) => typeof taskId === "string" && ids.has(taskId);
  // 任务
  for (const event of live(store.read(CHANNELS.board, 0, EVENT_TYPES.task))) {
    const p = event.payload as TaskEventPayload;
    if (ids.has(p.task.id)) purge.push({ globalSeq: event.globalSeq, payload: { ...p, task: purgedTask(p.task) } satisfies TaskEventPayload });
  }
  for (const event of live(store.read(TASKS_CHANNEL))) {
    if (mineTask((event.payload as { taskId?: unknown }).taskId)) purge.push({ globalSeq: event.globalSeq, payload: deletedMarker(event, deletedAt) });
  }
  for (const task of listTasks(store.reader)) {
    if (!ids.has(task.id) || ENDED_TASK_STATES.includes(task.state)) continue;
    const payload: TaskEventPayload = { task: { ...purgedTask(task), state: "cancelled", updatedAt: deletedAt }, change: "cancelled", from: task.state, by: "user" };
    events.push({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload });
  }
  // 子 agent 并行的提议和决定
  for (const event of live(store.read(SUB_AGENTS_CHANNEL))) {
    if (!mineTask((event.payload as { taskId?: unknown }).taskId)) continue;
    const purged = purgedParallelPayload(event.type, event.payload);
    if (purged) purge.push({ globalSeq: event.globalSeq, payload: purged });
  }
  // 定时作业
  for (const event of live(store.read(CHANNELS.board, 0, EVENT_TYPES.scheduledJob))) {
    const p = event.payload as ScheduledJobEventPayload;
    if (isInternalTo(p.job, project.id) || ids.has(p.job.taskId)) purge.push({ globalSeq: event.globalSeq, payload: purgedJobPayload(p) });
  }
  // 工单（内部任务的、作业的运行）：内容连标题、任务名、原因一起换掉（不再走下面通用的工单改写）
  const workOrderSeqs = new Set<number>();
  for (const event of live(store.read(CHANNELS.projects, 0, EVENT_TYPES.workOrder))) {
    const p = event.payload as WorkOrderEventPayload;
    if (p.workOrder.projectId !== project.id || !isInternalTo({ internal: workOrderInternal(store.reader, p.workOrder) }, project.id)) continue;
    workOrderSeqs.add(event.globalSeq);
    purge.push({ globalSeq: event.globalSeq, payload: { ...p, workOrder: purgedWorkOrder(p.workOrder, true) } satisfies WorkOrderEventPayload });
  }
  // 卡片和待我处理的事项
  const cardIds = new Set<string>();
  for (const event of live(store.read(CHANNELS.cards, 0, EVENT_TYPES.card))) {
    const { card } = event.payload as CardEventPayload;
    const payload = card.payload as { taskId?: unknown; internal?: ProjectInternal } | undefined;
    if (mineTask(payload?.taskId) || isInternalTo(payload, project.id)) cardIds.add(card.id);
  }
  const itemIds = new Set<string>();
  for (const event of live(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
    const { item } = event.payload as InboxItemEventPayload;
    const data = item.kind === "notice" ? (item.data as { taskId?: unknown } | undefined) : undefined;
    if (!isInternalTo(item, project.id) && !(item.cardId !== undefined && cardIds.has(item.cardId)) && !mineTask(data?.taskId)) continue;
    itemIds.add(item.id);
    if (item.cardId !== undefined) cardIds.add(item.cardId);
  }
  for (const event of live(store.read(CHANNELS.cards))) {
    const cardId = cardIdOf(event);
    if (cardId !== undefined && cardIds.has(cardId)) purge.push({ globalSeq: event.globalSeq, payload: deletedMarker(event, deletedAt) });
  }
  return { cardIds, itemIds, workOrderSeqs, purge, events };
}

/** 属于这个项目的事件改写成什么，同一事务追加的卡片新版本 */
function deletionPlan(deps: ProjectDeletionDeps, project: Project): { purge: PurgeRewrite[]; events: NewEvent[] } {
  const { store, cards, rewriters } = deps;
  // 照彻底删除的口径改写，完整内容注明"已随项目删除"（66 号票）
  const context: PurgeContext = { deletedAt: deps.now(), materialIds: new Set(), purgedBy: "project_deletion" };

  // 维护者会话：整条换成"已删除"标记
  const purge: PurgeRewrite[] = live(store.read(maintainerChannel(project.maintainerId))).map((event) => ({ globalSeq: event.globalSeq, payload: deletedMarker(event, context.deletedAt) }));
  // 项目内部的东西（64 号票）：一起删掉
  const internal = internalDeletion(store, project, context.deletedAt);
  purge.push(...internal.purge);

  const targets = new Map<number, StoredEvent>();
  const target = (event: StoredEvent) => targets.set(event.globalSeq, event);
  const cardIds = new Set<string>();

  // 立项书：交出的每一版、确认，以及立项书卡
  for (const event of live(store.read(CHARTERS_CHANNEL))) {
    if ((event.payload as { projectId?: string }).projectId !== project.id) continue;
    target(event);
    if (event.type === CHARTER_EVENTS.submitted) cardIds.add((event.payload as CharterSubmittedPayload).cardId);
  }
  // 这个维护者的审批（请求、审批卡、决定）和效果日志
  const approvalIds = new Set<string>();
  for (const event of live(store.read(GUARD_CHANNEL))) {
    if (event.type === GUARD_EVENTS.approvalRequested) {
      const { approval } = event.payload as ApprovalRequestedPayload;
      if (approval.origin.agentId !== project.maintainerId) continue;
      target(event);
      approvalIds.add(approval.approvalId);
      cardIds.add(approval.cardId);
    } else if (event.type === GUARD_EVENTS.approvalDecided) {
      if (approvalIds.has((event.payload as ApprovalDecidedPayload).approvalId)) target(event);
    } else if (event.type === GUARD_EVENTS.effectRecorded) {
      const { records } = event.payload as EffectRecordedPayload;
      if (records.length > 0 && records.every((r) => r.agentId === project.maintainerId)) target(event);
    }
  }
  // 维护者有副作用的调用的执行记录（调用摘要、结果摘要，23 号票）；它对话里被中断的"中断不确定"事项在下面的待我处理里
  for (const event of live(executionEventsOfAgent(store, project.maintainerId))) target(event);
  // 调用另存的完整参数和返回（53 号票）：维护者会话里的（含子 agent 的）、维护者自己的、归属这个项目的（评审子 agent 的）
  const ofProject = { maintainerConversation: maintainerChannel(project.maintainerId), maintainerId: project.maintainerId, projectId: project.id };
  // 这些调用的效果日志：子 agent、评审子 agent 的不在维护者名下，按调用找——记了调用 id 的（56 号票起）按调用 id 和 agent，
  // 旧的按紧跟在完整内容后面；维护者自己的上面按 agent 找过了
  for (const event of live(detailEventsOfProject(store, ofProject))) {
    target(event);
    for (const effect of live(effectEventsOfCall(store, effectCallOf(event.payload as ToolCallDetail), [event]))) target(effect);
  }
  // 没有完整内容的更早的调用（53 号票之前）：维护者会话里子 agent 的工具调用记录后面紧跟着的旧效果日志
  for (const event of live(store.read(ofProject.maintainerConversation, 0, EVENT_TYPES.message))) {
    const p = event.payload as MessageEventPayload;
    for (const part of p.message.parts) {
      if (part.type !== "tool_call") continue;
      const call = { callId: part.callId, tool: part.tool, agentId: p.agentId ?? project.maintainerId, conversation: event.channel };
      const effect = legacyEffectEventAfter(store, event, call);
      if (effect) target(effect);
    }
  }
  // 项目之外读过这个项目的调用（66 号票）：秘书会话里的、跨项目任务自己的维护者和评审子 agent 的。连同效果日志（按调用 id 和
  // agent、旧的按紧跟着）、执行记录和同一段调用摘要出现的别处（只认这个 agent 的）、会话里的工具调用记录；在会话里的这几次调用
  // 会话文件也要改（下面的 messages_purged）
  const outsideCalls = new Map<string, Set<string>>();
  for (const event of outsideReadsOf(store, project, deps.records(project.id))) {
    const detail = event.payload as ToolCallDetail;
    const call = effectCallOf(detail);
    target(event);
    for (const effect of live(effectEventsOfCall(store, call, [event]))) target(effect);
    for (const trace of live(executionTraces(store, detail.callId, detail.agentId))) target(trace);
    if (detail.conversation === null) continue;
    for (const record of toolCallRecordsOf(store, call)) target(record);
    outsideCalls.set(detail.conversation, (outsideCalls.get(detail.conversation) ?? new Set()).add(detail.callId));
  }
  // 这些卡片的每个版本、关掉和长期没处理的记录；项目内部的卡片（64 号票）上面整条换成了"已删除"标记，不再按字段改写
  for (const cardId of internal.cardIds) cardIds.delete(cardId);
  for (const event of live(store.read(CHANNELS.cards))) {
    const cardId = cardIdOf(event);
    if (cardId !== undefined && cardIds.has(cardId)) target(event);
  }
  // 这个项目的工单（16 号票）：工单的内容（任务书、打回意见）
  for (const event of live(store.read(CHANNELS.projects, 0, EVENT_TYPES.workOrder))) {
    if ((event.payload as WorkOrderEventPayload).workOrder.projectId === project.id && !internal.workOrderSeqs.has(event.globalSeq)) target(event);
  }
  // 这个项目的范围记录（18 号票）：摘要、说明、依据可能引着用户的原话
  for (const event of live(store.read(CHANNELS.projects, 0, EVENT_TYPES.scopeRecord))) {
    if ((event.payload as ScopeRecordEventPayload).record.projectId === project.id) target(event);
  }
  // 待我处理里属于这个项目的事项：删除的二次确认、这些卡片的事项、越界通知（数据里有项目编号）、项目内部的事项（64 号票）
  for (const event of live(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
    const { item } = event.payload as InboxItemEventPayload;
    if (
      internal.itemIds.has(item.id) ||
      inboxItemProjectId(item) === project.id ||
      (item.kind === "card" && cardIds.has(item.cardId)) ||
      interruptedNoticeData(item)?.agentId === project.maintainerId
    ) {
      target(event);
    }
  }

  const rewritten = [...targets.values()].toSorted((a, b) => a.globalSeq - b.globalSeq).map((event) => ({ event, payload: rewriters.rewrite(event, context) }));
  purge.push(...rewritten.map(({ event, payload }) => ({ globalSeq: event.globalSeq, payload })));

  // 项目之外的会话（秘书、跨项目任务的维护者）里改写了的消息：追加 messages_purged（66 号票）；项目内部任务：没结束的取消；
  // 改写过的卡片：追加改写后的新版本；项目内部的事项：删掉（不会一直卡着）
  const events: NewEvent[] = [...messagesPurgedEvents(rewritten.filter(({ event }) => outsideCalls.has(event.channel)), outsideCalls, context), ...internal.events];
  for (const item of listInboxItems(store.reader)) {
    if (internal.itemIds.has(item.id)) events.push({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...purgedInboxItem(item), deleted: true, version: item.version + 1 } } satisfies InboxItemEventPayload });
  }
  for (const cardId of cardIds) {
    const latest = cards.get(cardId);
    if (!latest) continue;
    const purged = cards.purged(latest, context);
    events.push(cards.buildUpdate(cardId, { payload: purged.payload, ...(purged.outcome === undefined ? {} : { outcome: purged.outcome }) }).event);
  }

  // 素材库里这个项目的内部任务由系统记下的记录（66 号票，用户 2026-10-10 定）：照彻底删除的口径删——同一事务记一条彻底删除的
  // 记忆命令（出处是删除项目，素材模块据此删掉素材、索引，记下墓碑，重建时不回来），改写它们的原始事件和带原话的记录。
  // 上面已经改写了的事件按上面的（skip：不再改第二遍，大多数原始事件——任务、计划的决定、卡片——上面已经整条换成了标记）；
  // 彻底删除连带追加的事件里，删除项目已经管了的不要：维护者会话上的（整条换成了标记、会话文件整个删掉）、删掉或另追加
  // 新版本的卡片、这个项目的范围记录的新版本
  const records = deps.internalRecords?.(project.id) ?? [];
  if (records.length > 0) {
    const purged = deletionEvents(
      { store, cards, rewriters, now: () => context.deletedAt },
      { mode: "purge", materials: records, from: { kind: "project_deletion", projectId: project.id }, skip: new Set(purge.map((p) => p.globalSeq)) },
    );
    purge.push(...purged.purge);
    const handled = (event: NewEvent) =>
      event.channel === maintainerChannel(project.maintainerId) ||
      (event.type === EVENT_TYPES.card && (internal.cardIds.has((event.payload as CardEventPayload).card.id) || cardIds.has((event.payload as CardEventPayload).card.id))) ||
      (event.type === EVENT_TYPES.scopeRecord && (event.payload as ScopeRecordEventPayload).record.projectId === project.id);
    events.push(...purged.events.filter((event) => !handled(event)));
  }
  return { purge, events };
}
