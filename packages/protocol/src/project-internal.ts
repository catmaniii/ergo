// 项目内部（64 号票，2026-10-09 用户定，ADR-0023）：项目内部任务是项目的维护者在自己项目里发起（或秘书替用户在这个项目里建）、
// 由它执行的流程或长程任务（代码维护：升级依赖、重构、按固定步骤发版……）。跟着它的东西——待我处理事项、它计划里的定时作业、
// 项目的维护者给的建议卡——都带同一个标记 internal（属于哪个项目，schema.ts 的 ProjectInternal）。
// 只在项目内部看得到：不上全局任务看板，秘书看不到细节、检索不到它们的记录（用户自己说过的话除外）；在项目页和项目的维护者会话里看得到，
// 要用户处理的照常进待我处理，来源写明"项目「X」内部"。凡是列任务、列事项、列作业、检索的地方，判断只用这里的 isProjectInternal。
import { t } from "./i18n/runtime.ts";
import type { InboxOrigin, ProjectInternal } from "./schema.ts";

/** 这条东西（任务、待我处理事项、定时作业、建议卡的负载……）是不是某个项目内部的 */
export function isProjectInternal(thing: { internal?: ProjectInternal | undefined } | undefined | null): boolean {
  return thing?.internal !== undefined;
}

/** 某个项目内部的：project 是项目编号 */
export function isInternalTo(thing: { internal?: ProjectInternal | undefined } | undefined | null, projectId: string): boolean {
  return thing?.internal?.projectId === projectId;
}

/** "项目「X」内部"：项目内部的东西在待我处理、审批卡、项目页上的标注 */
export function internalScopeLabel(projectName: string): string {
  return t("protocol.projectInternal.scope", { name: projectName });
}

/** 带上标记（不是项目内部的什么也不加）：放进待我处理事项、定时作业时展开用 */
export function internalMark(internal: ProjectInternal | undefined): { internal?: ProjectInternal } {
  return internal === undefined ? {} : { internal };
}

/**
 * 任务的事项从哪儿来：来源"任务「T」"；项目内部任务写明"项目「X」内部 · 任务「T」"，并带上标记（秘书看不到它的细节）；
 * 105 号票起还记下任务编号（origin，待我处理里"去看看 ›"去这个任务的整页），more 是要一起记的（阶段、那次调用）。
 * 建待我处理事项时展开进去：inbox.buildAdd({ ..., ...taskInboxOrigin(task) })
 */
export function taskInboxOrigin(
  task: { id: string; title: string; internal?: ProjectInternal | undefined },
  more: Omit<InboxOrigin, "taskId" | "projectId"> = {},
): { source: string; internal?: ProjectInternal; origin: InboxOrigin } {
  const own = t("protocol.projectInternal.task", { title: task.title });
  const origin: InboxOrigin = { taskId: task.id, ...(task.internal === undefined ? {} : { projectId: task.internal.projectId }), ...more };
  return task.internal === undefined ? { source: own, origin } : { source: t("protocol.projectInternal.source", { scope: internalScopeLabel(task.internal.projectName), own }), internal: task.internal, origin };
}

/**
 * 运营方案建的内部任务也上任务看板（141 号票，2026-10-18 用户定"显示，只能暂停、恢复"）：项目运营方案里的一条生效成的内部任务
 * （origin 是 operations）在任务看板对应的组里（运营中的定时、事件触发的在运营中，某个时间做一次的、做着的、结束了的照它们的状态），
 * 卡上标出属于哪个项目；秘书的查看板、看板变化也列出来、标项目名（秘书的任务工具照旧认不出它们）。别的内部任务照旧只在项目页上
 * （ADR-0023）。看板（前端、秘书看到的）只用这一个判断
 */
export function internalTaskOnBoard(task: { internal?: ProjectInternal | undefined; origin?: string | undefined }): boolean {
  return task.internal !== undefined && task.origin === "operations";
}

/** 任务上不上任务看板：不是项目内部的都上；项目内部的只有运营方案建的（internalTaskOnBoard） */
export function taskOnBoard(task: { internal?: ProjectInternal | undefined; origin?: string | undefined }): boolean {
  return task.internal === undefined || internalTaskOnBoard(task);
}

/** 运营方案里的一条只能暂停、恢复时的说明（菜单里取消、归档换成它，守护进程拒绝用户的取消、归档也是这句） */
export function operationsItemLockText(projectName: string): string {
  return t("protocol.projectInternal.operationsLock", { name: projectName });
}

/**
 * 用户对这个任务是不是只能暂停、恢复（141 号票）：它是项目现在生效的运营方案里的一条（方案里绑着它），项目没归档——取消、归档换成
 * operationsItemLockText 那句（点了进项目维护者的会话），守护进程同样拒绝用户的取消、归档。运营方案变更确认后去掉的那条照变更流程
 * 取消，不受这条限制；去掉了的（不再绑在现在的方案里）、项目归档了的不限。不限的是 undefined
 */
export function operationsItemLock(
  task: { id: string; internal?: ProjectInternal | undefined },
  project: { id: string; name: string; state: string; operations?: { items: ReadonlyArray<{ taskId?: string | undefined }> } | undefined } | undefined,
): string | undefined {
  if (!task.internal || !project || project.id !== task.internal.projectId || project.state === "archived") return undefined;
  return project.operations?.items.some((i) => i.taskId === task.id) ? operationsItemLockText(project.name) : undefined;
}
