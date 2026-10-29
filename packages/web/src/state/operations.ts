// 运营方案（130 号票，ADR-0028）的视图（纯函数）：
// - 项目页"运营方案"一节：现在生效的运营方案（Project.operations）里每一条一行——叫什么、怎么触发、怎么做、要的能力，
//   状态是在跑、暂停（及原因）、没生效（及原因）、要你手动（二狗现在还做不了的写明要做哪几步）、已结束；
//   状态照它生效成的内部任务和触发登记现算（看板频道上的任务、定时作业），收不到的照"在跑"写；
// - "运营方案变更"卡：差异按"加上、改了、去掉、重新开起来、照旧"分几组；
// - 这个项目的"运营方案变更"卡（项目页那一节下面列着）。
// 133 号票：服务那一条（means: service）的状态不看内部任务，看项目的服务（UiState.projectServices：上线到哪了、LSM 推来的在不在线），
// 行上带着它（入口"打开「X」"）。
import {
  capabilitiesText,
  ENDED_TASK_STATES,
  OPERATION_APPROACH_LABEL,
  OPERATIONS_MANUAL_PREFIX,
  scheduledJobStatusText,
  TASK_STATE_LABEL,
  type OperationItem,
  type OperationsChangeCardPayload,
  type Project,
  type ProjectOperationItem,
  type ProjectServiceView,
  type ScheduledJob,
  serviceStateText,
  t,
} from "./protocol.ts";
import { serviceChangedFields, serviceOfItem } from "./project-services.ts";
import type { UiState } from "./ui-state.ts";

/** 一条现在的状态 */
export type OperationStatusKind = "running" | "paused" | "failed" | "manual" | "ended";

export interface OperationRow {
  item: ProjectOperationItem;
  status: OperationStatusKind;
  /** 状态写成几个字："在跑"、"已暂停（项目已停用）"、"没生效"、"要你手动"、"已结束（已取消）" */
  statusText: string;
  /** 状态的补充：没生效的原因、要你手动做的步骤 */
  detail?: string;
  /** 在跑的：下一次什么时候（触发登记上的；事件触发的没有） */
  nextAt?: string;
  /** 怎么做、要什么能力："普通任务 · 联网" */
  howText: string;
  /** 它生效成的内部任务（点过去看任务详情） */
  taskId?: string;
  /** 服务那一条（133 号票）：项目的服务（入口、在不在线） */
  service?: ProjectServiceView;
}

/** 服务的样子 → 运营方案那一行的状态色 */
const SERVICE_ROW_STATUS = { online: "running", busy: "running", offline: "paused", withdrawn: "paused", failed: "failed", manual: "manual" } as const;

/** 服务那一条的状态（133 号票）：照项目的服务现算；还没收到的写"状态未知" */
function serviceRow(state: UiState, projectId: string, item: ProjectOperationItem, base: Omit<OperationRow, "status" | "statusText">): OperationRow {
  if (item.failed !== undefined) return { ...base, status: "failed", statusText: t("state.operations.status.failed"), detail: item.failed };
  const view = serviceOfItem(state, projectId, item.key);
  if (!view) return { ...base, status: "paused", statusText: t("state.operations.status.unknown") };
  const s = serviceStateText(view);
  return { ...base, service: view, status: SERVICE_ROW_STATUS[s.kind], statusText: s.text, ...(s.detail ? { detail: s.detail } : {}) };
}

/** 某个任务名下的触发登记（定时、事件触发的任务有一个） */
const jobOfTask = (state: UiState, taskId: string): ScheduledJob | undefined => Object.values(state.scheduledJobs).find((j) => j.ownerTaskId === taskId);

