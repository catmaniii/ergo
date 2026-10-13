// 项目（规格第 11 节，15 号票）的名字：项目状态、项目类型、立项的入口、项目页上的动作、项目列表频道上的变化。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 project-schema.ts。
// "哪个状态能做哪个动作"只在这里定一次（PROJECT_ACTION_RULES）：守护进程据此校验迁移，Web 据此给出入口。
import type { TaskState } from "./tasks.ts";

/**
 * 项目状态：筹备中 →（确认并开工）建设中 →（建设任务做完，用户在"首版做完了"卡上选转入使用）使用中 ⇄ 已停用；
 * 筹备中、建设中可以放弃 → 已归档；使用中、已停用 →（用户手动）已归档；取消归档回到归档前的状态。
 * 删除只能从已归档发起，要二次确认；删掉的项目不在这里（项目列表频道上一条 deleted 的变化）。
 * 112 号票（用户 2026-10-13 定）：项目状态变更时找用户——建设任务做完不再自动进入使用中，给用户一张"首版做完了"卡
 * （BUILD_DONE_CHOICES），不选就一直停在建设中。
 */
export const PROJECT_STATES = ["preparing", "building", "in_use", "retired", "archived"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const PROJECT_STATE_LABEL: Readonly<Record<ProjectState, string>> = {
  preparing: "筹备中",
  building: "建设中",
  in_use: "使用中",
  retired: "已停用",
  archived: "已归档",
};

/** 项目类型（立项书里写明，确认即生效）：开发类（默认工具包带 bash，可以绑定外部工作目录）、其他 */
export const PROJECT_KINDS = ["dev", "other"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABEL: Readonly<Record<ProjectKind, string>> = { dev: "开发类", other: "其他" };

/**
 * 项目从哪个入口诞生：秘书收口的"建议立项"卡上点了"立项"（用户明说、点"新建项目"，或者秘书自己建议的，都经这张卡），
 * 或者任务转为项目（不新建维护者，原任务的维护者接着做立项问答）
 */
export const PROJECT_ORIGINS = ["suggestion", "task"] as const;
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];

/**
 * 项目页上用户能做的动作（project_action 请求）：
 * - start_build 开工：立项书已确认、还在筹备中的（"只确认，稍后开工"之后）；或者建设中、首个建设任务失败或取消了，
 *   再发起一个建设任务（它接替成为首个建设任务，做完时出"首版做完了"卡，112 号票）；
 * - abandon 放弃（筹备中、建设中 → 已归档）、retire 停用、reactivate 重新启用、archive 归档（使用中、已停用 → 已归档）、
 *   unarchive 取消归档（回到归档前的状态）；
 * - delete 删除：只能从已归档发起，不马上删，在待我处理里放一条二次确认（PROJECT_DELETE_CONFIRM）。
 * 重置维护者不改项目状态，不在这里：单独的 reset_maintainer 请求（canResetMaintainer）
 */
export const PROJECT_ACTIONS = ["start_build", "abandon", "retire", "reactivate", "archive", "unarchive", "delete"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export const PROJECT_ACTION_LABEL: Readonly<Record<ProjectAction, string>> = {
  start_build: "开工",
  abandon: "放弃（归档）",
  retire: "停用",
  reactivate: "重新启用",
  archive: "归档",
  unarchive: "取消归档",
  delete: "删除",
};

/**
 * 项目列表频道上 project 事件的"这次是什么变化"：建出（立项、任务转为项目）、维护者交出立项书、立项书确认（只确认）、
 * 开工（确认并开工，或者稍后开工）、进入使用中（112 号票起是用户在"首版做完了"卡上选转入使用；之前是首个建设任务完成时系统改的）、
 * 停用、重新启用、放弃、归档、取消归档、删除
 */
export const PROJECT_CHANGES = [
  "created",
  "charter_submitted",
  "charter_confirmed",
  "building_started",
  "in_use",
  "retired",
  "reactivated",
  "abandoned",
  "archived",
  "unarchived",
  "deleted",
  // 27 号票：工具包变了（用户在项目页改、批准了"工具包变更"卡、维护者增减 skill 或减少能力）
  "toolkit_changed",
  // 112 号票：用户在"首版做完了"卡上选继续建设，又建出一轮建设任务（项目留在建设中，buildTaskId 换成新的那个）
  "build_continued",
] as const;
export type ProjectChange = (typeof PROJECT_CHANGES)[number];

/**
 * 每个动作能从哪些状态发起、到哪个状态（unarchive 回到归档前的状态；delete 不改状态，等二次确认）、
 * 在项目列表频道上记成什么变化（delete 没有：确认删除时才记 deleted）。
 * 守护进程按它校验和迁移，Web（含原型的假连接）按它给出入口：都只用这一份，迁移本身用 projectActionTarget
 */
export const PROJECT_ACTION_RULES: Readonly<
  Record<ProjectAction, { from: readonly ProjectState[]; to: ProjectState | "archived_from" | "unchanged"; change?: ProjectChange }>
> = {
  start_build: { from: ["preparing", "building"], to: "building", change: "building_started" },
  abandon: { from: ["preparing", "building"], to: "archived", change: "abandoned" },
  retire: { from: ["in_use"], to: "retired", change: "retired" },
  reactivate: { from: ["retired"], to: "in_use", change: "reactivated" },
  archive: { from: ["in_use", "retired"], to: "archived", change: "archived" },
  unarchive: { from: ["archived"], to: "archived_from", change: "unarchived" },
  delete: { from: ["archived"], to: "unchanged" },
};

/** 这两个动作让项目进入已归档：项目还有正在做或排队的工单时不能做（16 号票评审后用户定） */
export const ARCHIVING_ACTIONS: readonly ProjectAction[] = ["abandon", "archive"];

/**
 * 重置维护者（reset_maintainer 请求，16 号票）：不改项目状态，维护者新开一段会话、只凭项目档案重建理解（没有上一段的摘要），
 * 旧会话保留可查；已归档的项目维护者会话只读，不能重置
 */
export const RESET_MAINTAINER_LABEL = "重置维护者";

export function canResetMaintainer(project: { state: ProjectState }): boolean {
  return project.state !== "archived";
}

/**
 * 项目还有没结束的工单（正在做、排队）时归档被拒的说法：先完成或取消哪几个任务；定时作业的运行（19 号票，工单不属于任务）
 * 写明等它这次做完
 */
export function archiveBlockedText(orders: ReadonlyArray<{ taskId?: string | undefined; taskTitle?: string | undefined; title?: string | undefined }>): string {
  const tasks = [...new Map(orders.flatMap((o) => (o.taskId === undefined ? [] : [[o.taskId, `${o.taskId}「${o.taskTitle ?? ""}」`] as const]))).values()];
  const runs = [...new Set(orders.flatMap((o) => (o.taskId === undefined ? [`「${o.title ?? ""}」`] : [])))];
  const parts = [...(tasks.length > 0 ? [`先完成或取消任务 ${tasks.join("、")}`] : []), ...(runs.length > 0 ? [`等定时作业的运行${runs.join("、")}做完`] : [])];
  return `项目还有正在做或排队的工单：${parts.join("，")}，再归档`;
}

/** 取消归档时归档前的状态没记下（不该发生）：回到筹备中 */
const UNARCHIVE_FALLBACK: ProjectState = "preparing";

/**
 * 做这个动作之后项目到哪个状态、项目列表频道上记成什么变化，以及之后的"归档前的状态"（归档时记下，别的时候清掉）。
 * 删除（等二次确认）不改状态，返回 undefined。能不能做另看 projectActions
 */
export function projectActionTarget(
  project: { state: ProjectState; archivedFrom?: ProjectState },
  action: ProjectAction,
): { state: ProjectState; change: ProjectChange; archivedFrom?: ProjectState } | undefined {
  const rule = PROJECT_ACTION_RULES[action];
  if (rule.change === undefined || rule.to === "unchanged") return undefined;
  const state = rule.to === "archived_from" ? (project.archivedFrom ?? UNARCHIVE_FALLBACK) : rule.to;
  return { state, change: rule.change, ...(state === "archived" ? { archivedFrom: project.state } : {}) };
}

/**
 * "首版做完了"卡（build_done，112 号票）上的三个选择：转入使用（项目进入使用中，以后运营态的东西从这里接上）、
 * 继续建设（项目留在建设中，维护者按你写的一句话起草下一轮建设任务的计划，照常找你确认）、放弃并归档（照项目页上的放弃）。
 * 卡片动作名就是它们
 */
export const BUILD_DONE_CHOICES = ["put_in_use", "keep_building", "abandon"] as const;
export type BuildDoneChoice = (typeof BUILD_DONE_CHOICES)[number];

export const BUILD_DONE_CHOICE_LABEL: Readonly<Record<BuildDoneChoice, string>> = { put_in_use: "转入使用", keep_building: "继续建设", abandon: "放弃并归档" };

/** "首版做完了"卡的标题（卡上、待我处理里）：第一轮是首版，继续建设之后写第几轮 */
export function buildDoneTitle(p: { projectName: string; round: number }): string {
  return p.round <= 1 ? `项目「${p.projectName}」首版做完了` : `项目「${p.projectName}」第 ${p.round} 轮建设做完了`;
}

/** 立项书卡上的两种确认（按钮、维护者会话里的说明、项目档案里的立项书、素材都用这一份说法） */
export const CHARTER_DECISIONS = ["start", "later"] as const;
export type CharterDecision = (typeof CHARTER_DECISIONS)[number];

export const CHARTER_DECISION_LABEL: Readonly<Record<CharterDecision, string>> = { start: "确认并开工", later: "只确认，稍后开工" };

/** 工具包的形状（同计划的工具包 PlanToolkit） */
export interface ToolkitShape {
  skills: string[];
  mcp: string[];
  bash: boolean;
  network: boolean;
  /** 能不能给秘书发消息（102 号票）：不写是能，关掉了是 false（canTellSecretary） */
  tellSecretary?: boolean;
  /** 能不能发附件（117 号票）：不写是能，关掉了是 false（canSendAttachment） */
  sendAttachment?: boolean;
}

/** 什么都不带的工具包（立项书确认之前；起草计划时） */
export function emptyToolkit(): ToolkitShape {
  return { skills: [], mcp: [], bash: false, network: false };
}

/** 项目现在的工具包：立项书确认之后才有，之前什么都不带 */
export function projectToolkit(project: { charterConfirmed: boolean; toolkit?: ToolkitShape | undefined }): ToolkitShape {
  return project.charterConfirmed && project.toolkit ? project.toolkit : emptyToolkit();
}

/** 工具包带不带 bash 的说法（"工具包带 bash"） */
export function toolkitBashWording(bash: boolean): string {
  return `工具包${bash ? "带" : "不带"} bash`;
}

/** 待我处理里属于某个项目的事项（删除的二次确认）：事项数据里记着的项目编号 */
export function inboxItemProjectId(item: object): string | undefined {
  const data: unknown = "data" in item ? item.data : undefined;
  if (typeof data !== "object" || data === null || !("projectId" in data)) return undefined;
  return typeof data.projectId === "string" ? data.projectId : undefined;
}

/** 删除项目的二次确认（待我处理里的通知 project_delete）上的两个动作 */
export const PROJECT_DELETE_CONFIRM = "确认删除";
export const PROJECT_DELETE_CANCEL = "不删了";

/** 首个建设任务失败或取消了（项目留在建设中，可以再开工一次） */
const ENDED_UNSUCCESSFULLY: readonly TaskState[] = ["failed", "cancelled"];

/**
 * 某个项目现在能做哪些动作（按 PROJECT_ACTION_RULES，加上开工的前提）：项目页按它给出入口，守护进程按它校验。
 * buildTaskState 是首个建设任务现在的状态（没有就不给）
 */
export function projectActions(project: { state: ProjectState; charterConfirmed: boolean }, buildTaskState?: TaskState): ProjectAction[] {
  return PROJECT_ACTIONS.filter((action) => {
    if (!PROJECT_ACTION_RULES[action].from.includes(project.state)) return false;
    if (action !== "start_build") return true;
    if (project.state === "preparing") return project.charterConfirmed;
    return buildTaskState !== undefined && ENDED_UNSUCCESSFULLY.includes(buildTaskState);
  });
}

/** 动作不能做时的说法（"已停用的项目不能放弃"） */
export function projectActionRefusal(project: { state: ProjectState; charterConfirmed: boolean }, action: ProjectAction): string {
  const rule = PROJECT_ACTION_RULES[action];
  const here = PROJECT_STATE_LABEL[project.state];
  if (!rule.from.includes(project.state)) {
    return `${here}的项目不能${PROJECT_ACTION_LABEL[action]}（只有${rule.from.map((s) => PROJECT_STATE_LABEL[s]).join("、")}的能）`;
  }
  if (action === "start_build" && project.state === "preparing") return "立项书还没确认，不能开工：先在立项书卡上确认";
  if (action === "start_build") return "首个建设任务还没结束（只有它失败或取消了，才能再发起一个建设任务）";
  return `不能${PROJECT_ACTION_LABEL[action]}`;
}
