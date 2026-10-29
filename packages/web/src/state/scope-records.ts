// 范围记录的视图（纯函数，18 号票）：简版项目页的"范围记录"一节、任务详情里的范围记录。范围变更和越界分开（各一组），
// 每组最近的在前；每条写明哪次审视的（压缩会话时、工单结束时）、属于哪张工单和哪个任务。
// 越界通知在待我处理里（通知类事项 out_of_scope），照常算未读，不在这里。
import { SCOPE_RECORD_KIND_LABEL, SCOPE_REVIEW_TRIGGER_LABEL, type ScopeRecord, type ScopeRecordKind, t } from "./protocol.ts";
import { taskLabel, workOrderLabel } from "./readable-ids.ts";
import type { UiState } from "./ui-state.ts";

export interface ScopeRecordView {
  record: ScopeRecord;
  /** "范围变更" / "越界" */
  kind: string;
  /** "工单结束时" / "压缩会话时" */
  trigger: string;
  /** 属于哪张工单、哪个任务："工单 wo-2「加周报」 · 任务 t-1「给记账本加周报」"（159 号票：编号加名字，现取；163 号票写成 t-3「标题」）；都没有时没有 */
  where: string | undefined;
}

/** 范围变更、越界各一组，最近的在前 */
export type ScopeRecordGroups = Record<ScopeRecordKind, ScopeRecordView[]>;

function viewOf(state: UiState, record: ScopeRecord): ScopeRecordView {
  const parts = [
    ...(record.workOrderId === undefined ? [] : [t("state.scopeRecords.workOrder", { label: workOrderLabel(state, record.workOrderId) })]),
    ...(record.taskId === undefined ? [] : [t("state.scopeRecords.task", { label: taskLabel(state, record.taskId) })]),
  ];
  return { record, kind: SCOPE_RECORD_KIND_LABEL[record.kind], trigger: SCOPE_REVIEW_TRIGGER_LABEL[record.trigger], where: parts.length > 0 ? parts.join(" · ") : undefined };
}

function grouped(state: UiState, keep: (record: ScopeRecord) => boolean): ScopeRecordGroups {
  const groups: ScopeRecordGroups = { scope_change: [], out_of_scope: [] };
  const records = Object.values(state.scopeRecords)
    .filter(keep)
    .toSorted((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  for (const record of records) groups[record.kind].push(viewOf(state, record));
  return groups;
}

/** 某个项目的范围记录（项目维护者的：对话段里的、各张工单里的） */
export function projectScopeRecords(state: UiState, projectId: string): ScopeRecordGroups {
  return grouped(state, (r) => r.projectId === projectId);
}

/** 某个任务的范围记录：不属于项目的任务是它自己的维护者的；项目的任务是项目维护者做它的工单时的 */
export function taskScopeRecords(state: UiState, taskId: string): ScopeRecordGroups {
  return grouped(state, (r) => r.taskId === taskId);
}
