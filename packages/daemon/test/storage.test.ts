import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/sqlite.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

describe("存储薄接口", () => {
  it("打开的库是 WAL 模式", () => {
    const db = openDatabase(path.join(makeTempDir(), "ergou.db"));
    try {
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("FTS5 trigram 表能用三个字以上的中文子串查到中文文本", () => {
    const db = openDatabase(path.join(makeTempDir(), "memory.db"));
    try {
      db.exec("CREATE VIRTUAL TABLE notes USING fts5(body, tokenize = 'trigram')");
      db.run("INSERT INTO notes(body) VALUES (?)", "下午和老王讨论了二狗的守卫设计，决定先做路径围栏");
      db.run("INSERT INTO notes(body) VALUES (?)", "周末去买菜");
      const hits = db.all<{ body: string }>("SELECT body FROM notes WHERE notes MATCH ?", "守卫设计");
      expect(hits.map((h) => h.body)).toEqual(["下午和老王讨论了二狗的守卫设计，决定先做路径围栏"]);
    } finally {
      db.close();
    }
  });

  it("事务里抛错时整体回滚", () => {
    const db = openDatabase(path.join(makeTempDir(), "ergou.db"));
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t(v) VALUES (?)", "a");
          throw new Error("中途失败");
        }),
      ).toThrow("中途失败");
      expect(db.all("SELECT v FROM t")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("只屏蔽 node:sqlite 的那一条 ExperimentalWarning，其他警告照常输出", () => {
    const dir = makeTempDir();
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/storage/sqlite.ts")).href;
    const script = [
      `const { openDatabase } = await import(${JSON.stringify(moduleUrl)});`,
      `const db = openDatabase(${JSON.stringify(path.join(dir, "w.db"))});`,
      `db.close();`,
      `process.emitWarning("另一个实验特性", "ExperimentalWarning");`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("SQLite is an experimental feature");
    expect(result.stderr).toContain("另一个实验特性");
  });
});
