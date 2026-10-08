// 项目（规格第 11 节，15 号票）的名字：项目状态、项目类型、立项的入口、项目页上的动作、项目列表频道上的变化。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 project-schema.ts。
// "哪个状态能做哪个动作"只在这里定一次（PROJECT_ACTION_RULES）：守护进程据此校验迁移，Web 据此给出入口。
import type { TaskState } from "./tasks.ts";

/**
 * 项目状态：筹备中 →（确认并开工）建设中 →（首个建设任务完成，自动）使用中 ⇄ 已停用；
 * 筹备中、建设中可以放弃 → 已归档；使用中、已停用 →（用户手动）已归档；取消归档回到归档前的状态。
 * 删除只能从已归档发起，要二次确认；删掉的项目不在这里（项目列表频道上一条 deleted 的变化）。
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
 *   再发起一个建设任务（它接替成为首个建设任务，完成时项目进入使用中）；
 * - abandon 放弃（筹备中、建设中 → 已归档）、retire 停用、reactivate 重新启用、archive 归档（使用中、已停用 → 已归档）、
 *   unarchive 取消归档（回到归档前的状态）；
 * - delete 删除：只能从已归档发起，不马上删，在待我处理里放一条二次确认（PROJECT_DELETE_CONFIRM）
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
 * 开工（确认并开工，或者稍后开工）、首个建设任务完成进入使用中（系统）、停用、重新启用、放弃、归档、取消归档、删除
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

/** 取消归档时归档前的状态没记下（不该发生）：回到筹备中 */
const UNARCHIVE_FALLBACK: ProjectState = "preparing";

/**
 * 做这个动作之后项目到哪个状态、项目列表频道上记成什么变化，以及之后的"归档前的状态"（归档时记下，别的时候清掉）。
 * 删除不马上改状态（等二次确认），返回 undefined。能不能做另看 projectActions
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

/** 立项书卡上的两种确认（按钮、维护者会话里的说明、项目档案里的立项书、素材都用这一份说法） */
export const CHARTER_DECISIONS = ["start", "later"] as const;
export type CharterDecision = (typeof CHARTER_DECISIONS)[number];

export const CHARTER_DECISION_LABEL: Readonly<Record<CharterDecision, string>> = { start: "确认并开工", later: "只确认，稍后开工" };

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
