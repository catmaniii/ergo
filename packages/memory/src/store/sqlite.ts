// SQLite 薄接口：照守护进程的 storage/sqlite.ts（node:sqlite 的 DatabaseSync、WAL、复用预编译语句、只屏蔽那一条实验性警告），
// 不跨包引用守护进程的代码，只留 PoC 用得到的部分。事务可以嵌套：里面的并进最外面那一个；要单独回滚的一段用 savepoint（267 号票）。
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export type SqlValue = SQLInputValue;

export interface Database {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  /** 在一个事务里执行 fn；fn 抛错则整体回滚。嵌套时里面的并进外面的 */
  transaction<T>(fn: () => T): T;
  /**
   * 267 号票：能单独回滚的一段。不在事务里时就是 transaction；在事务里时是一个保存点（SAVEPOINT）：fn 抛错只回滚这一段，
   * 外面的事务接着走（写入口整次拒掉一次写、调用方接住接着做别的时用）
   */
  savepoint<T>(fn: () => T): T;
  close(): void;
}

/** 打开（不存在则创建）一个库；文件库开 WAL（":memory:" 没有 WAL，SQLite 自己忽略） */
export function openDatabase(file: string): Database {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // 忘掉的证据不留在空闲页里（同守护进程）
  db.exec("PRAGMA secure_delete = ON");
  return wrap(db);
}

function wrap(db: DatabaseSync): Database {
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };
  let depth = 0;
  let savepoints = 0;

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth -= 1;
      }
    },
    savepoint<T>(fn: () => T): T {
      if (depth === 0) return this.transaction(fn);
      savepoints += 1;
      const name = `sp_${savepoints}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
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

/** 加载 node:sqlite；Node 22 第一次加载时的"SQLite is an experimental feature"警告只屏蔽这一条 */
function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.startsWith("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}
