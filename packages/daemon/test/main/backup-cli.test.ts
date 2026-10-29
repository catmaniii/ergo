// 命令行备份（335 号票，npm run backup → src/run-backup.ts）：像外部定时器那样拉起脚本（只给环境），看退出码和输出。
// 守护进程是测试里起的（不碰真的守护进程），数据目录、同步目录都是临时目录，端口是系统挑的；拉起的进程用完即销毁。
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CHANNELS, nowIso } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { backupLockFile } from "../../src/backup/lock.ts";
import { readBackupRecord } from "../../src/backup/record.ts";
import { localDate, verifySnapshot } from "../../src/backup/snapshot.ts";
import { type BackupDaemon, startBackupDaemon } from "../helpers/backup.ts";
import { backupApi } from "../helpers/http.ts";
import { killIfRunning, waitUntil } from "../helpers/process.ts";
import { snapshotEvents, snapshotFile } from "../helpers/snapshots.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../../src/run-backup.ts");

/** 脚本的环境：和守护进程同一个数据目录（配置里有同步目录） */
const envOf = (test: Pick<BackupDaemon, "dataDir" | "homeDir">) => withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(test.homeDir), { ERGO_DATA_DIR: test.dataDir, DEEPSEEK_API_KEY: undefined });

function runScript(env: Record<string, string | undefined>, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

const lastLine = (stdout: string) => stdout.trim().split(/\r?\n/).at(-1);
const inboxIds = (dbFile: string) => snapshotEvents(dbFile, CHANNELS.inbox).map((e) => (e.payload as { item: { id: string } }).item.id);

/** 后台拉起脚本，边跑边收输出；测试结束时结束它 */
function startScript(env: Record<string, string | undefined>): { child: ChildProcess; stdout: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  onTestFinished(async () => {
    killIfRunning(child);
    await exited;
  });
  return { child, stdout: () => stdout, exited };
}

describe("命令行备份（npm run backup）", () => {
  it("守护进程开着时跑：本机和同步目录都有今天的快照、数据库一致，守护进程照常干活；一步一行，最后一行是结论，退出码 0，日志进 logs/backup.log，设置里看得到这次", async () => {
    const test = await startBackupDaemon({ start: new Date() });
    const { daemon, layout, syncDir, url } = test;
    const item = daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "快照之前的事项", source: "测试", urgency: "non_blocking" });
    const today = localDate(Date.now());

    const run = runScript(envOf(test));
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lastLine(run.stdout)).toBe(`备份完成：${today}，已写进同步目录`);
    expect(run.stdout).toContain(`同步目录：${syncDir}`);
    expect(run.stdout).toContain(`备份：本机快照 ${today} 做好了`);
    expect(run.stdout).toContain(`备份：开始写进同步目录 ${syncDir}`);
    for (const root of [layout.backups, syncDir]) expect(await verifySnapshot(path.join(root, today))).toEqual([]);
    expect(inboxIds(snapshotFile(syncDir, today, "db/ergo.db"))).toEqual([item.id]);
    // 守护进程照常干活
    const after = daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "备份之后的事项", source: "测试", urgency: "non_blocking" });
    expect(daemon.inbox.list().map((i) => i.id)).toEqual([item.id, after.id]);

    const log = fs.readFileSync(path.join(layout.logs, "backup.log"), "utf8");
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ── npm run backup（PID \d+）──/m);
    expect(log).toContain(`备份完成：${today}，已写进同步目录`);
    expect((await backupApi.status(url)).body).toMatchObject({ latestLocal: today, latestSync: today, last: { by: "script", mode: "manual", date: today, local: "created", sync: "copied" } });

    // 给定时器用的 --scheduled：今天的都有了，什么也不动
    const again = runScript(envOf(test), "--scheduled");
    expect(again.status).toBe(0);
    expect(lastLine(again.stdout)).toBe(`备份完成：${today} 的快照本机和同步目录里都已经有了，没重做`);
    expect(readBackupRecord(layout)).toMatchObject({ by: "script", mode: "auto", local: "kept", sync: "kept" });
  });

  it("两份同时跑不叠：守护进程的立即备份做到一半时跑脚本，脚本说明在等谁、等它做完再做自己的", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let copying!: () => void;
    const copyStarted = new Promise<void>((resolve) => (copying = resolve));
    const files: SnapshotFiles = {
      ...nodeSnapshotFiles,
      async copy(src, dest, length) {
        copying();
        await gate;
        return nodeSnapshotFiles.copy(src, dest, length);
      },
    };
    const test = await startBackupDaemon({ start: new Date(), backupFiles: () => files });
    const today = localDate(Date.now());
    const daemonRun = test.daemon.backup.backupNow();
    await copyStarted;

    const script = startScript(envOf(test));
    await waitUntil(() => script.stdout().includes("等另一份备份做完"), { timeoutMs: 30_000, describe: script.stdout });
    expect(script.stdout()).toContain(`等另一份备份做完——守护进程，PID ${process.pid}`);
    await sleep(1_500);
    expect(script.child.exitCode).toBeNull();
    expect(script.stdout()).not.toContain("开始做");

    release();
    expect(await daemonRun).toMatchObject({ local: "created", sync: "copied" });
    expect(await script.exited).toBe(0);
    expect(lastLine(script.stdout())).toBe(`备份完成：${today}，已写进同步目录`);
    // 脚本是在守护进程那次做完之后才做的：换掉了当天那份
    expect(readBackupRecord(test.layout)).toMatchObject({ by: "script", local: "replaced", sync: "replaced" });
    expect(fs.existsSync(backupLockFile(test.layout))).toBe(false);
  });

  it("守护进程没在跑也能用；锁的主人已经不在了（进程没了）：锁作废，接着做", async () => {
    const test = await startBackupDaemon({ start: new Date() });
    await test.daemon.stop();
    const dead = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    fs.mkdirSync(test.layout.backups, { recursive: true });
    fs.writeFileSync(backupLockFile(test.layout), JSON.stringify({ pid: dead.pid, processStartedAt: "2020-01-01T00:00:00.000Z", by: "daemon", since: nowIso() }));

    const run = runScript(envOf(test));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`锁的主人已经不在了（守护进程，PID ${dead.pid}`);
    expect(lastLine(run.stdout)).toBe(`备份完成：${localDate(Date.now())}，已写进同步目录`);
    expect(fs.existsSync(backupLockFile(test.layout))).toBe(false);
  });

  it("没做成退出码 1、最后一行写原因：同步目录不在时本机快照照样做好；参数不认得退出码 2", async () => {
    const syncDir = path.join(makeTempDir("ergo-sync-parent-"), "missing");
    const test = await startBackupDaemon({ start: new Date(), syncDir });
    await test.daemon.stop();
    const today = localDate(Date.now());

    const run = runScript(envOf(test));
    expect(run.status).toBe(1);
    expect(lastLine(run.stdout)).toBe(`备份失败：本机快照做好了（${today}），但没写进同步目录：同步目录 ${syncDir} 不存在`);
    expect(await verifySnapshot(path.join(test.layout.backups, today))).toEqual([]);
    expect(readBackupRecord(test.layout)).toMatchObject({ by: "script", local: "created", sync: "failed" });

    const bad = runScript(envOf(test), "--now");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("不认得的参数：--now");
  });
});
