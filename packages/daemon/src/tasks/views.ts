// 任务模块的派生视图（ergo.db，规格第 4 节"看板""计划与阶段"）：
// - tasks：每个任务的最新状态（看板频道上的 task 事件，按 id 留最后一条）；
// - task_briefs：每个任务最新的任务书；
// - task_plans：每一版计划（待确认 / 已确认 / 已打回；14 号票起还有计划变更提出的一版：proposed），确认的那份是勾掉、收窄之后的；
//   确认过的各版带上每项授权的授予时间和到期时间（grant_times，续期时更新）；流程（58 号票）另存流程计划（workflow：步骤和条件）；
// - task_budget：每个阶段的预算记账（14 号票）：工具调用次数、这一份预算从哪儿起算（用户让超预算的阶段接着做时重新起算：
//   工具调用次数和账本里的 token 数各记一个起算点）、超出预算时说明过进展没有。token 本身在 token 账本里（24 号票）。
import { CHANNELS, EVENT_TYPES, type Plan, type Task, type TaskEventPayload, type WorkflowPlan } from "@ergo/protocol";
import type { GrantTime } from "./plan.ts";
import type { DerivedView, StoredEvent } from "../events/event-store.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import {
  type BudgetMarkPayload,
  type BudgetResetPayload,
  type BudgetUsedPayload,
  type GrantRenewalDecidedPayload,
  type GrantTimes,
  type PlanChangeProposedPayload,
  type PlanDecidedPayload,
  type PlanRevisedPayload,
  type PlanSubmittedPayload,
  type TaskBrief,
  type TaskBriefPayload,
  TASK_EVENTS,
  TASKS_CHANNEL,
} from "./events.ts";

