// 主切面（335 号票）：设置里的"备份"接口（现在的状况、立即备份）、和定时那次不叠跑、备份锁（另一份在做时等它、主人没了锁作废）、
// backup.schedule 是 external 时守护进程不再到点备份、连着两天没人备份时提醒一条。
// 调度器的时钟换成手动拨的；同步目录一律是测试建的临时目录；端口是系统挑的。
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BackupStatusView, CHANNELS, nowIso } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { backupLockFile } from "../../src/backup/lock.ts";
import { RestoreRefused, restoreSnapshot } from "../../src/backup/restore.ts";
import { listSnapshotDates, readSnapshot, verifySnapshot } from "../../src/backup/snapshot.ts";
import { processStartTime } from "../../src/process/pid-file.ts";
import { put, startBackupDaemon } from "../helpers/backup.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { backupApi } from "../helpers/http.ts";
import { killIfRunning, waitUntil } from "../helpers/process.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

/** 取状况直到守护进程这边没排着、也没人拿着锁 */
async function idle(url: string): Promise<BackupStatusView> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const view = (await backupApi.status(url)).body;
    if (!view.queued && view.running === undefined) return view;
    if (Date.now() > deadline) throw new Error(`20 秒还没做完：${JSON.stringify(view)}`);
    await sleep(100);
  }
}

/** 复制文件时停住，等测试放行；记下同时有几份在复制（叠着跑会到 2） */
function gatedFiles() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const copyStarted = new Promise<void>((resolve) => (started = resolve));
  const state = { active: 0, maxActive: 0 };
  const files: SnapshotFiles = {
    ...nodeSnapshotFiles,
    async copy(src, dest, length) {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      started();
      try {
        await gate;
        return await nodeSnapshotFiles.copy(src, dest, length);
      } finally {
        state.active--;
      }
    },
  };
  return { files, release: () => release(), copyStarted, state };
}

/** 一个一直活着的进程（当作拿着锁的命令行脚本），测试结束时结束它 */
async function liveProcess(): Promise<{ child: ChildProcess; startedAt: string; exited: Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(async () => {
    killIfRunning(child);
    await exited;
  });
  let started: Date | undefined;
  await waitUntil(() => (started = processStartTime(child.pid!)) !== undefined, { timeoutMs: 5_000 });
  return { child, startedAt: started!.toISOString(), exited };
}

describe("设置里的备份接口", () => {
  it("GET 看状况：每天 03:30、下一次、同步目录能用、还没备份过；POST 立即备份马上回（排着），做完本机和同步目录都有当天的快照、记下最近一次", async () => {
    const { url, layout, syncDir } = await startBackupDaemon({ start: START });
    const before = (await backupApi.status(url)).body;
    expect(before).toEqual({ schedule: "internal", time: "03:30", next: nowIso(at(10, 8, 3, 30)), syncDir: { kind: "ready", dir: syncDir }, queued: false });

    const started = await backupApi.run(url);
    expect(started.status).toBe(200);
    expect(started.body.queued).toBe(true);
    const done = await idle(url);
    expect(done).toMatchObject({ latestLocal: "2026-10-07", latestSync: "2026-10-07", queued: false, last: { by: "daemon", mode: "manual", date: "2026-10-07", local: "created", sync: "copied" } });
    expect(done.last?.startedAt).toBe(nowIso(START));
    for (const root of [layout.backups, syncDir]) {
      expect(listSnapshotDates(root)).toEqual(["2026-10-07"]);
      expect(await verifySnapshot(path.join(root, "2026-10-07"))).toEqual([]);
    }
    // 锁放开了
    expect(fs.existsSync(backupLockFile(layout))).toBe(false);
  });

  it("和定时那次同时触发不叠跑：03:30 那次做到一半时点立即备份，排着等它做完才开始；两次都做了，最后一次是手动的、换掉了当天那份", async () => {
    const gated = gatedFiles();
    const lines: string[] = [];
    const { url, clock, daemon, dataDir } = await startBackupDaemon({ start: START, backupFiles: () => gated.files, log: (line) => lines.push(line) });
    put(dataDir, "projects/p-demo/charter.md", "# 立项书\n");
    clock.advanceTo(at(10, 8, 3, 30)); // 到点：守护进程自己开始备份（异步）
    await gated.copyStarted;

    const started = (await backupApi.run(url)).body;
    expect(started).toMatchObject({ queued: true, running: { by: "daemon", pid: process.pid } });
    await sleep(500);
    expect(gated.state.maxActive).toBe(1);
    // 再点一次：已经排着一次，不再排
    expect((await backupApi.run(url)).body.queued).toBe(true);

    gated.release();
    await daemon.internalJobs.whenIdle();
    const done = await idle(url);
    expect(gated.state.maxActive).toBe(1);
    expect(done.last).toMatchObject({ by: "daemon", mode: "manual", date: "2026-10-08", local: "replaced", sync: "replaced" });
    // 到点的一次 + 立即备份一次（点了两下也只排了一次）
    expect(lines.filter((l) => l.includes("开始做 2026-10-08 的本机快照"))).toHaveLength(2);
  });
});

