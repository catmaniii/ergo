// 每周归档清单（archive-list.ts，19 号票）的说法：卡片和待我处理事项的标题、纯文本降级、拒绝用户选择的原因。编排里不写文字。
// 172 号票：标题、来源、拒绝的原因按当时的语言写；175 号票起纯文本降级也是（和别的卡一样）
import { ARCHIVE_CHOICE_LABEL, type ArchiveChoice, type ArchiveListCardPayload, type ArchiveListItem, t, type Task, TASK_END_KIND_LABEL, TASK_STATE_LABEL } from "@ergo/protocol";

/** 清单的标题（卡片、待我处理事项）："归档清单：4 个任务结束超过 7 天" */
export const archiveListTitle = (payload: ArchiveListCardPayload) =>
  t("tasks.archive.title", { n: payload.items.length, count: payload.items.length, days: payload.afterDays });

/** 清单上的一项写成一行（纯文本降级） */
const itemLine = (item: ArchiveListItem) =>
  t("tasks.archive.text.item", { id: item.taskId, title: item.title, state: `${TASK_STATE_LABEL[item.state]}${item.endKind ? ` · ${TASK_END_KIND_LABEL[item.endKind]}` : ""}` }) +
  (item.decision ? t("tasks.archive.text.decided", { choice: ARCHIVE_CHOICE_LABEL[item.decision] }) : "");

/** 卡片的纯文本降级 */
export const archiveListText = (payload: ArchiveListCardPayload) =>
  t("tasks.archive.text.list", {
    title: archiveListTitle(payload),
    items: payload.items.map(itemLine).join(t("protocol.common.semiSep")),
    choices: Object.values(ARCHIVE_CHOICE_LABEL).join(t("protocol.common.listSep")),
  });

/** 待我处理事项上的来源 */
export const archiveListSource = () => t("protocol.tasks.actor.system");

/** 用户在清单上的选择做不了的原因 */
export const archiveRefusal = {
  notOnList: (taskId: string) => t("tasks.archive.notOnList", { id: taskId }),
  decided: (item: ArchiveListItem) => t("tasks.archive.decided", { id: item.taskId, title: item.title, choice: item.decision ? ARCHIVE_CHOICE_LABEL[item.decision] : "" }),
  notAllowed: (item: ArchiveListItem, choice: ArchiveChoice) =>
    t("tasks.archive.notAllowed", { id: item.taskId, title: item.title, state: TASK_STATE_LABEL[item.state], choice: ARCHIVE_CHOICE_LABEL[choice] }),
  noTask: (taskId: string) => t("tasks.tasks.noTask", { id: taskId }),
  notArchivable: (task: Task) => t("tasks.archive.notArchivable", { id: task.id, title: task.title, state: TASK_STATE_LABEL[task.state] }),
};
