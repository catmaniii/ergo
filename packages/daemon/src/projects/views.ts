// 项目的派生视图（规格第 4 节）：项目列表频道上的 project 事件归并成每个项目的最新状态，charters 频道上的立项书
// 归并成每个项目最新的一版。删掉的项目留一行（标 deleted），编号不会被新项目重用，维护者 id 也认得出"属于已删除的项目"。
import { CHANNELS, EVENT_TYPES, type Project, type ProjectEventPayload } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { CHARTER_EVENTS, CHARTERS_CHANNEL, type CharterSubmittedPayload } from "./events.ts";

export const projectsView: DerivedView = {
  name: "projects",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        maintainer_id TEXT NOT NULL,
        name TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        project TEXT NOT NULL,
        created_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_by_maintainer ON projects (maintainer_id);
      CREATE TABLE IF NOT EXISTS project_charters (
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        submitted TEXT NOT NULL
      );
    `);
  },
  clear(db) {
    db.exec("DELETE FROM projects; DELETE FROM project_charters;");
  },
  apply(db, event) {
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
      const { project, change } = event.payload as ProjectEventPayload;
      db.run(
        `INSERT INTO projects (id, maintainer_id, name, deleted, project, created_seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET maintainer_id = excluded.maintainer_id, name = excluded.name, deleted = excluded.deleted, project = excluded.project`,
        project.id,
        project.maintainerId,
        project.name,
        change === "deleted" ? 1 : 0,
        JSON.stringify(project),
        event.globalSeq,
      );
      return;
    }
    if (event.channel === CHARTERS_CHANNEL && event.type === CHARTER_EVENTS.submitted) {
      const p = event.payload as CharterSubmittedPayload;
      db.run(
        "INSERT INTO project_charters (project_id, revision, submitted) VALUES (?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET revision = excluded.revision, submitted = excluded.submitted",
        p.projectId,
        p.revision,
        JSON.stringify(p),
      );
    }
  },
};

interface ProjectRow {
  project: string;
  deleted: number;
}

/** 一个项目（删掉的也在，deleted 为 true） */
export function getProjectRow(db: ReadonlyDatabase, projectId: string): { project: Project; deleted: boolean } | undefined {
  const row = db.get<ProjectRow>("SELECT project, deleted FROM projects WHERE id = ?", projectId);
  return row && { project: JSON.parse(row.project) as Project, deleted: row.deleted === 1 };
}

/** 没删掉的项目，按建出的先后 */
export function listProjects(db: ReadonlyDatabase): Project[] {
  return db.all<ProjectRow>("SELECT project, deleted FROM projects WHERE deleted = 0 ORDER BY created_seq").map((r) => JSON.parse(r.project) as Project);
}

/** 建出过的项目数（删掉的也算：编号不重用） */
export function countProjects(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n ?? 0);
}

/** 某个维护者的项目（删掉的也在，deleted 为 true） */
export function projectOfMaintainer(db: ReadonlyDatabase, maintainerId: string): { project: Project; deleted: boolean } | undefined {
  const row = db.get<ProjectRow>("SELECT project, deleted FROM projects WHERE maintainer_id = ? ORDER BY created_seq DESC LIMIT 1", maintainerId);
  return row && { project: JSON.parse(row.project) as Project, deleted: row.deleted === 1 };
}

/** 没删掉的项目里有没有叫这个名字的 */
export function projectNamed(db: ReadonlyDatabase, name: string): Project | undefined {
  const row = db.get<ProjectRow>("SELECT project, deleted FROM projects WHERE deleted = 0 AND name = ?", name);
  return row && (JSON.parse(row.project) as Project);
}

/** 项目最新的一版立项书 */
export function latestCharter(db: ReadonlyDatabase, projectId: string): CharterSubmittedPayload | undefined {
  const row = db.get<{ submitted: string }>("SELECT submitted FROM project_charters WHERE project_id = ?", projectId);
  return row && (JSON.parse(row.submitted) as CharterSubmittedPayload);
}
