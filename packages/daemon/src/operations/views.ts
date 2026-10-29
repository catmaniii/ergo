// 运营方案（130 号票）的派生视图：operations 频道上每一份运营方案一行（交上来的、用户的决定）。项目上现在生效的那一版在
// 项目列表频道的 project 事件里（Project.operations），不在这里。删掉的项目的行照留（事件换成了删除标记的不再更新）。
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload, type OperationsProposedPayload } from "./events.ts";

export const operationsView: DerivedView = {
  name: "project_operations",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_operations (
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        proposed TEXT NOT NULL,
        decided TEXT,
        PRIMARY KEY (project_id, revision)
      );
    `);
  },
  clear(db) {
    db.exec("DELETE FROM project_operations;");
  },
  apply(db, event) {
    if (event.channel !== OPERATIONS_CHANNEL) return;
    if (event.type === OPERATIONS_EVENTS.proposed) {
      const p = event.payload as Partial<OperationsProposedPayload>;
      if (typeof p.projectId !== "string" || typeof p.revision !== "number") return;
      db.run("INSERT OR REPLACE INTO project_operations (project_id, revision, proposed, decided) VALUES (?, ?, ?, NULL)", p.projectId, p.revision, JSON.stringify(p));
    } else if (event.type === OPERATIONS_EVENTS.decided) {
      const p = event.payload as Partial<OperationsDecidedPayload>;
      if (typeof p.projectId !== "string" || typeof p.revision !== "number") return;
      db.run("UPDATE project_operations SET decided = ? WHERE project_id = ? AND revision = ?", JSON.stringify(p), p.projectId, p.revision);
    }
  },
};

export interface OperationsRow {
  proposed: OperationsProposedPayload;
  decided?: OperationsDecidedPayload;
}

const rowOf = (row: { proposed: string; decided: string | null }): OperationsRow => ({
  proposed: JSON.parse(row.proposed) as OperationsProposedPayload,
  ...(row.decided ? { decided: JSON.parse(row.decided) as OperationsDecidedPayload } : {}),
});

/** 一个项目交过的运营方案，按先后 */
export function operationsOfProject(db: ReadonlyDatabase, projectId: string): OperationsRow[] {
  return db.all<{ proposed: string; decided: string | null }>("SELECT proposed, decided FROM project_operations WHERE project_id = ? ORDER BY revision", projectId).map(rowOf);
}

/** 一个项目的第几份运营方案 */
export function operationsRevision(db: ReadonlyDatabase, projectId: string, revision: number): OperationsRow | undefined {
  const row = db.get<{ proposed: string; decided: string | null }>("SELECT proposed, decided FROM project_operations WHERE project_id = ? AND revision = ?", projectId, revision);
  return row && rowOf(row);
}
