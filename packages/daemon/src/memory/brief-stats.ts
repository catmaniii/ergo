// 每条消息的记忆简报的统计（412）：最近一段时间问了几次、超时几次、出错几次、最近一次用了多久——体检的"记忆简报"那一项读它。
// 以前超时、出错只记日志（message-brief.ts），账本只记带上了的那几笔，3 天超时 34 次体检看不出来。
//
// - 一个小而独立的接口：message-brief.ts 每问完一次（不论带没带上）record 一下，体检 snapshot 读；不碰简报的算法，也不改日志。
//   427（简报分步计时）在另一条线上也给简报加计时和统计，合并时对齐到这一份（或者把这一份换成那边的，体检只认 snapshot 的形状）；
// - 只在内存里：守护进程重启就清零（snapshot 的 from 写明从什么时候起算），不写事件、不写库——体检要"现在"的样子，不要历史；
// - 窗口：最近 BRIEF_STATS_WINDOW_MS（24 小时）里的，最多留 BRIEF_STATS_LIMIT 次（再多的丢最早的，比例照样看得出来）；
// - 结局四种：brought 带上了、empty 问了但没有相关的（不带）、timeout 超过上限这一轮不带、error 出错这一轮不带。
//   "问了几次"是四种加起来；短应答、记忆页关了简报、不是本人说的那些压根不问，不算。

/** 一次简报的结局 */
export type BriefOutcome = "brought" | "empty" | "timeout" | "error";

/** 看最近多久的（毫秒）：24 小时 */
export const BRIEF_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 窗口里最多留几次 */
export const BRIEF_STATS_LIMIT = 1000;

/** 统计这一刻的样子（体检读的就是它） */
export interface BriefStatsSnapshot {
  /** 从什么时候起算（毫秒时间戳）：窗口的起点、这份统计建起来的时刻（插件起来的时候）、超过上限丢掉最早的之后留下的最早一次，取最晚的 */
  from: number;
  /** 问了几次（四种结局加起来） */
  asked: number;
  /** 超时几次（超过上限，这一轮不带） */
  timedOut: number;
  /** 出错几次（这一轮不带） */
  failed: number;
  /** 最近一次：什么时候、用了多少毫秒（超时的记的是等到上限的那么久）、结局；一次都没问过是 undefined */
  last?: { at: number; ms: number; outcome: BriefOutcome };
}

export interface BriefStats {
  /** 问完一次记一笔：结局、用了多少毫秒 */
  record(outcome: BriefOutcome, ms: number): void;
  /** 现在窗口里的统计 */
  snapshot(): BriefStatsSnapshot;
}

export interface BriefStatsOptions {
  /** 现在（毫秒时间戳）：守护进程的时钟（测试拨假时钟） */
  now: () => number;
  /** 看最近多久的，默认 BRIEF_STATS_WINDOW_MS */
  windowMs?: number;
  /** 最多留几次，默认 BRIEF_STATS_LIMIT */
  limit?: number;
}

export function createBriefStats(options: BriefStatsOptions): BriefStats {
  const windowMs = options.windowMs ?? BRIEF_STATS_WINDOW_MS;
  const limit = options.limit ?? BRIEF_STATS_LIMIT;
  /** 从什么时候起有数：建起来的时刻；超过 limit 丢了最早的之后是留下的最早那一次 */
  let floor = options.now();
  /** 窗口里的每一次，早的在前 */
  const entries: Array<{ at: number; ms: number; outcome: BriefOutcome }> = [];

  /** 丢掉窗口外的 */
  const prune = (now: number) => {
    let drop = 0;
    while (drop < entries.length && entries[drop]!.at < now - windowMs) drop += 1;
    if (drop > 0) entries.splice(0, drop);
  };

  return {
    record(outcome, ms) {
      const at = options.now();
      entries.push({ at, ms: Math.max(0, Math.round(ms)), outcome });
      if (entries.length > limit) {
        entries.splice(0, entries.length - limit);
        floor = entries[0]!.at;
      }
      prune(at);
    },
    snapshot() {
      const now = options.now();
      prune(now);
      let timedOut = 0;
      let failed = 0;
      for (const entry of entries) {
        if (entry.outcome === "timeout") timedOut += 1;
        else if (entry.outcome === "error") failed += 1;
      }
      const last = entries.at(-1);
      return { from: Math.max(floor, now - windowMs), asked: entries.length, timedOut, failed, ...(last === undefined ? {} : { last: { ...last } }) };
    },
  };
}
