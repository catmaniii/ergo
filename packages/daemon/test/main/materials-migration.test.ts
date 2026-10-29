// 主切面（ADR-0035）：素材库的文件名从 db/memory.db 改成 db/materials.db，老库在启动时搬一次。
// 走真实的启动路径（真守护进程、临时数据目录、假模型假向量），不碰真的 ~/.ergo：
// - 老位置有库：起一次就改名（先备份一份、写 materials-migrated.json），库里的东西还在，再起一次不重复搬；
// - 两边都没有（新装）：素材库建在新名字上，不备份、不写记号；
// - 搬不成（拿一个目录占住老位置）：守护进程照常起来、日志写明"会用新的空库、以前的素材从事件日志重建"。
// 迁移函数本身的单测在 test/materials/migrate-materials.test.ts；这里只验组合根把它放在了打开素材库之前、失败不拦启动。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { MATERIALS_MIGRATION_MARKER } from "../../src/materials/migrate-materials.ts";
import { openDatabase, openReadonlyDatabase } from "../../src/storage/sqlite.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** 老位置：改名之前素材库一直是它（dataDirLayout().legacyMemoryDb） */
const legacyOf = (dataDir: string) => dataDirLayout(dataDir).legacyMemoryDb;
/** 新位置：素材库现在住这儿（dataDirLayout().materialsDb） */
const materialsOf = (dataDir: string) => dataDirLayout(dataDir).materialsDb;
/** <数据目录>/backup/ 下的迁移备份 */
const backupsOf = (dataDir: string) => path.join(dataDir, "backup");

/** 一个真的老库（db/memory.db）：建一张探针表写一行，启动之后看它还在不在（内容跟着搬过来了） */
function writeLegacyDb(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, "db"), { recursive: true });
  const db = openDatabase(legacyOf(dataDir));
  db.exec("CREATE TABLE legacy_probe (id TEXT PRIMARY KEY, text TEXT)");
  db.run("INSERT INTO legacy_probe VALUES (?, ?)", "mat-legacy-1", "改名之前就有的素材");
  db.close();
}

describe("素材库改名：老库 db/memory.db 在启动时搬到 db/materials.db", () => {
  it("老位置有库：起一次就改名、先备份一份、留下记号；库里的东西还在；再起一次不重复搬", { timeout: 60_000 }, async () => {
    const dataDir = makeTempDir("ergo-materials-migrate-");
    writeLegacyDb(dataDir);
    const legacyBytes = sha256(legacyOf(dataDir));
    const logs: string[] = [];
    const first = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, log: (line) => logs.push(line) });

    // 老名字不再有、新名字有；布局里的两个名字对得上
    expect(fs.existsSync(legacyOf(dataDir))).toBe(false);
    expect(fs.existsSync(materialsOf(dataDir))).toBe(true);
    expect(first.daemon.layout.materialsDb).toBe(materialsOf(dataDir));
    expect(first.daemon.layout.legacyMemoryDb).toBe(legacyOf(dataDir));
    // 库里的东西跟着搬过来了：老库里那张探针表、那一行还在（守护进程接着在这个库上工作）
    const copy = openReadonlyDatabase(materialsOf(dataDir));
    try {
      expect(copy.all("SELECT id, text FROM legacy_probe")).toEqual([{ id: "mat-legacy-1", text: "改名之前就有的素材" }]);
    } finally {
      copy.close();
    }
    // 备份：<数据目录>/backup/pre-migration-<时间>/ 里是改名之前的那一份，一个字节不差
    const backups = fs.readdirSync(backupsOf(dataDir));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-migration-\d{8}-\d{6}$/);
    expect(sha256(path.join(backupsOf(dataDir), backups[0]!, "memory.db"))).toBe(legacyBytes);
    // 记号：从哪来、备份在哪
    const markerFile = path.join(path.dirname(materialsOf(dataDir)), MATERIALS_MIGRATION_MARKER);
    expect(JSON.parse(fs.readFileSync(markerFile, "utf8"))).toMatchObject({ format: 1, from: legacyOf(dataDir), backup: `backup/${backups[0]}` });
    expect(logs.join("\n")).toContain("素材库改名");

    // 再起一次：不重复搬（不重写记号、不复制第二份备份、日志里没有第二次"改名"）
    await first.daemon.stop();
    const markerBefore = fs.readFileSync(markerFile, "utf8");
    const secondLogs: string[] = [];
    const second = await startTestDaemon({ reuse: { dataDir, homeDir: first.homeDir }, log: (line) => secondLogs.push(line) });
    expect(fs.readdirSync(backupsOf(dataDir))).toEqual(backups);
    expect(fs.readFileSync(markerFile, "utf8")).toBe(markerBefore);
    expect(secondLogs.join("\n")).not.toContain("素材库改名");
    expect(fs.existsSync(materialsOf(dataDir))).toBe(true);
    await second.daemon.stop();
  });

  it("新装、两边都没有：素材库建在新名字上；不备份、不写记号、日志里什么都没有", { timeout: 60_000 }, async () => {
    const logs: string[] = [];
    // fresh：数据目录是一个还不存在的新目录（不写测试的配置文件），看守护进程自己把东西建好
    const td = await startTestDaemon({ fresh: true, log: (line) => logs.push(line) });
    expect(td.daemon.layout.materialsDb).toBe(materialsOf(td.dataDir));
    expect(fs.existsSync(legacyOf(td.dataDir))).toBe(false);
    expect(fs.existsSync(materialsOf(td.dataDir))).toBe(true);
    // 没有老库：不搬、不备份、不写记号、不报"没搬成"
    expect(fs.existsSync(path.join(path.dirname(materialsOf(td.dataDir)), MATERIALS_MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(backupsOf(td.dataDir))).toBe(false);
    expect(logs.join("\n")).not.toContain("素材库改名");
    expect(logs.join("\n")).not.toContain("素材库没改名");
  });

  it("老位置被一个目录占着、搬不了：守护进程照常起来，日志写明会用新的空库、以前的素材从事件日志重建", { timeout: 60_000 }, async () => {
    const dataDir = makeTempDir("ergo-materials-migrate-fail-");
    // 拿目录占住 db/memory.db：复制那一下必然失败（稳定复现的"搬不了"，不靠权限位在 Windows 上的差别）
    fs.mkdirSync(legacyOf(dataDir), { recursive: true });
    const logs: string[] = [];
    const td = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, log: (line) => logs.push(line) });
    const all = logs.join("\n");
    // 日志里写明：没搬成、会用新的空库、以前的素材从事件日志重建（用户发现"素材是空的"时能查到这里）
    expect(all).toContain("素材库没改名");
    expect(all).toContain("会用新的空库");
    expect(all).toContain("从事件日志重建");
    expect(all).toContain(legacyOf(dataDir));
    // 老位置原样留着（搬不动就一个字节没动），新位置是守护进程自己建的空库，没有迁移记号
    expect(fs.statSync(legacyOf(dataDir)).isDirectory()).toBe(true);
    expect(fs.existsSync(materialsOf(dataDir))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(materialsOf(dataDir)), MATERIALS_MIGRATION_MARKER))).toBe(false);
    // 守护进程照常：素材库起来了（空库，能从事件日志重建素材），别的功能不受影响
    expect(td.daemon.materials.list()).toEqual([]);
    expect(td.daemon.memoryHost.active()).toBe("subtext");
  });
});
