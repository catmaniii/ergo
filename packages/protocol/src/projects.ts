// 项目（规格第 11 节，15 号票）的名字：项目状态、项目类型、立项的入口、项目页上的动作、项目列表频道上的变化。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 project-schema.ts。
// "哪个状态能做哪个动作"只在这里定一次（PROJECT_ACTION_RULES）：守护进程据此校验迁移，Web 据此给出入口。
import { followLocale, t, tTable } from "./i18n/runtime.ts";
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

export const PROJECT_STATE_LABEL: Readonly<Record<ProjectState, string>> = tTable({
  preparing: "protocol.projects.state.preparing",
  building: "protocol.projects.state.building",
  in_use: "protocol.projects.state.inUse",
  retired: "protocol.projects.state.retired",
  archived: "protocol.projects.state.archived",
});

/** 项目类型（立项书里写明，确认即生效）：开发类（默认工具包带 bash，可以绑定外部工作目录）、其他 */
export const PROJECT_KINDS = ["dev", "other"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABEL: Readonly<Record<ProjectKind, string>> = tTable({ dev: "protocol.projects.kind.dev", other: "protocol.projects.kind.other" });

/**
 * 项目从哪个入口诞生：秘书收口的"建议立项"卡上点了"立项"（用户明说、点"新建项目"，或者秘书自己建议的，都经这张卡），
 * 或者任务转为项目（不新建维护者，原任务的维护者接着做立项问答）；290 号票起还有从运行时已有的会话接管（takeover：新建项目时选了
 * "从 Claude Code 会话接管"，不经秘书、直接建出，维护者接着那个会话）
 */
export const PROJECT_ORIGINS = ["suggestion", "task", "takeover"] as const;
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];

/**
 * 项目页上用户能做的动作（project_action 请求）：
 * - start_build 开工：立项书已确认、还在筹备中的（"只确认，稍后开工"之后）；或者建设中、首个建设任务失败或取消了，
 *   再发起一个建设任务（它接替成为首个建设任务，做完时出"首版做完了"卡，112 号票）；
 * - abandon 放弃（筹备中、建设中 → 已归档）、retire 停用、reactivate 重新启用、archive 归档（使用中、已停用 → 已归档）、
 *   unarchive 取消归档（回到归档前的状态）；
 * - delete 删除：只能从已归档发起，不马上删，在待我处理里放一条二次确认（PROJECT_DELETE_CONFIRM）；
 * - go_live 转入使用（259 号票）：建设中的，不马上转，出一张"转入使用"确认卡（go_live，卡上列转运营检查清单），用户在卡上确认才转——
 *   转运营不管谁发起（用户自己在项目页点、维护者提、秘书代办）都要用户确认，没有绕过的路（GO_LIVE_BY）。
 *   "首版做完了"卡已经在等的就用那一张（它的"转入使用"同样是这道确认）。
 * 重置维护者不改项目状态，不在这里：单独的 reset_maintainer 请求（canResetMaintainer）
 */
export const PROJECT_ACTIONS = ["start_build", "abandon", "retire", "reactivate", "archive", "unarchive", "delete", "go_live"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export const PROJECT_ACTION_LABEL: Readonly<Record<ProjectAction, string>> = tTable({
  start_build: "protocol.projects.action.startBuild",
  abandon: "protocol.projects.action.abandon",
  retire: "protocol.projects.action.retire",
  reactivate: "protocol.projects.action.reactivate",
  archive: "protocol.projects.action.archive",
  unarchive: "protocol.projects.action.unarchive",
  delete: "protocol.projects.action.delete",
  go_live: "protocol.projects.action.goLive",
});

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
  // 125 号票：用户在"立项要求变更"卡上确认了，立项书改写了（目标、范围、首版；项目类型、工作目录不变）
  "charter_changed",
  // 130 号票：用户在"运营方案变更"卡上确认了，现在生效的运营方案换了（项目状态不变；"首版做完了"卡上确认并转入使用的记在 in_use 那一条上）
  "operations_changed",
  // 261 号票：用户在"规范改写"卡上确认了，本项目的规范改写变了（跟新版规范的，项目上记着的规范版本换成新的）
  "standard_changed",
  // 262 号票：规范上线之前建的项目，用户在"补齐规范文档"卡上选了补齐：改用现在的规范（项目上记下规范版本，有模板的几份从模板放进档案）
  "standard_adopted",
  // 289 号票：维护者用的运行时（Project.runtime）或给它选的值（Project.runtimeOptions）改了（项目状态不变）
  "runtime_set",
  // 290 号票：从运行时已有的会话接管来的（Project.takeover）交还了、收回了（项目状态不变）
  "takeover_set",
] as const;
export type ProjectChange = (typeof PROJECT_CHANGES)[number];

