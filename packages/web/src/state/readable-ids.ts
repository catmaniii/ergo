// 给用户看的编号：任务、负责人、项目、工单、定时作业不只写 t-3、tm-2，带上简短描述，写成仓库里原来的
// "编号「简短描述」"——"t-3「给记账本加周报」"、"tm-2「记账本的任务负责人」"。名字从状态层现取（任务标题、项目名、工单标题、
// 负责人属于哪个任务或项目），名字变了跟着变。取不到的：补发推完了（caughtUp）还没有就是删掉了，写"t-3（已删除）"；还没推完的只写"t-3"，
// 免得刚打开时满屏"已删除"。写法在协议包（readable-ids.ts），守护进程拼给用户看的句子用同一套。纯函数。
import { ASSISTANT_NAME_MARK, CHANNELS, deletedIdLabel, MAINTAINER_CHANNEL_PREFIX, maintainerIdLabel, type MaintainerOwner, MEMORY_CURATOR_AGENT_ID, namedIdLabel, t } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 取不到时：补发推完了是删掉了，还没推完只写编号 */
function missing(state: UiState, id: string): string {
  return state.caughtUp ? deletedIdLabel(id) : id;
}

/** "t-3「给记账本加周报」" */
export function taskLabel(state: UiState, taskId: string): string {
  const task = state.tasks[taskId];
  return task ? namedIdLabel(taskId, task.title) : missing(state, taskId);
}

/** "p-1「记账本」" */
export function projectLabel(state: UiState, projectId: string): string {
  const project = state.projects[projectId];
  return project ? namedIdLabel(projectId, project.name) : missing(state, projectId);
}

/** "wo-2「加一个导出说明」" */
export function workOrderLabel(state: UiState, workOrderId: string): string {
  const workOrder = state.workOrders[workOrderId];
  return workOrder ? namedIdLabel(workOrderId, workOrder.title) : missing(state, workOrderId);
}

/** "j-1「每天备份」"（以前的定时作业） */
export function jobLabel(state: UiState, jobId: string): string {
  const job = state.scheduledJobs[jobId];
  return job ? namedIdLabel(jobId, job.title) : missing(state, jobId);
}

/**
 * 负责人属于谁：项目在前（任务转为项目后负责人归项目），然后是任务、迁移来的定时作业。项目的负责人（pm-）只认项目：
 * 它执行的项目任务不是它的"属于"，项目删掉了它也就没了
 */
function maintainerOwner(state: UiState, maintainerId: string): MaintainerOwner | undefined {
  const project = Object.values(state.projects).find((p) => p.maintainerId === maintainerId);
  if (project) return { kind: "project", name: project.name };
  if (maintainerId.startsWith("pm-")) return undefined;
  const task = Object.values(state.tasks).find((x) => x.maintainerId === maintainerId);
  if (task) return { kind: "task", name: task.title };
  const job = Object.values(state.scheduledJobs).find((j) => j.maintainerId === maintainerId);
  return job ? { kind: "job", name: job.title } : undefined;
}

/** "tm-2「记账本的任务负责人」"、"pm-1「记账本的项目负责人」"；记忆管理员（它的会话也按负责人的频道开）不属于谁，也不会删掉，直接写名字 */
export function maintainerLabel(state: UiState, maintainerId: string): string {
  if (maintainerId === MEMORY_CURATOR_AGENT_ID) return t("state.readableIds.memoryCurator");
  const owner = maintainerOwner(state, maintainerId);
  return owner ? maintainerIdLabel(maintainerId, owner) : missing(state, maintainerId);
}

/**
 * 一个编号写成给用户看的样子：手里有的任务、项目、工单、定时作业、负责人直接认；手里没有的按编号的开头认是哪种（任务 t-、项目 p-、
 * 工单 wo-、定时作业 j-、负责人 tm- / pm- / jm-，后面是数字），写取不到；都认不出的（任务标题、别的编号）原样
 */
export function readableId(state: UiState, ref: string): string {
  if (ref === MEMORY_CURATOR_AGENT_ID) return maintainerLabel(state, ref);
  if (Object.hasOwn(state.tasks, ref)) return taskLabel(state, ref);
  if (Object.hasOwn(state.projects, ref)) return projectLabel(state, ref);
  if (Object.hasOwn(state.workOrders, ref)) return workOrderLabel(state, ref);
  if (Object.hasOwn(state.scheduledJobs, ref)) return jobLabel(state, ref);
  const owner = maintainerOwner(state, ref);
  if (owner) return maintainerIdLabel(ref, owner);
  const prefix = /^(t|p|wo|j|tm|pm|jm)-\d+$/.exec(ref)?.[1];
  switch (prefix) {
    case "t":
      return taskLabel(state, ref);
    case "p":
      return projectLabel(state, ref);
    case "wo":
      return workOrderLabel(state, ref);
    case "j":
      return jobLabel(state, ref);
    case "tm":
    case "pm":
    case "jm":
      return maintainerLabel(state, ref);
    default:
      return ref;
  }
}

/**
 * 会话的名字（记忆删除卡里素材的来源、记忆 · 素材按会话筛和成批删除时选会话，在"记忆"页）：秘书主线写名字占位（能放标签的地方用 NamedText 显示成名字标签，
 * 下拉选项这类纯文字的地方用 useNamedPlain 换成名字），负责人的写"tm-2「记账本的任务负责人」"
 */
export function conversationName(state: UiState, conversation: string): string {
  if (conversation === CHANNELS.secretary) return t("state.readableIds.secretaryMain", { name: ASSISTANT_NAME_MARK });
  return conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? maintainerLabel(state, conversation.slice(MAINTAINER_CHANNEL_PREFIX.length)) : conversation;
}

/**
 * 句子里说哪个会话（成批删除素材的确认框，在记忆 · 素材）：秘书主线写"会话「二狗主线」"（名字占位同上）；负责人的编号已经带「」，
 * 写"会话 tm-2「记账本的任务负责人」"，不再套一层「」
 */
export function conversationPhrase(state: UiState, conversation: string): string {
  const name = conversationName(state, conversation);
  return conversation === CHANNELS.secretary ? t("state.readableIds.conversationQuoted", { name }) : t("state.readableIds.conversation", { name });
}
