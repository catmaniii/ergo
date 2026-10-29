// 范围记录的派生视图（ergo.db，18 号票）：scope_records，每条范围记录一行（项目列表频道、任务看板频道上的 scope_record 事件）。
// "近期范围记录"（每次唤起维护者时拼到系统提示末尾的最近 5 条）、项目档案和产出区里文件的对账都从这里取。
// 删除项目时项目的范围记录被改写成删除标记（"删除参与方"登记表里范围审视的那一份，purge.ts），派生视图整体重放时跟着变；彻底删除改写过的记录另追加一条新版本
// （同一个 id），这里换成新的内容。
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type ScopeRecord, type ScopeRecordEventPayload } from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

/** 范围记录在哪些频道上：项目维护者的在项目列表频道，不属于项目的任务的在任务看板频道 */
export const SCOPE_RECORD_CHANNELS: readonly string[] = [CHANNELS.projects, CHANNELS.board];

export const scopeRecordsView: DerivedView = {
  name: "scope_records",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scope_records (
        id TEXT PRIMARY KEY,
        maintainer_id TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        record TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scope_records_by_maintainer ON scope_records (maintainer_id, global_seq);
    `);
  },
  clear(db) {
    db.exec("DELETE FROM scope_records");
  },
  apply(db, event) {
    if (event.type !== EVENT_TYPES.scopeRecord || !SCOPE_RECORD_CHANNELS.includes(event.channel) || isDeletedEventPayload(event.payload)) return;
    const { record } = event.payload as ScopeRecordEventPayload;
    db.run(
      // 同一条记录改写后追加的新版本（彻底删除）：只换内容，先后还按第一次记下时的
      "INSERT INTO scope_records (id, maintainer_id, project_id, task_id, record, global_seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      record.id,
      record.maintainerId,
      record.projectId ?? null,
      record.taskId ?? null,
      JSON.stringify(record),
      event.globalSeq,
    );
  },
};

const parse = (row: { record: string }) => JSON.parse(row.record) as ScopeRecord;

/** 某个维护者最近的几条范围记录，越早的在前 */
export function recentScopeRecords(db: ReadonlyDatabase, maintainerId: string, limit: number): ScopeRecord[] {
  return db.all<{ record: string }>("SELECT record FROM scope_records WHERE maintainer_id = ? ORDER BY global_seq DESC LIMIT ?", maintainerId, limit).map(parse).toReversed();
}

/** 全部范围记录，按先后（启动时和项目档案、产出区里的文件对账） */
export function allScopeRecords(db: ReadonlyDatabase): ScopeRecord[] {
  return db.all<{ record: string }>("SELECT record FROM scope_records ORDER BY global_seq").map(parse);
}
