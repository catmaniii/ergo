// 待办里每一项"去看看 ›"跳到哪（105 号票，纯函数）：
// - 事项上记了来源（origin，守护进程建事项时记下）的按来源去：记了会话的（一次调用、一张卡实际所在的会话）按"卡在哪个会话"去——
//   秘书会话、任务自己的会话（任务整页；项目内部任务的会话就是项目维护者的，也去任务）、项目维护者的会话（项目，多项目任务派来的工单
//   在这里做）；没记会话的有任务去任务的整页（负责它的 agent 的会话），有项目去项目的整页（维护者的会话；删除项目的确认去项目页）。
//   卡片事项到了会话里定位到那张卡，通知定位到那次调用（中断不确定、交给我做）；
// - 系统的事项不记来源，按种类去对应的页面：到点 / 错过的提醒去日历上那一天，关注类别、语音、节假日去设置里那一页，
//   归档清单去看板，配对请求去配对批准页，还没迁移的定时作业被自动暂停去看板（项目内部的去项目页）上那张作业卡；
// - 没有去处的（备份失败、快照校验失败、向量模型未下载），和旧事项没记来源的，不出按钮。
// 地址怎么拼在 app/route-hash.ts 的 inboxJumpRoute（状态层不碰路由）。
import { CHANNELS, type InboxItem, localDate, MAINTAINER_CHANNEL_PREFIX, type NoticeType, tTable } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 系统的事项去设置里的哪一页（app/route-hash.ts 的 MorePage 里的几页） */
export type InboxJumpSettingsPage = "watch" | "voice" | "workday-rules";

export type InboxJump =
  /** 任务的整页（负责它的 agent 的会话）；at：会话里定位到这张卡、这次调用 */
  | { kind: "task"; taskId: string; at?: string }
  /** 项目的整页；chat：维护者的会话（窄屏是会话那一页）；at 同上；jobId：项目页上这个定时作业那一行 */
  | { kind: "project"; projectId: string; chat: boolean; at?: string; jobId?: string }
  /** 秘书会话；at 同上 */
  | { kind: "secretary"; at?: string }
  /** 日历上那一天（YYYY-MM-DD） */
  | { kind: "calendar"; date: string }
  /** 看板；jobId：看板上这个定时作业的卡 */
  | { kind: "board"; jobId?: string }
  /** 设置里的某一页 */
  | { kind: "settings"; page: InboxJumpSettingsPage }
  /** 配对批准页 */
  | { kind: "pairing"; cardId: string };

/** 系统的通知按种类去的页面 */
const SETTINGS_OF: Partial<Record<NoticeType, InboxJumpSettingsPage>> = {
  watch_categories_broken: "watch",
  voice_reference_missing: "voice",
  voice_recognizer_unavailable: "voice",
  holiday_data_missing: "workday-rules",
  holiday_import_problem: "workday-rules",
};

/** 这一项"去看看 ›"去哪；没有去处是 undefined（不出按钮） */
export function inboxJump(state: UiState, item: InboxItem): InboxJump | undefined {
  if (item.origin) return originJump(state, item);
  if (item.kind === "card") {
    const type = state.cards[item.cardId]?.card.type;
    if (type === "archive_list") return { kind: "board" };
    if (type === "pairing") return { kind: "pairing", cardId: item.cardId };
    return undefined;
  }
  const notice = item.notice as NoticeType;
  if (notice === "reminder_due" || notice === "missed_reminder") return { kind: "calendar", date: localDate(new Date(item.createdAt)) };
  if (notice === "archive_list") return { kind: "board" };
  const page = SETTINGS_OF[notice];
  if (page) return { kind: "settings", page };
  if (notice === "scheduled_job_auto_paused") return jobJump(state, item.data);
  return undefined;
}

/**
 * 按记下的来源去。记了会话的（审批卡、交给我做、中断不确定、快速动作卡：一次调用、一张卡实际所在的会话）按"卡在哪个会话"去：
 * 秘书会话；任务自己的维护者的会话去任务整页（项目内部任务的维护者就是项目的维护者，也去任务）；项目维护者的会话去项目——
 * 多项目任务（17 号票）派到项目的工单由项目维护者做，调用记着那个多项目任务，可卡出在项目维护者的会话里，去任务整页找不到它。
 * 没记会话的（任务、项目自己的事项）有任务去任务、有项目去项目
 */
