// 恢复命令的命令行入口（src/restore.ts）：像 LSM 那样拉起守护进程（src/main.ts），恢复命令看到它在运行就拒绝；
// 守护进程被结束之后（pid 文件还留着，但进程已经不在了）按日期恢复；--list 列出快照。
// 数据目录、同步目录都是临时目录，端口是临时挑的空闲端口；拉起的进程是测试的一部分，用完即销毁。
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { localDate } from "../../src/backup/snapshot.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { put, startBackupDaemon } from "../helpers/backup.ts";
import { writeConfig } from "../helpers/daemon.ts";
import { freePorts } from "../helpers/ports.ts";
import { forceKill, isProcessAlive, waitUntil } from "../helpers/process.ts";
import { tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

const SRC = path.resolve(import.meta.dirname, "../../src");

describe("恢复命令（命令行）", () => {
  it("守护进程在运行时拒绝、什么也不动；结束之后按日期恢复；--list 列出快照", async () => {
    // 先做一份今天的快照（时钟就用现在）
    const prepared = await startBackupDaemon({ start: new Date() });
    prepared.daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "快照里的事项", source: "测试", urgency: "non_blocking" });
    const result = await prepared.daemon.backup.backupNow();
    expect(result).toMatchObject({ local: "created", sync: "copied" });
    const today = localDate(Date.now());
    expect(result.date).toBe(today);
    await prepared.daemon.stop();
    const { dataDir, homeDir } = prepared;
    writeConfig(dataDir, { ports: await freePorts() });
    const env = withEnv(process.env, tempUserProfileEnv(homeDir), { ERGOU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: undefined });

    const daemon = startEntry(env);
    await waitUntil(() => daemon.stderr().includes("已启动"), { timeoutMs: 20_000, describe: daemon.stderr });
    const after = put(dataDir, "projects/p-demo/after.md", "快照之后写的");

    const refused = runRestore(env, today);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/没有恢复：守护进程还在运行（.*）：先在 Local Service Manager 里停掉 ergou-daemon，再恢复/);
    expect(fs.existsSync(after)).toBe(true);

    // 守护进程被结束（pid 文件还在，进程已经不在了）
    forceKill(daemon.child.pid!);
    await daemon.exited;
    expect(fs.existsSync(dataDirLayout(dataDir).pidFile)).toBe(true);

    const listed = runRestore(env, "--list");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`本机备份区（${dataDirLayout(dataDir).backups}）：${today}`);
    expect(listed.stdout).toContain(`同步目录（${prepared.syncDir}）：${today}`);

    const done = runRestore(env, today, "--from", "sync");
    expect({ status: done.status, stderr: done.stderr }).toEqual({ status: 0, stderr: "" });
    expect(done.stdout).toContain(`已从 ${path.join(prepared.syncDir, today)} 恢复数据目录`);
    expect(fs.existsSync(after)).toBe(false);

    const missing = runRestore(env, "2020-01-01");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("没有恢复：找不到 2020-01-01 的快照");
  });
});

function runRestore(env: Record<string, string | undefined>, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(SRC, "restore.ts"), ...args], { env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

/** 像 LSM 那样拉起入口（只给环境），测试结束时结束它 */
function startEntry(env: Record<string, string | undefined>): { child: ChildProcess; exited: Promise<void>; stderr: () => string } {
  const child = spawn(process.execPath, [path.join(SRC, "main.ts")], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  onTestFinished(async () => {
    if (child.pid !== undefined && isProcessAlive(child.pid)) forceKill(child.pid);
    await exited;
  });
  return { child, exited, stderr: () => stderr };
}
