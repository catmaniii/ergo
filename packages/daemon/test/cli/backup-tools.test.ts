// ergo backup / ergo restore（356 号票）：一行命令装的没有 npm run，备份、恢复的命令行工具接到 ergo 命令上。
// 都是临时的数据目录、临时的主目录；不碰服务管家。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";
import { listSnapshotDates, localDate } from "../../src/backup/snapshot.ts";
import type { InstallLayout } from "../../src/release/layout.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

const MAIN = path.resolve(import.meta.dirname, "../../src/cli/main.ts");
const quiet = { out: () => {}, err: () => {}, ask: async () => "" };

function ergo(env: Record<string, string | undefined>, ...args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

function setup() {
  const home = makeTempDir("ergo-home-");
  const dataDir = makeTempDir("ergo-data-");
  return { home, dataDir, env: withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(home), { ERGO_DATA_DIR: dataDir, DEEPSEEK_API_KEY: undefined, ERGO_HOME: undefined }) };
}

/** 一个假的程序目录：工具只记下收到的参数和数据目录，退出码是 7 */
function fakeApp(tool: string) {
  const appDir = makeTempDir("ergo-app-");
  const out = path.join(appDir, "seen.json");
  const script = path.join(appDir, "packages", "daemon", "src", `${tool}${path.extname(import.meta.filename)}`);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), data: process.env.ERGO_DATA_DIR }));\nprocess.exit(7);\n`);
  const layout: InstallLayout = { kind: "installed", home: appDir, appDir, node: process.execPath };
  return { layout, seen: () => JSON.parse(fs.readFileSync(out, "utf8")) as { args: string[]; data: string } };
}

describe("ergo backup / ergo restore", () => {
  it("真的跑：ergo backup 做好今天的快照（退出码 0），ergo restore --list 列得出来", () => {
    const { dataDir, env } = setup();
    const backup = ergo(env, "backup");
    expect(backup.stderr).toBe("");
    expect(backup.status).toBe(0);
    const today = localDate(Date.now());
    expect(backup.stdout).toContain(`备份完成：${today}`);
    expect(listSnapshotDates(path.join(dataDir, "backups"))).toEqual([today]);

    const list = ergo(env, "restore", "--list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(`数据目录：${dataDir}`);
    expect(list.stdout).toContain(today);
  }, 90_000);

  it("ergo restore 不带日期：用法写的是 ergo restore，退出码 2", () => {
    const { env } = setup();
    const run = ergo(env, "restore");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("ergo restore <日期");
  });

  it("参数原样转（--from sync 不被 ergo 自己吃掉）、数据目录明着传、退出码原样带回", async () => {
    const { layout, seen } = fakeApp("restore");
    const dataDir = makeTempDir("ergo-data-");
    const ctx = createContext(layout, { ERGO_DATA_DIR: dataDir }, quiet);
    expect(await runCli(["restore", "2026-10-15", "--from", "sync"], ctx)).toBe(7);
    expect(seen()).toEqual({ args: ["2026-10-15", "--from", "sync"], data: dataDir });
  });

  it("ergo backup --scheduled 跑的是 run-backup，定时用的开关转过去", async () => {
    const { layout, seen } = fakeApp("run-backup");
    const ctx = createContext(layout, { ERGO_DATA_DIR: makeTempDir("ergo-data-") }, quiet);
    expect(await runCli(["backup", "--scheduled"], ctx)).toBe(7);
    expect(seen().args).toEqual(["--scheduled"]);
  });
});
