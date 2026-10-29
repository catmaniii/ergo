// 个人档案（281 号票）的派生视图（ergo.db）：从 personal_files 频道归并。
// - personal_people：重要的人（本人那份一直在，不进这张表）；
// - personal_values：每个字段的每个值一行，现在的值 until 是空的，旧值记着到哪天为止（同一字段来了新值，上一行补上 until）；
//   撤销最近一次写入删掉那一行、上一行的 until 清空；忘掉一个字段删掉它的全部行；
// - personal_notes：记下的事；
// - personal_reminders（283）：生日、纪念日的每年提醒——哪个人哪个字段、提前几天、对应提醒插件里的哪一条；字段、人删了跟着删；
// - personal_candidates（283）：记忆管理员攒的候选（一个人被提到、或者他的一条固定信息）、合进了哪张卡、结局；
// - personal_groups（285）：用户给档案里的人选的分组；没选过的不在这张表里（按关系猜）。281–302 号票建的库里没有这张表，打开时补一遍。
// 留痕（trail）按 JSON 存在行上，档案页按它写"出处"。彻底删除改写事件后整体重放：被改写的值紧跟着就被删除事件去掉，不会露出删除标记。
import type { DerivedView, StoredEvent } from "../events/event-store.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import { isPersonGroup, type PersonGroup } from "@ergo/protocol";
import { PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, type PersonalFileTrail } from "./events.ts";