/**
 * 每个动作能从哪些状态发起、到哪个状态（unarchive 回到归档前的状态；delete、go_live 不改状态，等用户确认）、
 * 在项目列表频道上记成什么变化（delete、go_live 没有：确认删除时才记 deleted，在确认卡上确认转入使用时才记 in_use）。
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
  go_live: { from: ["building"], to: "unchanged" },
};

/** 这两个动作让项目进入已归档：项目还有正在做或排队的工单时不能做（16 号票评审后用户定） */
export const ARCHIVING_ACTIONS: readonly ProjectAction[] = ["abandon", "archive"];

/**
 * 重置维护者（reset_maintainer 请求，16 号票）：不改项目状态，维护者新开一段会话、只凭项目档案重建理解（没有上一段的摘要），
 * 旧会话保留可查；已归档的项目维护者会话只读，不能重置
 */
export let RESET_MAINTAINER_LABEL = "";

export function canResetMaintainer(project: { state: ProjectState }): boolean {
  return project.state !== "archived";
}

/**
 * 项目还有没结束的工单（正在做、排队）时归档被拒的说法：先完成或取消哪几个任务；定时作业的运行（19 号票，工单不属于任务）
 * 写明等它这次做完
 */
export function archiveBlockedText(orders: ReadonlyArray<{ taskId?: string | undefined; taskTitle?: string | undefined; title?: string | undefined }>): string {
  const sep = t("protocol.common.listSep");
  const tasks = [
    ...new Map(orders.flatMap((o) => (o.taskId === undefined ? [] : [[o.taskId, t("protocol.readableIds.label", { id: o.taskId, name: o.taskTitle ?? "" })] as const]))).values(),
  ];
  const runs = [...new Set(orders.flatMap((o) => (o.taskId === undefined ? [t("protocol.projects.archiveBlocked.quoted", { title: o.title ?? "" })] : [])))];
  const parts = [
    ...(tasks.length > 0 ? [t("protocol.projects.archiveBlocked.tasks", { tasks: tasks.join(sep) })] : []),
    ...(runs.length > 0 ? [t("protocol.projects.archiveBlocked.runs", { runs: runs.join(sep) })] : []),
  ];
  return t("protocol.projects.archiveBlocked.text", { parts: parts.join(t("protocol.plan.scope.sep")) });
}

/** 取消归档时归档前的状态没记下（不该发生）：回到筹备中 */
const UNARCHIVE_FALLBACK: ProjectState = "preparing";

/**
 * 做这个动作之后项目到哪个状态、项目列表频道上记成什么变化，以及之后的"归档前的状态"（归档时记下，别的时候清掉）。
 * 删除（等二次确认）、转入使用（等确认卡，259 号票）不改状态，返回 undefined。能不能做另看 projectActions
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

export const BUILD_DONE_CHOICE_LABEL: Readonly<Record<BuildDoneChoice, string>> = tTable({
  put_in_use: "protocol.projects.buildDone.putInUse",
  keep_building: "protocol.projects.buildDone.keepBuilding",
  abandon: "protocol.projects.buildDone.abandon",
});

// ───────────────────────── 转入使用的确认（259 号票） ─────────────────────────

/**
 * 谁发起的转入使用（issue 19 第 8 条：不管谁发起都必须用户确认）：用户自己在项目页点的、项目的维护者提的（propose_go_live）、
 * 秘书照用户说的代办的（秘书的 propose_go_live）。都只出"转入使用"确认卡，用户在卡上确认才转
 */
