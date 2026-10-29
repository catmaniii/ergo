// 项目的派生视图（规格第 4 节）：项目列表频道上的 project 事件归并成每个项目的最新状态，charters 频道上的立项书
// 归并成每个项目最新的一版，立项要求变更（125 号票）、规范改写（261 号票，standards 频道）每次一行。删掉的项目留一行（标 deleted），编号不会被新项目重用，维护者 id 也认得出"属于已删除的项目"。
import { applyStandardChange, CHANNELS, EVENT_TYPES, type Project, type ProjectEventPayload, type StandardOverrideEntry } from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import {
  CHARTER_EVENTS,
  type CharterChangeDecidedPayload,
  type CharterChangeProposedPayload,
  CHARTERS_CHANNEL,
  type CharterSubmittedPayload,
  STANDARD_EVENTS,
  type StandardChangeDecidedPayload,
  type StandardChangeProposedPayload,
  STANDARDS_CHANNEL,
} from "./events.ts";

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
      CREATE TABLE IF NOT EXISTS project_charter_changes (
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        proposed TEXT NOT NULL,
        decided TEXT,
        PRIMARY KEY (project_id, revision)
      );
      CREATE TABLE IF NOT EXISTS project_standard_changes (
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        proposed TEXT NOT NULL,
        decided TEXT,
        PRIMARY KEY (project_id, revision)
      );
    `);
  },
  clear(db) {
    db.exec("DELETE FROM projects; DELETE FROM project_charters; DELETE FROM project_charter_changes; DELETE FROM project_standard_changes;");
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
      return;
    }
    // 立项要求变更（125 号票）：提出的一行，用户确认或拒绝了记上决定
    if (event.channel === CHARTERS_CHANNEL && event.type === CHARTER_EVENTS.changeProposed) {
      const p = event.payload as CharterChangeProposedPayload;
      db.run("INSERT OR REPLACE INTO project_charter_changes (project_id, revision, proposed, decided) VALUES (?, ?, ?, NULL)", p.projectId, p.revision, JSON.stringify(p));
      return;
    }
    if (event.channel === CHARTERS_CHANNEL && event.type === CHARTER_EVENTS.changeDecided) {
      const p = event.payload as CharterChangeDecidedPayload;
      db.run("UPDATE project_charter_changes SET decided = ? WHERE project_id = ? AND revision = ?", JSON.stringify(p), p.projectId, p.revision);
      return;
    }
    // 规范改写（261 号票）：同上，提出的一行，用户确认或拒绝了记上决定
    if (event.channel === STANDARDS_CHANNEL && event.type === STANDARD_EVENTS.changeProposed) {
      const p = event.payload as StandardChangeProposedPayload;
      db.run("INSERT OR REPLACE INTO project_standard_changes (project_id, revision, proposed, decided) VALUES (?, ?, ?, NULL)", p.projectId, p.revision, JSON.stringify(p));
      return;
    }
    if (event.channel === STANDARDS_CHANNEL && event.type === STANDARD_EVENTS.changeDecided) {
      const p = event.payload as StandardChangeDecidedPayload;
      db.run("UPDATE project_standard_changes SET decided = ? WHERE project_id = ? AND revision = ?", JSON.stringify(p), p.projectId, p.revision);
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

/** 一个没删掉的项目（删掉了的、没有的是 undefined；项目服务的 get 就是它） */
export function getProject(db: ReadonlyDatabase, projectId: string): Project | undefined {
  const row = getProjectRow(db, projectId);
  return row && !row.deleted ? row.project : undefined;
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

/** 一个项目的立项要求变更（125 号票）：按先后，每次提出的和用户的决定（还没决定的没有） */
export function charterChanges(db: ReadonlyDatabase, projectId: string): Array<{ proposed: CharterChangeProposedPayload; decided?: CharterChangeDecidedPayload }> {
  return db
    .all<{ proposed: string; decided: string | null }>("SELECT proposed, decided FROM project_charter_changes WHERE project_id = ? ORDER BY revision", projectId)
    .map((row) => ({ proposed: JSON.parse(row.proposed) as CharterChangeProposedPayload, ...(row.decided ? { decided: JSON.parse(row.decided) as CharterChangeDecidedPayload } : {}) }));
}

/** 一个项目的规范改写（261 号票）：按先后，每次提出的和用户的决定（还没决定的没有） */
export function standardChanges(db: ReadonlyDatabase, projectId: string): Array<{ proposed: StandardChangeProposedPayload; decided?: StandardChangeDecidedPayload }> {
  return db
    .all<{ proposed: string; decided: string | null }>("SELECT proposed, decided FROM project_standard_changes WHERE project_id = ? ORDER BY revision", projectId)
    .map((row) => ({ proposed: JSON.parse(row.proposed) as StandardChangeProposedPayload, ...(row.decided ? { decided: JSON.parse(row.decided) as StandardChangeDecidedPayload } : {}) }));
}

/**
 * 一个项目现在生效的规范改写（261 号票）：用户确认了的每一次按先后合起来（applyStandardChange），每条带着提它那一次说的为什么。
 * 没有改写是空的
 */
export function standardOverrides(db: ReadonlyDatabase, projectId: string): Array<StandardOverrideEntry & { why: string }> {
  const whys = new Map<number, string>();
  let entries: StandardOverrideEntry[] = [];
  for (const { decided } of standardChanges(db, projectId)) {
    if (!decided?.confirmed) continue;
    whys.set(decided.revision, decided.why);
    entries = applyStandardChange(entries, decided.items, { revision: decided.revision, confirmedAt: decided.time });
  }
  return entries.map((e) => ({ ...e, why: whys.get(e.revision) ?? "" }));
}