export const personalFilesView: DerivedView = {
  name: "personal_files",
  channels: [PERSONAL_FILES_CHANNEL],
  create(db) {
    const tables = ["personal_people", "personal_values", "personal_notes", "personal_reminders", "personal_candidates", "personal_groups"];
    const existed = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`, ...tables).length === tables.length;
    db.exec(`
      CREATE TABLE IF NOT EXISTS personal_people (person_id TEXT PRIMARY KEY, added_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_values (
        global_seq INTEGER PRIMARY KEY,
        person_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        since TEXT NOT NULL,
        until TEXT,
        trail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personal_values_by_field ON personal_values (person_id, field);
      CREATE TABLE IF NOT EXISTS personal_notes (
        note_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        text TEXT NOT NULL,
        date TEXT NOT NULL,
        at TEXT NOT NULL,
        trail TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_reminders (
        person_id TEXT NOT NULL,
        field TEXT NOT NULL,
        days_before INTEGER NOT NULL,
        reminder_id TEXT,
        PRIMARY KEY (person_id, field)
      );
      CREATE TABLE IF NOT EXISTS personal_candidates (
        candidate_id TEXT PRIMARY KEY,
        person_key TEXT NOT NULL,
        person_id TEXT,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL,
        relation TEXT,
        field TEXT,
        value TEXT,
        material_ids TEXT NOT NULL,
        heard TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        card_id TEXT,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personal_candidates_by_key ON personal_candidates (person_key);
      CREATE TABLE IF NOT EXISTS personal_groups (person_id TEXT PRIMARY KEY, grp TEXT NOT NULL);
    `);
    // 新建的表（第一次装上、手删过库；285 号票起升级时缺 personal_groups）：从事件日志补一遍，只读这一个频道。
    // 补之前先清空已有的几张表——重放不会先清，已有的行会和补进来的撞（UNIQUE）
    if (existed) return undefined;
    personalFilesView.clear(db);
    return "refill";
  },
  clear: (db) =>
    db.exec("DELETE FROM personal_people; DELETE FROM personal_values; DELETE FROM personal_notes; DELETE FROM personal_reminders; DELETE FROM personal_candidates; DELETE FROM personal_groups;"),
  apply(db, event) {
    if (event.channel !== PERSONAL_FILES_CHANNEL || event.type !== PERSONAL_FILE_EVENT) return;
    applyChange(db, event, event.payload as PersonalFileChange);
  },
};

function applyChange(db: Database, event: StoredEvent, change: PersonalFileChange): void {
  switch (change.change) {
    case "person_added":
      db.run("INSERT OR IGNORE INTO personal_people (person_id, added_seq) VALUES (?, ?)", change.personId, event.globalSeq);
      return;
    case "group_set":
      db.run("INSERT INTO personal_groups (person_id, grp) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET grp = excluded.grp", change.personId, change.group);
      return;
    case "field_set":
      // 本人的姓名不带值（"我的名字"是真相），只留痕
      if (change.value === undefined) return;
      db.run("UPDATE personal_values SET until = ? WHERE person_id = ? AND field = ? AND until IS NULL", event.time, change.personId, change.field);
      db.run(
        "INSERT INTO personal_values (global_seq, person_id, field, value, since, until, trail) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        event.globalSeq,
        change.personId,
        change.field,
        change.value,
        event.time,
        JSON.stringify(change.trail),
      );
      return;
    case "field_undone": {
      const current = db.get<{ global_seq: number }>("SELECT global_seq FROM personal_values WHERE person_id = ? AND field = ? AND until IS NULL", change.personId, change.field);
      if (!current) return;
      db.run("DELETE FROM personal_values WHERE global_seq = ?", current.global_seq);
      const previous = db.get<{ global_seq: number }>("SELECT global_seq FROM personal_values WHERE person_id = ? AND field = ? ORDER BY global_seq DESC LIMIT 1", change.personId, change.field);
      if (previous) db.run("UPDATE personal_values SET until = NULL WHERE global_seq = ?", previous.global_seq);
      return;
    }
    case "note_added":
      db.run(
        "INSERT OR REPLACE INTO personal_notes (note_id, person_id, text, date, at, trail, global_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        change.noteId,
        change.personId,
        change.text,
        change.date,
        event.time,
        JSON.stringify(change.trail),
        event.globalSeq,
      );
      return;
    case "field_forgotten":
      db.run("DELETE FROM personal_values WHERE person_id = ? AND field = ?", change.personId, change.field);
      db.run("DELETE FROM personal_reminders WHERE person_id = ? AND field = ?", change.personId, change.field);
      return;
    case "note_forgotten":
      db.run("DELETE FROM personal_notes WHERE note_id = ? AND person_id = ?", change.noteId, change.personId);
      return;
    case "person_forgotten":
      db.run("DELETE FROM personal_people WHERE person_id = ?", change.personId);
      db.run("DELETE FROM personal_values WHERE person_id = ?", change.personId);
      db.run("DELETE FROM personal_notes WHERE person_id = ?", change.personId);
      db.run("DELETE FROM personal_reminders WHERE person_id = ?", change.personId);
      db.run("DELETE FROM personal_candidates WHERE person_id = ?", change.personId);
      db.run("DELETE FROM personal_groups WHERE person_id = ?", change.personId);
      return;
    case "reminder_set":
      db.run(
        "INSERT INTO personal_reminders (person_id, field, days_before, reminder_id) VALUES (?, ?, ?, NULL) ON CONFLICT (person_id, field) DO UPDATE SET days_before = excluded.days_before",
        change.personId,
        change.field,
        change.daysBefore,
      );
      return;
    case "reminder_cleared":
      db.run("DELETE FROM personal_reminders WHERE person_id = ? AND field = ?", change.personId, change.field);
      return;
    case "reminder_linked":
      db.run("UPDATE personal_reminders SET reminder_id = ? WHERE person_id = ? AND field = ?", change.reminderId ?? null, change.personId, change.field);
      return;
    case "candidate_added":
      db.run(
        `INSERT OR REPLACE INTO personal_candidates (candidate_id, person_key, person_id, name, aliases, relation, field, value, material_ids, heard, origin, status, card_id, global_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        change.candidateId,
        change.personKey,
        change.personId ?? null,
        change.name,
        JSON.stringify(change.aliases),
        change.relation ?? null,
        change.field ?? null,
        change.value ?? null,
        JSON.stringify(change.materialIds),
        JSON.stringify(change.heard),
        change.origin,
        event.globalSeq,
      );
      return;
    case "candidates_carded":
      for (const id of change.candidateIds) db.run("UPDATE personal_candidates SET card_id = ? WHERE candidate_id = ?", change.cardId, id);
      return;
    case "candidates_resolved":
      for (const id of change.candidateIds) db.run("UPDATE personal_candidates SET status = ? WHERE candidate_id = ?", change.outcome, id);
      return;
  }
}

/** 视图里的一个值 */
export interface StoredValue {
  globalSeq: number;
  field: string;
  value: string;
  since: string;
  until?: string;
  trail: PersonalFileTrail;
}

/** 视图里的一件事 */
export interface StoredNote {
  noteId: string;
  text: string;
  date: string;
  at: string;
  trail: PersonalFileTrail;
  globalSeq: number;
}

/** 重要的人（按建的先后），不含本人 */
export function listPeople(reader: ReadonlyDatabase): string[] {
  return reader.all<{ person_id: string }>("SELECT person_id FROM personal_people ORDER BY added_seq").map((r) => r.person_id);
}

export function hasPerson(reader: ReadonlyDatabase, personId: string): boolean {
  return reader.get("SELECT 1 FROM personal_people WHERE person_id = ?", personId) !== undefined;
}

/** 285：用户给这个人选的分组；没选过是 undefined（按关系猜） */
export function chosenGroupOf(reader: ReadonlyDatabase, personId: string): PersonGroup | undefined {
  const row = reader.get<{ grp: string }>("SELECT grp FROM personal_groups WHERE person_id = ?", personId);
  return row !== undefined && isPersonGroup(row.grp) ? row.grp : undefined;
}

/** 一个人的全部值（每个字段新的在前） */
export function valuesOf(reader: ReadonlyDatabase, personId: string): StoredValue[] {
  return reader
    .all<{ global_seq: number; field: string; value: string; since: string; until: string | null; trail: string }>(
      "SELECT global_seq, field, value, since, until, trail FROM personal_values WHERE person_id = ? ORDER BY global_seq DESC",
      personId,
    )
    .map((r) => ({
      globalSeq: Number(r.global_seq),
      field: r.field,
      value: r.value,
      since: r.since,
      ...(r.until === null ? {} : { until: r.until }),
      trail: JSON.parse(r.trail) as PersonalFileTrail,
    }));
}

/** 一个人记下的事（事情的日期新的在前，同一天后记的在前） */
export function notesOf(reader: ReadonlyDatabase, personId: string): StoredNote[] {
  return reader
    .all<{ note_id: string; text: string; date: string; at: string; trail: string; global_seq: number }>(
      "SELECT note_id, text, date, at, trail, global_seq FROM personal_notes WHERE person_id = ? ORDER BY date DESC, global_seq DESC",
      personId,
    )
    .map((r) => ({ noteId: r.note_id, text: r.text, date: r.date, at: r.at, trail: JSON.parse(r.trail) as PersonalFileTrail, globalSeq: Number(r.global_seq) }));
}

/** 一条每年提醒的设置（283） */
export interface StoredReminder {
  personId: string;
  field: string;
  daysBefore: number;
  reminderId?: string;
}

type ReminderRow = { person_id: string; field: string; days_before: number; reminder_id: string | null };

/** 每年提醒的设置：一个人的（给了 personId），或者全部 */
export function remindersOf(reader: ReadonlyDatabase, personId?: string): StoredReminder[] {
  const rows =
    personId === undefined
      ? reader.all<ReminderRow>("SELECT person_id, field, days_before, reminder_id FROM personal_reminders ORDER BY person_id, field")
      : reader.all<ReminderRow>("SELECT person_id, field, days_before, reminder_id FROM personal_reminders WHERE person_id = ? ORDER BY field", personId);
  return rows.map((r) => ({ personId: r.person_id, field: r.field, daysBefore: Number(r.days_before), ...(r.reminder_id === null ? {} : { reminderId: r.reminder_id }) }));
}

/** 一条候选（283） */
export interface StoredCandidate {
  candidateId: string;
  personKey: string;
  personId?: string;
  name: string;
  aliases: string[];
  relation?: string;
  field?: string;
  value?: string;
  materialIds: string[];
  heard: string[];
  origin: string;
  status: "pending" | "accepted" | "rejected" | "dropped";
  cardId?: string;
  globalSeq: number;
}

/** 候选（按加进来的先后）：只要某种结局的（给了 status），或者全部 */
export function candidatesOf(reader: ReadonlyDatabase, status?: StoredCandidate["status"]): StoredCandidate[] {
  const sql = `SELECT * FROM personal_candidates${status === undefined ? "" : " WHERE status = ?"} ORDER BY global_seq`;
  const rows = status === undefined ? reader.all<Record<string, unknown>>(sql) : reader.all<Record<string, unknown>>(sql, status);
  return rows.map((r) => ({
    candidateId: String(r.candidate_id),
    personKey: String(r.person_key),
    ...(r.person_id === null ? {} : { personId: String(r.person_id) }),
    name: String(r.name),
    aliases: JSON.parse(String(r.aliases)) as string[],
    ...(r.relation === null ? {} : { relation: String(r.relation) }),
    ...(r.field === null ? {} : { field: String(r.field) }),
    ...(r.value === null ? {} : { value: String(r.value) }),
    materialIds: JSON.parse(String(r.material_ids)) as string[],
    heard: JSON.parse(String(r.heard)) as string[],
    origin: String(r.origin),
    status: String(r.status) as StoredCandidate["status"],
    ...(r.card_id === null ? {} : { cardId: String(r.card_id) }),
    globalSeq: Number(r.global_seq),
  }));
}
