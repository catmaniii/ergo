// 项目列表的只读视图（278 号票，方案 C，docs/research/29-plugin-expansion-review.html）：按编号、按维护者、按任务、按名字找没删掉的项目，
// 项目档案各文件在哪。只读事件存储的派生视图（views.ts），不要项目服务，谁都能建一份——任务模块建在项目系统之前（项目系统要任务模块），
// 它要的 TaskProjects（核对项目名、认成编号、任务属于哪个项目、内部任务在哪个项目）就从这里拿，"任务 → 项目"不用再后接线。
// 项目服务（projects.ts）里同名的几样也是它。
import { type Project, type Task, hasOwnMaintainer, t } from "@ergo/protocol";
import { RequestRejected, UnknownProjects } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { TaskProjects } from "../tasks/tasks.ts";
import type { ProjectLookup, ScopeReviewProjects } from "./api.ts";
import { projectRecordsPaths, type ProjectRecordsPaths } from "./records.ts";
import { getProject, getProjectRow, listProjects, projectNamed, projectOfMaintainer } from "./views.ts";

/** 项目列表的只读视图：ProjectLookup（触发底座、计划里涉及的项目的核对）、ScopeReviewProjects（范围审视）、TaskProjects（任务模块）都是它 */
export interface ProjectDirectory extends ProjectLookup, ScopeReviewProjects, TaskProjects {
  get(projectId: string): Project | undefined;
  /** 没删掉的项目，按建出的先后 */
  list(): Project[];
  /** 某个维护者的项目（删掉的也认：deleted 为 true） */
  ofMaintainer(maintainerId: string): { project: Project; deleted: boolean } | undefined;
  /** 某个维护者维护的、没删掉的项目 */
  maintainedBy(maintainerId: string): Project | undefined;
  /** 任务属于哪个项目（16 号票）：由这个项目的维护者执行的任务（只涉及一个项目的）；任务自己的维护者执行的、项目删掉了的没有 */
  projectOf(task: Task): Project | undefined;
  /** 项目档案各文件的位置 */
  records(projectId: string): ProjectRecordsPaths;
}

export interface ProjectDirectoryOptions {
  store: Pick<EventStore, "reader">;
  /** 数据目录的项目区（真实路径） */
  projectsDir: string;
}

export function createProjectDirectory(options: ProjectDirectoryOptions): ProjectDirectory {
  const { store, projectsDir } = options;

  const maintainedBy = (maintainerId: string): Project | undefined => {
    const found = projectOfMaintainer(store.reader, maintainerId);
    return found && !found.deleted ? found.project : undefined;
  };

  /** 项目名认成没删掉的项目 */
  const named = (names: readonly string[]) => names.map((name) => ({ name, project: projectNamed(store.reader, name) }));

  return {
    get: (projectId) => getProject(store.reader, projectId),
    list: () => listProjects(store.reader),
    ofMaintainer: (maintainerId) => projectOfMaintainer(store.reader, maintainerId),
    maintainedBy,
    projectOf: (task) => (hasOwnMaintainer(task) ? undefined : maintainedBy(task.maintainerId)),
    records: (projectId) => projectRecordsPaths(projectsDir, projectId),

    checkTaskProjects: (names) =>
      named(names).map(({ name, project }) => {
        if (!project) {
          const all = listProjects(store.reader).map((p) => p.name);
          throw new UnknownProjects(all.length > 0 ? t("projects.errors.unknownWithList", { name, list: all.join(t("pages.common.listSep")) }) : t("projects.errors.unknownNone", { name }));
        }
        if (project.state === "archived") throw new RequestRejected("not_allowed", t("projects.errors.taskArchived", { name }));
        return project.id;
      }),

    internalHost: (projectId, opts = {}) => {
      const row = getProjectRow(store.reader, projectId);
      if (!row || row.deleted) throw new RequestRejected("not_found", t("projects.errors.noSuchProject", { id: projectId }));
      const { project } = row;
      if (project.state === "archived") throw new RequestRejected("not_allowed", t("projects.errors.internalArchived", { name: project.name }));
      // 立项书确认之前不能在项目里发起任务（规格第 11 节）；只有首个建设任务例外：它在确认立项书的那一刻建出（还没建过的才算）
      const firstBuild = opts.firstBuild === true && project.buildTaskId === undefined;
      if (!project.charterConfirmed && !firstBuild) throw new RequestRejected("not_allowed", t("projects.errors.internalPreparing", { name: project.name }));
      return { id: project.id, name: project.name, maintainerId: project.maintainerId };
    },

    projectIdsOf: (names) => named(names).flatMap(({ project }) => (project ? [project.id] : [])),
  };
}
