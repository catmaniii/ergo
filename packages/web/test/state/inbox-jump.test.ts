// 105 号票：待办里每一项"去看看 ›"跳到它从哪来的地方。事项上记了来源（origin）的按来源去：任务的整页、项目的整页（维护者的会话）、
// 秘书会话，能定位的带上要定位的卡片或调用；系统的事项按种类去对应的页面；旧事项没记来源的不出按钮。
import { describe, expect, test } from "vitest";
import { type CardInboxItem, initialUiState, type InboxItem, type InboxJump, inboxJump, inboxJumpLabel, localDate, type NoticeInboxItem, type Project, type Task, type UiState } from "../../src/state/index.ts";
import { card, cardInboxItem, inboxItem } from "./events.ts";

const notice = (type: string, overrides: Partial<NoticeInboxItem> = {}) => inboxItem(`i-${type}`, { notice: type, ...overrides });
const cardItem = (cardId: string, overrides: Partial<CardInboxItem> = {}) => cardInboxItem(`i-${cardId}`, cardId, overrides);

/** 卡片事项那张卡的类型（系统的卡按类型认去处） */
function withCards(...cards: [id: string, type: string][]): UiState {
  return { ...initialUiState, cards: Object.fromEntries(cards.map(([id, type]) => [id, { card: card(id, 1, { type }) }])) };
}

/** 会话只记了维护者的会话时，按维护者认出是哪个任务、哪个项目 */
const withMaintainers: UiState = {
  ...initialUiState,
  tasks: { "t-9": { id: "t-9", maintainerId: "tm-9" } as Task },
  projects: { "p-9": { id: "p-9", maintainerId: "pm-9" } as Project },
};

/**
 * 记了会话的事项按"卡在哪个会话"去：t-1 是有自己维护者的任务，t-4 是项目 p-1 的内部任务（维护者就是项目的维护者 pm-1），
 * t-multi 是多项目任务（17 号票，自己的维护者 tm-multi），派到项目 p-1 的工单由项目维护者 pm-1 做
 */
const world: UiState = {
  ...initialUiState,
  tasks: {
    "t-1": { id: "t-1", maintainerId: "tm-1" } as Task,
    "t-4": { id: "t-4", maintainerId: "pm-1" } as Task,
    "t-multi": { id: "t-multi", maintainerId: "tm-multi" } as Task,
  },
  projects: { "p-1": { id: "p-1", maintainerId: "pm-1" } as Project },
};

/** 守护进程的 callInboxOrigin 实际记下的样子 */
const ownCall = (toolCallId: string) => ({ taskId: "t-1", conversation: "maintainer:tm-1", toolCallId, stageId: "2" });
const workOrderCall = (toolCallId: string) => ({ taskId: "t-multi", projectId: "p-1", conversation: "maintainer:pm-1", toolCallId, stageId: "3" });
const internalCall = (toolCallId: string) => ({ taskId: "t-4", projectId: "p-1", conversation: "maintainer:pm-1", toolCallId });

