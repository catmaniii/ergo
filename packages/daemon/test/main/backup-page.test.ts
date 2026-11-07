// 主切面：设置 · 备份单独一页要的接口——改另存的文件夹（真跑一次备份）、清掉、改时刻和谁来定时（不重启，内部作业跟着变）、
// 选文件夹时校验、列快照、手动校验（和备份同一把锁；411 起结果记进本机备份区，重启后还在、体检读它）、在电脑上打开。数据目录和文件夹都是临时目录，端口系统挑，"打开"换成记下来。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BackupStatusView, nowIso } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { backupLockFile } from "../../src/backup/lock.ts";
import { VERIFY_RECORD_FILE } from "../../src/backup/record.ts";
import { listSnapshotDates, readSnapshot, verifySnapshot } from "../../src/backup/snapshot.ts";
import { loadConfig } from "../../src/config/config.ts";
import { type BackupDaemon, put, restartBackupDaemon, startBackupDaemon } from "../helpers/backup.ts";
import { backupApi } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);
const TODAY = "2026-10-07";
const BACKUP_KEY = "internal:backup";
const OVERDUE_KEY = "internal:backup_overdue_check";

async function idle(url: string): Promise<BackupStatusView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const view = (await backupApi.status(url)).body;
    if (!view.queued && !view.verifying && view.running === undefined) return view;
    if (Date.now() > deadline) throw new Error(`30 秒还没做完：${JSON.stringify(view)}`);
    await sleep(100);
  }
}

const backupNow = async (url: string) => {
  expect((await backupApi.run(url)).status).toBe(200);
  return idle(url);
};

const configText = (test: Pick<BackupDaemon, "layout">) => fs.readFileSync(test.layout.configFile, "utf8");
const pendingAt = (test: BackupDaemon, key: string) => test.daemon.scheduler.pending().find((p) => p.key === key)?.at;
const newFolder = (name = "ergo-new-") => makeTempDir(name);

/** 复制文件时停住，等测试放行 */
function gatedFiles() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const copyStarted = new Promise<void>((resolve) => (started = resolve));
  const files: SnapshotFiles = {
    ...nodeSnapshotFiles,
    async copy(src, dest, length) {
      started();
      await gate;
      return nodeSnapshotFiles.copy(src, dest, length);
    },
  };
  return { files, release: () => release(), copyStarted };
}

