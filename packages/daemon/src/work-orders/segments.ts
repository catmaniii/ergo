// 项目维护者的会话分段（规格第 11、21 节，16 号票，ADR-0012）。分段本身是事件日志里的状态（维护者会话频道上的 segment 事件），
// 子进程按哪一段拉起由项目维护者模块（projects/maintainers.ts）看这里的当前段决定。
// - 每段一个会话（会话区里这个维护者目录下的一个会话，名字由段指定）：工单段在工单开始时开，对话段在维护者手上没有段时
//   用户直接说话（或者运行时给了它一条不属于任务的通知）时开；第一段对话段接着这个维护者以前的会话（子进程报回接的是哪个）；
// - 一段该结束时（工单的活做完了；对话段闲置退出、有工单在等）转收尾中：进展文档的内容哈希没变、或者维护者没写这一段的摘要，
//   就催它写回；催写回到了次数（第 8 节的催促阈值）还没写回，转为用户拍板：待我处理里一条"卡住求助"，这一段没写回就结束，
//   工单照常结束，项目的队列接着走；写回之后这一段才结束，工单随之结束；
// - 重置维护者：当前这段直接结束（不催写回；写回中途重置的，工单照常算完成），新开一段（没有上一段的摘要）；
//   没写回就结束的段，时间线上记一笔（项目页上工单那一行也写）；
// - 维护者干活时用户发来的话作为插话进当前段；交给它的、属于别的任务的输入留在队里，等那个任务的工单段。
// 每段开头追加一条带工单分隔 part 的消息，前端把各段拼成一条连续的聊天。
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  availableTaskActions,
  CHAT_SEGMENT_TITLE,
  EVENT_TYPES,
  type MaintainerSegment,
  maintainerChannel,
  type MessageEventPayload,
  type Project,
  RESET_SEGMENT_TITLE,
  WORK_ORDER_SOURCE_LABEL,
  type WorkOrder,
  type WorkOrderOutcome,
  WRITE_BACK_HELP_ACK,
  type WriteBackGap,
} from "@ergou/protocol";
import { type QueuedAgentInput, queuedAgentInput } from "../conversation/agent-session.ts";
import { buildAgentNotice, buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { ProjectService } from "../projects/projects.ts";
import { taskMessageScope } from "../tasks/stages.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { endedEvent, segmentEvent } from "./events.ts";
import { escalatedNote, isDraftingSegment, nudgeText, unwrittenRecord, writeBackHelp, writeBackMissing } from "./texts.ts";
import { closingSegments, currentSegment, getWorkOrder, segmentOpenedSeq, segmentsOf } from "./views.ts";

/** 进展文档的内容哈希（没有这个文件时是固定的一串） */
export function fileHash(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/** 催写回的通知的幂等键（第几次）：催过几次从事件日志里数，守护进程重启后照样接着数 */
const nudgeKey = (segmentId: string, n: number) => `segment-nudge:${segmentId}:${n}`;

export interface SegmentsOptions {
  store: EventStore;
  tasks: TaskService;
  projects: ProjectService;
  inbox: InboxService;
  /** 一段收尾时最多催几次写回（同第 8 节的催促阈值） */
  nudges: number;
  now: () => string;
  /** 一段结束了（工单随之结束）：派单器看下一张 */
  onClosed: (maintainerId: string) => void;
}

export interface Segments {
  /** 恢复：守护进程重启前在收尾的段接着收尾 */
  start(): void;
  /** 维护者手上的那一段（进行中或收尾中） */
  current(maintainerId: string): MaintainerSegment | undefined;
  /** 上一段（已结束的最后一段） */
  previous(maintainerId: string): MaintainerSegment | undefined;
  /** 维护者手上这一段的工单（工单段的；对话段、没有段时没有） */
  currentWorkOrder(maintainerId: string): WorkOrder | undefined;
  /** 维护者会话里一条消息的归属：项目；属于任务的还有任务和当时的阶段 */
  scopeIn(where: { projectId: string; taskId?: string | undefined }): MessageScope;
  /** 维护者会话里的消息现在属于哪个项目、哪个任务（当前这一段的） */
  scopeOf(maintainerId: string): MessageScope | undefined;
  /** 开一段：段的事件和会话里的分隔线（同一事务，不追加） */
  open(project: Project, input: { workOrder?: WorkOrder; reset?: boolean; key?: string }): { segment: MaintainerSegment; events: NewEvent[] };
  /** 一段该结束了：转收尾中（工单段记下工单要以什么结局结束），再看能不能结束 */
  requestClose(segment: MaintainerSegment, outcome?: WorkOrderOutcome, reason?: string): void;
  /** 维护者这一轮结束了：收尾中的段看看写回了没有 */
  turnEnded(maintainerId: string): void;
  /** 维护者现在处理不处理这条输入（属于当前这一段的才处理；别的留在队里） */
  accepts(maintainerId: string, input: QueuedAgentInput): boolean;
  /** 会话里来了交给维护者的、不属于任务的输入，又没有在进行的段：开一个对话段 */
  inputArrived(maintainerId: string, payload: MessageEventPayload): void;
  /** 用户往维护者会话里发话之前：手上没有在进行的段就开一个对话段（分隔线排在用户这句话之前，同一事务） */
  messagePrelude(maintainerId: string, key: string): NewEvent[];
  /** 维护者闲置退出了：对话段该结束了 */
  idleExited(maintainerId: string): void;
  /** 维护者写（或改）这一段的摘要 */
  writeSummary(maintainerId: string, summary: string): MaintainerSegment;
  /** 子进程报回它接的是哪个会话：和这一段记着的不一样（第一段对话段接着以前的会话）就记下 */
  recordSession(maintainerId: string, segmentId: string, session: string): void;
  /** 重置维护者：当前这段直接结束，新开一段，只凭项目档案；返回新的一段 */
  reset(project: Project, key: string): { segmentId: string };
}

export function createSegments(options: SegmentsOptions): Segments {
  const { store, tasks, projects, inbox, now } = options;
  /** 这一轮同步代码里已经编好、还没追加的段号（同一事务里开几段时不撞号） */
  const issued = new Map<string, number>();

  const current = (maintainerId: string) => currentSegment(store.reader, maintainerId);
  const workOrderOf = (segment: MaintainerSegment | undefined): WorkOrder | undefined =>
    segment?.workOrderId === undefined ? undefined : getWorkOrder(store.reader, segment.workOrderId);

  const scopeIn = (where: { projectId: string; taskId?: string | undefined }): MessageScope => {
    if (where.taskId === undefined) return { projectId: where.projectId };
    const task = tasks.get(where.taskId);
    // "当前阶段"只在 taskMessageScope 一处算（25 号票）
    return { ...(task ? taskMessageScope(task) : { taskId: where.taskId }), projectId: where.projectId };
  };

  const nextSegmentId = (maintainerId: string) => {
    const n = Math.max(issued.get(maintainerId) ?? 0, segmentsOf(store.reader, maintainerId).length) + 1;
    issued.set(maintainerId, n);
    return { segmentId: `${maintainerId}-s${n}`, first: n === 1 };
  };

  const progressHash = (projectId: string) => fileHash(projects.records(projectId).progress);

  const open = (project: Project, input: { workOrder?: WorkOrder; reset?: boolean; key?: string }): { segment: MaintainerSegment; events: NewEvent[] } => {
    const maintainerId = project.maintainerId;
    const { segmentId, first } = nextSegmentId(maintainerId);
    const wo = input.workOrder;
    const segment: MaintainerSegment = {
      segmentId,
      maintainerId,
      projectId: project.id,
      kind: wo ? "work_order" : "chat",
      ...(wo ? { workOrderId: wo.id, taskId: wo.taskId } : {}),
      session: segmentId,
      // 第一段对话段：还没有这个会话时接着以前的会话（任务转为项目、16 号票之前的立项问答），之后每段一个新的；
      // 重置开的段只凭项目档案，不接
      ...(!wo && first && !input.reset ? { continueEarlier: true } : {}),
      reset: input.reset === true,
      state: "open",
      progressHash: progressHash(project.id),
      openedAt: now(),
    };
    const title = input.reset ? RESET_SEGMENT_TITLE : wo ? wo.title : CHAT_SEGMENT_TITLE;
    const divider = buildMessage(
      { conversation: maintainerChannel(maintainerId), speaker: "system", parts: [{ type: "work_order_divider", workOrderId: wo?.id ?? "", title, from: wo ? WORK_ORDER_SOURCE_LABEL[wo.source] : "你" }] },
      { ...scopeIn(segment), ...(input.key ? { idempotencyKey: `${input.key}#divider` } : {}) },
    );
    return { segment, events: [segmentEvent(segment, "opened", input.key ? `${input.key}#segment` : undefined), divider.event] };
  };

  /** 写回了：进展的内容哈希变了、摘要写了 */
  const writtenBack = (segment: MaintainerSegment) => ({ progressChanged: progressHash(segment.projectId) !== segment.progressHash, hasSummary: segment.summary !== undefined });

  /** 没写回就结束的段：时间线上记一笔 */
  const unwrittenEvent = (segment: MaintainerSegment, gap: WriteBackGap): NewEvent => {
    const record = unwrittenRecord(segment, gap);
    return buildTimelineRecord(
      maintainerChannel(segment.maintainerId),
      { kind: "write_back_missing", ...record, ...(segment.workOrderId === undefined ? {} : { workOrderId: segment.workOrderId }) },
      scopeIn(segment),
    ).event;
  };

  /** 这一段结束（工单随之结束；没写回的如实记下），派单器看下一张 */
  const close = (segment: MaintainerSegment, opts: { unwritten?: WriteBackGap; extra?: NewEvent[] } = {}) => {
    const time = now();
    const events: NewEvent[] = [segmentEvent({ ...segment, state: "closed", closedAt: time, ...(opts.unwritten ? { unwritten: opts.unwritten } : {}) }, "closed")];
    const wo = workOrderOf(segment);
    if (wo && wo.state !== "ended") events.push(endedEvent(wo, time, segment.outcome ?? "done", { reason: segment.reason, unwritten: opts.unwritten }));
    if (opts.unwritten) events.push(unwrittenEvent(segment, opts.unwritten));
    store.appendBatch([...events, ...(opts.extra ?? [])]);
    options.onClosed(segment.maintainerId);
  };

  /** 维护者在这一段里开始处理过输入（这一段开了之后有 turn_start）：一条都没处理过的段没有要写回的 */
  const worked = (segment: MaintainerSegment) => {
    const opened = segmentOpenedSeq(store.reader, segment.segmentId);
    return opened !== undefined && store.read(maintainerChannel(segment.maintainerId), opened, EVENT_TYPES.turnStart).length > 0;
  };

  /** 维护者还在处理这一段的输入（手头有一条，或者还有这一段要处理的排着） */
  const busy = (segment: MaintainerSegment) => {
    const conversation = maintainerChannel(segment.maintainerId);
    if (startedInputs(store.reader, conversation).length > 0) return true;
    return pendingInputs(store.reader, conversation).some((q) => accepts(segment.maintainerId, queuedAgentInput(store, q)));
  };

  /** 这一段催过几次写回 */
  const nudgesSent = (segmentId: string) => {
    let n = 0;
    while (store.eventByIdempotencyKey(nudgeKey(segmentId, n + 1))) n += 1;
    return n;
  };

  /** 催一次写回（这一段的工单是起草计划的，说法照只读的那一套：进展经 write_progress 写回） */
  const nudge = (segment: MaintainerSegment, missing: readonly string[], n: number) => {
    const text = nudgeText(segment, missing, isDraftingSegment(segment, workOrderOf(segment)));
    store.append(buildAgentNotice(maintainerChannel(segment.maintainerId), text, nudgeKey(segment.segmentId, n), scopeIn(segment)).event);
  };

  /**
   * 催写回到了次数还没写回：转为用户拍板。待我处理里一条"卡住求助"，会话里一条说明，这一段没写回就结束，工单照常结束，
   * 项目的队列接着走。工单段收尾时它的任务已经离开了执行中（计划交了是待确认，执行的是已完成、失败或取消了），任务的状态不再改
   */
  const escalate = (segment: MaintainerSegment, missing: readonly string[]) => {
    const project = projects.get(segment.projectId);
    if (!project) return close(segment, { unwritten: "nudged" });
    const wo = workOrderOf(segment);
    const help = writeBackHelp(project, wo, missing);
    const item = inbox.buildAdd({
      kind: "notice",
      notice: "stuck_help",
      title: help.title,
      body: help.body,
      source: `项目「${project.name}」`,
      urgency: "non_blocking",
      actions: [WRITE_BACK_HELP_ACK],
      // 不记任务编号：任务"卡住求助"的那一套（用户回话即恢复执行）按 taskId 认事项，这条不是那种
      data: { projectId: project.id, maintainerId: segment.maintainerId, segmentId: segment.segmentId, ...(wo ? { workOrderId: wo.id } : {}) },
    });
    const note = buildMessage({ conversation: maintainerChannel(segment.maintainerId), speaker: "system", parts: [{ type: "text", text: escalatedNote(segment, options.nudges) }] }, scopeIn(segment));
    close(segment, { unwritten: "nudged", extra: [note.event, item.event] });
    inbox.alert(item.item);
  };

  /** 收尾中的段：写回了就结束（工单随之结束），没写回就催，催到了次数转为用户拍板；维护者还在干活就等它这一轮结束 */
  const checkClosing = (segment: MaintainerSegment) => {
    const latest = current(segment.maintainerId);
    if (!latest || latest.segmentId !== segment.segmentId || latest.state !== "closing") return;
    if (busy(latest)) return;
    // 一条输入都没处理过的段（刚重置、刚开就该结束了）：没有要写回的
    if (!worked(latest)) return close(latest);
    const { progressChanged, hasSummary } = writtenBack(latest);
    // 18 号票的范围审视加在这里：写回检查通过之后、这一段结束（工单结束）之前，维护者的子进程还活着。
    // 审视的结果（范围变更、越界）用 conversation/messages.ts 的 buildTimelineRecord 追加到维护者会话，
    // 带上 workOrderId（工单段的）和 scopeIn(latest) 给的归属，放进 close 的 extra，和这一段、工单的结束同一事务
    if (progressChanged && hasSummary) return close(latest);
    const missing = writeBackMissing(progressChanged, hasSummary);
    const sent = nudgesSent(latest.segmentId);
    if (sent >= options.nudges) return escalate(latest, missing);
    nudge(latest, missing, sent + 1);
  };

  const requestClose = (segment: MaintainerSegment, outcome?: WorkOrderOutcome, reason?: string) => {
    if (segment.state !== "open") return;
    const closing: MaintainerSegment = { ...segment, state: "closing", ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}) };
    store.append(segmentEvent(closing, "closing"));
    checkClosing(closing);
  };

  const accepts = (maintainerId: string, input: QueuedAgentInput): boolean => {
    const segment = current(maintainerId);
    if (!segment) return false;
    // 用户直接说的话总是作为插话进当前这一段
    if (input.payload.message.speaker === "user") return true;
    const taskId = input.payload.taskId;
    if (taskId === undefined) return true;
    // 运行时交给它的、属于某个任务的：只在做这个任务的工单段里处理（别的任务的留在队里，等它的工单）
    if (segment.kind !== "work_order" || segment.taskId !== taskId) return false;
    // 收尾中：催写回之类的照常处理（任务这时可能已经结束了）
    if (segment.state === "closing") return true;
    const task = tasks.get(taskId);
    return task !== undefined && availableTaskActions(task, "maintainer").includes("work");
  };

  return {
    start() {
      for (const segment of closingSegments(store.reader)) checkClosing(segment);
    },
    current,
    previous: (maintainerId) => segmentsOf(store.reader, maintainerId).findLast((s) => s.state === "closed"),
    currentWorkOrder: (maintainerId) => workOrderOf(current(maintainerId)),
    scopeIn,
    scopeOf(maintainerId) {
      const segment = current(maintainerId);
      if (segment) return scopeIn(segment);
      const project = projects.maintainedBy(maintainerId);
      return project && { projectId: project.id };
    },
    open,
    requestClose,
    turnEnded(maintainerId) {
      const segment = current(maintainerId);
      if (segment?.state === "closing") checkClosing(segment);
    },
    accepts,
    inputArrived(maintainerId, payload) {
      if (payload.taskId !== undefined || (payload.message.speaker !== "user" && payload.agentInput !== true)) return;
      if (current(maintainerId)) return;
      const project = projects.maintainedBy(maintainerId);
      if (!project || project.state === "archived") return;
      store.appendBatch(open(project, {}).events);
    },
    messagePrelude(maintainerId, key) {
      if (current(maintainerId)) return [];
      const project = projects.maintainedBy(maintainerId);
      return project ? open(project, { key }).events : [];
    },
    idleExited(maintainerId) {
      const segment = current(maintainerId);
      if (segment?.kind === "chat" && segment.state === "open") requestClose(segment);
    },
    writeSummary(maintainerId, summary) {
      const text = summary.trim();
      if (!text) throw new RequestRejected("bad_params", "摘要是空的：写这一段做了什么、定了什么、下一步是什么");
      const segment = current(maintainerId);
      if (!segment) throw new RequestRejected("not_allowed", "现在没有在进行的会话段");
      const next: MaintainerSegment = { ...segment, summary: text };
      store.append(segmentEvent(next, "summary"));
      return next;
    },
    recordSession(maintainerId, segmentId, session) {
      const segment = current(maintainerId);
      if (segment?.segmentId !== segmentId || segment.session === session) return;
      store.append(segmentEvent({ ...segment, session }, "session"));
    },
    reset(project, key) {
      // 同一个幂等键重发：不再重置一次
      const done = store.eventByIdempotencyKey(`${key}#segment`);
      if (done) return { segmentId: (done.payload as { segment: MaintainerSegment }).segment.segmentId };
      const segment = current(project.maintainerId);
      const events: NewEvent[] = [];
      let continueWith: WorkOrder | undefined;
      let ended = false;
      if (segment) {
        const { progressChanged, hasSummary } = writtenBack(segment);
        const handled = worked(segment);
        // 没写回就结束了（处理过输入、进展没变或没写摘要）：如实记下
        const unwritten: WriteBackGap | undefined = handled && !(progressChanged && hasSummary) ? "reset" : undefined;
        const time = now();
        events.push(segmentEvent({ ...segment, state: "closed", closedAt: time, ...(unwritten ? { unwritten } : {}) }, "closed", `${key}#closed`));
        const wo = workOrderOf(segment);
        if (wo && wo.state !== "ended") {
          // 工单还在做：新的一段接着做它；已经在收尾（写回中途重置）的工单照常算完成
          if (segment.state === "open") continueWith = wo;
          else {
            events.push(endedEvent(wo, time, segment.outcome ?? "done", { reason: segment.reason, unwritten }));
            ended = true;
          }
        }
        if (unwritten) events.push(unwrittenEvent(segment, unwritten));
      }
      const opened = open(project, { reset: true, key, ...(continueWith ? { workOrder: continueWith } : {}) });
      store.appendBatch([...events, ...opened.events]);
      if (ended) options.onClosed(project.maintainerId);
      return { segmentId: opened.segment.segmentId };
    },
  };
}
