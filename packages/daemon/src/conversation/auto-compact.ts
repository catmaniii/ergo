// 二狗按每个 agent 的压缩点自动压缩（420，协议包的 auto-compact.ts）：会话（agent-session.ts）在每轮结束（回复已经交出去）后问这里
// 要不要压，压完（或没压成）告诉这里，这里记着上次的结果和"没压成之后多久再试"。纯的，时间由调用方给。
//
// - 要压：这段会话最近一次干活的模型调用的上下文（缓存命中 + 未命中 + 输出，和 pi 算的、⚙ 上显示的一样）超过了生效的压缩点
//   （设置 · 模型的默认或 ⚙ 里单独设的，按模型窗口夹过：effectiveAutoCompact），而且不在"没压成之后等着再试"的时间里；
// - 没压成（模型出错、超时、压缩时子进程退出了）不连环重试：连续第 n 次没成，之后 15 分钟 × 2^(n-1)（最多 2 小时）里每轮结束都不再试，
//   到了时间也是等下一轮结束时再看（不为了重试另起一次）；压好了清零；
// - "没什么可压的"（刚压过、对话里能压的不够——最近约 2 万 token 原样留着）不算失败，但同样等一会儿再看，免得每轮都白问一次；
// - 被中止（清空、回退把它打断了）不记失败，下一轮结束照常再看。
// pi 自己"窗口 − 16384"的自动压缩（到了窗口边上、上下文溢出）的结果也记在这里（by: pi），没压成同样算一次失败——
// 二狗的点比它低，它没压成时二狗再跟着压也一样压不成。
import type { AgentAutoCompactOutcome, AgentAutoCompactResult, AgentAutoCompactTrigger } from "@ergo/protocol";

/** 没压成之后等多久再试：第一次 15 分钟，之后翻倍，最多 2 小时 */
export const AUTO_COMPACT_RETRY_BASE_MS = 15 * 60_000;
export const AUTO_COMPACT_RETRY_MAX_MS = 2 * 60 * 60_000;

/** "没什么可压的"之后等多久再看 */
export const AUTO_COMPACT_NOTHING_WAIT_MS = 15 * 60_000;

/** 连续第 failures 次没压成之后等多久再试 */
export function autoCompactRetryMs(failures: number): number {
  return Math.min(AUTO_COMPACT_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), AUTO_COMPACT_RETRY_MAX_MS);
}

/** 记着的：上次自动压缩的结果、连续没压成几次、下次最早什么时候再看（毫秒时间戳） */
export interface AutoCompactState {
  last?: AgentAutoCompactResult;
  failures: number;
  retryAt?: number;
}

/** 这一轮结束了，要不要压：用量知道、超过了压缩点、不在等着再试的时间里 */
export function autoCompactDue(state: Pick<AutoCompactState, "retryAt">, usedTokens: number | undefined, at: number, now: number): boolean {
  if (usedTokens === undefined || usedTokens <= at) return false;
  return state.retryAt === undefined || now >= state.retryAt;
}

/** 一次自动压缩结束了：记下结果，没压成的按次数往后推下次再试的时间 */
export function afterAutoCompact(
  state: AutoCompactState,
  result: { outcome: AgentAutoCompactOutcome; by: AgentAutoCompactTrigger; tokensBefore?: number | undefined; message?: string | undefined },
  now: number,
  nowIso: string,
): AutoCompactState {
  const last: AgentAutoCompactResult = {
    outcome: result.outcome,
    by: result.by,
    at: nowIso,
    ...(result.tokensBefore === undefined ? {} : { tokensBefore: result.tokensBefore }),
    ...(result.message === undefined ? {} : { message: result.message }),
  };
  switch (result.outcome) {
    case "done":
      return { last, failures: 0 };
    case "failed": {
      const failures = state.failures + 1;
      return { last, failures, retryAt: now + autoCompactRetryMs(failures) };
    }
    case "nothing":
      return { last, failures: state.failures, retryAt: now + AUTO_COMPACT_NOTHING_WAIT_MS };
    case "aborted":
      return { last, failures: state.failures, ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }) };
  }
}
