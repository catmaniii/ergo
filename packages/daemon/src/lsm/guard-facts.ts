// 服务管家在守卫眼里（419）：守卫的判定函数是纯函数，管理器端口、受保护的进程号由这里在判定前现取，作为环境事实交进去
// （guard-runtime/facts.ts 只在这次判定有相关的调用时才取）。只读服务管家数据目录里的文件、拍一张本机进程快照，不连服务管家、不改任何东西。
// - 管理器端口：registry/manager.yaml 的 port（没有这个文件是 ERGO_SVC_PORT 或 7420，和 ergo 命令一个算法），加上 LSM_URL 里的；
// - 受保护的进程：守护进程自己（process.pid），服务管家（state.json 的 manager.pid），命脉服务（state.json 里记的 pid）——
//   二狗自己的登记（LSM_SERVICE_ID，没有是 ergo-daemon）、它的公网隧道（登记里 exposure.via）、tailnet 网关（manager.yaml 的 tailnet.gateway）；
// - 进程快照（process/process-list.ts）补上可执行文件名（按名字杀时比）、已经不在的去掉，连同它们的上级进程（连同子进程杀上级会连带杀到它们）。
// 取不到的照实报：state.json 在却读不了、没记管理器的进程号，或者是服务管家拉起来的却找不到 state.json（数据目录读错了地方）时
// complete 是 false，守卫按"接近底线"先问。
import fs from "node:fs";
import path from "node:path";
import type { ProcessFacts, ProtectedProcess } from "../guard/index.ts";
import { DAEMON_SERVICE_ID, managerAddress } from "../cli/service.ts";
import { processCreationTimes, processSnapshot, type ProcessEntry } from "../process/process-list.ts";

/** 守卫现取的服务管家的事实（GuardRuntimeOptions.supervisor） */
export interface SupervisorGuardFacts {
  /**
   * 管理器此刻的端口：manager.yaml 的，加上拉起守护进程的那个管理器的（LSM_URL 里的）——二狗的登记没声明 LSM_DATA_DIR、
   * 读错了数据目录时靠后一个
   */
  ports(): number[];
  /** 受保护的进程 */
  processes(): ProcessFacts;
}

export interface SupervisorGuardFactsOptions {
  /** 服务管家的数据目录 */
  svcDataDir: string;
  env: NodeJS.ProcessEnv;
  /** 守护进程自己的进程号（测试里换） */
  selfPid?: number;
  /** 守护进程自己的可执行文件（取不到进程快照时按它的名字认守护进程） */
  selfExe?: string;
  /** 本机进程快照（测试里换成假的）；抛错就当取不到 */
  snapshot?: () => ReadonlyMap<number, ProcessEntry>;
  /** 进程的创建时间（认上级进程时防进程号复用；测试里换） */
  creationTimes?: (pids: readonly number[]) => ReadonlyMap<number, number>;
}

/** 往上认几层上级进程 */
const MAX_ANCESTORS = 8;

export function supervisorGuardFacts(options: SupervisorGuardFactsOptions): SupervisorGuardFacts {
  const { svcDataDir, env } = options;
  const registry = path.join(svcDataDir, "registry");
  return {
    ports() {
      const linked = linkPort(env.LSM_URL);
      return [...new Set([managerAddress({ svcDataDir, env }).port, ...(linked === undefined ? [] : [linked])])];
    },
    processes() {
      const self: ProtectedProcess = { pid: options.selfPid ?? process.pid, role: "daemon" };
      const list: ProtectedProcess[] = [self];
      let complete = true;
      const state = readState(path.join(svcDataDir, "state.json"));
      // 是服务管家拉起来的（有 LSM_URL），却找不到它的 state.json：数据目录读错了地方，服务管家的进程号没取到
      if (state === "unreadable" || (state === undefined && env.LSM_URL?.trim())) complete = false;
      else if (state !== undefined) {
        const manager = pidOf(state.manager?.pid);
        if (manager === undefined) complete = false;
        else list.push({ pid: manager, role: "manager" });
        const own = env.LSM_SERVICE_ID?.trim() || DAEMON_SERVICE_ID;
        const lifelines = [own, exposureVia(path.join(registry, "services", `${own}.yaml`)), tailnetGateway(path.join(registry, "manager.yaml"))];
        for (const id of new Set(lifelines.filter((x): x is string => x !== undefined))) {
          const pid = pidOf(state.services?.[id]?.pid);
          if (pid !== undefined) list.push(id === own ? { pid, role: "daemon" } : { pid, role: "service", service: id });
        }
      }
      return withSnapshot(dedupe(list), complete, options);
    },
  };
}

