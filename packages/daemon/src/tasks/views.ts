// 任务模块的派生视图（ergou.db，规格第 4 节"看板""计划与阶段"）：
// - tasks：每个任务的最新状态（看板频道上的 task 事件，按 id 留最后一条）；
// - task_briefs：每个任务最新的任务书；
// - task_plans：每一版计划（待确认 / 已确认 / 已打回），确认的那份是勾掉、收窄之后的。
import { CHANNELS, EVENT_TYPES, type Plan, type Task, type TaskEventPayload } from "@ergou/protocol";
import type { DerivedView, StoredEvent } from "../events/event-store.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import { type PlanDecidedPayload, type PlanSubmittedPayload, type TaskBrief, type TaskBriefPayload, TASK_EVENTS, TASKS_CHANNEL } from "./events.ts";

export const tasksView: DerivedView = {
  name: "tasks",
  create: (db) => {
    createTables(db);
    // 12 号票建的表没有 queued_seq（13 号票加的）：补上这一列（之前排队的按建出的先后）
    if (!db.all<{ name: string }>("PRAGMA table_info(tasks)").some((c) => c.name === "queued_seq")) db.exec("ALTER TABLE tasks ADD COLUMN queued_seq INTEGER");
  },
  clear: (db) => db.exec("DELETE FROM tasks; DELETE FROM task_briefs; DELETE FROM task_plans;"),
  apply: applyTaskEvent,
};

function createTables(db: Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        maintainer_id TEXT NOT NULL,
        state TEXT NOT NULL,
        task TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        queued_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_briefs (
        task_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        brief TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_plans (
        plan_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        card_id TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS task_plans_by_task ON task_plans (task_id, revision);
    `);
}

function applyTaskEvent(db: Database, event: StoredEvent): void {
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
      const { task, from } = event.payload as TaskEventPayload;
      // 进入排队的先后（13 号票：名额空出时排在最前的先开始）：从别的状态转进排队中时记下
      const queuedSeq = task.state === "queued" && from !== "queued" ? event.globalSeq : null;
      db.run(
        `INSERT INTO tasks (task_id, maintainer_id, state, task, created_seq, queued_seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET state = excluded.state, task = excluded.task, queued_seq = COALESCE(excluded.queued_seq, tasks.queued_seq)`,
        task.id,
        task.maintainerId,
        task.state,
        JSON.stringify(task),
        event.globalSeq,
        queuedSeq,
      );
      return;
    }
    if (event.channel !== TASKS_CHANNEL) return;
    switch (event.type) {
      case TASK_EVENTS.briefWritten: {
        const p = event.payload as TaskBriefPayload;
        db.run(
          `INSERT INTO task_briefs (task_id, revision, brief) VALUES (?, ?, ?)
           ON CONFLICT (task_id) DO UPDATE SET revision = excluded.revision, brief = excluded.brief`,
          p.taskId,
          p.revision,
          JSON.stringify(p.brief),
        );
        return;
      }
      case TASK_EVENTS.planSubmitted: {
        const p = event.payload as PlanSubmittedPayload;
        db.run(
          "INSERT INTO task_plans (plan_id, task_id, revision, status, plan, card_id) VALUES (?, ?, ?, 'pending', ?, ?)",
          p.planId,
          p.taskId,
          p.revision,
          JSON.stringify(p.plan),
          p.cardId,
        );
        return;
      }
      case TASK_EVENTS.planDecided: {
        const p = event.payload as PlanDecidedPayload;
        if (p.decision === "confirmed" && p.plan) {
          db.run("UPDATE task_plans SET status = 'confirmed', plan = ?, decided_at = ? WHERE plan_id = ?", JSON.stringify(p.plan), p.time, p.planId);
        } else {
          db.run("UPDATE task_plans SET status = 'rejected', decided_at = ? WHERE plan_id = ?", p.time, p.planId);
        }
        return;
      }
      default:
        return;
    }
}

export function getTask(db: ReadonlyDatabase, taskId: string): Task | undefined {
  const row = db.get<{ task: string }>("SELECT task FROM tasks WHERE task_id = ?", taskId);
  return row && (JSON.parse(row.task) as Task);
}

/** 某个维护者执行的任务（12 号票：任务自己的维护者，一个维护者一个任务） */
export function taskOfMaintainer(db: ReadonlyDatabase, maintainerId: string): Task | undefined {
  const row = db.get<{ task: string }>("SELECT task FROM tasks WHERE maintainer_id = ? ORDER BY created_seq DESC LIMIT 1", maintainerId);
  return row && (JSON.parse(row.task) as Task);
}

/** 全部任务，先建的在前 */
export function listTasks(db: ReadonlyDatabase): Task[] {
  return db.all<{ task: string }>("SELECT task FROM tasks ORDER BY created_seq").map((row) => JSON.parse(row.task) as Task);
}

/** 排队中的任务，按进入排队的先后 */
export function queuedTasks(db: ReadonlyDatabase): Task[] {
  return db.all<{ task: string }>("SELECT task FROM tasks WHERE state = 'queued' ORDER BY queued_seq, created_seq").map((row) => JSON.parse(row.task) as Task);
}

/** 建过多少个任务（新任务的编号接着往下排） */
export function countTasks(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks")?.n ?? 0);
}

export function getBrief(db: ReadonlyDatabase, taskId: string): { brief: TaskBrief; revision: number } | undefined {
  const row = db.get<{ brief: string; revision: number }>("SELECT brief, revision FROM task_briefs WHERE task_id = ?", taskId);
  return row && { brief: JSON.parse(row.brief) as TaskBrief, revision: Number(row.revision) };
}

export type PlanStatus = "pending" | "confirmed" | "rejected";

export interface StoredPlan {
  planId: string;
  taskId: string;
  revision: number;
  status: PlanStatus;
  /** 确认的计划是勾掉、收窄之后的那份 */
  plan: Plan;
  cardId: string;
  decidedAt?: string;
}

interface PlanRow {
  plan_id: string;
  task_id: string;
  revision: number;
  status: PlanStatus;
  plan: string;
  card_id: string;
  decided_at: string | null;
}

function toPlan(row: PlanRow): StoredPlan {
  return {
    planId: row.plan_id,
    taskId: row.task_id,
    revision: Number(row.revision),
    status: row.status,
    plan: JSON.parse(row.plan) as Plan,
    cardId: row.card_id,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
  };
}

export function getPlan(db: ReadonlyDatabase, planId: string): StoredPlan | undefined {
  const row = db.get<PlanRow>("SELECT * FROM task_plans WHERE plan_id = ?", planId);
  return row && toPlan(row);
}

/** 全部计划（各个任务的各版），先提交的在前 */
export function listPlans(db: ReadonlyDatabase): StoredPlan[] {
  return db.all<PlanRow>("SELECT * FROM task_plans ORDER BY task_id, revision").map(toPlan);
}

/** 某个任务最新的一版计划 */
export function latestPlan(db: ReadonlyDatabase, taskId: string): StoredPlan | undefined {
  const row = db.get<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1", taskId);
  return row && toPlan(row);
}
