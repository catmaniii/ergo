// 删除项目（规格第 11 节，ADR-0010）：用户在待我处理里的二次确认上选了"确认删除"之后，按这个顺序做：
// 1. 先停维护者（马上不再接输入，之后来的输入也不唤起它），等它的子进程结束（内存里的原文随之没了）；
// 2. 复查：停下来的这段时间里用户取消了归档（或者项目已经不在了）就整个中止，什么都不删，维护者恢复成能唤起；
//    没变就在同一个事务里追加项目的 deleted，并改写属于这个项目的事件：
//    - 维护者会话频道上的事件全部换成"已删除"标记（和彻底删除同一个口子，ADR-0008）；
//    - 立项书正文（charters 频道的事件、立项书卡的每个版本）、这个维护者的审批（审批请求、审批卡、审批决定）和效果日志、
//      这个项目的工单的内容（16 号票）、范围记录的摘要和说明（18 号票）、维护者会话里和属于项目的工具调用另存的完整参数和返回
//      （53 号票）、待我处理里属于这个项目的事项：用记忆模块的改写函数表（memory/rewriters.ts）按事件类型字段级改写，原话换成删除标记，
//      状态不变；改写过的卡片追加一个改写后的新版本（开着的页面据此换掉手里的卡）；
// 3. 最后删项目档案和会话区里维护者的会话文件（项目已经删了，不再回头）。
// 用户在维护者会话里说过的话作为素材保留（原文副本，ADR-0006）：这里不碰素材库，也不追加 messages_purged。
import {
  type CardDismissedEventPayload,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  inboxItemProjectId,
  type InboxItemEventPayload,
  interruptedNoticeData,
  isDeletedEventPayload,
  maintainerChannel,
  type Project,
  type ScopeRecordEventPayload,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import { deletedMarker, type PurgeContext } from "../events/purge.ts";
import { type ApprovalDecidedPayload, type ApprovalRequestedPayload, type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { executionEventsOfAgent } from "../guard-runtime/executions.ts";
import { detailEventsOfProject } from "../guard-runtime/tool-call-details.ts";
import type { PurgeRewriters } from "../memory/rewriters.ts";
import { CHARTER_EVENTS, CHARTERS_CHANNEL, type CharterSubmittedPayload } from "./events.ts";
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

/** 属于这个项目的事件改写成什么，同一事务追加的卡片新版本 */
function deletionPlan(deps: ProjectDeletionDeps, project: Project): { purge: PurgeRewrite[]; events: NewEvent[] } {
  const { store, cards, rewriters } = deps;
  const context: PurgeContext = { deletedAt: deps.now(), materialIds: new Set() };

  // 维护者会话：整条换成"已删除"标记
  const purge: PurgeRewrite[] = live(store.read(maintainerChannel(project.maintainerId))).map((event) => ({ globalSeq: event.globalSeq, payload: deletedMarker(event, context.deletedAt) }));

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
  for (const event of live(detailEventsOfProject(store, ofProject))) target(event);
  // 这些卡片的每个版本、关掉和长期没处理的记录
  for (const event of live(store.read(CHANNELS.cards))) {
    const cardId = event.type === EVENT_TYPES.card ? (event.payload as CardEventPayload).card.id : (event.payload as Partial<CardDismissedEventPayload>).cardId;
    if (cardId !== undefined && cardIds.has(cardId)) target(event);
  }
  // 这个项目的工单（16 号票）：工单的内容（任务书、打回意见）
  for (const event of live(store.read(CHANNELS.projects, 0, EVENT_TYPES.workOrder))) {
    if ((event.payload as WorkOrderEventPayload).workOrder.projectId === project.id) target(event);
  }
  // 这个项目的范围记录（18 号票）：摘要、说明、依据可能引着用户的原话
  for (const event of live(store.read(CHANNELS.projects, 0, EVENT_TYPES.scopeRecord))) {
    if ((event.payload as ScopeRecordEventPayload).record.projectId === project.id) target(event);
  }
  // 待我处理里属于这个项目的事项：删除的二次确认、这些卡片的事项、越界通知（数据里有项目编号）
  for (const event of live(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
    const { item } = event.payload as InboxItemEventPayload;
    if (inboxItemProjectId(item) === project.id || (item.kind === "card" && cardIds.has(item.cardId)) || interruptedNoticeData(item)?.agentId === project.maintainerId) target(event);
  }

  for (const event of [...targets.values()].toSorted((a, b) => a.globalSeq - b.globalSeq)) purge.push({ globalSeq: event.globalSeq, payload: rewriters.rewrite(event, context) });

  // 改写过的卡片：追加改写后的新版本
  const events: NewEvent[] = [];
  for (const cardId of cardIds) {
    const latest = cards.get(cardId);
    if (!latest) continue;
    const purged = cards.purged(latest, context);
    events.push(cards.buildUpdate(cardId, { payload: purged.payload, ...(purged.outcome === undefined ? {} : { outcome: purged.outcome }) }).event);
  }
  return { purge, events };
}