interface SupervisorState {
  manager?: { pid?: unknown };
  services?: Record<string, { pid?: unknown } | undefined>;
}

/** state.json：没有这个文件（没装服务管家）是 undefined，在却读不了、不是 JSON 是 unreadable */
function readState(file: string): SupervisorState | "unreadable" | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, "")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as SupervisorState) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** LSM_URL（ws://127.0.0.1:7420/link）里的端口；没有、读不出是 undefined */
function linkPort(url: string | undefined): number | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function pidOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** 登记里 exposure 段接的是哪条隧道（via 后面的 id）；和体检（doctor/doctor.ts）一个读法 */
function exposureVia(file: string): string | undefined {
  const text = readText(file);
  return text === undefined ? undefined : /(^|\n)\s*exposure:\s*\r?\n\s*via:\s*['"]?([^\s'"#]+)/.exec(text)?.[2];
}

/** manager.yaml 顶层 tailnet 段里的 gateway（tailnet 网关的服务 id） */
function tailnetGateway(file: string): string | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^tailnet:\s*(?:#.*)?$/.test(l));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s+gateway:\s*['"]?([^\s'"#]+)/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 同一个进程号只留一条（守护进程优先） */
function dedupe(list: readonly ProtectedProcess[]): ProtectedProcess[] {
  const out: ProtectedProcess[] = [];
  for (const p of list) if (!out.some((x) => x.pid === p.pid)) out.push(p);
  return out;
}

/**
 * 拍一张进程快照：补上可执行文件名，去掉已经不在的（守护进程自己除外），认出上级进程（创建时间早于下级的才算）。
 * 拍不了时守护进程按自己的可执行文件认，别的没有名字（按名字杀的判不准）
 */
function withSnapshot(list: ProtectedProcess[], complete: boolean, options: SupervisorGuardFactsOptions): ProcessFacts {
  let snapshot: ReadonlyMap<number, ProcessEntry>;
  try {
    snapshot = (options.snapshot ?? processSnapshot)();
  } catch {
    const exe = path.basename(options.selfExe ?? process.execPath);
    return { protected: list.map((p) => (p.pid === list[0]!.pid ? { ...p, exe } : p)), complete };
  }
  const alive = list.filter((p, i) => i === 0 || snapshot.has(p.pid)).map((p) => {
    const exe = snapshot.get(p.pid)?.exe ?? (p.pid === list[0]!.pid ? path.basename(options.selfExe ?? process.execPath) : undefined);
    return exe === undefined ? p : { ...p, exe };
  });
  const chains = alive.map((p) => {
    const chain: number[] = [];
    let current = p.pid;
    for (let i = 0; i < MAX_ANCESTORS; i++) {
      const parent = snapshot.get(current)?.parent;
      if (parent === undefined || parent === 0 || parent === current || chain.includes(parent) || !snapshot.has(parent)) break;
      chain.push(parent);
      current = parent;
    }
    return { of: p.pid, chain };
  });
  let times: ReadonlyMap<number, number> = new Map();
  try {
    times = (options.creationTimes ?? processCreationTimes)([...new Set(chains.flatMap((c) => [c.of, ...c.chain]))]);
  } catch {
    // 取不到创建时间：不核对进程号复用（宁可多认）
  }
  const protectedPids = new Set(alive.map((p) => p.pid));
  const ancestors: Array<{ pid: number; exe?: string; of: number }> = [];
  for (const { of, chain } of chains) {
    let below = of;
    // 它是谁的上级：记离它最近的受保护的下级
    let nearest = of;
    for (const pid of chain) {
      const parentTime = times.get(pid);
      const childTime = times.get(below);
      // 父进程比子进程还晚起：这个进程号已经被别的进程复用了，再往上的都不是
      if (parentTime !== undefined && childTime !== undefined && parentTime > childTime) break;
      if (protectedPids.has(pid)) nearest = pid;
      else if (!ancestors.some((a) => a.pid === pid)) {
        const exe = snapshot.get(pid)?.exe;
        ancestors.push(exe === undefined ? { pid, of: nearest } : { pid, exe, of: nearest });
      }
      below = pid;
    }
  }
  return { protected: alive, complete, ...(ancestors.length > 0 ? { ancestors } : {}) };
}