function originJump(state: UiState, item: InboxItem): InboxJump | undefined {
  const origin = item.origin!;
  // 卡片定位到卡（审批卡也是卡，不是那次调用），通知定位到那次调用
  const target = item.kind === "card" ? item.cardId : origin.toolCallId;
  const at = target === undefined ? {} : { at: target };
  const conversation = origin.conversation;
  if (conversation === CHANNELS.secretary) return { kind: "secretary", ...at };
  if (conversation?.startsWith(MAINTAINER_CHANNEL_PREFIX)) return conversationJump(state, conversation.slice(MAINTAINER_CHANNEL_PREFIX.length), origin, at);
  if (origin.taskId) return { kind: "task", taskId: origin.taskId, ...at };
  if (origin.projectId) return { kind: "project", projectId: origin.projectId, chat: !(item.kind === "notice" && item.notice === "project_delete"), ...at };
  return undefined;
}

/**
 * 会话里的一条（卡、调用、消息）去哪个页面看（158 号票：设置里素材的出处也按这个去）：秘书会话；维护者的会话按它是哪个任务自己的、
 * 哪个项目的，去任务、项目的整页（和待办的"去看看 ›"同一个认法）；认不出的是 undefined
 */
export function conversationAtJump(state: UiState, conversation: string, ids: { taskId?: string | undefined; projectId?: string | undefined }, at: string): InboxJump | undefined {
  if (conversation === CHANNELS.secretary) return { kind: "secretary", at };
  if (conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return conversationJump(state, conversation.slice(MAINTAINER_CHANNEL_PREFIX.length), ids, { at });
  return undefined;
}

/** 卡、调用在某个维护者的会话里：这个会话是哪个任务自己的、哪个项目的；认不出的、维护者换过的（会话不在了）不出按钮 */
function conversationJump(state: UiState, maintainerId: string, origin: { taskId?: string | undefined; projectId?: string | undefined }, at: { at?: string }): InboxJump | undefined {
  const task = origin.taskId === undefined ? undefined : state.tasks[origin.taskId];
  if (task?.maintainerId === maintainerId) return { kind: "task", taskId: task.id, ...at };
  const named = origin.projectId === undefined ? undefined : state.projects[origin.projectId];
  const project = named?.maintainerId === maintainerId ? named : Object.values(state.projects).find((p) => p.maintainerId === maintainerId);
  if (project) return { kind: "project", projectId: project.id, chat: true, ...at };
  const owner = Object.values(state.tasks).find((t) => t.maintainerId === maintainerId);
  if (owner) return { kind: "task", taskId: owner.id, ...at };
  // 任务还没收到（页面上没有它）、也不是哪个项目的维护者：当它是任务自己的会话
  if (origin.taskId !== undefined && task === undefined && origin.projectId === undefined) return { kind: "task", taskId: origin.taskId, ...at };
  return undefined;
}

/** 还没迁移的定时作业被自动暂停（76 号票之后的属于定时触发的任务，记了任务）：看板上那张作业卡，项目里的去项目页那一行 */
function jobJump(state: UiState, data: unknown): InboxJump | undefined {
  const jobId = (data as { jobId?: unknown } | undefined)?.jobId;
  if (typeof jobId !== "string") return undefined;
  const projectId = state.scheduledJobs[jobId]?.projectId;
  return projectId ? { kind: "project", projectId, chat: false, jobId } : { kind: "board", jobId };
}

const JUMP_LABEL: Readonly<Record<InboxJump["kind"], string>> = tTable({
  task: "state.inboxJump.task",
  project: "state.inboxJump.project",
  secretary: "state.inboxJump.secretary",
  calendar: "state.inboxJump.calendar",
  board: "state.inboxJump.board",
  settings: "state.inboxJump.settings",
  pairing: "state.inboxJump.pairing",
});

/** 按钮上的字：写明去哪 */
export function inboxJumpLabel(jump: InboxJump): string {
  return JUMP_LABEL[jump.kind];
}
