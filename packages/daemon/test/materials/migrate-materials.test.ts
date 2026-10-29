// ADR-0035：素材库的文件名从 db/memory.db 改成 db/materials.db，老库在启动时搬一次。这里只测迁移函数本身
// （临时目录，不碰真的数据目录）：搬过去内容一个字节不差（sha256）、备份和记号都在、幂等、两边都没有是新装、
// 搬不成时抛出去且老库原样不动、回滚能回。
// 主切面（组合根在打开素材库之前调用它、搬不成也不拦启动）在 test/main/materials-migration.test.ts。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MATERIALS_MIGRATION_MARKER, migrateMaterialsDb, rollbackMaterialsDb } from "../../src/materials/migrate-materials.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const now = () => new Date("2026-10-29T08:00:00.000Z");
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function setup() {
  const dataDir = makeTempDir("ergo-materials-migrate-");
  const dbDir = path.join(dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const from = path.join(dbDir, "memory.db");
  const to = path.join(dbDir, "materials.db");
  const marker = path.join(dbDir, MATERIALS_MIGRATION_MARKER);
  fs.writeFileSync(from, "materials-data");
  fs.writeFileSync(`${from}-wal`, "wal");
  fs.writeFileSync(`${from}-shm`, "shm");
  const log: string[] = [];
  return { dataDir, dbDir, from, to, marker, now, log: (line: string) => log.push(line), lines: log };
}

/** 老库这一族文件（库 + -wal + -shm）的 sha256 */
const hashes = (t: ReturnType<typeof setup>) => [t.from, `${t.from}-wal`, `${t.from}-shm`].map(sha256);

describe("素材库改名：db/memory.db → db/materials.db", () => {
  it("老库连同 -wal / -shm 搬过去：内容一个字节不差（sha256）、老位置空了、备份和记号都在", () => {
    const t = setup();
    const before = hashes(t);
    expect(migrateMaterialsDb(t)).toBe("moved");
    // 新位置上就是老位置的那几个文件，内容一个字节不差
    expect(fs.existsSync(t.to)).toBe(true);
    expect([t.to, `${t.to}-wal`, `${t.to}-shm`].map(sha256)).toEqual(before);
    expect(fs.readFileSync(t.to, "utf8")).toBe("materials-data");
    // 老位置空了（不是复制，是搬）
    for (const file of [t.from, `${t.from}-wal`, `${t.from}-shm`]) expect(fs.existsSync(file)).toBe(false);
    // 先备份一份：<数据目录>/backup/pre-migration-<时间>/ 里是老名字，内容一样
    const backups = fs.readdirSync(path.join(t.dataDir, "backup"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-migration-\d{8}-\d{6}$/);
    const backupDir = path.join(t.dataDir, "backup", backups[0]!);
    expect(fs.readdirSync(backupDir).toSorted()).toEqual(["memory.db", "memory.db-shm", "memory.db-wal"]);
    expect([path.join(backupDir, "memory.db"), path.join(backupDir, "memory.db-wal"), path.join(backupDir, "memory.db-shm")].map(sha256)).toEqual(before);
    // 记号：从哪来、什么时候、备份在哪
    const marker = JSON.parse(fs.readFileSync(t.marker, "utf8")) as { format: number; at: string; from: string; backup: string };
    expect(marker.format).toBe(1);
    expect(marker.at).toBe("2026-10-29T08:00:00.000Z");
    expect(marker.from).toBe(t.from);
    expect(marker.backup).toBe(`backup/${backups[0]}`);
    expect(t.lines.join("\n")).toContain("素材库改名");
  });

  it("幂等：新位置已经有了就不再动，老位置又冒出来一份也不覆盖", () => {
    const t = setup();
    migrateMaterialsDb(t);
    expect(migrateMaterialsDb(t)).toBe("skipped");
    expect(fs.readFileSync(t.to, "utf8")).toBe("materials-data");
    expect(fs.readdirSync(path.join(t.dataDir, "backup"))).toHaveLength(1);
    // 搬完之后又有人往 db/ 里放了一份老名字的库：新位置已经有，不覆盖也不再搬
    fs.writeFileSync(t.from, "another");
    expect(migrateMaterialsDb(t)).toBe("skipped");
    expect(fs.readFileSync(t.to, "utf8")).toBe("materials-data");
    expect(fs.readFileSync(t.from, "utf8")).toBe("another");
  });

  it("两边都没有：新装，什么都不建", () => {
    const t = setup();
    for (const file of [t.from, `${t.from}-wal`, `${t.from}-shm`]) fs.rmSync(file);
    expect(migrateMaterialsDb(t)).toBe("skipped");
    expect(fs.existsSync(t.to)).toBe(false);
    expect(fs.existsSync(t.marker)).toBe(false);
    expect(fs.existsSync(path.join(t.dataDir, "backup"))).toBe(false);
  });

  it("搬不成（老位置是个目录）：抛出去，老位置原样留着、新位置不建、不写记号", () => {
    const t = setup();
    for (const file of [t.from, `${t.from}-wal`, `${t.from}-shm`]) fs.rmSync(file);
    fs.mkdirSync(t.from, { recursive: true });
    expect(() => migrateMaterialsDb(t)).toThrow(/EPERM|EISDIR|EACCES/);
    expect(fs.statSync(t.from).isDirectory()).toBe(true);
    expect(fs.existsSync(t.to)).toBe(false);
    expect(fs.existsSync(t.marker)).toBe(false);
  });

  it("回滚：搬回 db/memory.db、记号删掉；老位置已经有了就不覆盖；再回滚一次没得回", () => {
    const t = setup();
    const before = hashes(t);
    migrateMaterialsDb(t);
    expect(rollbackMaterialsDb(t)).toBe("rolledBack");
    expect([t.from, `${t.from}-wal`, `${t.from}-shm`].map(sha256)).toEqual(before);
    expect(fs.existsSync(t.to)).toBe(false);
    expect(fs.existsSync(t.marker)).toBe(false);
    // 再回滚一次：新位置已经没有了
    expect(rollbackMaterialsDb(t)).toBe("skipped");
    // 搬一次、老位置又有一份：拒绝（不覆盖）
    migrateMaterialsDb(t);
    fs.writeFileSync(t.from, "existing");
    expect(rollbackMaterialsDb(t)).toBe("skipped");
    expect(fs.readFileSync(t.from, "utf8")).toBe("existing");
    expect(t.lines.join("\n")).toContain("素材库搬回");
  });
});
