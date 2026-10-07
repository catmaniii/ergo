// 孤儿进程回收（规格第 3 节）：Job 里的进程，从活着的 agent 子进程顺着父子关系往下走不到的，就是孤儿——
// 比如 bash 起的后台程序在 bash 退出后留下的，或者 agent 子进程退出后它没结束的孙进程。agent 管家按周期（默认每分钟）
// 把它们结束掉。Job 不允许脱离（job-object.ts），所以 agent 起的进程都在 Job 里，跑不掉。
import type { JobObject } from "../process/job-object.ts";
import { parentProcessIds } from "../process/process-list.ts";

/** Job 里哪些进程是孤儿：从 roots（活着的 agent 子进程）顺着父子关系往下走不到的（纯函数） */
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

/** 回收一次：结束 Job 里的孤儿进程，返回结束了哪些 */
export function sweepOrphans(job: JobObject, roots: ReadonlySet<number>, log: (line: string) => void): number[] {
  const orphans = findOrphans(job.processIds(), parentProcessIds(), roots);
  const killed: number[] = [];
  for (const pid of orphans) {
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
