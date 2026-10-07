// Job 对象：agent 子进程和它起的孙进程都在二狗自建、不允许脱离的 Job 里；
// 守护进程被强杀后，它们都不再存在（规格第 17 节恢复规则的前提）。
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createJobObject } from "../src/process/job-object.ts";
import { LineDecoder } from "../src/runtime/line-channel.ts";
import { forceKill, isProcessAlive, waitUntil } from "./helpers/process.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const daemonHost = path.join(import.meta.dirname, "fixtures", "daemon-host.ts");

interface HostStatus {
  daemonPid: number;
  agentPid: number;
  grandchildPid: number;
  orphanPid: number;
  inJob: { agent: boolean; grandchild: boolean; orphan: boolean };
  limits: { killOnClose: boolean; breakawayAllowed: boolean };
}

/** 三个后代进程都在 Job 里、Job 不允许脱离；强杀前都活着，强杀后一个不剩 */
const ALL_IN_JOB_THEN_GONE = {
  status: {
    inJob: { agent: true, grandchild: true, orphan: true },
    limits: { killOnClose: true, breakawayAllowed: false },
  },
  aliveBeforeKill: [true, true, true],
  survivorsAfterKill: [],
};

describe.runIf(process.platform === "win32")("Job 对象", () => {
  it("强杀守护进程后，agent 子进程、孙进程和父进程已退出的孤儿曾孙进程都不再存在", async () => {
    expect(await killDaemonScenario({ daemonInOuterJob: false })).toMatchObject(ALL_IN_JOB_THEN_GONE);
  });

  it("守护进程本身已经在别的 Job 里（比如由 LSM 拉起）时同样成立", async () => {
    expect(await killDaemonScenario({ daemonInOuterJob: true })).toMatchObject(ALL_IN_JOB_THEN_GONE);
  });
});

interface ScenarioResult {
  status: HostStatus;
  aliveBeforeKill: boolean[];
  survivorsAfterKill: number[];
}

/** 起守护进程宿主 → 等它报告各进程 → 强杀它 → 最多等 10 秒，返回还活着的后代进程 */
async function killDaemonScenario({ daemonInOuterJob }: { daemonInOuterJob: boolean }): Promise<ScenarioResult> {
  const args = { dataDir: makeTempDir(), homeDir: makeTempDir(), pidDir: makeTempDir() };
  const host = spawn(process.execPath, [daemonHost, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  host.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // 兜底：测试中途失败时，把还没确认结束的进程清掉（确认结束的不再碰，免得 pid 被复用后误杀）
  const unconfirmed = new Set<number>([host.pid!]);
  const hostExited = new Promise((resolve) => host.once("exit", resolve)).then(() => unconfirmed.delete(host.pid!));
  onTestFinished(async () => {
    for (const pid of unconfirmed) forceKill(pid);
    await hostExited;
  });

  if (daemonInOuterJob) {
    // 模拟 LSM：守护进程开始拉起子进程之前，先被放进一个外层 Job
    const outer = createJobObject();
    onTestFinished(() => outer.close());
    outer.assign(host.pid!);
  }
  host.stdin.write("go\n");

  const status = await readStatus(host.stdout, () => stderr);
  const descendants = [status.agentPid, status.grandchildPid, status.orphanPid];
  for (const pid of descendants) unconfirmed.add(pid);

  const aliveBeforeKill = descendants.map(isProcessAlive);

  host.kill("SIGKILL");

  await waitUntil(() => descendants.every((pid) => !isProcessAlive(pid)), { timeoutMs: 10_000 }).catch(() => {});
  const survivorsAfterKill = descendants.filter(isProcessAlive);
  for (const pid of descendants) if (!survivorsAfterKill.includes(pid)) unconfirmed.delete(pid);
  return { status, aliveBeforeKill, survivorsAfterKill };
}

function readStatus(stdout: NodeJS.ReadableStream, stderr: () => string): Promise<HostStatus> {
  const decoder = new LineDecoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`守护进程宿主没有报告状态；stderr：\n${stderr()}`)), 25_000);
    stdout.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const message = JSON.parse(line) as HostStatus | { error: unknown };
        clearTimeout(timer);
        if ("error" in message) reject(new Error(`agent 报错：${JSON.stringify(message.error)}`));
        else resolve(message);
      }
    });
  });
}
