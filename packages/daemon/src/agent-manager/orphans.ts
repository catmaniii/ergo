// 孤儿进程回收（规格第 3 节）：Job 里的进程，从活着的 agent 子进程顺着父子关系往下走不到的，就是孤儿——
// 比如 bash 起的后台程序在 bash 退出后留下的，或者 agent 子进程退出后它没结束的孙进程。agent 管家按周期（默认每分钟）
// 把它们结束掉。Job 不允许脱离（job-object.ts），所以 agent 起的进程都在 Job 里，跑不掉。
//
// 178 号票补的两条：
// - **还在跑的工具调用期间起的进程这一轮不杀**：Git Bash（MSYS2）里一个 MSYS 进程 fork 再 exec 另一个 MSYS 程序时，新程序是个
//   新的 Windows 进程，它的 Windows 父进程（fork 出来的中间进程）交接完马上就退了。管道各段、`bash 脚本`、它们下面的整棵树
//   因此顺着父进程号走不到，可 bash 还在等它们。按创建时间认：晚于所有活着的 agent 里最早一个还没结束的工具调用的开始时间
//   （留 1 秒余量）的、取不到创建时间的，这一轮先留着；调用都结束之后它们若还在，下一轮照样回收。
// - **agent-browser 跟着开它的 agent 走**（用户 2026-10-19 定）：agent 的 bash 环境里 AGENT_BROWSER_SOCKET_DIR 指向这个 agent
//   自己的目录（agent-manager.ts 注入），agent-browser 的守护进程在那里写 `<会话>.pid`。pid 文件里写着的、在 Job 里、可执行文件名
//   是 agent-browser 开头的守护进程算开它的 agent 的，连同它下面的进程（它开的 Chrome）都不当孤儿——只限那个 agent 还活着、
//   还没闲置太久（管家决定给不给它的目录）。认不准的（改了 socket 目录、pid 被复用了……）照旧回收。
import fs from "node:fs";
import path from "node:path";
import type { JobObject } from "../process/job-object.ts";
import { processCreationTimes, processSnapshot } from "../process/process-list.ts";

/** 创建时间和工具调用开始时间比较时的余量（毫秒）：调用开始是守护进程收到报告的时刻，进程创建在子进程那边 */
export const ORPHAN_CREATION_MARGIN_MS = 1000;

/** Job 里哪些进程是孤儿：从 roots（活着的 agent 子进程，加上认得出的 agent-browser 守护进程）顺着父子关系往下走不到的（纯函数） */
export function findOrphans(jobPids: readonly number[], parentOf: ReadonlyMap<number, number>, roots: ReadonlySet<number>): number[] {
  const inJob = new Set(jobPids);
  const children = new Map<number, number[]>();
  for (const pid of jobPids) {
    const parent = parentOf.get(pid);
    if (parent === undefined || !inJob.has(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const attached = new Set<number>();
  const pending = jobPids.filter((pid) => roots.has(pid));
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (attached.has(pid)) continue;
    attached.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return jobPids.filter((pid) => !attached.has(pid));
}

/**
 * 孤儿里这一轮能结束的（纯函数）：没有在跑的工具调用（busySince 没给）时全都能；有的话，只结束创建时间早于
 * busySince − 余量的，晚于它的、取不到创建时间的可能是那个调用起的，先留着
 */
export function reapable(orphans: readonly number[], createdAt: ReadonlyMap<number, number>, busySince: number | undefined): number[] {
  if (busySince === undefined) return [...orphans];
  return orphans.filter((pid) => {
    const created = createdAt.get(pid);
    return created !== undefined && created < busySince - ORPHAN_CREATION_MARGIN_MS;
  });
}

/** 是不是 agent-browser 的可执行文件（Windows 上是 agent-browser-win32-x64.exe；CLI 和守护进程是同一个） */
export function isAgentBrowserExe(name: string): boolean {
  return /^agent-browser/i.test(name);
}

/** pid 文件里写着的进程里，认得出是 agent-browser 守护进程的：在 Job 里、可执行文件名是 agent-browser 开头（纯函数） */
export function recognizedBrowserDaemons(listed: readonly number[], jobPids: readonly number[], exeOf: ReadonlyMap<number, string>): number[] {
  const inJob = new Set(jobPids);
  return [...new Set(listed)].filter((pid) => inJob.has(pid) && isAgentBrowserExe(exeOf.get(pid) ?? ""));
}

/** agent-browser 的 socket 目录里各会话的守护进程 pid（`<会话>.pid`，内容是整数）；目录不在、读不了是空的 */
export function readBrowserDaemonPids(socketDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(socketDir).filter((name) => name.endsWith(".pid"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const text = fs.readFileSync(path.join(socketDir, name), "utf8").trim();
      return /^\d+$/.test(text) ? [Number(text)] : [];
    } catch {
      return [];
    }
  });
}

/** 这一轮回收看什么 */
export interface SweepScope {
  /** 活着的 agent 子进程 */
  roots: ReadonlySet<number>;
  /** 活着的 agent 里最早一个还没结束的工具调用的开始时间（毫秒）；没有在跑的调用不给 */
  busySince?: number;
  /** 这些 agent-browser socket 目录里的守护进程留着（活着、没闲置太久的 agent 的） */
  browserSocketDirs?: readonly string[];
}

/** 回收一次：结束 Job 里的孤儿进程，返回结束了哪些 */
export function sweepOrphans(job: JobObject, scope: SweepScope, log: (line: string) => void): number[] {
  const jobPids = job.processIds();
  const snapshot = processSnapshot();
  const parentOf = new Map([...snapshot].map(([pid, { parent }]) => [pid, parent]));
  const exeOf = new Map([...snapshot].map(([pid, { exe }]) => [pid, exe]));
  const browsers = recognizedBrowserDaemons((scope.browserSocketDirs ?? []).flatMap(readBrowserDaemonPids), jobPids, exeOf);
  const orphans = findOrphans(jobPids, parentOf, new Set([...scope.roots, ...browsers]));
  const busySince = scope.busySince;
  const candidates = reapable(orphans, busySince === undefined || orphans.length === 0 ? new Map() : processCreationTimes(orphans), busySince);
  const killed: number[] = [];
  for (const pid of candidates) {
    try {
      // 结束前再确认一次它还在 Job 里（进程刚退出、pid 被别的进程复用时不误杀）
      if (!job.contains(pid)) continue;
      process.kill(pid);
      killed.push(pid);
    } catch {
      // 已经退出了
    }
  }
  if (killed.length > 0) log(`回收了 ${killed.length} 个孤儿进程：${killed.join("、")}`);
  return killed;
}
