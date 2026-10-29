// 338 号票：推理库迁移的单元测试（临时目录，不碰真的数据目录）
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateReasoningDb, rollbackReasoningDb } from "../../src/memory/migrate-rg.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const now = () => new Date("2026-10-29T08:00:00.000Z");

function setup() {
  const dataDir = makeTempDir("ergo-migrate-");
  const from = path.join(dataDir, "db", "rg.db");
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, "rg-data");
  fs.writeFileSync(`${from}-wal`, "wal");
  const toDir = path.join(dataDir, "memory", "subtext");
  const log: string[] = [];
  return { dataDir, from, toDir, storeName: "rg.db", log: (line: string) => log.push(line), now, lines: log };
}

describe("把推理库搬进插件数据目录", () => {
  it("搬过去：目标有了、旧的不在、备份里有、记号里写着从哪来", () => {
    const t = setup();
    expect(migrateReasoningDb(t)).toBe("moved");
    expect(fs.readFileSync(path.join(t.toDir, "rg.db"), "utf8")).toBe("rg-data");
    expect(fs.readFileSync(path.join(t.toDir, "rg.db-wal"), "utf8")).toBe("wal");
    expect(fs.existsSync(t.from)).toBe(false);
    const marker = JSON.parse(fs.readFileSync(path.join(t.toDir, "migrated.json"), "utf8")) as { format: number; from: string; backup: string };
    expect(marker.format).toBe(1);
    expect(marker.from).toBe(t.from);
    expect(fs.readdirSync(path.join(t.dataDir, "backup"))).toHaveLength(1);
    expect(t.lines.join("\n")).toContain("推理库搬进插件数据目录");
  });

  it("幂等：目标已经有了就不再动，旧文件还在也不动", () => {
    const t = setup();
    migrateReasoningDb(t);
    fs.writeFileSync(t.from, "another");
    expect(migrateReasoningDb(t)).toBe("skipped");
    expect(fs.readFileSync(path.join(t.toDir, "rg.db"), "utf8")).toBe("rg-data");
    expect(fs.readFileSync(t.from, "utf8")).toBe("another");
  });

  it("两边都没有：什么都创建（新装）", () => {
    const t = setup();
    fs.rmSync(t.from);
    fs.rmSync(`${t.from}-wal`);
    expect(migrateReasoningDb(t)).toBe("skipped");
    expect(fs.existsSync(path.join(t.toDir, "rg.db"))).toBe(false);
  });

  it("回滚：搬回 db/、记号删掉；db/ 已经有东西时拒绝", () => {
    const t = setup();
    migrateReasoningDb(t);
    expect(rollbackReasoningDb(t)).toBe("rolledBack");
    expect(fs.readFileSync(t.from, "utf8")).toBe("rg-data");
    expect(fs.existsSync(path.join(t.toDir, "migrated.json"))).toBe(false);
    // 再回滚一次：已经没得回
    expect(rollbackReasoningDb(t)).toBe("skipped");
    // 搬一次再试"db/ 已经有"：拒绝
    migrateReasoningDb(t);
    fs.writeFileSync(t.from, "existing");
    expect(rollbackReasoningDb(t)).toBe("skipped");
    expect(fs.readFileSync(t.from, "utf8")).toBe("existing");
  });
});
