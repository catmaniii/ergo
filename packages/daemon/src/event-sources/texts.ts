// 事件来源的说法（77 号票）：推来的事件的一句话说明（看板卡、任务详情、交给 agent 的通知、提醒里都是这一句）、
// 文件夹不能监视的原因、分发和各来源的日志。编排里不写文字。
// 174 号票：事件的一句话、不能监视的原因给用户看（生成时按当时的语言）；日志不翻；事件值里的写法（FOLDER_CHANGE_LABEL）是数据。
import { t } from "@ergo/protocol";

/** 二狗内部事件的一句话 */
export const ergoSummary = {
  taskDone: (taskId: string, title: string) => t("eventSources.summary.taskDone", { id: taskId, title }),
  taskFailed: (taskId: string, title: string, reason: string | undefined) =>
    reason ? t("eventSources.summary.taskFailedReason", { id: taskId, title, reason }) : t("eventSources.summary.taskFailed", { id: taskId, title }),
  taskWaiting: (taskId: string, title: string, reason: string | undefined) =>
    reason ? t("eventSources.summary.taskWaitingReason", { id: taskId, title, reason }) : t("eventSources.summary.taskWaiting", { id: taskId, title }),
  projectState: (name: string, from: string, to: string) => t("eventSources.summary.projectState", { name, from, to }),
  runFailed: (taskId: string | undefined, title: string, run: string, reason: string | undefined) => {
    const who = taskId ? t("eventSources.summary.task", { id: taskId }) : t("eventSources.summary.job");
    return reason ? t("eventSources.summary.runFailedReason", { who, title, run, reason }) : t("eventSources.summary.runFailed", { who, title, run });
  },
};

/** 文件夹变化的一句话："新增文件 报告.pdf（D:\收件箱）" */
export const folderSummary = (kind: keyof typeof FOLDER_CHANGE_LABEL, relativePath: string, folder: string) => t(`eventSources.folder.${kind}`, { path: relativePath, folder });

/** 文件夹变化的种类在事件值里的写法（数据：过滤、步骤里的 {{事件.change}} 按它认，不翻） */
// @i18n-ignore-next data：事件值
export const FOLDER_CHANGE_LABEL = { added: "新增", changed: "修改", removed: "删除" } as const;

/** 文件夹不能监视的原因 */
export const folderRefusal = {
  notAbsolute: (p: string) => t("eventSources.refusal.notAbsolute", { path: p }),
  notLocal: (p: string) => t("eventSources.refusal.notLocal", { path: p }),
  missing: (p: string) => t("eventSources.refusal.missing", { path: p }),
  notDirectory: (p: string) => t("eventSources.refusal.notDirectory", { path: p }),
  inside: (p: string, area: string) => t("eventSources.refusal.inside", { path: p, area }),
  contains: (p: string, area: string) => t("eventSources.refusal.contains", { path: p, area }),
};

/** 整个数据目录在不许监视的地方里的说法（受保护区域之外另加的一块） */
export const dataDirTitle = () => t("eventSources.dataDir");

// @i18n-ignore-start log：日志
/** 文件夹监视的日志 */
export const folderLog = {
  error: (folder: string, err: string) => `监视文件夹 ${folder} 出错：${err}`,
  saveError: (folder: string, err: string) => `监视文件夹 ${folder} 出错：存比对底子出错：${err}`,
  emitError: (folder: string, rel: string, err: string) => `监视文件夹 ${folder} 出错：交出 ${rel} 的变化出错：${err}`,
  /** 守护进程停机期间（或者文件夹看不到的那段时间）的变化，比对补上 */
  caughtUp: (folder: string, n: number) => `文件夹 ${folder}：停机期间有 ${n} 处变化，开机比对补上`,
  /** 看不到了（不在、出错、现在成了不许监视的地方）：不算删除，隔一会儿再看 */
  lost: (folder: string, reason: string) => `文件夹 ${folder} 现在看不到（${reason}）：不算删除，每隔一会儿再看，回来了和底子比一遍接着监视`,
  back: (folder: string) => `文件夹 ${folder} 又能看到了：和底子比一遍，接着监视`,
};

/** 文件夹看不到的原因（日志里写） */
export const FOLDER_LOST_REASON = { missing: "文件夹不在", watchError: (err: string) => `监视出错：${err}` };

/** 分发的日志 */
export const triggerText = {
  notDelivered: (summary: string, subId: string, reason: string) => `事件「${summary}」没交给 ${subId}：${reason}`,
  syncError: (source: string, err: string) => `事件来源 ${source} 跟上订阅时出错：${err}`,
};

/** 二狗内部事件交给订阅出错（日志） */
export const ergoEmitError = (subId: string, err: string) => `内部事件交给 ${subId} 出错：${err}`;
// @i18n-ignore-end

/** 登记表里有、守护进程还没有实现的来源（发起时的拒绝原因） */
export const sourceMissingText = (source: string) => t("eventSources.sourceMissing", { source });

/** 出错的说明（有堆栈的带堆栈） */
export const errorText = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));
