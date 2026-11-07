// 服务管家里一个服务的日志，给人、给 agent 看之前怎么整理：秘书的 lsm_logs（418）和设置 · 服务一页（428）共用这一套。
// 服务管家那边取最后 N 行时已经脱敏过一遍，这里照现有的脱敏办法（guard 的 redactSecretShapes）再擦一遍像密钥的；
// 每行截到 400 字，一共最多 6000 字，多了只留最后的（新的在下面，最要紧）。
import { redactSecretShapes } from "../guard/index.ts";

/** 默认给几行、最多几行（服务管家那边最多 500：给 agent 和手机上看的不用那么多） */
export const LOG_LINES_DEFAULT = 60;
export const LOG_LINES_MAX = 200;
/** 一行最长多少字、一共最多多少字（多了只留最后的） */
const LOG_LINE_MAX_CHARS = 400;
const LOG_TOTAL_MAX_CHARS = 6_000;

/** 整理好的日志：lines 是留下的（旧的在前），cut 是前面还有行被截掉了 */
export function tidyLogLines(raw: string): { lines: string[]; cut: boolean } {
  const all = raw
    .split(/\r?\n/)
    .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
    .map((line) => {
      const clean = redactSecretShapes(line);
      return clean.length > LOG_LINE_MAX_CHARS ? `${clean.slice(0, LOG_LINE_MAX_CHARS)}…` : clean;
    });
  const kept: string[] = [];
  let size = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    size += all[i]!.length + 1;
    if (size > LOG_TOTAL_MAX_CHARS) break;
    kept.unshift(all[i]!);
  }
  return { lines: kept, cut: kept.length < all.length };
}

/** 要几行：不给是默认，超了按上限，至少 1 行 */
export function logLinesWanted(lines: number | undefined): number {
  if (lines === undefined || !Number.isFinite(lines)) return LOG_LINES_DEFAULT;
  return Math.min(LOG_LINES_MAX, Math.max(1, Math.trunc(lines)));
}
