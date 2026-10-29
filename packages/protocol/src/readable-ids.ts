// 给用户看的编号（159 号票，2026-10-18 用户定）：任务、维护者、项目、工单、定时作业不只写 t-3、tm-2 这种编号，带上简短描述；
// 写法统一成仓库里原来的"编号「简短描述」"（163 号票，用户定）——"t-3「给记账本加周报」"、"tm-2「记账本的任务维护者」"，
// 编号和「之间不空格；取不到的（删掉了的）写"t-3（已删除）"。句子里照原来的写法前面带上是什么（"任务 t-3「…」""工单 wo-3「…」"）。
// 前端按状态层现取的名字拼（名字变了跟着变，state/readable-ids.ts），守护进程拼给用户看的句子时按当时的名字拼。
// 给 agent 看的上下文、工具参数照旧只用编号，不经这里。纯函数，不引用 TypeBox。

import { followLocale, t } from "./i18n/runtime.ts";

/** 描述里的名字最多几个字，多的截掉、加"…" */
export const ID_DESCRIPTION_MAX = 24;

/** 取不到（删掉了的）时编号后面的说明（跟着当前语言，followLocale） */
export let DELETED_ID_NOTE = "";
followLocale(() => {
  DELETED_ID_NOTE = t("protocol.readableIds.deleted");
});

/** 名字压成一行（连续空白并成一个空格），超过 ID_DESCRIPTION_MAX 个字的截短加"…" */
export function shortDescription(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line.length > ID_DESCRIPTION_MAX ? `${line.slice(0, ID_DESCRIPTION_MAX)}…` : line;
}

/** "t-3「给记账本加周报」"：描述照给的写（压成一行，不截短）；描述是空的只写编号 */
export function idLabel(id: string, description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return line ? t("protocol.readableIds.label", { id, name: line }) : id;
}

/** 编号加名字（任务标题、项目名、工单标题……），名字太长的截短 */
export function namedIdLabel(id: string, name: string): string {
  return idLabel(id, shortDescription(name));
}

/** 取不到的："t-3（已删除）" */
export function deletedIdLabel(id: string): string {
  return `${id}${DELETED_ID_NOTE}`;
}

/** 维护者属于谁：任务自己的、项目的、迁移来的定时作业自己的 */
export interface MaintainerOwner {
  readonly kind: "task" | "project" | "job";
  /** 任务标题、项目名、定时作业的名字 */
  readonly name: string;
}

/** 维护者的描述："记账本的任务维护者"、"记账本的项目维护者"（名字截短，后缀照写） */
export function maintainerDescription(owner: MaintainerOwner): string {
  const name = shortDescription(owner.name);
  if (owner.kind === "task") return t("protocol.readableIds.maintainer.task", { name });
  return owner.kind === "project" ? t("protocol.readableIds.maintainer.project", { name }) : t("protocol.readableIds.maintainer.job", { name });
}

/** "tm-2「记账本的任务维护者」" */
export function maintainerIdLabel(id: string, owner: MaintainerOwner): string {
  return idLabel(id, maintainerDescription(owner));
}
