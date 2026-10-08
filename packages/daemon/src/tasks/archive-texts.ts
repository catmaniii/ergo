// 每周归档清单（archive-list.ts，19 号票）的说法：卡片和待我处理事项的标题、纯文本降级、拒绝用户选择的原因。编排里不写文字。
import { ARCHIVE_CHOICE_LABEL, type ArchiveChoice, type ArchiveListCardPayload, type ArchiveListItem, type Task, TASK_END_KIND_LABEL, TASK_STATE_LABEL } from "@ergou/protocol";

/** 清单的标题（卡片、待我处理事项）："归档清单：4 个任务结束超过 7 天" */
export const archiveListTitle = (payload: ArchiveListCardPayload) => `归档清单：${payload.items.length} 个任务结束超过 ${payload.afterDays} 天`;

/** 清单上的一项写成一行（纯文本降级） */
const itemLine = (item: ArchiveListItem) =>
  `${item.taskId}「${item.title}」（${TASK_STATE_LABEL[item.state]}${item.endKind ? ` · ${TASK_END_KIND_LABEL[item.endKind]}` : ""}）${item.decision ? `：${ARCHIVE_CHOICE_LABEL[item.decision]}` : ""}`;

/** 卡片的纯文本降级 */
export const archiveListText = (payload: ArchiveListCardPayload) =>
  `${archiveListTitle(payload)}：${payload.items.map(itemLine).join("；")}。每项可选：${Object.values(ARCHIVE_CHOICE_LABEL).join("、")}。`;

/** 待我处理事项上的来源 */
export const ARCHIVE_LIST_SOURCE = "系统";

/** 用户在清单上的选择做不了的原因 */
export const archiveRefusal = {
  notOnList: (taskId: string) => `清单上没有任务 ${taskId}`,
  decided: (item: ArchiveListItem) => `任务 ${item.taskId}「${item.title}」已经选过了：${item.decision ? ARCHIVE_CHOICE_LABEL[item.decision] : ""}`,
  notAllowed: (item: ArchiveListItem, choice: ArchiveChoice) => `任务 ${item.taskId}「${item.title}」${TASK_STATE_LABEL[item.state]}，不能${ARCHIVE_CHOICE_LABEL[choice]}`,
  noTask: (taskId: string) => `没有任务 ${taskId}`,
  notArchivable: (task: Task) => `任务 ${task.id}「${task.title}」现在是${TASK_STATE_LABEL[task.state]}，不能归档`,
};
