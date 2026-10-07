// 时钟（可注入）：调度器和按时间行事的模块（简单提醒、以后的定时作业和内部作业）都从这里取时间、设计时器。
// 正式运行用系统时钟；测试换成手动拨的时钟（test/helpers/clock.ts），到点不靠真等。
import { nowIso } from "@ergou/protocol";

export interface Clock {
  /** 现在（毫秒） */
  now(): number;
  /** 到 at（毫秒）时调用 fn；at 已经过了就尽快调用（不在登记的同一段代码里）。返回取消函数 */
  setTimer(at: number, fn: () => void): () => void;
}

/** setTimeout 能等的最长时间（约 24.8 天）；更远的分段等 */
const MAX_DELAY_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(at, fn) {
    let handle: NodeJS.Timeout | undefined;
    const arm = () => {
      const delay = Math.max(0, at - Date.now());
      handle = setTimeout(
        () => {
          if (Date.now() >= at) fn();
          else arm();
        },
        Math.min(delay, MAX_DELAY_MS),
      );
      // 计时器不拦着进程退出：守护进程靠端口活着
      handle.unref();
    };
    arm();
    return () => clearTimeout(handle);
  },
};

/** 时钟上现在的协议时间（带时区偏移的本地 ISO 时间） */
export function clockIso(clock: Clock): string {
  return nowIso(new Date(clock.now()));
}