export const GO_LIVE_BY = ["user", "maintainer", "secretary"] as const;
export type GoLiveBy = (typeof GO_LIVE_BY)[number];

export const GO_LIVE_BY_LABEL: Readonly<Record<GoLiveBy, string>> = tTable({
  user: "protocol.projects.goLive.by.user",
  maintainer: "protocol.projects.goLive.by.maintainer",
  secretary: "protocol.projects.goLive.by.secretary",
});

/**
 * "转入使用"确认卡（go_live）上的两个选择：确认转入使用（卡片动作和"首版做完了"卡同名 put_in_use：带着运营方案的就是"确认并转入使用"）、
 * 先不转（项目留在建设中）
 */
export const GO_LIVE_CHOICES = ["put_in_use", "dismiss"] as const;
export type GoLiveChoice = (typeof GO_LIVE_CHOICES)[number];

export const GO_LIVE_CHOICE_LABEL: Readonly<Record<GoLiveChoice, string>> = tTable({
  put_in_use: "protocol.projects.goLive.confirm",
  dismiss: "protocol.projects.goLive.dismiss",
});

/** "转入使用"确认卡的标题（卡上、待我处理里） */
export function goLiveTitle(p: { projectName: string }): string {
  return t("protocol.projects.goLive.title", { name: p.projectName });
}

/** "首版做完了"卡的标题（卡上、待我处理里）：第一轮是首版，继续建设之后写第几轮 */
export function buildDoneTitle(p: { projectName: string; round: number }): string {
  return p.round <= 1 ? t("protocol.projects.buildDone.title", { name: p.projectName }) : t("protocol.projects.buildDone.titleRound", { name: p.projectName, round: p.round });
}

/** 立项书卡上的两种确认（按钮、维护者会话里的说明、项目档案里的立项书、素材都用这一份说法） */
export const CHARTER_DECISIONS = ["start", "later"] as const;
export type CharterDecision = (typeof CHARTER_DECISIONS)[number];

export const CHARTER_DECISION_LABEL: Readonly<Record<CharterDecision, string>> = tTable({ start: "protocol.projects.charterDecision.start", later: "protocol.projects.charterDecision.later" });

// ───────────────────────── 立项要求变更（125 号票） ─────────────────────────

/**
 * 立项书确认之后能经"立项要求变更"改的几项：目标、范围、首版。决定运行时行为的那几项不走这条路——项目类型、工作目录不能改，
 * 工具包照旧走工具包变更卡（CHARTER_FIXED_NOTE）
 */
export const CHARTER_CHANGEABLE = ["goal", "scope", "firstVersion"] as const;
export type CharterField = (typeof CHARTER_CHANGEABLE)[number];

export const CHARTER_FIELD_LABEL: Readonly<Record<CharterField, string>> = tTable({
  goal: "protocol.projects.charterField.goal",
  scope: "protocol.projects.charterField.scope",
  firstVersion: "protocol.projects.charterField.firstVersion",
});

/** 卡上、工具说明里写明哪些不走这条路 */
export let CHARTER_FIXED_NOTE = "";

followLocale(() => {
  RESET_MAINTAINER_LABEL = t("protocol.projects.resetMaintainer");
  CHARTER_FIXED_NOTE = t("protocol.projects.charterFixedNote");
});

/** 立项要求里能改的那几项（立项书的一部分） */
export interface CharterRequirements {
  goal: string;
  scope: string[];
  firstVersion: string;
}

/** 维护者提的立项要求变更：只写要改的几项，没写的照旧（照 121 号票：写了的整项按写的算，范围要写全） */
export type CharterDraft = Partial<CharterRequirements>;

/** 立项要求变更里的一处（卡上逐条对照新旧）：目标、首版写前后两句；范围写去掉的和加上的条目 */
export type CharterChangeItem =
  | { field: "goal" | "firstVersion"; before: string; after: string }
  | { field: "scope"; removed: string[]; added: string[] };

