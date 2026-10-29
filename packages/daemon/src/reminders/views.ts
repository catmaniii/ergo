// 简单提醒的派生视图（ergo.db，规格第 4 节"提醒"）：每条提醒的最新状态。
// 任务看板频道上的 reminder 事件就是提醒的最新状态，视图按 id 留最后一条；守护进程启动时据此重新登记调度。
import { CHANNELS, EVENT_TYPES, type Reminder, type ReminderEventPayload, type ReminderStatus } from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const remindersView: DerivedView = {
  name: "reminders",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        reminder_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        next_at INTEGER,
        reminder TEXT NOT NULL,
        created_seq INTEGER NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM reminders"),
  apply(db, event) {
    if (event.channel !== CHANNELS.board || event.type !== EVENT_TYPES.reminder) return;
    const { reminder } = event.payload as ReminderEventPayload;
    db.run(
      `INSERT INTO reminders (reminder_id, status, next_at, reminder, created_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (reminder_id) DO UPDATE SET status = excluded.status, next_at = excluded.next_at, reminder = excluded.reminder`,
      reminder.id,
      reminder.status,
      reminder.nextAt === undefined ? null : new Date(reminder.nextAt).getTime(),
      JSON.stringify(reminder),
      event.globalSeq,
    );
  },
};

export function getReminder(db: ReadonlyDatabase, reminderId: string): Reminder | undefined {
  const row = db.get<{ reminder: string }>("SELECT reminder FROM reminders WHERE reminder_id = ?", reminderId);
  return row && (JSON.parse(row.reminder) as Reminder);
}

/** 某个状态的提醒（不给就是全部），先建的在前 */
export function listReminders(db: ReadonlyDatabase, status?: ReminderStatus): Reminder[] {
  const rows =
    status === undefined
      ? db.all<{ reminder: string }>("SELECT reminder FROM reminders ORDER BY created_seq")
      : db.all<{ reminder: string }>("SELECT reminder FROM reminders WHERE status = ? ORDER BY created_seq", status);
  return rows.map((row) => JSON.parse(row.reminder) as Reminder);
}

/** 建过多少条提醒（新提醒的编号接着往下排） */
export function countReminders(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")?.n ?? 0);
}
