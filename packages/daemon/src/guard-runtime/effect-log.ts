// 效果日志（规格第 9 节）：ergou.db 的派生视图，由 guard 频道上的 effect_recorded 事件归并。
// 只有执行成功的调用才追加：`{序号, 任务, 阶段, agent, 工具或伪工具, 规范化参数, 效果摘要, 时间}`，再加上会话段。
// 时序规则和授权项计次只看它（判定时按范围取：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话的）。
import type { DerivedView } from "../events/event-store.ts";
import type { EffectRecord } from "../guard/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";

export const effectLogView: DerivedView = {
  name: "effect_log",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS effect_log (
        seq INTEGER PRIMARY KEY,
        task_id TEXT,
        stage_id TEXT,
        agent_id TEXT NOT NULL,
        segment_id TEXT,
        tool TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS effect_log_by_task ON effect_log (task_id, seq);
      CREATE INDEX IF NOT EXISTS effect_log_by_segment ON effect_log (agent_id, segment_id, seq);
    `),
  clear: (db) => db.exec("DELETE FROM effect_log"),
  apply(db, event) {
    if (event.channel !== GUARD_CHANNEL || event.type !== GUARD_EVENTS.effectRecorded) return;
    for (const record of (event.payload as EffectRecordedPayload).records) {
      db.run(
        "INSERT INTO effect_log (seq, task_id, stage_id, agent_id, segment_id, tool, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
        record.seq,
        record.taskId,
        record.stageId,
        record.agentId,
        record.segmentId ?? null,
        record.tool,
        JSON.stringify(record),
      );
    }
  },
};

/** 效果日志的范围：任务里是这个任务；不属于任务的是某个 agent 的某段会话 */
export type EffectScope = { taskId: string } | { taskId: null; agentId: string; segmentId: string | undefined };

/** 范围里的效果，按序号 */
export function listEffects(db: ReadonlyDatabase, scope: EffectScope): EffectRecord[] {
  const rows =
    scope.taskId !== null
      ? db.all<{ record: string }>("SELECT record FROM effect_log WHERE task_id = ? ORDER BY seq", scope.taskId)
      : db.all<{ record: string }>(
          "SELECT record FROM effect_log WHERE task_id IS NULL AND agent_id = ? AND segment_id IS ? ORDER BY seq",
          scope.agentId,
          scope.segmentId ?? null,
        );
  return rows.map((row) => JSON.parse(row.record) as EffectRecord);
}

/** 下一条效果的序号（全局从 1 起连续） */
export function nextEffectSeq(db: ReadonlyDatabase): number {
  return Number(db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM effect_log")?.seq ?? 0) + 1;
}
