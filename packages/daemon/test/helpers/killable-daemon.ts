// 能被直接杀掉的守护进程（被杀后的恢复，23 号票）：在独立进程里起一个守护进程实例（fixtures/killable-daemon.ts），
// 测试经 WebSocket 当前端连它，然后像 LSM 重启时那样直接杀掉它（Windows 上是 TerminateProcess，Job 对象随之关闭，
// agent 子进程和孙进程一起结束），再用同一个数据目录在测试进程里起一个（startTestDaemon 的 reuse）看恢复。
//
//   const killable = await startKillableDaemon({ maintainer: { "tm-1": [起草计划的剧本, 执行的剧本] } });
//   const frontend = await TestFrontend.connect(killable.url);
//   …
//   await killable.waitFor((m) => m.allowed?.toolName === "bash", "bash 开始执行");
//   await killable.kill();
//   const td = await restartAfterKill(killable, { maintainer: … });
//   await frontend.reconnect([…], td.url);
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { readJsonLines } from "../../src/runtime/line-channel.ts";
import type { KillableDaemonArgs } from "../fixtures/killable-daemon.ts";
import { type StartTestDaemonOptions, startTestDaemon, TEST_PAGE, type TestDaemon, writeConfig } from "./daemon.ts";
import { forceKill, isProcessAlive, waitUntil } from "./process.ts";
import { makeTempDir } from "./temp-dir.ts";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "killable-daemon.ts");

/** 守护进程宿主报出来的一行 */
export interface KillableReport {
  ready?: { url: string; externalUrl: string; pid: number; secretaryPid: number | null };
  guard?: { type: string; payload: unknown };
  agent?: { agentId: string; pid: number };
  allowed?: { agentId: string; toolCallId: string; toolName: string };
  pids?: { job: number[]; agents: Array<{ agentId: string; pid: number }> };
}

export interface KillableDaemon {
  url: string;
  pid: number;
  /** 秘书子进程的 pid */
  secretaryPid: number | null;
  dataDir: string;
  homeDir: string;
  webRoot: string;
  programDir: string;
  /** 到目前为止报出来的每一行 */
  readonly reports: readonly KillableReport[];
  /** 等报出来某一行（已经报过的也算） */
  waitFor(match: (report: KillableReport) => boolean, what: string, timeoutMs?: number): Promise<KillableReport>;
  /** 现在 Job 对象里的全部进程、活着的 agent 子进程 */
  processes(): Promise<NonNullable<KillableReport["pids"]>>;
  /** 直接杀掉守护进程（不走停止流程），等它退出 */
  kill(): Promise<void>;
}

export interface KillableDaemonOptions {
  secretary?: FauxStep[];
  secretaryTokensPerSecond?: number;
  /** 维护者 id → 第几次唤起（从 1 起）的剧本 */
  maintainer?: Record<string, FauxStep[][]>;
  /** 并行派出的子 agent（20 号票）：子 agent id（sa-<n>）→ 剧本 */
  subAgent?: Record<string, FauxStep[]>;
  /** 起来之前写进数据目录 config/ergou.json 的配置 */
  config?: Record<string, unknown>;
}

export async function startKillableDaemon(options: KillableDaemonOptions = {}): Promise<KillableDaemon> {
  const dataDir = makeTempDir("ergou-data-");
  const homeDir = makeTempDir("ergou-home-");
  const webRoot = makeTempDir("ergou-web-");
  fs.writeFileSync(path.join(webRoot, "index.html"), TEST_PAGE);
  const programDir = makeTempDir("ergou-program-");
  if (options.config) writeConfig(dataDir, options.config);
  const args: KillableDaemonArgs = {
    dataDir,
    homeDir,
    webRoot,
    programDir,
    secretary: options.secretary ?? [],
    ...(options.secretaryTokensPerSecond === undefined ? {} : { secretaryTokensPerSecond: options.secretaryTokensPerSecond }),
    maintainer: options.maintainer ?? {},
    ...(options.subAgent === undefined ? {} : { subAgent: options.subAgent }),
  };
  const host = spawn(process.execPath, [FIXTURE, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  host.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  // 兜底：测试中途失败时连同子进程树一起结束（已经退出的不再碰）
  onTestFinished(async () => {
    if (host.exitCode === null && host.signalCode === null) forceKill(host.pid!);
    await exited;
  });

  const reports: KillableReport[] = [];
  readJsonLines<KillableReport>(host.stdout, (report) => reports.push(report), { onInvalid: (line) => reports.push({ guard: { type: "unparsed", payload: line } }) });

  const waitFor = async (match: (report: KillableReport) => boolean, what: string, timeoutMs = 30_000) => {
    let found: KillableReport | undefined;
    await waitUntil(() => (found = reports.find(match)) !== undefined || host.exitCode !== null, { timeoutMs, describe: () => `等${what}；守护进程的 stderr：\n${stderr.slice(-3000)}` });
    if (!found) throw new Error(`守护进程退出了，没等到${what}；stderr：\n${stderr.slice(-3000)}`);
    return found;
  };

  const { ready } = await waitFor((r) => r.ready !== undefined, "守护进程起来");
  return {
    url: ready!.url,
    pid: ready!.pid,
    secretaryPid: ready!.secretaryPid,
    dataDir,
    homeDir,
    webRoot,
    programDir,
    reports,
    waitFor,
    async processes() {
      const before = reports.length;
      host.stdin.write("pids\n");
      await waitUntil(() => reports.slice(before).some((r) => r.pids !== undefined), { describe: () => "等 Job 里的进程列表" });
      return reports.slice(before).find((r) => r.pids !== undefined)!.pids!;
    },
    async kill() {
      host.kill("SIGKILL");
      await exited;
    },
  };
}

/** 用被杀的那个守护进程的数据目录、主目录、Web 目录和程序目录，在测试进程里再起一个（测试结束时停掉） */
export function restartAfterKill(killed: KillableDaemon, options: Omit<StartTestDaemonOptions, "reuse" | "webRoot" | "programDir"> = {}): Promise<TestDaemon> {
  return startTestDaemon({ ...options, reuse: { dataDir: killed.dataDir, homeDir: killed.homeDir }, webRoot: killed.webRoot, programDir: killed.programDir });
}

/** 这些进程都结束了（最多等 10 秒）；返回还活着的 */
export async function survivors(pids: readonly number[], timeoutMs = 10_000): Promise<number[]> {
  await waitUntil(() => pids.every((pid) => !isProcessAlive(pid)), { timeoutMs }).catch(() => {});
  return pids.filter(isProcessAlive);
}