describe("事项种类 → 去处", () => {
  const cases: [what: string, item: InboxItem, expected: InboxJump | undefined, state?: UiState][] = [
    // ── 任务的事项：任务的整页（负责它的 agent 的会话），卡片事项定位到那张卡
    ["计划确认卡", cardItem("c-plan", { origin: { taskId: "t-1" } }), { kind: "task", taskId: "t-1", at: "c-plan" }],
    ["流程的计划卡、计划变更卡、并行确认卡（一样按任务）", cardItem("c-wf", { origin: { taskId: "t-2" } }), { kind: "task", taskId: "t-2", at: "c-wf" }],
    ["任务里的审批卡（任务自己的会话）：定位到卡（不是那次调用）", cardItem("c-appr", { origin: ownCall("call-1") }), { kind: "task", taskId: "t-1", at: "c-appr" }, world],
    ["等你验收：任务的整页", notice("stage_acceptance", { origin: { taskId: "t-1", stageId: "2" } }), { kind: "task", taskId: "t-1" }],
    ["卡住求助、失败后的抉择、超预算、授权到期续期", notice("stuck_help", { origin: { taskId: "t-1" } }), { kind: "task", taskId: "t-1" }],
    ["任务里的中断不确定：定位到那次调用", notice("interrupted", { origin: ownCall("call-7") }), { kind: "task", taskId: "t-1", at: "call-7" }, world],
    ["任务里的交给我做：定位到那次调用", notice("hand_over", { origin: ownCall("call-8") }), { kind: "task", taskId: "t-1", at: "call-8" }, world],
    ["任务还没收到（页面上没有它）：当是任务自己的会话", notice("hand_over", { origin: ownCall("call-8") }), { kind: "task", taskId: "t-1", at: "call-8" }],
    ["定时触发的任务被自动暂停：任务的整页", notice("scheduled_job_auto_paused", { origin: { taskId: "t-3" }, data: { jobId: "j-3" } }), { kind: "task", taskId: "t-3" }],
    ["项目内部任务的事项：去这个内部任务的整页（有任务先去任务）", cardItem("c-int", { origin: { taskId: "t-4", projectId: "p-1" }, internal: { projectId: "p-1", projectName: "官网" } }), { kind: "task", taskId: "t-4", at: "c-int" }],
    ["项目内部任务里的审批卡：会话是项目维护者的、也是这个任务的，去任务", cardItem("c-int-a", { origin: internalCall("call-5") }), { kind: "task", taskId: "t-4", at: "c-int-a" }, world],
    // ── 多项目任务派到项目的工单（17 号票）：调用记着多项目任务，卡出在项目维护者的会话里——去项目，不去任务整页（那里没有这张卡）
    ["工单里的审批卡", cardItem("c-wo-a", { origin: workOrderCall("call-6") }), { kind: "project", projectId: "p-1", chat: true, at: "c-wo-a" }, world],
    ["工单里的交给我做", notice("hand_over", { origin: workOrderCall("call-9") }), { kind: "project", projectId: "p-1", chat: true, at: "call-9" }, world],
    ["工单里的中断不确定", notice("interrupted", { origin: workOrderCall("call-10") }), { kind: "project", projectId: "p-1", chat: true, at: "call-10" }, world],
    ["多项目任务还没收到也一样去项目", cardItem("c-wo-b", { origin: workOrderCall("call-11") }), { kind: "project", projectId: "p-1", chat: true, at: "c-wo-b" }, { ...world, tasks: {} }],
    ["项目的维护者换过（原来的会话不在了）：不出按钮", cardItem("c-wo-c", { origin: { ...workOrderCall("call-12"), conversation: "maintainer:pm-old" } }), undefined, world],
    // ── 项目的事项：项目的整页（维护者的会话）
    ["立项书", cardItem("c-charter", { origin: { projectId: "p-1" } }), { kind: "project", projectId: "p-1", chat: true, at: "c-charter" }],
    ["工具包变更卡、维护者在问（项目的工单）", cardItem("c-tk", { origin: { projectId: "p-1" } }), { kind: "project", projectId: "p-1", chat: true, at: "c-tk" }],
    ["越界通知（项目维护者的工作）", notice("out_of_scope", { origin: { projectId: "p-1" } }), { kind: "project", projectId: "p-1", chat: true }],
    ["工单没写回的卡住求助", notice("stuck_help", { origin: { projectId: "p-1" } }), { kind: "project", projectId: "p-1", chat: true }],
    ["删除项目的确认：项目页（不是会话）", notice("project_delete", { origin: { projectId: "p-1" } }), { kind: "project", projectId: "p-1", chat: false }],
    ["项目维护者会话里的审批：定位到卡", cardItem("c-pa", { origin: { projectId: "p-1", conversation: "maintainer:pm-1", toolCallId: "call-2" } }), { kind: "project", projectId: "p-1", chat: true, at: "c-pa" }, world],
    // ── 秘书会话
    ["快速动作卡、记忆删除卡：秘书会话里那张卡", cardItem("c-qa", { origin: { conversation: "secretary" } }), { kind: "secretary", at: "c-qa" }],
    ["秘书对话里的审批卡", cardItem("c-sa", { origin: { conversation: "secretary", toolCallId: "call-3" } }), { kind: "secretary", at: "c-sa" }],
    ["秘书对话里的中断不确定、交给我做：那次调用", notice("interrupted", { origin: { conversation: "secretary", toolCallId: "call-4" } }), { kind: "secretary", at: "call-4" }],
    // ── 只记了维护者的会话：按维护者认出任务、项目；认不出不出按钮
    ["维护者会话里的快速动作卡：认出是任务", cardItem("c-m1", { origin: { conversation: "maintainer:tm-9" } }), { kind: "task", taskId: "t-9", at: "c-m1" }, withMaintainers],
    ["维护者会话里的快速动作卡：认出是项目", cardItem("c-m2", { origin: { conversation: "maintainer:pm-9" } }), { kind: "project", projectId: "p-9", chat: true, at: "c-m2" }, withMaintainers],
    ["认不出的维护者会话", cardItem("c-m3", { origin: { conversation: "maintainer:gone" } }), undefined, withMaintainers],
    // ── 简单提醒：日历上那一天
    ["到点的提醒", notice("reminder_due", { createdAt: "2026-10-07T12:00:00", cardId: "c-rem" }), { kind: "calendar", date: localDate(new Date("2026-10-07T12:00:00")) }],
    ["错过的提醒", notice("missed_reminder", { createdAt: "2026-10-08T12:00:00" }), { kind: "calendar", date: localDate(new Date("2026-10-08T12:00:00")) }],
    // ── 系统的：对应的页面
    ["关注类别设置有问题", notice("watch_categories_broken"), { kind: "settings", page: "watch" }],
    ["还没有参考音色", notice("voice_reference_missing"), { kind: "settings", page: "voice" }],
    ["语音识别不可用", notice("voice_recognizer_unavailable"), { kind: "settings", page: "voice" }],
    ["节假日数据缺失", notice("holiday_data_missing"), { kind: "settings", page: "workday-rules" }],
    ["节假日数据导入有问题", notice("holiday_import_problem"), { kind: "settings", page: "workday-rules" }],
    ["归档清单（卡片）", cardItem("c-arch"), { kind: "board" }, withCards(["c-arch", "archive_list"])],
    ["配对请求（卡片）：配对批准页", cardItem("c-pair"), { kind: "pairing", cardId: "c-pair" }, withCards(["c-pair", "pairing"])],
    ["还没迁移的定时作业被自动暂停（没记任务）：看板上那张作业卡", notice("scheduled_job_auto_paused", { data: { jobId: "j-1" } }), { kind: "board", jobId: "j-1" }],
    ["项目内部的、还没迁移的作业：项目页上那一行", notice("scheduled_job_auto_paused", { data: { jobId: "j-2" } }), { kind: "project", projectId: "p-1", chat: false, jobId: "j-2" }, { ...initialUiState, scheduledJobs: { "j-2": { id: "j-2", projectId: "p-1" } as UiState["scheduledJobs"][string] } }],
    // ── 没有去处
    ["备份失败：没有备份的页面", notice("backup_failed"), undefined],
    ["快照校验失败", notice("snapshot_check_failed"), undefined],
    ["向量模型未下载：没有页面管它（正文写着要跑的命令）", notice("embedding_model_missing"), undefined],
    ["旧事项没记来源：不出按钮", notice("stuck_help", { data: { taskId: "t-1" } }), undefined],
    ["旧的卡片事项没记来源、卡片不是系统的", cardItem("c-old"), undefined, withCards(["c-old", "plan"])],
    ["卡片还没收到、没记来源", cardItem("c-none"), undefined],
  ];
  test.each(cases)("%s", (_what, item, expected, state = initialUiState) => {
    expect(inboxJump(state, item)).toEqual(expected);
  });
});

test("按钮上写去哪", () => {
  expect(inboxJumpLabel({ kind: "task", taskId: "t-1" })).toBe("去任务 ›");
  expect(inboxJumpLabel({ kind: "project", projectId: "p-1", chat: true })).toBe("去项目 ›");
  expect(inboxJumpLabel({ kind: "secretary" })).toBe("去对话里 ›");
  expect(inboxJumpLabel({ kind: "calendar", date: "2026-10-07" })).toBe("去日历 ›");
  expect(inboxJumpLabel({ kind: "board" })).toBe("去看板 ›");
  expect(inboxJumpLabel({ kind: "settings", page: "watch" })).toBe("去设置 ›");
  expect(inboxJumpLabel({ kind: "pairing", cardId: "c-1" })).toBe("去核对 ›");
});