describe("备份锁", () => {
  it("命令行那份正拿着锁：立即备份等它（设置里看得到是谁在做），那个进程没了锁作废，接着做完；恢复命令在有人拿着锁时也拒绝", async () => {
    const lines: string[] = [];
    const test = await startBackupDaemon({ start: new Date(), log: (line) => lines.push(line) });
    const { url, daemon, layout } = test;
    const holder = await liveProcess();
    const since = nowIso();
    fs.mkdirSync(layout.backups, { recursive: true });
    fs.writeFileSync(backupLockFile(layout), JSON.stringify({ pid: holder.child.pid, processStartedAt: holder.startedAt, by: "script", since }));

    let settled = false;
    const result = daemon.backup.backupNow().finally(() => (settled = true));
    await waitUntil(() => lines.some((l) => l.includes("等另一份备份做完")), { timeoutMs: 5_000, describe: () => lines.join("\n") });
    expect(lines.find((l) => l.includes("等另一份备份做完"))).toContain(`命令行，PID ${holder.child.pid}`);
    const waiting = (await backupApi.status(url)).body;
    expect(waiting).toMatchObject({ queued: true, running: { by: "script", pid: holder.child.pid, since } });
    await sleep(1_500);
    expect(settled).toBe(false);
    expect(listSnapshotDates(layout.backups)).toEqual([]);

    killIfRunning(holder.child);
    await holder.exited;
    expect(await result).toMatchObject({ local: "created", sync: "copied" });
    expect(lines.some((l) => l.includes("锁的主人已经不在了"))).toBe(true);
    expect((await idle(url)).last).toMatchObject({ by: "daemon", local: "created" });

    // 恢复命令：守护进程停了，但有一份备份正拿着锁
    await daemon.stop();
    const another = await liveProcess();
    fs.writeFileSync(backupLockFile(layout), JSON.stringify({ pid: another.child.pid, processStartedAt: another.startedAt, by: "script", since: nowIso() }));
    const date = listSnapshotDates(layout.backups).at(-1)!;
    await expect(restoreSnapshot({ config: daemon.config, layout, date })).rejects.toThrow(RestoreRefused);
    await expect(restoreSnapshot({ config: daemon.config, layout, date })).rejects.toThrow(`有一份备份正在做（命令行，PID ${another.child.pid}`);
  });
});

describe("交给外部定时器（backup.schedule 是 external）", () => {
  it("到 03:30 守护进程不再自己备份；每周校验、临时区清理照旧登记；设置里写交给外部定时器、没有下一次", async () => {
    const { url, daemon, layout, advanceTo } = await startBackupDaemon({ start: START, config: { backup: { schedule: "external" } } });
    await advanceTo(at(10, 8, 4, 30));
    expect(listSnapshotDates(layout.backups)).toEqual([]);
    expect(daemon.internalJobs.state("backup")).toBeUndefined();
    expect(daemon.internalJobs.state("verify_snapshot")).toBeDefined();
    expect(daemon.internalJobs.state("clean_tmp")?.lastRunAt).toBe(nowIso(at(10, 8, 4, 0)));
    const view = (await backupApi.status(url)).body;
    expect(view).toMatchObject({ schedule: "external", time: "03:30", queued: false });
    expect(view.next).toBeUndefined();
    // 立即备份照样能用
    await backupApi.run(url);
    expect((await idle(url)).last).toMatchObject({ by: "daemon", mode: "manual", date: "2026-10-08", local: "created", sync: "copied" });
  });

  it("连着两天没人备份：中午提醒一条（没处理就不再叠一条）；点“立即备份”守护进程马上做一次；之后有人备份过就不再提醒", async () => {
    const { url, daemon, syncDir, advanceTo } = await startBackupDaemon({ start: START, config: { backup: { schedule: "external" } } });
    const overdue = () => daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "backup_overdue");
    // 从 10-07 21:00 交给外部定时器起算：10-09 中午才 39 小时，不提醒
    await advanceTo(at(10, 9, 12, 0));
    expect(overdue()).toEqual([]);
    // 10-10 中午：两天多没人备份
    await advanceTo(at(10, 10, 12, 0));
    expect(overdue()).toHaveLength(1);
    expect(overdue()[0]).toMatchObject({ kind: "notice", title: "备份已经 2 天没跑了", urgency: "non_blocking", source: "备份", actions: ["立即备份", "知道了"] });
    expect(overdue()[0]).toMatchObject({ body: expect.stringContaining("npm run backup") });
    // 第二天中午：那条还没处理，不再叠一条
    await advanceTo(at(10, 11, 12, 0));
    expect(overdue()).toHaveLength(1);

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.inbox]: 0 });
    expect(await frontend.inboxAction({ itemIds: [overdue()[0]!.id], action: "handle", choice: "立即备份" })).toMatchObject({ ok: true });
    await waitUntil(() => readSnapshot(path.join(syncDir, "2026-10-11")) !== undefined, { timeoutMs: 10_000 });
    expect((await idle(url)).last).toMatchObject({ by: "daemon", mode: "manual", date: "2026-10-11", local: "created", sync: "copied" });

    // 10-11 12:00 备份过：10-12 中午才一天，不提醒；之后又没人备份，10-13 中午满两天，再提醒一条（上一条已经处理过了）
    await advanceTo(at(10, 12, 12, 0));
    expect(overdue()).toHaveLength(1);
    await advanceTo(at(10, 13, 12, 0));
    expect(overdue()).toHaveLength(2);
    expect(overdue().filter((i) => i.kind === "notice" && i.handled === undefined)).toHaveLength(1);
  });
});
