// 孤儿进程回收：Job 里的进程，从活着的 agent 子进程顺着父子关系往下走不到的，就是孤儿——
// 比如 bash 起的后台程序在 bash 退出后留下的，或者 agent 子进程退出后它没结束的孙进程。agent 管家按周期（默认每分钟）
// 把它们结束掉。Job 不允许脱离（job-object.ts），所以 agent 起的进程都在 Job 里，跑不掉。
//
// 补的两条：
// - **还在跑的工具调用期间起的进程这一轮不杀**：Git Bash（MSYS2）里一个 MSYS 进程 fork 再 exec 另一个 MSYS 程序时，新程序是个
//   新的 Windows 进程，它的 Windows 父进程（fork 出来的中间进程）交接完马上就退了。管道各段、`bash 脚本`、它们下面的整棵树
//   因此顺着父进程号走不到，可 bash 还在等它们。按创建时间认：晚于所有活着的 agent 里最早一个还没结束的工具调用的开始时间
//   （留 1 秒余量）的、取不到创建时间的，这一轮先留着；调用都结束之后它们若还在，下一轮照样回收。
// - **ego lite 的进程一律不杀**（466）：ego lite 没开着时，二狗的 shim 会抢先像用户自己打开那样替他打开（不在 Job 里，web/ego-open.ts）；
//   可万一还是被 ego-browser 自己拉起来了（agent 用完整路径调了真的 ego-browser、shim 没能用上），拉起来的就在 Job 里，
//   ego-browser 退了它就成了孤儿。那是用户自己用的浏览器（登录着各种网站），可执行文件在 ego lite 的程序目录下
//   （web/ego-browser.ts 的 egoProgramDirs：安装目录、active_version_dir）的进程连同它下面的进程都不算孤儿；
//   取不到完整路径的，名字是 ego.exe、ego-browser.exe 的也留着。
import type { JobObject } from "../process/job-object.ts";
import { processCreationTimes, processImagePaths, processSnapshot } from "../process/process-list.ts";
import { isEgoProgramName, isUnderDirs } from "../web/index.ts";

/** 创建时间和工具调用开始时间比较时的余量（毫秒）：调用开始是守护进程收到报告的时刻，进程创建在子进程那边 */
export const ORPHAN_CREATION_MARGIN_MS = 1000;

/** Job 里哪些进程是孤儿：从 roots（活着的 agent 子进程，加上 ego lite 的进程）顺着父子关系往下走不到的（纯函数） */
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

/**
 * 孤儿里哪些是 ego lite 的进程（纯函数）：可执行文件的完整路径在 keepDirs 下的；取不到完整路径的按名字（ego.exe、ego-browser.exe）
 */
export function egoProcesses(orphans: readonly number[], imageOf: ReadonlyMap<number, string>, exeOf: ReadonlyMap<number, string>, keepDirs: readonly string[]): number[] {
  return orphans.filter((pid) => {
    const image = imageOf.get(pid);
    return image === undefined ? isEgoProgramName(exeOf.get(pid) ?? "") : isUnderDirs(image, keepDirs);
  });
}

/** 这一轮回收看什么 */
export interface SweepScope {
  /** 活着的 agent 子进程 */
  roots: ReadonlySet<number>;
  /** 活着的 agent 里最早一个还没结束的工具调用的开始时间（毫秒）；没有在跑的调用不给 */
  busySince?: number;
  /** 可执行文件在这些目录下的进程（连同它下面的）不当孤儿：ego lite 的程序目录 */
  keepDirs?: readonly string[];
}

/** 回收一次：结束 Job 里的孤儿进程，返回结束了哪些 */
export function sweepOrphans(job: JobObject, scope: SweepScope, log: (line: string) => void): number[] {
  const jobPids = job.processIds();
  const snapshot = processSnapshot();
  const parentOf = new Map([...snapshot].map(([pid, { parent }]) => [pid, parent]));
  const exeOf = new Map([...snapshot].map(([pid, { exe }]) => [pid, exe]));
  let orphans = findOrphans(jobPids, parentOf, new Set(scope.roots));
  // ego lite 的进程：认出来的当根，它下面的进程一起留着（只对孤儿取完整路径，没有孤儿时一个都不取）
  if (orphans.length > 0) {
    const ego = egoProcesses(orphans, processImagePaths(orphans), exeOf, scope.keepDirs ?? []);
    if (ego.length > 0) orphans = findOrphans(jobPids, parentOf, new Set([...scope.roots, ...ego]));
  }
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