/** 一条的状态 */
export function operationRow(state: UiState, item: ProjectOperationItem, projectId = ""): OperationRow {
  if (item.service) return serviceRow(state, projectId, item, { item, howText: item.service.web ? t("state.operations.serviceWeb", { app: item.service.app }) : t("state.operations.serviceNoWeb") });
  const approach = item.steps ? t("state.operations.approachSteps", { approach: OPERATION_APPROACH_LABEL[item.approach], count: item.steps }) : OPERATION_APPROACH_LABEL[item.approach];
  const howText = `${item.automatic ? `${approach} · ` : ""}${capabilitiesText(item.capabilities)}`;
  const base = { item, howText, ...(item.taskId ? { taskId: item.taskId } : {}) };
  if (!item.automatic) return { ...base, status: "manual", statusText: t("state.operations.status.manual"), detail: `${OPERATIONS_MANUAL_PREFIX}${item.manual ?? item.triggerText}` };
  if (item.failed !== undefined || item.taskId === undefined) return { ...base, status: "failed", statusText: t("state.operations.status.failed"), detail: item.failed ?? t("state.operations.noTask") };
  const task = state.tasks[item.taskId];
  if (task && ENDED_TASK_STATES.includes(task.state)) return { ...base, status: "ended", statusText: t("state.operations.status.ended", { state: TASK_STATE_LABEL[task.state] }) };
  const job = jobOfTask(state, item.taskId);
  if (job?.state === "paused") return { ...base, status: "paused", statusText: scheduledJobStatusText(job) };
  if (job?.state === "cancelled") return { ...base, status: "ended", statusText: t("state.operations.status.cancelled") };
  return { ...base, status: "running", statusText: t("state.operations.status.running"), ...(job?.nextAt ? { nextAt: job.nextAt } : {}) };
}

/** 项目页"运营方案"一节：现在生效的每一条（没有运营方案的是空的） */
export function projectOperationRows(state: UiState, project: Pick<Project, "id" | "operations">): OperationRow[] {
  return (project.operations?.items ?? []).map((item) => operationRow(state, item, project.id));
}

/** 这个项目的"运营方案变更"卡（项目页运营方案一节下面列着），先提的在前 */
export function projectOperationsChangeCards(state: UiState, projectId: string): string[] {
  return Object.values(state.cards)
    .map((s) => s.card)
    .filter((c) => c.type === "operations_change" && (c.payload as Partial<OperationsChangeCardPayload>).projectId === projectId)
    .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((c) => c.id);
}

/** "运营方案变更"卡上的一组 */
export interface OperationChangeGroup {
  kind: "added" | "changed" | "removed" | "restored";
  items: Array<{ key: string; after: OperationItem; before?: OperationItem; inPlace?: boolean }>;
}

/** "运营方案变更"卡的差异：按加上、改了、去掉、重新开起来分组（空的组不列）；照旧的另列 */
export function operationsChangeGroups(p: OperationsChangeCardPayload): OperationChangeGroup[] {
  const groups: OperationChangeGroup[] = [
    { kind: "added", items: p.added.map((i) => ({ key: i.key, after: i })) },
    { kind: "changed", items: p.changed.map((c) => ({ key: c.after.key, after: c.after, before: c.before, inPlace: c.inPlace })) },
    { kind: "removed", items: p.removed.map((i) => ({ key: i.key, after: i })) },
    { kind: "restored", items: p.restored.map((i) => ({ key: i.key, after: i })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** 一条要的能力写成一句话 */
const caps = (i: OperationItem) => capabilitiesText(i.capabilities);

/** 改了的一条，改了哪几处（给人看的）："时间：每天 08:00 → 每天 07:00" */
export function operationChangedFields(before: OperationItem, after: OperationItem): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(t("state.operations.changed.name", { before: before.name, after: after.name }));
  if (before.triggerText !== after.triggerText && !after.service) out.push(t("state.operations.changed.trigger", { before: before.triggerText, after: after.triggerText }));
  if (before.approach !== after.approach) out.push(t("state.operations.changed.approach", { before: OPERATION_APPROACH_LABEL[before.approach], after: OPERATION_APPROACH_LABEL[after.approach] }));
  if (before.instructions !== after.instructions) out.push(t("state.operations.changed.instructions"));
  if (caps(before) !== caps(after)) out.push(t("state.operations.changed.capabilities", { before: caps(before), after: caps(after) }));
  if ((before.onFailure ?? "") !== (after.onFailure ?? "")) out.push(t("state.operations.changed.onFailure"));
  if (JSON.stringify(before.workflow?.steps.map((s) => [s.tool, s.args])) !== JSON.stringify(after.workflow?.steps.map((s) => [s.tool, s.args]))) out.push(t("state.operations.changed.workflow"));
  if (before.service && after.service) out.push(...serviceChangedFields(before.service, after.service));
  return out.length > 0 ? out : [t("state.operations.changed.wording")];
}
