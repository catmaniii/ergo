// 事件来源的说法（77 号票）：推来的事件的一句话说明（看板卡、任务详情、交给 agent 的通知、提醒里都是这一句）、
// 文件夹不能监视的原因、分发和各来源的日志。编排里不写文字。

/** 二狗内部事件的一句话 */
export const ergouSummary = {
  taskDone: (taskId: string, title: string) => `任务 ${taskId}「${title}」完成了`,
  taskFailed: (taskId: string, title: string, reason: string | undefined) => `任务 ${taskId}「${title}」失败了${reason ? `：${reason}` : ""}`,
  taskWaiting: (taskId: string, title: string, reason: string | undefined) => `任务 ${taskId}「${title}」转等我${reason ? `：${reason}` : ""}`,
  projectState: (name: string, from: string, to: string) => `项目「${name}」从${from}变成${to}`,
  runFailed: (taskId: string | undefined, title: string, run: string, reason: string | undefined) =>
    `${taskId ? `任务 ${taskId}` : "定时作业"}「${title}」的${run}失败了${reason ? `：${reason}` : ""}`,
};

/** 文件夹变化的一句话："新增文件 报告.pdf（D:\收件箱）" */
export const folderSummary = (change: string, relativePath: string, folder: string) => `${change}文件 ${relativePath}（${folder}）`;

/** 文件夹变化的种类在事件值里的写法 */
export const FOLDER_CHANGE_LABEL = { added: "新增", changed: "修改", removed: "删除" } as const;

/** 文件夹不能监视的原因 */
export const folderRefusal = {
  notAbsolute: (p: string) => `文件夹要写完整路径（比如 D:\\收件箱）：${p}`,
  notLocal: (p: string) => `只能监视本机盘上的文件夹（比如 D:\\收件箱）：${p} 是网络位置或设备路径`,
  missing: (p: string) => `文件夹不在：${p}`,
  notDirectory: (p: string) => `这不是文件夹：${p}`,
  inside: (p: string, area: string) => `不能监视 ${p}：它在${area}里（二狗的数据目录、密钥区、受保护区域不能监视）`,
  contains: (p: string, area: string) => `不能含子文件夹监视 ${p}：它里面有${area}（二狗的数据目录、密钥区、受保护区域不能监视）；去掉"含子文件夹"，或者换一个更具体的文件夹`,
};

/** 整个数据目录在不许监视的地方里的说法（受保护区域之外另加的一块） */
export const DATA_DIR_TITLE = "二狗的数据目录";

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

/** 分发的日志、被拒的原因 */
export const triggerText = {
  /** 登记表里有、守护进程还没有实现的来源 */
  sourceMissing: (source: string) => `事件来源 ${source} 还没接上`,
  notDelivered: (summary: string, subId: string, reason: string) => `事件「${summary}」没交给 ${subId}：${reason}`,
  syncError: (source: string, err: string) => `事件来源 ${source} 跟上订阅时出错：${err}`,
};

/** 二狗内部事件交给订阅出错（日志） */
export const ergouEmitError = (subId: string, err: string) => `内部事件交给 ${subId} 出错：${err}`;

/** 出错的说明（有堆栈的带堆栈） */
export const errorText = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));
