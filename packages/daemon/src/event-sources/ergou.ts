// 二狗内部事件（77 号票，来源编号 ergou）：从事件日志里认出这几种事，交给等它的订阅——
// - 任务完成、失败、转"等我"（看板频道的 task 事件，状态真的变了的那一条；普通任务、流程、长程任务都算，反复运行的任务一次运行做完不算完成）；
// - 项目状态变化（项目频道的 project 事件，筹备中 → 建设中 → 使用中 → 已停用之间变了；归档、取消归档也是状态变化）；
// - 定时、事件触发的任务的一次运行失败（看板频道 scheduled_job 的 run_finished，运行记成失败）。
// 可以按任务、项目过滤（过滤条件 taskId、projectId）。自己的事不触发自己（任务失败不会触发它自己）。
// 项目内部的事只在项目里看得到（64 号票）：只交给同一个项目里的订阅，或者点名要这个任务、这个项目的订阅。
// 去重键是事件日志的全局序号：同一条事件只交一次。守护进程里的事是同步推的，停机期间没有内部事件，不用开机补。
import {
  CHANNELS,
  ERGOU_EVENT_SOURCE,
  type ErgouEvent,
  EVENT_TYPES,
  filterValue,
  isDeletedEventPayload,
  PROJECT_STATE_LABEL,
  type ProjectEventPayload,
  type ScheduledJobEventPayload,
  TASK_KIND_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskEventPayload,
  taskKind,
} from "@ergou/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { runLabel } from "../scheduled-jobs/texts.ts";
import { oneLine } from "../util/text.ts";
import { ergouEmitError, ergouSummary, errorText } from "./texts.ts";
import type { EventSourceContext, EventSourceImpl, EventSubscription, SourceEvent } from "./types.ts";

/** 一条内部事件：事件、值，和它属于哪个项目内部（项目内部的只交给同一个项目的订阅、点名要它的订阅） */
interface ErgouHappening {
  event: ErgouEvent;
  summary: string;
  data: Record<string, string>;
  internalProject?: string;
}

const reasonText = (text: string | undefined) => (text === undefined ? undefined : oneLine(text, 300));

/** 一条日志事件里认出的内部事件（没有的是空的） */
function happeningsOf(e: StoredEvent): ErgouHappening[] {
  if (isDeletedEventPayload(e.payload)) return [];
  if (e.channel === CHANNELS.board && e.type === EVENT_TYPES.task) {
    const { task, from } = e.payload as TaskEventPayload;
    if (from === task.state) return [];
    const project = task.internal ?? (task.projectIds?.length === 1 ? { projectId: task.projectIds[0]!, projectName: task.projects[0] ?? task.projectIds[0]! } : undefined);
    const base = {
      taskId: task.id,
      taskTitle: task.title,
      taskKind: TASK_KIND_LABEL[taskKind(task)],
      ...(project ? { projectId: project.projectId, projectName: project.projectName } : {}),
    };
    const internal = task.internal ? { internalProject: task.internal.projectId } : {};
    if (task.state === "done") return [{ event: "task_done", summary: ergouSummary.taskDone(task.id, task.title), data: base, ...internal }];
    if (task.state === "failed") {
      const reason = reasonText(task.failReason);
      return [{ event: "task_failed", summary: ergouSummary.taskFailed(task.id, task.title, reason), data: { ...base, ...(reason ? { reason } : {}) }, ...internal }];
    }
    if (task.state === "waiting_for_user") {
      const reason = reasonText(task.waitNote ?? (task.waitReason ? TASK_WAIT_REASON_LABEL[task.waitReason] : undefined));
      return [{ event: "task_waiting", summary: ergouSummary.taskWaiting(task.id, task.title, reason), data: { ...base, ...(reason ? { reason } : {}) }, ...internal }];
    }
    return [];
  }
  if (e.channel === CHANNELS.projects && e.type === EVENT_TYPES.project) {
    const { project, from } = e.payload as ProjectEventPayload;
    if (from === null || from === project.state) return [];
    const was = PROJECT_STATE_LABEL[from];
    const now = PROJECT_STATE_LABEL[project.state];
    return [{ event: "project_state", summary: ergouSummary.projectState(project.name, was, now), data: { projectId: project.id, projectName: project.name, from: was, to: now } }];
  }
  if (e.channel === CHANNELS.board && e.type === EVENT_TYPES.scheduledJob) {
    const { job, change, run } = e.payload as ScheduledJobEventPayload;
    if (change !== "run_finished" || run?.state !== "failed") return [];
    const reason = reasonText(run.reason);
    const data: Record<string, string> = {
      ...(job.ownerTaskId === undefined ? {} : { taskId: job.ownerTaskId }),
      taskTitle: job.title,
      runId: run.runId,
      ...(reason ? { reason } : {}),
      ...(job.projectId === undefined ? {} : { projectId: job.projectId, projectName: job.projectName ?? job.projectId }),
    };
    return [{ event: "run_failed", summary: ergouSummary.runFailed(job.ownerTaskId, job.title, runLabel(run), reason), data, ...(job.internal ? { internalProject: job.internal.projectId } : {}) }];
  }
  return [];
}

/** 这个订阅要不要这条内部事件：选了这种事件、过滤条件对得上、不是它自己的事、项目内部的事只给同一个项目或点名要的 */
function wants(sub: EventSubscription, h: ErgouHappening): boolean {
  if (!sub.trigger.events.includes(h.event)) return false;
  const taskId = filterValue(sub.trigger, "taskId");
  const projectId = filterValue(sub.trigger, "projectId");
  if (typeof taskId === "string" && h.data.taskId !== taskId) return false;
  if (typeof projectId === "string" && h.data.projectId !== projectId) return false;
  if (sub.taskId !== undefined && h.data.taskId === sub.taskId) return false;
  if (h.internalProject !== undefined && sub.projectId !== h.internalProject && taskId === undefined && projectId === undefined) return false;
  return true;
}

export function createErgouSource(deps: { store: EventStore; ctx: EventSourceContext }): EventSourceImpl {
  let subs: readonly EventSubscription[] = [];
  const unsubscribe = deps.store.onAppend((e) => {
    if (subs.length === 0) return;
    for (const h of happeningsOf(e)) {
      const event: SourceEvent = { source: ERGOU_EVENT_SOURCE, event: h.event, at: e.time, summary: h.summary, data: h.data, key: `ergou:${e.globalSeq}:${h.event}` };
      for (const sub of subs) {
        if (!wants(sub, h)) continue;
        try {
          deps.ctx.emit(sub, event);
        } catch (err) {
          deps.ctx.log(ergouEmitError(sub.id, errorText(err)));
        }
      }
    }
  });
  return {
    id: ERGOU_EVENT_SOURCE,
    // 任务、项目对不对得上看板（不在的任务、项目照样能等：以后建出来的不会是同一个编号，只是永远等不到）
    check: () => [],
    sync(next) {
      subs = next;
    },
    stop() {
      unsubscribe();
      subs = [];
    },
  };
}