describe("改另存的文件夹", () => {
  it("改了不用重启：下一次立即备份写到新文件夹，旧文件夹里已有的一个字节没动", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, syncDir: oldDir, layout } = test;
    await backupNow(url);
    expect(listSnapshotDates(oldDir)).toEqual([TODAY]);
    const manifest = path.join(oldDir, TODAY, "manifest.json");
    const before = fs.readFileSync(manifest);
    const oldEntries = fs.readdirSync(oldDir).toSorted();

    const target = newFolder();
    const changed = await backupApi.config(url, { syncDir: target });
    expect(changed.status).toBe(200);
    expect(changed.body.syncDir).toEqual({ kind: "ready", dir: target });
    expect(JSON.parse(configText(test)).backup.syncDir).toBe(target);

    const done = await backupNow(url);
    expect(done.last).toMatchObject({ local: "replaced", sync: "copied" });
    expect(listSnapshotDates(target)).toEqual([TODAY]);
    expect(await verifySnapshot(path.join(target, TODAY))).toEqual([]);
    // 旧的没搬、没删
    expect(fs.readdirSync(oldDir).toSorted()).toEqual(oldEntries);
    expect(fs.readFileSync(manifest).equals(before)).toBe(true);
    expect(listSnapshotDates(layout.backups)).toEqual([TODAY]);
  });

  it("命令行脚本每次现读文件：页面改完，npm run backup 也写到新文件夹", async () => {
    const test = await startBackupDaemon({ start: new Date() });
    const target = newFolder();
    expect((await backupApi.config(test.url, { syncDir: target })).status).toBe(200);
    const script = path.resolve(import.meta.dirname, "../../src/run-backup.ts");
    const env = withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(test.homeDir), { ERGO_DATA_DIR: test.dataDir, DEEPSEEK_API_KEY: undefined });
    const run = spawnSync(process.execPath, [script], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`同步目录：${target}`);
    expect(listSnapshotDates(target)).toHaveLength(1);
    expect(listSnapshotDates(test.syncDir)).toEqual([]);
  });

  it("正在备份时改位置：这一份照样写到原来的文件夹，做完之后才用新的", async () => {
    const gated = gatedFiles();
    const test = await startBackupDaemon({ start: START, backupFiles: () => gated.files });
    const { url, syncDir: oldDir } = test;
    expect((await backupApi.run(url)).body.queued).toBe(true);
    await gated.copyStarted;

    const target = newFolder();
    const changed = await backupApi.config(url, { syncDir: target });
    expect(changed.status).toBe(200);
    expect(changed.body.syncDir).toEqual({ kind: "ready", dir: target });
    expect(changed.body.queued).toBe(true);

    gated.release();
    await idle(url);
    expect(listSnapshotDates(oldDir)).toEqual([TODAY]);
    expect(listSnapshotDates(target)).toEqual([]);

    await backupNow(url);
    expect(listSnapshotDates(target)).toEqual([TODAY]);
  });

  it("不存在的文件夹：不说好不写配置；createSyncDir 才新建、才生效", async () => {
    const test = await startBackupDaemon({ start: START });
    const before = configText(test);
    const target = path.join(newFolder(), "还没有", "ergo-backup");

    expect((await backupApi.checkFolder(test.url, target)).body).toEqual({ kind: "missing", dir: target });
    const refused = await backupApi.config(test.url, { syncDir: target });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("不存在");
    expect(configText(test)).toBe(before);
    expect(fs.existsSync(target)).toBe(false);

    const made = await backupApi.config(test.url, { syncDir: target, createSyncDir: true });
    expect(made.status).toBe(200);
    expect(made.body.syncDir).toEqual({ kind: "ready", dir: target });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("非法路径（相对路径、数据目录里、是个文件、写不进去）：回明确的原因，配置一个字节不变，运行中的也不变", async () => {
    let failWrites = false;
    const files: SnapshotFiles = {
      ...nodeSnapshotFiles,
      writeFile: (file, data) => (failWrites ? Promise.reject(Object.assign(new Error("EACCES: 模拟的"), { code: "EACCES" })) : nodeSnapshotFiles.writeFile(file, data)),
    };
    const test = await startBackupDaemon({ start: START, backupFiles: () => files });
    const { url, dataDir, syncDir } = test;
    const before = configText(test);
    const aFile = path.join(newFolder(), "a.txt");
    fs.writeFileSync(aFile, "x");
    const cases: Array<[string, string]> = [
      ["relative\\folder", "完整路径"],
      [dataDir, "数据目录"],
      [path.join(dataDir, "backups", "x"), "数据目录"],
      [aFile, "不是文件夹"],
    ];
    for (const [dir, reason] of cases) {
      expect((await backupApi.checkFolder(url, dir)).body).toMatchObject({ kind: "invalid", reason: expect.stringContaining(reason) });
      const res = await backupApi.config(url, { syncDir: dir });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(reason);
    }
    failWrites = true;
    const readonlyDir = newFolder();
    expect((await backupApi.checkFolder(url, readonlyDir)).body).toMatchObject({ kind: "invalid", reason: expect.stringContaining("没有写入权限") });
    const noWrite = await backupApi.config(url, { syncDir: readonlyDir });
    expect(noWrite.status).toBe(400);
    expect(noWrite.body.message).toContain("没有写入权限");
    failWrites = false;

    expect(configText(test)).toBe(before);
    expect((await backupApi.status(url)).body.syncDir).toEqual({ kind: "ready", dir: syncDir });
  });

  it("配置文件被手改坏了：回明确的错，不覆盖；修好了接着能改", async () => {
    const test = await startBackupDaemon({ start: START });
    const good = configText(test);
    const broken = `${good}\n{ 这里被改坏了`;
    fs.writeFileSync(test.layout.configFile, broken);
    const res = await backupApi.config(test.url, { time: "05:00" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("不是合法的 JSON");
    expect(configText(test)).toBe(broken);
    expect((await backupApi.status(test.url)).body.time).toBe("03:30");

    fs.writeFileSync(test.layout.configFile, good);
    expect((await backupApi.config(test.url, { time: "05:00" })).body.time).toBe("05:00");
  });

  it("清掉：之后只做本机那份；配置里别的内容按字节不变；已有的快照没动", async () => {
    const test = await startBackupDaemon({ start: START, config: { note: "手写的 { 东西 }" } });
    const { url, syncDir, layout } = test;
    await backupNow(url);
    const text = configText(test);
    const cleared = await backupApi.config(url, { syncDir: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.syncDir).toEqual({ kind: "none" });
    const after = configText(test);
    expect(JSON.parse(after).backup.syncDir).toBeUndefined();
    // 只少了 syncDir 那一段
    const member = `"syncDir": ${JSON.stringify(syncDir)}`;
    expect(text).toContain(member);
    const [head, tail] = text.split(member) as [string, string];
    expect(after.startsWith(head.slice(0, head.lastIndexOf('"backup"')))).toBe(true);
    expect(after.endsWith(tail.replace(/^,?\s*/, ""))).toBe(true);

    const done = await backupNow(url);
    expect(done.last).toMatchObject({ sync: "not_configured" });
    expect(listSnapshotDates(layout.backups)).toEqual([TODAY]);
    expect(listSnapshotDates(syncDir)).toEqual([TODAY]);
  });
});

describe("改时刻、改谁来定时：不重启", () => {
  it("改时刻：内部作业重新排，下一次跟着变；到新的点真的备份，旧的点不再备份", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, syncDir } = test;
    expect(pendingAt(test, BACKUP_KEY)).toBe(at(10, 8, 3, 30).getTime());

    const changed = await backupApi.config(url, { time: "05:15" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ time: "05:15", next: nowIso(at(10, 8, 5, 15)) });
    expect(pendingAt(test, BACKUP_KEY)).toBe(at(10, 8, 5, 15).getTime());
    expect(JSON.parse(configText(test)).backup.time).toBe("05:15");

    await test.advanceTo(at(10, 8, 4, 0));
    expect(listSnapshotDates(syncDir)).toEqual([]);
    await test.advanceTo(at(10, 8, 5, 20));
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-08"]);
    expect((await backupApi.status(url)).body.next).toBe(nowIso(at(10, 9, 5, 15)));
  });

  it("改时刻不补跑：今天已经做过，新的时刻已经过了点，也等到明天（下一次写的和真正排的一致）", async () => {
    const test = await startBackupDaemon({ start: at(10, 7, 3, 0) });
    await test.advanceTo(at(10, 7, 3, 35));
    expect(listSnapshotDates(test.syncDir)).toEqual([TODAY]);
    await test.advanceTo(at(10, 7, 15, 0));
    const lastBefore = (await backupApi.status(test.url)).body.last;

    const changed = await backupApi.config(test.url, { time: "10:00" });
    expect(changed.body.next).toBe(nowIso(at(10, 8, 10, 0)));
    expect(pendingAt(test, BACKUP_KEY)).toBe(at(10, 8, 10, 0).getTime());
    await test.daemon.internalJobs.whenIdle();
    expect((await backupApi.status(test.url)).body.last).toEqual(lastBefore);
  });

  it("时刻写得不对：回原因，什么都不变", async () => {
    const test = await startBackupDaemon({ start: START });
    const before = configText(test);
    const res = await backupApi.config(test.url, { time: "25:99" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("时刻");
    expect(configText(test)).toBe(before);
    expect(pendingAt(test, BACKUP_KEY)).toBe(at(10, 8, 3, 30).getTime());
  });

  it("换成外部定时器：到点的作业撤掉、提醒作业加上；换回来反过来；都不重启", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, syncDir } = test;
    expect(pendingAt(test, BACKUP_KEY)).toBeDefined();
    expect(pendingAt(test, OVERDUE_KEY)).toBeUndefined();

    const external = await backupApi.config(url, { schedule: "external" });
    expect(external.status).toBe(200);
    expect(external.body.schedule).toBe("external");
    expect(external.body.next).toBeUndefined();
    expect(pendingAt(test, BACKUP_KEY)).toBeUndefined();
    expect(pendingAt(test, OVERDUE_KEY)).toBe(at(10, 8, 12, 0).getTime());
    expect(JSON.parse(configText(test)).backup.schedule).toBe("external");

    // 外部定时器管着：到点不备份
    await test.advanceTo(at(10, 8, 4, 0));
    expect(listSnapshotDates(syncDir)).toEqual([]);

    const internal = await backupApi.config(url, { schedule: "internal" });
    expect(internal.body.next).toBe(nowIso(at(10, 9, 3, 30)));
    expect(pendingAt(test, OVERDUE_KEY)).toBeUndefined();
    expect(pendingAt(test, BACKUP_KEY)).toBe(at(10, 9, 3, 30).getTime());
    // 换回来不立刻补跑
    await test.daemon.internalJobs.whenIdle();
    expect(listSnapshotDates(syncDir)).toEqual([]);
    await test.advanceTo(at(10, 9, 3, 35));
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-09"]);
  });

  it("写进了配置文件：下次启动读到的就是改过的", async () => {
    const test = await startBackupDaemon({ start: START, config: { backup: { schedule: "external" } } });
    await backupApi.config(test.url, { schedule: "internal", time: "06:45" });
    const loaded = loadConfig({ env: { ERGO_DATA_DIR: test.dataDir }, homeDir: test.homeDir });
    expect(loaded.backup).toMatchObject({ schedule: "internal", time: "06:45", syncDir: test.syncDir });
  });
});

describe("手动校验最新的快照", () => {
  it("和备份不同时跑：备份正做着时排在后面，做完才校验；出结果（本机、另存文件夹各一条）", async () => {
    const gated = gatedFiles();
    const lines: string[] = [];
    const test = await startBackupDaemon({ start: START, backupFiles: () => gated.files, log: (line) => lines.push(line) });
    const { url } = test;
    await backupApi.run(url);
    await gated.copyStarted;

    const started = await backupApi.verify(url);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ verifying: true, queued: true });
    expect(started.body.lastVerify).toBeUndefined();
    // 正排着，再点一次不重复排
    expect((await backupApi.verify(url)).body.verifying).toBe(true);
    await sleep(200);
    expect(lines.some((l) => l.startsWith("校验："))).toBe(false);

    gated.release();
    const done = await idle(url);
    expect(done.verifying).toBe(false);
    expect(done.lastVerify?.checks).toEqual([
      { location: "local", date: TODAY, problems: [] },
      { location: "sync", date: TODAY, problems: [] },
    ]);
    const backupDone = lines.findIndex((l) => l.includes("已写进同步目录"));
    const verified = lines.findIndex((l) => l.startsWith("校验："));
    expect(backupDone).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThan(backupDone);
    expect(lines.filter((l) => l.startsWith("校验：本机备份区"))).toHaveLength(1);
    expect(fs.existsSync(backupLockFile(test.layout))).toBe(false);
  });

  it("没通过：结果里写问题，也放一条事项", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, layout } = test;
    await backupNow(url);
    const snapshot = readSnapshot(path.join(layout.backups, TODAY))!;
    const [rel] = Object.keys(snapshot.manifest.files);
    fs.rmSync(path.join(snapshot.dir, "data", ...rel!.split("/")), { force: true });

    expect((await backupApi.verify(url)).status).toBe(200);
    const done = await idle(url);
    const local = done.lastVerify?.checks.find((c) => c.location === "local");
    expect(local?.problems.join("")).toContain("不见了");
    expect(test.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "snapshot_check_failed")).toHaveLength(1);
  });

  it("校验结果记进本机备份区（411）：重启之后设置 · 备份照样看得到，体检的备份那一项按它说没通过", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, layout } = test;
    await backupNow(url);
    const snapshot = readSnapshot(path.join(layout.backups, TODAY))!;
    const [rel] = Object.keys(snapshot.manifest.files);
    fs.rmSync(path.join(snapshot.dir, "data", ...rel!.split("/")), { force: true });
    await backupApi.verify(url);
    const verified = (await idle(url)).lastVerify;
    expect(verified?.checks.find((c) => c.location === "local")?.problems.join("")).toContain("不见了");
    expect(fs.existsSync(path.join(layout.backups, VERIFY_RECORD_FILE))).toBe(true);

    const again = await restartBackupDaemon(test, at(10, 7, 22, 0));
    expect((await backupApi.status(again.url)).body.lastVerify).toEqual(verified);
    const facts = again.daemon.backup.doctorFacts();
    expect(facts).toMatchObject({ schedule: "internal", lastVerify: verified, latestLocal: TODAY, running: false });
    expect(facts.last).toMatchObject({ local: "created", sync: "copied" });
    expect(Date.parse(facts.lastOkAt!)).toBeGreaterThanOrEqual(Date.parse(nowIso(START)));
    const item = (await again.daemon.doctor.view()).groups.find((g) => g.kind === "core")?.items.find((i) => i.id === "backup");
    expect(item).toMatchObject({ level: "warn", fact: { key: "doctor.backup.verifyFailed" }, action: { kind: "open", route: "#/more/backup" } });
    expect(item?.text.fact).toContain("不见了");
  });

  it("另存的文件夹用不了：只校验本机，写明另存文件夹为什么没查", async () => {
    const test = await startBackupDaemon({ start: START });
    await backupNow(test.url);
    fs.rmSync(test.syncDir, { recursive: true, force: true });
    await backupApi.verify(test.url);
    const done = await idle(test.url);
    expect(done.lastVerify?.checks.map((c) => c.location)).toEqual(["local"]);
    expect(done.lastVerify?.syncSkipped).toContain("不存在");
  });

  it("还没有快照：checks 是空的，不报错", async () => {
    const test = await startBackupDaemon({ start: START });
    await backupApi.verify(test.url);
    const done = await idle(test.url);
    expect(done.lastVerify?.checks).toEqual([]);
  });
});