/** 改动合上现在的立项书：没写的几项照旧（只动目标、范围、首版，别的原样） */
export function mergeCharterDraft<C extends CharterRequirements>(charter: C, draft: CharterDraft): C {
  return {
    ...charter,
    ...(draft.goal === undefined ? {} : { goal: draft.goal.trim() }),
    ...(draft.scope === undefined ? {} : { scope: draft.scope.map((s) => s.trim()).filter((s) => s.length > 0) }),
    ...(draft.firstVersion === undefined ? {} : { firstVersion: draft.firstVersion.trim() }),
  };
}

/** 两版立项书在能改的那几项上的不同（没有不同是空的）：范围按条目比，先后不算 */
export function charterChangeItems(before: CharterRequirements, after: CharterRequirements): CharterChangeItem[] {
  const items: CharterChangeItem[] = [];
  if (before.goal !== after.goal) items.push({ field: "goal", before: before.goal, after: after.goal });
  const removed = before.scope.filter((s) => !after.scope.includes(s));
  const added = after.scope.filter((s) => !before.scope.includes(s));
  if (removed.length > 0 || added.length > 0) items.push({ field: "scope", removed, added });
  if (before.firstVersion !== after.firstVersion) items.push({ field: "firstVersion", before: before.firstVersion, after: after.firstVersion });
  return items;
}

const quoted = (s: string) => t("protocol.projects.archiveBlocked.quoted", { title: s });

/** 一处改动写成一句（卡的纯文本降级、交给维护者的通知、立项书末尾的变更记录）："首版：「…」→「…」"；"范围：去掉「…」；加上「…」" */
export function charterChangeItemText(item: CharterChangeItem): string {
  const label = CHARTER_FIELD_LABEL[item.field];
  if (item.field !== "scope") return t("protocol.projects.charterChange.text", { label, before: item.before, after: item.after });
  const quote = quoted;
  const sep = t("protocol.common.listSep");
  const parts = [
    ...(item.removed.length > 0 ? [t("protocol.projects.charterChange.removed", { items: item.removed.map(quote).join(sep) })] : []),
    ...(item.added.length > 0 ? [t("protocol.projects.charterChange.added", { items: item.added.map(quote).join(sep) })] : []),
  ];
  return t("protocol.projects.charterChange.scope", { label, parts: parts.join(t("protocol.common.semiSep")) });
}

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
  return `工具包${bash ? "带" : "不带"} bash`; // @i18n-ignore model：维护者的系统提示、工具结果里用
}

/** 待我处理里属于某个项目的事项（删除的二次确认）：事项数据里记着的项目编号 */
export function inboxItemProjectId(item: object): string | undefined {
  const data: unknown = "data" in item ? item.data : undefined;
  if (typeof data !== "object" || data === null || !("projectId" in data)) return undefined;
  return typeof data.projectId === "string" ? data.projectId : undefined;
}

/** 删除项目的二次确认（待我处理里的通知 project_delete）上的两个动作 */
export const PROJECT_DELETE_CONFIRM = "确认删除"; // @i18n-ignore fixed：事项的动作按字认
export const PROJECT_DELETE_CANCEL = "不删了"; // @i18n-ignore fixed：事项的动作按字认

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

/** 动作在句子里的说法：按钮上要再确认的带"…"（"转入使用…"），句子里不带 */
const actionWord = (action: ProjectAction) => PROJECT_ACTION_LABEL[action].replace(/…$/, "");

/** 动作不能做时的说法（"已停用的项目不能放弃"） */
export function projectActionRefusal(project: { state: ProjectState; charterConfirmed: boolean }, action: ProjectAction): string {
  const rule = PROJECT_ACTION_RULES[action];
  const here = PROJECT_STATE_LABEL[project.state];
  if (!rule.from.includes(project.state)) {
    return t("protocol.projects.refusal.state", {
      state: here,
      action: actionWord(action),
      allowed: rule.from.map((s) => PROJECT_STATE_LABEL[s]).join(t("protocol.common.listSep")),
    });
  }
  if (action === "start_build" && project.state === "preparing") return t("protocol.projects.refusal.charterUnconfirmed");
  if (action === "start_build") return t("protocol.projects.refusal.buildRunning");
  return t("protocol.projects.refusal.other", { action: actionWord(action) });
}
