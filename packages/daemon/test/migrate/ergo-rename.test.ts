// 从 ergou 迁到 ergo 的迁移脚本（312 号票，migrate/ergo-rename.ts）：只在临时目录里测——
// dry-run 什么都不动、正式跑改名 + 改文件名 + 建目录联接、重跑全跳过、联接建好后旧路径照样读得到文件、守护进程在跑时不动、两份都在时不动。
// 守护进程在不在跑按配置里的端口查：临时数据目录的配置里写一个测试自己的端口，不去碰本机真的 8810。
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { lsmSteps, migrateToErgo, migrationDirs } from "../../src/migrate/ergo-rename.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const REPO = path.resolve(import.meta.dirname, "../../../..");

/** 跑一次命令行 */
const run = (args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [path.join(REPO, "packages/daemon/src/migrate-ergo.ts"), ...args], { cwd: REPO, windowsHide: true }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout }));
  });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 拿一个空闲端口（监听一下就关） */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 一个旧的数据目录（主目录下的 .ergou）：旧名字的配置（本机端口是测试的）、事件库连同 -wal、一个集合的旧清单、一份普通文件 */
async function oldDataDir(): Promise<{ home: string; oldDir: string; newDir: string; port: number }> {
  const home = makeTempDir("ergo-migrate-home-");
  const oldDir = path.join(home, ".ergou");
  const port = await freePort();
  write(path.join(oldDir, "config", "ergou.json"), JSON.stringify({ ports: { local: port, external: await freePort() } }));
  write(path.join(oldDir, "db", "ergou.db"), "DB");
  write(path.join(oldDir, "db", "ergou.db-wal"), "WAL");
  write(path.join(oldDir, "db", "memory.db"), "MEM");
  write(path.join(oldDir, "skills", "pack", "ergou-collection.json"), "{}");
  write(path.join(oldDir, "projects", "p-1", "notes.md"), "笔记");
  return { home, oldDir, newDir: path.join(home, ".ergo"), port };
}

