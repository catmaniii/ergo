// 服务管家在守卫眼里（419）：判定前现取管理器端口、受保护的进程（守护进程、服务管家、命脉服务的进程号）。
// 只读临时目录里编的 state.json、manager.yaml、登记；进程快照、创建时间都是假的——不碰真的服务管家、不拍真的进程快照。
// 守护进程一侧只在这次判定有相关的调用时才取（guard-runtime/facts.ts）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type JudgedCall } from "../../src/guard/index.ts";
import { gatherFacts } from "../../src/guard-runtime/facts.ts";
import { supervisorGuardFacts } from "../../src/lsm/guard-facts.ts";
import type { ProcessEntry } from "../../src/process/process-list.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假的进程快照：守护进程 4242 ← cmd 4100 ← 服务管家 4343 ← conhost 4000 ← svchost 900；隧道 4444 是服务管家的子进程 */
const SNAPSHOT: ReadonlyMap<number, ProcessEntry> = new Map([
  [900, { parent: 4, exe: "svchost.exe" }],
  [4000, { parent: 900, exe: "conhost.exe" }],
  [4343, { parent: 4000, exe: "node.exe" }],
  [4100, { parent: 4343, exe: "cmd.exe" }],
  [4242, { parent: 4100, exe: "node.exe" }],
  [4444, { parent: 4343, exe: "ssh.exe" }],
]);
/** 创建时间：上级都比下级早 */
const TIMES: ReadonlyMap<number, number> = new Map([
  [900, 1],
  [4000, 2],
  [4343, 3],
  [4100, 4],
  [4242, 5],
  [4444, 6],
]);

function rig(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = makeTempDir("ergo-svc-guard-");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return supervisorGuardFacts({
    svcDataDir: dir,
    env: { ERGO_SVC_PORT: "47999", ...env },
    selfPid: 4242,
    selfExe: "C:\\apps\\node\\node.exe",
    snapshot: () => SNAPSHOT,
    creationTimes: (pids) => new Map(pids.flatMap((p) => (TIMES.has(p) ? [[p, TIMES.get(p)!] as const] : []))),
  });
}

const STATE = JSON.stringify({
  version: 1,
  manager: { pid: 4343, startedAt: 1 },
  services: { "ergo-daemon": { state: "RUNNING", pid: 4100 }, "ergo-tunnel": { state: "RUNNING", pid: 4444 }, "ergo-gw": { state: "RUNNING", pid: 5555 }, other: { pid: 6000 } },
});
const DAEMON_ENTRY = "id: ergo-daemon\nexposure:\n  via: ergo-tunnel\n  remotePort: 18811\n";
const MANAGER = "bind: 127.0.0.1\nport: 47420\ntailnet:\n  domain: example.ts.net\n  gateway: ergo-gw\nprofiles: {}\n";

describe("管理器端口", () => {
  it("manager.yaml 的 port；没有这个文件时是 ERGO_SVC_PORT（和 ergo 命令一个算法）", () => {
    expect(rig({ "registry/manager.yaml": MANAGER }).ports()).toEqual([47420]);
    expect(rig().ports()).toEqual([47999]);
  });

  it("加上拉起守护进程的那个管理器的端口（LSM_URL）：数据目录读错了地方也认得出", () => {
    expect(rig({ "registry/manager.yaml": MANAGER }, { LSM_URL: "ws://127.0.0.1:47555/link" }).ports()).toEqual([47420, 47555]);
    expect(rig({ "registry/manager.yaml": MANAGER }, { LSM_URL: "ws://127.0.0.1:47420/link" }).ports()).toEqual([47420]);
    expect(rig({}, { LSM_URL: "not a url" }).ports()).toEqual([47999]);
  });
});

