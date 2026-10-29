// 主切面（338 号票）：会意的推理库在启动时从老位置 db/rg.db 搬进插件自己的数据目录 memory/subtext/rg.db。
// 走真实的启动路径（真守护进程、临时数据目录、假模型假向量），不碰真的 ~/.ergo：
// - 老位置有库：起一次就搬过去（先备份一份、写 migrated.json），再起一次不重复搬；
// - 两边都没有（新装）：插件目录建出来、引擎照常把库建在新位置；
// - 搬不成（拿一个目录占住老位置）：守护进程照常起来、日志里写明，引擎自己建新的空库。
// 迁移函数本身的单测在 test/memory/migrate-rg.test.ts；这里只验组合根把它放在了引擎打开之前、失败不拦启动。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_MARKER } from "../../src/memory/migrate-rg.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 老位置：338 号票之前引擎一直开的是它（dataDirLayout().legacyRgDb） */
const legacyOf = (dataDir: string) => path.join(dataDir, "db", "rg.db");
/** 会意插件自己的数据目录（<数据目录>/memory/subtext/） */
const providerDirOf = (dataDir: string) => path.join(dataDir, "memory", "subtext");
/** 新位置：推理库现在住这儿（dataDirLayout().rgDb） */
const newRgOf = (dataDir: string) => path.join(providerDirOf(dataDir), "rg.db");
/** <数据目录>/backup/ 下的迁移备份 */
const backupsOf = (dataDir: string) => path.join(dataDir, "backup");

describe("会意的推理库搬进插件自己的数据目录", () => {
  it("老位置有库：起一次就搬到 memory/subtext/、先备份一份、留下 migrated.json；再起一次不重复搬", { timeout: 60_000 }, async () => {
    const dataDir = makeTempDir("ergo-migrate-");
    fs.mkdirSync(path.join(dataDir, "db"), { recursive: true });
    // 迁移只看文件在不在、不看内容：摆一个假的库就够（真的解析留给引擎，它这会儿读不懂就记一条"用不了"）
    fs.writeFileSync(legacyOf(dataDir), "legacy-rg");
    const logs: string[] = [];
    const first = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, memoryPlugin: true, log: (line) => logs.push(line) });

    // 搬到新位置、老位置不再有
    expect(fs.existsSync(newRgOf(dataDir))).toBe(true);
    expect(fs.existsSync(legacyOf(dataDir))).toBe(false);
    expect(first.daemon.layout.rgDb).toBe(newRgOf(dataDir));
    expect(first.daemon.layout.legacyRgDb).toBe(legacyOf(dataDir));
    // 记号：从哪来、备份在哪
    const marker = path.join(providerDirOf(dataDir), MIGRATION_MARKER);
    expect(fs.existsSync(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ format: 1, from: legacyOf(dataDir), backup: expect.stringMatching(/^backup\/pre-migration-/) });
    // 备份：db/ 下那一份原样复制在 <数据目录>/backup/pre-migration-<时间>/ 里
    const backups = fs.readdirSync(backupsOf(dataDir));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-migration-\d{8}-\d{6}$/);
    expect(fs.readFileSync(path.join(backupsOf(dataDir), backups[0]!, "rg.db"), "utf8")).toBe("legacy-rg");
    expect(logs.join("\n")).toContain("推理库搬进插件数据目录");

    // 再起一次：不重复搬（不重写记号、不复制第二份备份、日志里没有第二次"搬进"）
    await first.daemon.stop();
    const markerBefore = fs.readFileSync(marker, "utf8");
    const secondLogs: string[] = [];
    const second = await startTestDaemon({ reuse: { dataDir, homeDir: first.homeDir }, memoryPlugin: true, log: (line) => secondLogs.push(line) });
    expect(fs.readdirSync(backupsOf(dataDir))).toEqual(backups);
    expect(fs.readFileSync(marker, "utf8")).toBe(markerBefore);
    expect(secondLogs.join("\n")).not.toContain("推理库搬进插件数据目录");
    expect(fs.existsSync(newRgOf(dataDir))).toBe(true);
    await second.daemon.stop();
  });

  it("新装、两边都没有：插件目录建出来、引擎照常把库建在新位置；不搬也不报错", { timeout: 60_000 }, async () => {
    const logs: string[] = [];
    // fresh：数据目录是一个还不存在的新目录（不写测试的配置文件），看守护进程自己把东西建好
    const td = await startTestDaemon({ fresh: true, log: (line) => logs.push(line) });
    expect(td.daemon.layout.rgDb).toBe(newRgOf(td.dataDir));
    expect(fs.existsSync(providerDirOf(td.dataDir))).toBe(true);
    // 记忆插件起来时把空库建好（openReasoningDb 会建目录、写 manifest），照常能用
    expect(fs.existsSync(newRgOf(td.dataDir))).toBe(true);
    expect(td.daemon.memoryHost.active()).toBe("subtext");
    // 没有老库：不搬、不备份、不报"没搬成"
    expect(fs.existsSync(legacyOf(td.dataDir))).toBe(false);
    expect(fs.existsSync(path.join(providerDirOf(td.dataDir), MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(backupsOf(td.dataDir))).toBe(false);
    expect(logs.join("\n")).not.toContain("推理库搬进插件数据目录");
    expect(logs.join("\n")).not.toContain("推理库没搬成");
  });

  it("老位置被一个目录占着、搬不过去：守护进程照常起来，日志写明没搬成、会新建一个空库，不崩", { timeout: 60_000 }, async () => {
    const dataDir = makeTempDir("ergo-migrate-fail-");
    // 拿目录占住 db/rg.db：复制那一下必然失败（稳定复现的"搬不了"，不靠权限位在 Windows 上的差别）
    fs.mkdirSync(legacyOf(dataDir), { recursive: true });
    const logs: string[] = [];
    const td = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, memoryPlugin: true, log: (line) => logs.push(line) });
    const all = logs.join("\n");
    // 日志里写明：没搬成、按"还没搬"继续、会新建空库（用户看到"记忆是空的"时能查到这里）
    expect(all).toContain("推理库没搬成");
    expect(all).toContain("新建一个空库");
    expect(all).toContain(legacyOf(dataDir));
    // 老位置原样留着（搬不动就一个字节没动），新位置是引擎自己建的空库，没有迁移记号
    expect(fs.statSync(legacyOf(dataDir)).isDirectory()).toBe(true);
    expect(fs.existsSync(newRgOf(dataDir))).toBe(true);
    expect(fs.existsSync(path.join(providerDirOf(dataDir), MIGRATION_MARKER))).toBe(false);
    // 守护进程照常：记忆插件起来了（装配走完，每晚整理的作业照样排上），别的功能不受影响
    expect(td.daemon.memoryHost.active()).toBe("subtext");
    expect(td.daemon.internalJobs.state("memory-nightly")).toMatchObject({ job: "memory-nightly" });
  });
});