describe("已有的快照", () => {
  it("本机和另存文件夹各列日期和大小，新的在前；另存文件夹没配就不带；用不了写原因；清单坏了的写原因", async () => {
    const test = await startBackupDaemon({ start: START });
    const { url, layout, syncDir } = test;
    const empty = (await backupApi.snapshots(url)).body;
    expect(empty).toEqual({ local: { dir: layout.backups, snapshots: [] }, sync: { dir: syncDir, snapshots: [] } });

    await backupNow(url);
    await test.advanceTo(at(10, 8, 3, 35));
    const listed = (await backupApi.snapshots(url)).body;
    expect(listed.local.snapshots.map((s) => s.date)).toEqual(["2026-10-08", TODAY]);
    expect(listed.sync?.snapshots.map((s) => s.date)).toEqual(["2026-10-08", TODAY]);
    const manifest = readSnapshot(path.join(layout.backups, TODAY))!.manifest;
    const total = [...Object.values(manifest.files), ...Object.values(manifest.databases)].reduce((sum, f) => sum + f.size, 0);
    expect(listed.local.snapshots[1]?.bytes).toBe(total);
    expect(total).toBeGreaterThan(0);

    put(syncDir, "2026-10-01/manifest.json", "读不懂");
    const bad = (await backupApi.snapshots(url)).body;
    expect(bad.sync?.snapshots.at(-1)).toMatchObject({ date: "2026-10-01", problem: expect.stringContaining("读不出来") });

    fs.rmSync(syncDir, { recursive: true, force: true });
    const gone = (await backupApi.snapshots(url)).body;
    expect(gone.sync).toMatchObject({ dir: syncDir, snapshots: [], problem: expect.stringContaining("不存在") });
    expect(gone.local.snapshots).toHaveLength(2);

    await backupApi.config(url, { syncDir: null });
    expect((await backupApi.snapshots(url)).body.sync).toBeUndefined();
  });
});