describe("受保护的进程", () => {
  it("守护进程、服务管家、二狗自己的登记、它的公网隧道、tailnet 网关；已经不在的去掉；补上可执行文件名和上级进程", () => {
    const facts = rig({ "state.json": STATE, "registry/manager.yaml": MANAGER, "registry/services/ergo-daemon.yaml": DAEMON_ENTRY }).processes();
    expect(facts.complete).toBe(true);
    expect(facts.protected).toEqual([
      { pid: 4242, role: "daemon", exe: "node.exe" },
      { pid: 4343, role: "manager", exe: "node.exe" },
      // 服务管家记着的二狗的进程号（钩子包着的那一层）
      { pid: 4100, role: "daemon", exe: "cmd.exe" },
      { pid: 4444, role: "service", service: "ergo-tunnel", exe: "ssh.exe" },
      // ergo-gw 的 5555 已经不在了；别的服务（other）不算命脉
    ]);
    expect(facts.ancestors).toEqual([
      { pid: 4000, exe: "conhost.exe", of: 4343 },
      { pid: 900, exe: "svchost.exe", of: 4343 },
    ]);
  });

  it("LSM_SERVICE_ID 换了登记名：按它认二狗自己的登记", () => {
    const state = JSON.stringify({ manager: { pid: 4343 }, services: { "my-ergo": { pid: 4100 }, "ergo-daemon": { pid: 4444 } } });
    const facts = rig({ "state.json": state }, { LSM_SERVICE_ID: "my-ergo" }).processes();
    expect(facts.protected.map((p) => p.pid)).toEqual([4242, 4343, 4100]);
  });

  it("没装服务管家（没有 state.json）：只有守护进程自己，算取全了", () => {
    const facts = rig().processes();
    expect(facts).toMatchObject({ complete: true, protected: [{ pid: 4242, role: "daemon", exe: "node.exe" }] });
  });

  it("state.json 读不了、没记管理器的进程号，或者是服务管家拉起来的却找不到 state.json：没取全（守卫按接近底线先问）", () => {
    expect(rig({}, { LSM_URL: "ws://127.0.0.1:47555/link" }).processes().complete).toBe(false);
    expect(rig({ "state.json": "{not json" }).processes().complete).toBe(false);
    expect(rig({ "state.json": JSON.stringify({ services: {} }) }).processes().complete).toBe(false);
  });

  it("上级进程比下级还晚起（进程号被复用了）：不再往上认", () => {
    const facts = supervisorGuardFacts({
      svcDataDir: makeTempDir("ergo-svc-guard-"),
      env: {},
      selfPid: 4242,
      snapshot: () => SNAPSHOT,
      creationTimes: () => new Map([[4242, 5], [4100, 99], [4343, 3]]),
    }).processes();
    expect(facts.ancestors).toBeUndefined();
  });

  it("拍不了进程快照：守护进程按自己的可执行文件认，别的没有名字", () => {
    const dir = makeTempDir("ergo-svc-guard-");
    fs.writeFileSync(path.join(dir, "state.json"), STATE);
    const facts = supervisorGuardFacts({
      svcDataDir: dir,
      env: {},
      selfPid: 4242,
      selfExe: "C:\\apps\\node\\node.exe",
      snapshot: () => {
        throw new Error("no snapshot");
      },
    }).processes();
    expect(facts.protected).toEqual([
      { pid: 4242, role: "daemon", exe: "node.exe" },
      { pid: 4343, role: "manager" },
      { pid: 4100, role: "daemon" },
    ]);
  });
});

const shell = (tool: string, args: Record<string, unknown>): JudgedCall => ({ tool, args, origin: "shell", text: "…" });

describe("守护进程一侧：有相关的调用才取", () => {
  const agent: GuardAgent = { kind: "secretary", agentId: "secretary", cwd: "D:\\x", toolkit: { bash: true, network: true }, scratchDir: "D:\\x" };

  it("发 HTTP 请求、拆不开的取端口，杀进程取受保护的进程；别的都不取", () => {
    let ports = 0;
    let processes = 0;
    const supervisor = {
      ports: () => (ports++, [47421]),
      processes: () => (processes++, { protected: [], complete: true }),
    };
    const ctx = { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: makeTempDir("ergo-home-"), supervisor };
    expect(gatherFacts([shell("shell_command", { program: "echo", paths: [] })], ctx)).toEqual({});
    expect(gatherFacts([shell("http_request", { method: "GET", url: "http://127.0.0.1:1/" })], ctx)).toEqual({ supervisorPorts: [47421] });
    expect(gatherFacts([shell("opaque_shell", { reason: "x", command: "x" })], ctx)).toEqual({ supervisorPorts: [47421] });
    expect(gatherFacts([shell("kill_process", { program: "kill", pids: [1] })], ctx)).toEqual({ processes: { protected: [], complete: true } });
    expect({ ports, processes }).toEqual({ ports: 2, processes: 1 });
  });

  it("取的时候出错：不给（判定时按更严的算）", () => {
    const supervisor = {
      ports: (): number[] => {
        throw new Error("x");
      },
      processes: () => {
        throw new Error("x");
      },
    };
    const ctx = { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: makeTempDir("ergo-home-"), supervisor };
    expect(gatherFacts([shell("http_request", { method: "POST", url: "http://127.0.0.1:1/" }), shell("kill_process", { program: "kill", pids: [1] })], ctx)).toEqual({});
  });
});