export const tasksView: DerivedView = {
  name: "tasks",
  create: (db) => {
    createTables(db);
    // 12 号票建的表没有 queued_seq（13 号票加的）：补上这一列（之前排队的按建出的先后）
    if (!db.all<{ name: string }>("PRAGMA table_info(tasks)").some((c) => c.name === "queued_seq")) db.exec("ALTER TABLE tasks ADD COLUMN queued_seq INTEGER");
    // 14 号票加的：确认过的各版计划里每项授权的授予时间和到期时间
    if (!db.all<{ name: string }>("PRAGMA table_info(task_plans)").some((c) => c.name === "grant_times")) db.exec("ALTER TABLE task_plans ADD COLUMN grant_times TEXT");
    // 58 号票加的：流程的计划（步骤和条件）
    if (!db.all<{ name: string }>("PRAGMA table_info(task_plans)").some((c) => c.name === "workflow")) db.exec("ALTER TABLE task_plans ADD COLUMN workflow TEXT");
  },
  clear: (db) => db.exec("DELETE FROM tasks; DELETE FROM task_briefs; DELETE FROM task_plans; DELETE FROM task_budget;"),
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
      CREATE TABLE IF NOT EXISTS task_budget (
        task_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        base_tokens INTEGER NOT NULL DEFAULT 0,
        base_tool_calls INTEGER NOT NULL DEFAULT 0,
        warned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, stage_id)
      );
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
          "INSERT INTO task_plans (plan_id, task_id, revision, status, plan, card_id, workflow) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p.planId,
          p.taskId,
          p.revision,
          p.refused ? "refused" : "pending",
          JSON.stringify(p.plan),
          p.cardId,
          p.workflow === undefined ? null : JSON.stringify(p.workflow),
        );
        return;
      }
      case TASK_EVENTS.planDecided: {
        const p = event.payload as PlanDecidedPayload;
        if (p.decision === "confirmed" && p.plan) {
          db.run(
            "UPDATE task_plans SET status = 'confirmed', plan = ?, decided_at = ?, grant_times = ?, workflow = COALESCE(?, workflow) WHERE plan_id = ?",
            JSON.stringify(p.plan),
            p.time,
            p.grantTimes === undefined ? null : JSON.stringify(p.grantTimes),
            p.workflow === undefined ? null : JSON.stringify(p.workflow),
            p.planId,
          );
        } else if (p.decision === "returned") {
          // 让维护者改（58 号票）：这一版还是审查没通过的那一版，只记下处理的时间
          db.run("UPDATE task_plans SET decided_at = ? WHERE plan_id = ?", p.time, p.planId);
        } else {
          // 打回、拒绝；重做时作废的计划变更（84 号票）也一样不再生效；撤回会话作废的确认过的计划（152 号票）留下作废时的授予时间
          db.run("UPDATE task_plans SET status = 'rejected', decided_at = ? WHERE plan_id = ?", p.time, p.planId);
          if (p.decision === "voided" && p.grantTimes) db.run("UPDATE task_plans SET grant_times = ? WHERE plan_id = ?", JSON.stringify(p.grantTimes), p.planId);
        }
        return;
      }
      case TASK_EVENTS.planChangeProposed: {
        const p = event.payload as PlanChangeProposedPayload;
        db.run("INSERT INTO task_plans (plan_id, task_id, revision, status, plan, card_id) VALUES (?, ?, ?, 'proposed', ?, ?)", p.planId, p.taskId, p.revision, JSON.stringify(p.plan), p.cardId);
        return;
      }
      case TASK_EVENTS.planRevised: {
        const p = event.payload as PlanRevisedPayload;
        // 维护者自行调整的一版没有卡片：沿用基于的那一版的卡片（任务详情里的计划卡）；流程的（153 号票：撤回、切换会话分支时换回的那一版）
        // 沿用那一版的流程计划（步骤和条件，执行时照它逐步核对）
        const base = db.get<{ card_id: string; workflow: string | null }>("SELECT card_id, workflow FROM task_plans WHERE plan_id = ?", p.basePlanId);
        db.run(
          "INSERT INTO task_plans (plan_id, task_id, revision, status, plan, card_id, decided_at, grant_times, workflow) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)",
          p.planId,
          p.taskId,
          p.revision,
          JSON.stringify(p.plan),
          base?.card_id ?? "",
          p.time,
          JSON.stringify(p.grantTimes),
          base?.workflow ?? null,
        );
        return;
      }
      case TASK_EVENTS.grantRenewalDecided: {
        const p = event.payload as GrantRenewalDecidedPayload;
        if (p.decision === "renewed" && p.grantTimes) db.run("UPDATE task_plans SET grant_times = ? WHERE plan_id = ?", JSON.stringify(p.grantTimes), p.planId);
        return;
      }
      case TASK_EVENTS.budgetUsed: {
        const p = event.payload as BudgetUsedPayload;
        db.run(
          `INSERT INTO task_budget (task_id, stage_id, tool_calls) VALUES (?, ?, ?)
           ON CONFLICT (task_id, stage_id) DO UPDATE SET tool_calls = tool_calls + excluded.tool_calls`,
          p.taskId,
          p.stageId,
          p.toolCalls,
        );
        return;
      }
      case TASK_EVENTS.budgetReset: {
        const p = event.payload as BudgetResetPayload;
        db.run(
          `INSERT INTO task_budget (task_id, stage_id, base_tokens) VALUES (?, ?, ?)
           ON CONFLICT (task_id, stage_id) DO UPDATE SET base_tokens = excluded.base_tokens, base_tool_calls = tool_calls, warned = 0`,
          p.taskId,
          p.stageId,
          p.baseTokens,
        );
        return;
      }
      case TASK_EVENTS.budgetWarned: {
        const p = event.payload as BudgetMarkPayload;
        db.run("UPDATE task_budget SET warned = 1 WHERE task_id = ? AND stage_id = ?", p.taskId, p.stageId);
        return;
      }
      default:
        return;
    }
}

/** 删掉了的任务（186 号票，Task.deleted）：读任务的地方都跳过它（行留着：编号不收回，countTasks 照样数） */
const live = (task: Task | undefined): Task | undefined => (task?.deleted ? undefined : task);

export function getTask(db: ReadonlyDatabase, taskId: string): Task | undefined {
  return live(getTaskRecord(db, taskId));
}

/** 这个编号的任务，删掉了的也给（删除任务时认"已经删过了"用，186 号票） */
export function getTaskRecord(db: ReadonlyDatabase, taskId: string): Task | undefined {
  const row = db.get<{ task: string }>("SELECT task FROM tasks WHERE task_id = ?", taskId);
  return row && (JSON.parse(row.task) as Task);
}

/** 某个维护者执行的任务（12 号票：任务自己的维护者，一个维护者一个任务）；删掉了的没有 */
export function taskOfMaintainer(db: ReadonlyDatabase, maintainerId: string): Task | undefined {
  const row = db.get<{ task: string }>("SELECT task FROM tasks WHERE maintainer_id = ? ORDER BY created_seq DESC LIMIT 1", maintainerId);
  return live(row && (JSON.parse(row.task) as Task));
}

/** 全部任务，先建的在前（删掉了的不在里面） */
export function listTasks(db: ReadonlyDatabase): Task[] {
  return db.all<{ task: string }>("SELECT task FROM tasks ORDER BY created_seq").flatMap((row) => {
    const task = JSON.parse(row.task) as Task;
    return task.deleted ? [] : [task];
  });
}

