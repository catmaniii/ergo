// 存储薄接口：守护进程里所有 SQLite 访问都经过这里（规格第 4 节）。
// 现在的驱动是 node:sqlite（2026-10-07 验证过 FTS5 trigram 分词器可用）；
// 将来要换 better-sqlite3，只改这个文件，上层只看见下面的 Database 接口。
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export type SqlValue = SQLInputValue;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Database {
  /** 执行一段（可含多条语句的）SQL，不取结果 */
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  /** 在一个事务里执行 fn；fn 抛错则整体回滚。可以嵌套（内层用保存点）。 */
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
  return wrap(db);
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
  let savepointSeq = 0;

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      const nested = db.isTransaction;
      const savepoint = `sp_${++savepointSeq}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (err) {
        db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
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
