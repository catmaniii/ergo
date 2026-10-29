// 调度器（规格第 13 节）：守护进程里唯一管"到点做什么"的地方，简单提醒、定时作业和内部作业共用；不用 Windows 计划任务。
// 按 key 登记：同一个 key 再登记就换掉原来的（改了时间的提醒），取消了就不再执行。时钟可注入（见 clock.ts）。
// 调度器只管内存里的计时器；要做的事有哪些、下一次在什么时候，存在各自模块的派生视图里，
// 守护进程启动时由各模块重新登记（所以重启后还没到点的照常触发）。错过的触发怎么补在 19 号票。
import type { Clock } from "./clock.ts";

export interface Scheduler {
  /** 到 at（毫秒）时执行 run；同一个 key 再登记就换掉原来的。at 已经过了就尽快执行 */
  schedule(key: string, at: number, run: () => void): void;
  cancel(key: string): void;
  /** 登记着、还没执行的（按时间先后） */
  pending(): Array<{ key: string; at: number }>;
  /** 取消全部计时器（守护进程停止时） */
  stop(): void;
}

export interface SchedulerOptions {
  clock: Clock;
  /** 执行出错时记日志 */
  log?: (line: string) => void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { clock } = options;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const jobs = new Map<string, { at: number; cancel: () => void }>();

  const cancel = (key: string) => {
    jobs.get(key)?.cancel();
    jobs.delete(key);
  };

  return {
    schedule(key, at, run) {
      cancel(key);
      const job = {
        at,
        cancel: clock.setTimer(at, () => {
          // 执行前先摘掉：run 里可以为同一个 key 登记下一次
          if (jobs.get(key) !== job) return;
          jobs.delete(key);
          try {
            run();
          } catch (err) {
            log(`调度器执行 ${key} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          }
        }),
      };
      jobs.set(key, job);
    },
    cancel,
    pending() {
      return [...jobs.entries()].map(([key, job]) => ({ key, at: job.at })).toSorted((a, b) => a.at - b.at);
    },
    stop() {
      for (const key of jobs.keys()) cancel(key);
    },
  };
}