describe("在电脑上打开", () => {
  it("只认本机和另存文件夹两处：打开的是配置里的路径；用不了写原因，不乱开", async () => {
    const opened: string[] = [];
    const test = await startBackupDaemon({
      start: START,
      openFolder: (dir) => {
        opened.push(dir);
        return Promise.resolve();
      },
    });
    const { url, layout, syncDir } = test;
    expect((await backupApi.open(url, "local")).body).toEqual({ opened: true });
    expect((await backupApi.open(url, "sync")).body).toEqual({ opened: true });
    expect(opened).toEqual([layout.backups, syncDir]);

    fs.rmSync(syncDir, { recursive: true, force: true });
    expect((await backupApi.open(url, "sync")).body).toMatchObject({ opened: false, error: expect.stringContaining("不存在") });
    await backupApi.config(url, { syncDir: null });
    expect((await backupApi.open(url, "sync")).body).toMatchObject({ opened: false, error: expect.any(String) });
    expect(opened).toHaveLength(2);

    expect((await backupApi.open(url, "elsewhere" as "local")).status).toBe(400);
  });

  it("打不开（拉不起文件管理器）：写原因，不是 500", async () => {
    const test = await startBackupDaemon({ start: START, openFolder: () => Promise.reject(new Error("拉不起来")) });
    expect((await backupApi.open(test.url, "local")).body).toMatchObject({ opened: false, error: expect.stringContaining("拉不起来") });
  });
});

describe("状况里页面要的", () => {
  it("本机路径、留几份、命令（git clone 的说法，因为测试在仓库里跑），都在 GET /api/backup 里", async () => {
    const test = await startBackupDaemon({ start: START });
    const view = (await backupApi.status(test.url)).body;
    expect(view).toMatchObject({ localDir: test.layout.backups, retention: { local: 7, syncDaily: 7, syncWeekly: 4 }, verifying: false });
    expect(view.commands.install).toBe("source");
    expect(view.commands.scheduled).toContain("npm run backup -- --scheduled");
    expect(view.commands.restore.some((s) => s.command.includes("restore.ts"))).toBe(true);
  });
});
