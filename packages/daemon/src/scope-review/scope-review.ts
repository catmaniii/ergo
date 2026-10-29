// 范围审视（规格第 10 节，18 号票）在守护进程这一侧：守护进程不跑模型，审视的模型调用在维护者自己的子进程里（运行时封装层的
// agent-child/scope-review.ts）；这里给子进程备好对照物和"近期范围记录"，把子进程交回的结果存成范围记录。
// - 对照物：立项书（125 号票起是现在的立项书：用户确认了的立项要求变更改过的，从事件算）、任务书和现在生效的计划（授权项、工具包、
//   用户说过的限制）、用户在审批卡上批准过的调用（这个维护者的最近 20 条），和用户在这个维护者会话里直接说的话（最近 20 条；
//   125 号票起是运行时核实过的格式：原文、会话、时间、设备，秘书转达来的换成用户在秘书那里的原话）；
// - 近期范围记录：这个维护者最近 5 条（从守护进程保存的取，换了新的会话分段也拿得到），子进程拼到系统提示末尾；
// - 存：每条发现一条 scope_record（落在哪个频道见协议包的 scopeRecordChannel）、维护者会话频道上一条 timeline_record
//   （种类 scope_change / out_of_scope，时间线标出），越界另在待我处理放一条不推送、不卡任务的通知；
//   都在同一事务里（工单结束时的和这一段、工单的结束同一事务，由调用方放进 appendBatch）。范围记录上记着这次审视看到的
//   用户原话从哪来（sources：对照物里的消息和审批、会话里交给维护者的输入），彻底删除其中一条时连带改写（purge.ts）；
// - 项目档案的范围记录 scope-records.md（不属于项目的任务：任务产出区里的同名文件）是这些事件的投影：事件追加之后往文件里
//   添一条（同一条记录改写后追加的新版本换掉文件里原来那条），启动时把没写进去、没换掉的补上（文件里每条带记录号）。
//   范围记录以事件为准。
// 范围审视是软约束：不拦任何工具调用，也不暂停维护者。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EVENT_TYPES,
  type InboxOrigin,
  internalMark,
  isDeletedEventPayload,
  isJobRunWorkOrder,
  isLegacyJob,
  maintainerChannel,
  OUT_OF_SCOPE_ACK,
  type OutOfScopeNoticeData,
  type ScopeOwnership,
  type ScopeRecord,
  type ScopeRecordEventPayload,
  scopeRecordChannel,
  type ScopeReviewTrigger,
  type ScopeSources,
  type Task,
  t,
} from "@ergo/protocol";
import { listApprovals } from "../approvals/views.ts";
import { buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import type { ScopeReviewContext, ScopeReviewResult } from "../conversation/scope-reviews.ts";
import { recentMessagesOf } from "../conversation/views.ts";
import { type UserWordsDeps, verifiedRecentWords } from "../conversation/user-words.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { getWorkOrder, type ScopeReviewProjects, workOrderInternal } from "../projects/api.ts";
import { getJob } from "../scheduled-jobs/index.ts";
import type { TaskService } from "../tasks/tasks.ts";
import {
  APPROVALS_LIMIT,
  basisLine,
  DETAIL_LINE_PREFIX,
  outOfScopeNotice,
  recentRecordsText,
  recordFileEntry,
  recordMarker,
  type ReferenceInput,
  referenceText,
  reviewFailedNote,
  taskRecordsHeader,
  USER_WORDS_LIMIT,
} from "./texts.ts";
import { allScopeRecords, recentScopeRecords, SCOPE_RECORD_CHANNELS } from "./views.ts";

/** 不属于项目的任务的范围记录：任务产出区里的这个文件（项目的在项目档案的 scope-records.md） */
export const TASK_RECORDS_FILE = "scope-records.md";

/** 系统提示末尾的近期范围记录取几条（规格第 10 节） */
export const RECENT_SCOPE_RECORDS = 5;

/** 一段工作属于谁（ownership，记在范围记录和越界通知上），和它在维护者会话里的归属（scope，时间线记录、说明带上） */
export interface ScopeOwner {
  ownership: ScopeOwnership;
  scope: MessageScope;
}

/** 拼归属：没有的（undefined）不写（两个维护者模块共用，条件展开只在这里写一次） */
export function ownershipOf(parts: { maintainerId: string; projectId?: string | undefined; taskId?: string | undefined; workOrderId?: string | undefined }): ScopeOwnership {
  const { maintainerId, projectId, taskId, workOrderId } = parts;
  return {
    maintainerId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(workOrderId === undefined ? {} : { workOrderId }),
  };
}

/** 范围记录的时间线记录的幂等键（彻底删除时据此找到它连带改写） */
export const scopeTimelineKey = (recordId: string) => `scope-record:${recordId}#timeline`;

export interface ScopeReviewOptions {
  store: EventStore;
  /**
   * 项目现在的立项书全文（125 号票：用户确认了的立项要求变更改过的，从事件算，不读维护者写得到的 charter.md）；
   * 不给、或者立项书还没确认的读项目档案里的 charter.md
   */
  charterText?: (projectId: string) => string | undefined;
  /** 核实用户的话（125 号票）：对照物里"用户在会话里说的话"改成运行时核实过的格式（秘书转达来的换成原话）；不给就照原样列 */
  userWords?: UserWordsDeps;
  inbox: InboxService;
  /** 项目系统给范围审视的（277 号票的入口）：项目的名字、维护者的项目、项目档案里立项书和范围记录的位置 */
  projects: ScopeReviewProjects;
  tasks: Pick<TaskService, "get" | "brief" | "latestPlan" | "confirmedPlan">;
  /** 数据目录的输出区：不属于项目的任务的产出，每个任务一格（范围记录写在这里） */
  outputsDir: string;
  now: () => string;
  log: (line: string) => void;
}

export interface ScopeReview {
  /** 开始把范围记录写进文件（先把以前没写进去的、没换掉的补上） */
  start(): void;
  stop(): void;
  /** 这个维护者此刻的对照物、近期范围记录，和对照物里的用户原话从哪来（拉起时进装配，之后变了由会话交给子进程） */
  context(ownership: ScopeOwnership): ScopeReviewContext;
  /** 审视的结果要追加的事件（范围记录、时间线记录、越界通知；没做成的是会话里的一条说明）：调用方放进 appendBatch */
  recordEvents(owner: ScopeOwner, trigger: ScopeReviewTrigger, result: ScopeReviewResult): NewEvent[];
  /** 追加审视的结果（压缩会话时子进程自己做的审视） */
  save(owner: ScopeOwner, trigger: ScopeReviewTrigger, result: ScopeReviewResult): void;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * 文件里换掉这条记录原来的那一条（记录号所在的一行，连同下面的说明那一行）；文件里还没有这条是 undefined，
 * 和原来一样的原样返回
 */
function replaceEntry(existing: string, record: ScopeRecord): string | undefined {
  const lines = existing.split("\n");
  const at = lines.findIndex((line) => line.includes(recordMarker(record.id)));
  if (at < 0) return undefined;
  let end = at + 1;
  while (end < lines.length && lines[end]!.startsWith(DETAIL_LINE_PREFIX)) end += 1;
  const entry = recordFileEntry(record);
  if (`${lines.slice(at, end).join("\n")}\n` === entry) return existing;
  return [...lines.slice(0, at), ...entry.slice(0, -1).split("\n"), ...lines.slice(end)].join("\n");
}

/** 越界通知从哪来（105 号票）：项目维护者的工作去项目（做任务的工单时也是，越界发生在项目维护者的会话里），任务自己的维护者的去任务 */
function scopeInboxOrigin(ownership: ScopeOwnership): { origin?: InboxOrigin } {
  if (ownership.projectId !== undefined) return { origin: { projectId: ownership.projectId } };
  return ownership.taskId !== undefined ? { origin: { taskId: ownership.taskId } } : {};
}

export function createScopeReview(options: ScopeReviewOptions): ScopeReview {
  const { store, inbox, projects, tasks, now, log } = options;
  let unsubscribe: (() => void) | undefined;

  /** 范围记录写在哪个文件：项目维护者的在项目档案里（项目删掉了就不写），不属于项目的任务的在任务的产出区里 */
  const fileOf = (record: ScopeRecord): { file: string; header?: string } | undefined => {
    if (record.projectId !== undefined) {
      const owned = projects.ofMaintainer(record.maintainerId);
      if (!owned || owned.deleted || owned.project.id !== record.projectId) return undefined;
      return { file: projects.records(record.projectId).scopeRecords };
    }
    if (record.taskId === undefined) return undefined;
    const task = tasks.get(record.taskId);
    return { file: path.join(options.outputsDir, record.taskId, TASK_RECORDS_FILE), ...(task ? { header: taskRecordsHeader(task) } : {}) };
  };

  /** 文件里写上这条（已经有了就换成现在的样子：彻底删除改写过的；一样的不动） */
  const project = (record: ScopeRecord) => {
    const target = fileOf(record);
    if (!target) return;
    try {
      const existing = read(target.file);
      const replaced = replaceEntry(existing, record);
      if (replaced === existing) return;
      if (replaced !== undefined) return fs.writeFileSync(target.file, replaced);
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      const lead = existing === "" ? (target.header ?? "") : existing.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(target.file, `${lead}${recordFileEntry(record)}`);
    } catch (err) {
      log(`范围记录 ${record.id} 没写进文件：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 对照物里的任务：任务书、现在生效的计划和它的状态 */
  const taskReference = (task: Task): NonNullable<ReferenceInput["task"]> => {
    const brief = tasks.brief(task.id)?.brief;
    // 现在生效的（确认过的）计划；还没确认过的用最新交上去的那版
    const stored = tasks.confirmedPlan(task.id) ?? tasks.latestPlan(task.id);
    return { task, ...(brief ? { brief } : {}), ...(stored ? { plan: { plan: stored.plan, status: stored.status } } : {}) };
  };

  const ownerLabel = (ownership: ScopeOwnership): string => {
    if (ownership.projectId !== undefined) return t("scopeReview.owner.project", { name: projects.get(ownership.projectId)?.name ?? ownership.projectId });
    if (ownership.taskId !== undefined) return t("scopeReview.owner.task", { title: tasks.get(ownership.taskId)?.title ?? ownership.taskId });
    return ownership.maintainerId;
  };

  /** 归属里工单、任务现在的名字（越界通知写编号加名字，159 号票） */
  const ownerNames = (ownership: ScopeOwnership) => ({
    workOrder: ownership.workOrderId === undefined ? undefined : getWorkOrder(store.reader, ownership.workOrderId)?.title,
    task: ownership.taskId === undefined ? undefined : tasks.get(ownership.taskId)?.title,
  });

  const recordEvents: ScopeReview["recordEvents"] = ({ ownership, scope }, trigger, { report, context }) => {
    const conversation = maintainerChannel(ownership.maintainerId);
    const events: NewEvent[] = [];
    if (report.error !== undefined) {
      log(`维护者 ${ownership.maintainerId} 的范围审视没做成：${report.error}`);
      events.push(buildMessage({ conversation, speaker: "system", parts: [{ type: "text", text: reviewFailedNote(report.error) }] }, scope).event);
    }
    // 这次审视看到的用户原话从哪来：对照物里的，加上会话里交给维护者的输入（工作记录里有它们）
    const sources: ScopeSources = { messageIds: [...new Set([...context.sources.messageIds, ...report.inputIds])], approvalIds: context.sources.approvalIds };
    const time = now();
    for (const finding of report.findings) {
      const record: ScopeRecord = {
        id: `sr-${randomUUID()}`,
        kind: finding.kind,
        summary: finding.summary,
        ...(finding.detail === undefined ? {} : { detail: finding.detail }),
        ...(finding.basis === undefined ? {} : { basis: finding.basis }),
        trigger,
        ...ownership,
        time,
      };
      const payload: ScopeRecordEventPayload = { record, sources };
      events.push({ channel: scopeRecordChannel(record), type: EVENT_TYPES.scopeRecord, payload });
      // 时间线上标出（维护者会话频道，带种类和归属）
      const detail = [finding.detail, finding.basis === undefined ? undefined : basisLine(finding.basis)].filter((x) => x !== undefined).join("\n");
      events.push(
        buildTimelineRecord(
          conversation,
          { kind: finding.kind, summary: finding.summary, ...(detail ? { detail } : {}), ...(ownership.workOrderId === undefined ? {} : { workOrderId: ownership.workOrderId }) },
          scope,
          { idempotencyKey: scopeTimelineKey(record.id) },
        ).event,
      );
      // 越界：待我处理里一条不推送、不卡任务的通知（照常算未读）
      if (finding.kind === "out_of_scope") {
        const data: OutOfScopeNoticeData = { recordId: record.id, ...ownership };
        // 项目内部任务（或它计划里的作业）的工单段里审视出来的：秘书看不到细节（64 号票）
        const internal = ownership.workOrderId !== undefined ? workOrderInternal(store.reader, getWorkOrder(store.reader, ownership.workOrderId)) : ownership.taskId !== undefined ? tasks.get(ownership.taskId)?.internal : undefined;
        events.push(
          inbox.buildAdd({ kind: "notice", notice: "out_of_scope", ...outOfScopeNotice(record, ownerLabel(ownership), ownerNames(ownership)), ...internalMark(internal), ...scopeInboxOrigin(ownership), urgency: "non_blocking", actions: [OUT_OF_SCOPE_ACK], data: { ...data } }).event,
        );
      }
    }
    return events;
  };

  return {
    start() {
      // 事件追加之后写进文件；以前追加了、没来得及写进文件（或换掉）的（守护进程被杀）先补上
      unsubscribe = store.onAppend((event) => {
        if (event.type !== EVENT_TYPES.scopeRecord || !SCOPE_RECORD_CHANNELS.includes(event.channel) || isDeletedEventPayload(event.payload)) return;
        project((event.payload as ScopeRecordEventPayload).record);
      });
      for (const record of allScopeRecords(store.reader)) project(record);
    },
    stop() {
      unsubscribe?.();
    },
    context(ownership) {
      const owned = ownership.projectId === undefined ? undefined : projects.get(ownership.projectId);
      // 定时触发的一次运行的工单段（19 号票的定时作业；76 号票）：触发登记和它每次运行的授权；定时触发的任务的运行连同它的任务、计划
      const wo = ownership.workOrderId === undefined ? undefined : getWorkOrder(store.reader, ownership.workOrderId);
      const job = wo && isJobRunWorkOrder(wo) ? getJob(store.reader, wo.scheduledJobId) : undefined;
      const taskId = ownership.taskId ?? (job && !isLegacyJob(job) ? job.ownerTaskId : undefined);
      const task = taskId === undefined ? undefined : tasks.get(taskId);
      const jobToolkit = job && tasks.confirmedPlan(job.taskId)?.plan.toolkit;
      const conversation = maintainerChannel(ownership.maintainerId);
      const userWords = recentMessagesOf(store.reader, conversation, "user", USER_WORDS_LIMIT);
      // 125 号票：核实过的格式（原文、哪个会话、时间、设备；秘书转达来的换成用户在秘书那里的原话，找不到原话的不算）
      const verified = options.userWords ? verifiedRecentWords(options.userWords, userWords, conversation) : undefined;
      const approvals = listApprovals(store.reader, "approved")
        .filter((a) => a.origin.agentId === ownership.maintainerId)
        .slice(-APPROVALS_LIMIT);
      const reference = referenceText({
        ...(owned ? { project: { id: owned.id, name: owned.name, charter: options.charterText?.(owned.id) ?? read(projects.records(owned.id).charter) } } : {}),
        ...(task ? { task: taskReference(task) } : {}),
        ...(job ? { job: { job, ...(jobToolkit ? { toolkit: jobToolkit } : {}) } } : {}),
        approvals: approvals.map((a) => ({ time: a.decidedAt ?? a.requestedAt, toolTitle: a.toolTitle, argsSummary: a.argsSummary })),
        userWords,
        ...(verified ? { verifiedWords: verified } : {}),
      });
      const recent = recentRecordsText(recentScopeRecords(store.reader, ownership.maintainerId, RECENT_SCOPE_RECORDS));
      return {
        reference,
        ...(recent === undefined ? {} : { recentRecords: recent }),
        // 看到的用户原话从哪来：会话里的这几条，秘书转达来的连同用户在秘书那里的原话（彻底删除其中一条时连带改写这条范围记录）
        sources: { messageIds: [...new Set([...userWords.map((m) => m.id), ...(verified ?? []).map((w) => w.messageId)])], approvalIds: approvals.map((a) => a.approvalId) },
      };
    },
    recordEvents,
    save(owner, trigger, result) {
      const events = recordEvents(owner, trigger, result);
      if (events.length > 0) store.appendBatch(events);
    },
  };
}