/** 执行中的任务有几个（不算 except 这一个）：它们占着全局执行名额（tasks/slots.ts 数名额用） */
export function countRunningTasks(db: ReadonlyDatabase, except?: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE state = 'running' AND task_id != ?", except ?? "")?.n ?? 0);
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

/**
 * 一版计划的状态：待确认、已确认、已打回（计划变更被拒也是它），以及计划变更提出、还在等用户的（proposed，14 号票）；
 * 流程的计划审查没让它交给用户授权的（refused，58 号票：退回维护者补充、判定不可执行）
 */
export type PlanStatus = "pending" | "confirmed" | "rejected" | "proposed" | "refused";

export interface StoredPlan {
  planId: string;
  taskId: string;
  revision: number;
  status: PlanStatus;
  /** 确认的计划是勾掉、收窄之后的那份 */
  plan: Plan;
  cardId: string;
  decidedAt?: string;
  /** 确认过的计划里每项授权的授予时间和到期时间（毫秒；14 号票起记，之前确认的没有，按确认时刻算） */
  grantTimes?: Record<string, GrantTime>;
  /** 流程的计划（58 号票）：步骤和条件；plan 是由它推出的、交给执行控制器的那份 */
  workflow?: WorkflowPlan;
}

interface PlanRow {
  plan_id: string;
  task_id: string;
  revision: number;
  status: PlanStatus;
  plan: string;
  card_id: string;
  decided_at: string | null;
  grant_times: string | null;
  workflow: string | null;
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
    ...(row.grant_times ? { grantTimes: grantTimesOf(JSON.parse(row.grant_times) as GrantTimes) } : {}),
    ...(row.workflow ? { workflow: JSON.parse(row.workflow) as WorkflowPlan } : {}),
  };
}

function grantTimesOf(times: GrantTimes): Record<string, GrantTime> {
  return Object.fromEntries(Object.entries(times).map(([id, t]) => [id, { grantedAt: Date.parse(t.grantedAt), expiresAt: Date.parse(t.expiresAt) }]));
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

/** 某个任务现在生效的计划：最新一版确认过的（14 号票起，计划变更提出的一版在确认之前不算） */
export function confirmedPlan(db: ReadonlyDatabase, taskId: string): StoredPlan | undefined {
  const row = db.get<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? AND status = 'confirmed' ORDER BY revision DESC LIMIT 1", taskId);
  return row && toPlan(row);
}

/** 某个任务确认过的各版计划（112 号票：哪几条原定由你验收、按新规矩改由评审），先确认的在前 */
export function confirmedPlans(db: ReadonlyDatabase, taskId: string): StoredPlan[] {
  return db.all<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? AND status = 'confirmed' ORDER BY revision", taskId).map(toPlan);
}

/**
 * 某个任务在卡上给用户看过的各版计划（93 号票评审：确认了的、自行调整的、还在等的、被拒或作废的都算；审查没让它交给用户的不算），
 * 先提交的在前
 */
export function shownPlans(db: ReadonlyDatabase, taskId: string): StoredPlan[] {
  return db.all<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? AND status <> 'refused' ORDER BY revision", taskId).map(toPlan);
}

/** 某个任务审查没让它交给用户授权的几版（流程，58 号票），先提交的在前 */
export function refusedPlans(db: ReadonlyDatabase, taskId: string): StoredPlan[] {
  return db.all<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? AND status = 'refused' ORDER BY revision", taskId).map(toPlan);
}

/** 某个任务还在等用户的计划变更（计划变更提出、还没确认或拒绝的那一版） */
export function proposedPlan(db: ReadonlyDatabase, taskId: string): StoredPlan | undefined {
  const row = db.get<PlanRow>("SELECT * FROM task_plans WHERE task_id = ? AND status = 'proposed' ORDER BY revision DESC LIMIT 1", taskId);
  return row && toPlan(row);
}

/** 一个阶段这一份预算的记账：工具调用次数（从上次再给一份预算起算）、token 从账本里的多少起算、超出预算时说明过进展没有 */
export interface StageUsage {
  toolCalls: number;
  baseTokens: number;
  warned: boolean;
}

export function stageUsage(db: ReadonlyDatabase, taskId: string, stageId: string): StageUsage {
  const row = db.get<{ tool_calls: number; base_tokens: number; base_tool_calls: number; warned: number }>(
    "SELECT tool_calls, base_tokens, base_tool_calls, warned FROM task_budget WHERE task_id = ? AND stage_id = ?",
    taskId,
    stageId,
  );
  if (!row) return { toolCalls: 0, baseTokens: 0, warned: false };
  return { toolCalls: Number(row.tool_calls) - Number(row.base_tool_calls), baseTokens: Number(row.base_tokens), warned: Number(row.warned) === 1 };
}
