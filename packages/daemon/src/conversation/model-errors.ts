// 模型调用出错（421）：按服务商回的原文分出种类（服务商忙、太久没回应、别的出错），聊天里"正在重试"那行字、
// 最后没成时会话里的说明都按它写。原文只截短放进事件（排查用），给人看的话走语言文件。
import { type ModelErrorKind, t } from "@ergo/protocol";

/** 服务商忙：限流、过载、503 这类（pi 也当成能重试的） */
const BUSY = /overloaded|high demand|at capacity|rate.?limit|too many requests|\b429\b|\b503\b|service.?unavailable|ResourceExhausted|server (is )?busy/i;
/** 太久没回应：二狗等不到一个字中止的（silentCallError）、服务商那边或者网络超时的 */
const TIMEOUT = /timed? ?out|timeout|ETIMEDOUT/i;

/** 出错原文的种类 */
export function modelErrorKind(error: string): ModelErrorKind {
  if (BUSY.test(error)) return "busy";
  if (TIMEOUT.test(error)) return "timeout";
  return "error";
}

/** 原文截短成一行（事件里、说明里括号中的那一段） */
export function clipModelError(error: string, max = 160): string {
  const line = error.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 自动重试过、最后还是没成：会话里那条"这次没能回复"的原因写清是服务商那边的情况、可以怎么办。
 * retries 是重试了几次（最后一次 model_retry 的 attempt），error 是最后一次出错的原文
 */
export function modelFailedReason(error: string, retries: number): string {
  return t(FAILED[modelErrorKind(error)], { count: retries, error: clipModelError(error) });
}

const FAILED: Readonly<Record<ModelErrorKind, string>> = {
  busy: "conversation.modelFailed.busy",
  timeout: "conversation.modelFailed.timeout",
  error: "conversation.modelFailed.error",
};
