// 存储薄接口：守护进程里所有 SQLite 访问都经过这里（规格第 4 节）。
// 现在的驱动是 node:sqlite（2026-10-07 验证过 FTS5 trigram 分词器可用）；
// 将来要换 better-sqlite3，只改这个文件，上层只看见下面的 Database 接口。
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

export type SqlValue = SQLInputValue;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** 只读的连接：查询派生视图用，写不进去（底层也是只读打开的） */
export interface ReadonlyDatabase {
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

export interface Database extends ReadonlyDatabase {
  /** 执行一段（可含多条语句的）SQL，不取结果 */
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  /** 在一个事务里执行 fn；fn 抛错则整体回滚。不支持嵌套。 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** 打开（不存在则创建）一个 WAL 模式的库。 */
export function openDatabase(file: string): Database {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // 删掉、改写的内容不留在空闲页里（彻底删除，21 号票）
  db.exec("PRAGMA secure_delete = ON");
  return wrap(db);
}

/** 只读地打开一个已经存在的库（WAL 模式下读得到写连接已提交的内容） */
export function openReadonlyDatabase(file: string): ReadonlyDatabase {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const { get, all, close } = wrap(db);
  return { get, all, close };
}

/**
 * 把一个库一致地复制成新文件（`VACUUM INTO`，备份用）：只读打开源库，生成的是 VACUUM 那一刻已提交内容的快照；
 * 写连接照常追加，互不妨碍（WAL）。生成的文件是普通的单文件库（不是 WAL 模式），dest 不能已经存在。
 */
export function vacuumIntoSync(source: string, dest: string): void {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  // 删掉、改写的内容不留在空闲页里（彻底删除，21 号票）
  db.exec("PRAGMA secure_delete = ON");
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
}

/** 完整性检查（`PRAGMA integrity_check`）：没问题是空数组；打不开、不是数据库也算问题 */
export function integrityCheckSync(file: string): string[] {
  const { DatabaseSync } = loadSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const problems = rows.map((r) => r.integrity_check).filter((r) => r !== "ok");
    return problems;
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  } finally {
    db?.close();
  }
}

/** 同 vacuumIntoSync，但在工作线程里做：大库不卡守护进程的事件循环 */
export function vacuumInto(source: string, dest: string): Promise<void> {
  return inWorker({ op: "vacuum_into", source, dest }).then(() => undefined);
}

/** 同 integrityCheckSync，但在工作线程里做 */
export function integrityCheck(file: string): Promise<string[]> {
  return inWorker({ op: "integrity_check", file }).then((r) => r as string[]);
}

/** 工作线程里做的操作（sqlite-worker.ts 按 op 调上面的同步函数） */
export type WorkerOp = { op: "vacuum_into"; source: string; dest: string } | { op: "integrity_check"; file: string };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

// 一个常驻的工作线程，按先后一件件做（拉起一个线程要几十毫秒，不每次都拉）。
// 有活的时候 ref（命令行工具等它的结果时进程不会先退出），闲着时 unref（不拦着进程退出）。
let worker: Worker | undefined;
let nextId = 1;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

function sqliteWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./sqlite-worker.ts", import.meta.url));
  const failAll = (err: Error) => {
    if (worker === w) worker = undefined;
    for (const { reject } of waiting.values()) reject(err);
    waiting.clear();
  };
  w.on("message", (reply: WorkerReply) => {
    const pending = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (waiting.size === 0) w.unref();
    if (!pending) return;
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error));
  });
  w.on("error", failAll);
  w.on("exit", (code) => failAll(new Error(`SQLite 工作线程意外退出（${code}）`)));
  worker = w;
  return w;
}

function inWorker(op: WorkerOp): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const w = sqliteWorker();
    waiting.set(id, { resolve, reject });
    w.ref();
    // worker_threads 的 Worker，不是浏览器的 window.postMessage，没有 targetOrigin
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    w.postMessage({ id, op });
  });
}

function wrap(db: DatabaseSync): Database {
  // 同一条 SQL 反复执行时复用预编译语句
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => {
      statements.clear();
      db.close();
    },
  };
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | undefined;

/**
 * 加载 node:sqlite。Node 22 在第一次加载它时发一条
 * "ExperimentalWarning: SQLite is an experimental feature"；只屏蔽这一条，其他警告照常输出。
 */
function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

function isSqliteExperimentalWarning(warning: string | Error, typeOrOptions: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions
        ? (typeOrOptions as { type?: unknown }).type
        : typeof warning === "string"
          ? undefined
          : warning.name;
  return type === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature");
}
