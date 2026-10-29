// LSM 用的入口和 stop 钩子（src/main.ts、src/stop.ts）：按 LSM 的方式拉起一个独立进程
// （只给 ERGO_DATA_DIR，端口从数据目录的配置读），秘书拉起来、健康探针有回应；stop 钩子核对 pid 文件后把它停下，
// 对不上就什么也不做。
// 这是测试的一部分：数据目录是临时的，端口是临时挑的空闲端口，用完即销毁，不在 LSM 登记。
// （进程被直接结束时子进程随 Job 对象一起结束，见 job-object.test.ts。）
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { type PidRecord, readPidFile } from "../../src/process/pid-file.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { writePortConfig } from "../helpers/ports.ts";
import { isProcessAlive, killIfRunning, SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

const SRC = path.resolve(import.meta.dirname, "../../src");

describe("ergo-daemon 入口", () => {
  // 等入口报"已启动"（20 秒）再等秘书拉起来（20 秒）：加起来超过默认的用例超时，写明更长的
  it("只给数据目录就能起来：端口从配置读，写下 pid 文件，秘书拉起之后 /healthz 报告它闲着；没有模型 key 时记一条提示", { timeout: 50_000 }, async () => {
    const daemon = await startEntry();
    expect(daemon.stderr()).toContain(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.stderr()).toContain("没有 deepseek 的模型 key");
    expect(readPidFile(daemon.pidFile)).toMatchObject({ pid: daemon.child.pid, port: daemon.port });

    // Web UI 有没有构建都行（构建产物不进仓库），这里只看秘书（等它拉起来）
    let health = await healthz(daemon.port);
    const deadline = Date.now() + SECRETARY_START_TIMEOUT_MS;
    while (health.secretary !== "idle" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      health = await healthz(daemon.port);
    }
    expect(health.secretary).toBe("idle");
    // 插件（126 号票）：入口经组合根和插件清单装好了插件（走的是正式的装配路径）
    expect(health.plugins).toEqual({ running: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: [], skipped: [] });
    // 插件都装上了：不降级（Web UI 没构建时整体不健康，和插件无关）
    expect(health.status).toBe(health.webUi === true ? "ok" : "unhealthy");
  });
});

describe("单实例（23 号票）", () => {
  it("同一个数据目录已经有一个在跑：再起一个立即退出（退出码 1）、说明原因，不碰任何状态；先起的那个照常，pid 文件还是它的", { timeout: 50_000 }, async () => {
    const daemon = await startEntry();
    const second = spawn(process.execPath, [path.join(SRC, "main.ts")], { env: daemon.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    onTestFinished(() => {
      killIfRunning(second);
    });
    let stderr = "";
    second.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain(`已经有一个守护进程在运行（pid 文件里的守护进程（PID ${daemon.child.pid}）还在运行）`);
    expect(readPidFile(daemon.pidFile)).toMatchObject({ pid: daemon.child.pid, port: daemon.port });
    expect((await healthz(daemon.port)).secretary).toBeDefined();
  });
});

describe("接入 LSM 的 link 协议（23 号票）", () => {
  it("LSM 注入了身份：入口连上它；经协议要求停机时优雅停止、删掉 pid 文件、发 bye、以退出码 0 退出", { timeout: 50_000 }, async () => {
    const lsm = await startLsmStandIn({ heartbeatIntervalMs: 200 });
    const daemon = await startEntry(lsm.env);
    expect(daemon.stderr()).toContain("接入 LSM");
    expect(await lsm.waitFor((m) => m.type === "hello", "握手")).toMatchObject({ pid: daemon.child.pid, port: daemon.port });
    await lsm.waitFor((m) => m.type === "heartbeat", "心跳");
    let code: number | null = null;
    daemon.child.once("exit", (c) => (code = c));
    lsm.send({ type: "stop", id: "cmd-1", mode: "now", deadlineMs: 60_000 });
    expect(await lsm.waitFor((m) => m.type === "bye", "bye")).toEqual({ type: "bye", reason: "shutdown-complete" });
    await daemon.exited;
    expect(code).toBe(0);
    expect(fs.existsSync(daemon.pidFile)).toBe(false);
    await expect(healthz(daemon.port)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe.skipIf(process.platform !== "win32")("stop 钩子", () => {
  it("监听端口的就是 pid 文件里的守护进程：结束它，端口放出，pid 文件删掉；再停一次也算成功", async () => {
    const daemon = await startEntry();
    const stop = runStop(daemon.env);
    expect({ status: stop.status, stderr: stop.stderr }).toMatchObject({ status: 0 });
    await daemon.exited;
    await expect(healthz(daemon.port)).rejects.toThrow(/ECONNREFUSED/);
    expect(fs.existsSync(daemon.pidFile)).toBe(false);
    expect(runStop(daemon.env).status).toBe(0);
  });

  it("pid 文件里是别的进程：什么也不做，说明原因", async () => {
    const daemon = await startEntry();
    const record = readPidFile(daemon.pidFile)!;
    writeRecord(daemon.pidFile, { ...record, pid: process.pid });
    const stop = runStop(daemon.env);
    expect(stop.status).not.toBe(0);
    expect(stop.stderr).toContain("不是 pid 文件里的守护进程");
    expect(isProcessAlive(daemon.child.pid!)).toBe(true);
    expect((await healthz(daemon.port)).secretary).toBeDefined();
  });

  it("pid 对得上但启动时间对不上（pid 被复用）：什么也不做，说明原因", async () => {
    const daemon = await startEntry();
    const record = readPidFile(daemon.pidFile)!;
    writeRecord(daemon.pidFile, { ...record, startedAt: "2020-01-01T00:00:00.000Z" });
    const stop = runStop(daemon.env);
    expect(stop.status).not.toBe(0);
    expect(stop.stderr).toContain("启动时间");
    expect(isProcessAlive(daemon.child.pid!)).toBe(true);
  });

  it("没有 pid 文件：什么也不做，说明原因", async () => {
    const daemon = await startEntry();
    fs.rmSync(daemon.pidFile);
    const stop = runStop(daemon.env);
    expect(stop.status).not.toBe(0);
    expect(stop.stderr).toContain("没有 pid 文件");
    expect(isProcessAlive(daemon.child.pid!)).toBe(true);
  });
});

interface EntryProcess {
  port: number;
  child: ChildProcess;
  exited: Promise<void>;
  /** 给守护进程和 stop 钩子的环境（LSM 给两者注入的是同一份） */
  env: Record<string, string | undefined>;
  pidFile: string;
  stderr: () => string;
}

/** 像 LSM 那样拉起入口：只给数据目录（和测试用的临时主目录），等它报"已启动" */
async function startEntry(extraEnv: Record<string, string> = {}): Promise<EntryProcess> {
  const dataDir = makeTempDir("ergo-data-");
  const homeDir = makeTempDir("ergo-home-");
  const port = await writePortConfig(dataDir);
  const env = withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(homeDir), { ERGO_DATA_DIR: dataDir, DEEPSEEK_API_KEY: undefined }, extraEnv);

  const child = spawn(process.execPath, [path.join(SRC, "main.ts")], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  onTestFinished(async () => {
    killIfRunning(child);
    await exited;
  });
  await waitUntil(() => stderr.includes("已启动"), { timeoutMs: 20_000, describe: () => stderr });
  return { port, child, exited, env, pidFile: dataDirLayout(dataDir).pidFile, stderr: () => stderr };
}

function runStop(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [path.join(SRC, "stop.ts")], { env, encoding: "utf8", windowsHide: true });
}

function writeRecord(file: string, record: PidRecord): void {
  fs.writeFileSync(file, JSON.stringify(record));
}

function healthz(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => resolve(JSON.parse(body) as Record<string, unknown>));
      })
      .on("error", reject);
  });
}