describe("迁移脚本", () => {
  it("不给 --data-dir 是主目录下的 .ergou → .ergo；给新名字的目录时旧的是它旁边旧名字的那个", () => {
    expect(migrationDirs({ homeDir: "C:\\Users\\me" })).toEqual({ oldDir: path.resolve("C:\\Users\\me\\.ergou"), newDir: path.resolve("C:\\Users\\me\\.ergo") });
    expect(migrationDirs({ homeDir: "C:\\Users\\me", dataDir: "D:\\data\\.ergo" })).toEqual({ oldDir: path.resolve("D:\\data\\.ergou"), newDir: path.resolve("D:\\data\\.ergo") });
    expect(migrationDirs({ homeDir: "C:\\Users\\me", dataDir: "D:\\ergou-data" })).toEqual({ oldDir: path.resolve("D:\\ergou-data"), newDir: path.resolve("D:\\ergo-data") });
  });

  it("dry-run 只列要做什么，什么都不动", async () => {
    const { home, oldDir, newDir } = await oldDataDir();
    const result = await migrateToErgo({ homeDir: home, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.state, s.what])).toEqual([
      ["done", "确认守护进程没在跑"],
      ["planned", `把 ${oldDir} 改名成 ${newDir}`],
      ["planned", `${path.join("config", "ergou.json")} 改名成 ergo.json`],
      ["planned", `${path.join("db", "ergou.db")} 改名成 ergo.db`],
      ["planned", `${path.join("db", "ergou.db-wal")} 改名成 ergo.db-wal`],
      ["planned", `${path.join("skills", "pack", "ergou-collection.json")} 改名成 ergo-collection.json`],
      ["planned", `在 ${oldDir} 建目录联接，指到 ${newDir}`],
    ]);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(fs.lstatSync(oldDir).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(oldDir, "db", "ergou.db"), "utf8")).toBe("DB");
  });

  it("正式跑：改名、改文件名、建联接；旧路径照样读得到文件；重跑全跳过", async () => {
    const { home, oldDir, newDir } = await oldDataDir();
    const result = await migrateToErgo({ homeDir: home, dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.state === "done")).toBe(true);
    // 新目录里是新名字
    expect(fs.readFileSync(path.join(newDir, "db", "ergo.db"), "utf8")).toBe("DB");
    expect(fs.readFileSync(path.join(newDir, "db", "ergo.db-wal"), "utf8")).toBe("WAL");
    expect(fs.readFileSync(path.join(newDir, "db", "memory.db"), "utf8")).toBe("MEM");
    expect(JSON.parse(fs.readFileSync(path.join(newDir, "config", "ergo.json"), "utf8"))).toHaveProperty("ports");
    expect(fs.existsSync(path.join(newDir, "skills", "pack", "ergo-collection.json"))).toBe(true);
    for (const old of ["config/ergou.json", "db/ergou.db", "db/ergou.db-wal", "skills/pack/ergou-collection.json"]) expect(fs.existsSync(path.join(newDir, old))).toBe(false);
    // 旧路径是指到新目录的目录联接：事件日志里写着的旧路径照样读得到
    expect(fs.lstatSync(oldDir).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync.native(oldDir)).toBe(fs.realpathSync.native(newDir));
    expect(fs.readFileSync(path.join(oldDir, "projects", "p-1", "notes.md"), "utf8")).toBe("笔记");
    expect(fs.readFileSync(path.join(oldDir, "db", "ergo.db"), "utf8")).toBe("DB");

    const again = await migrateToErgo({ homeDir: home, dryRun: false });
    expect(again.ok).toBe(true);
    expect(again.steps.map((s) => s.state)).toEqual(["done", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    const dry = await migrateToErgo({ homeDir: home, dryRun: true });
    expect(dry.steps.filter((s) => s.state === "planned")).toEqual([]);
  });

  it("中途停下过（目录改了名、联接还没建）：再跑接着做完", async () => {
    const { home, oldDir, newDir } = await oldDataDir();
    fs.renameSync(oldDir, newDir);
    fs.renameSync(path.join(newDir, "db", "ergou.db"), path.join(newDir, "db", "ergo.db"));
    const result = await migrateToErgo({ homeDir: home, dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.what.includes("ergou.db 改名"))?.state).toBe("skipped");
    expect(result.steps.find((s) => s.what.includes("ergou.json"))?.state).toBe("done");
    expect(fs.realpathSync.native(oldDir)).toBe(fs.realpathSync.native(newDir));
  });

  it("守护进程在跑（配置里的本机端口有人在听）：什么都不动，退出不成功", async () => {
    const { home, oldDir, newDir, port } = await oldDataDir();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const result = await migrateToErgo({ homeDir: home, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([{ what: "确认守护进程没在跑", state: "failed", detail: expect.stringContaining(`本机端口 ${port}`) }]);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(fs.existsSync(path.join(oldDir, "db", "ergou.db"))).toBe(true);
  });

  it("新旧两个目录都是真目录：不动，写明两份都在", async () => {
    const { home, oldDir, newDir } = await oldDataDir();
    fs.mkdirSync(newDir);
    const result = await migrateToErgo({ homeDir: home, dryRun: false, running: async () => undefined });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ state: "failed", detail: expect.stringContaining("两份都在") });
    expect(fs.existsSync(path.join(oldDir, "db", "ergou.db"))).toBe(true);
  });

  it("LSM 那边的几步照 LSM 的命令行写：停旧的、撤名下的服务、换登记文件、开机自启和 tailnet 照旧开、启动新的", () => {
    const steps = lsmSteps("C:\\Users\\me\\.ergo").join("\n");
    for (const s of ["lsm stop ergou-daemon", "lsm owned remove ergou-daemon--", "lsm tailnet ergou-daemon off", "ergo-daemon.yaml", "ERGO_DATA_DIR", "C:\\Users\\me\\.ergo", "lsm reload", "lsm autostart ergo-daemon on", "lsm start ergo-daemon"]) {
      expect(steps).toContain(s);
    }
  });

  it("命令行：npm run migrate:ergo -- --data-dir <目录> --dry-run，用法不对退出码 2", async () => {
    const { oldDir } = await oldDataDir();
    const dry = await run(["--data-dir", oldDir, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("○ 要做");
    expect(dry.out).toContain("LSM 那边接着做");
    expect(fs.lstatSync(oldDir).isSymbolicLink()).toBe(false);
    expect((await run(["--bogus"])).code).toBe(2);
  });
});
