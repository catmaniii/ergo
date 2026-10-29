// 一次运行的结局（纯函数；19 号票定的结局，155 号票加"已撤回"，176 号票加"部分完成"）。编排（jobs.ts）收集这一轮的情况交进来，
// 说法在 texts.ts：
// - 被打断（守护进程停机、子进程意外退出）的是中断；你撤回会话、切换分支时被中止的是已撤回；
// - 这一轮出错、被中止，维护者用 fail_job_run 报了失败，定时触发的流程还有步骤既没做完也没说明跳过：失败，
//   这一轮里有一步没做成的，原因后面跟着那几步；
// - 都没有、但这一轮里有一步等不到批准被拦下、或者交给用户亲手做（用户 2026-10-19 定）：部分完成，原因写清哪几步没做成；
// - 都没有：成功。
import type { TurnEndEventPayload } from "@ergo/protocol";
import { failedWithBlocked, interruptedReason, partialReason, rolledBackReason, turnFailure } from "./texts.ts";

/**
 * 一次运行怎么结束的：成功、失败；部分完成（176 号票）、中断（停机打断）、没运行（排着时暂停、取消了）、已撤回（155 号票）
 * 不算进连续失败
 */
export type RunEnd = { state: "done" } | { state: "failed" | "interrupted" | "dropped" | "rolled_back" | "partial"; reason: string };

/** 这一轮里没做成的一步：先问用户的调用等不到批准被拦下（审批卡还在待办里）、守卫判定交给用户亲手做 */
export type BlockedStep = { kind: "approval"; toolTitle: string; argsSummary: string } | { kind: "hand_over"; toolTitle: string };

export interface RunEndInput {
  /** 这一轮怎么结束的 */
  turn: Pick<TurnEndEventPayload, "outcome" | "error">;
  /** 这一轮被中止时，这个会话是不是正在撤回、切换分支（conversation/rollback.ts 的 navigating） */
  navigating?: "rollback" | "switch" | undefined;
  /** 维护者用 fail_job_run 报的原因 */
  reported?: string | undefined;
  /** 定时触发的流程：还有几步既没做完也没说明跳过（要读计划核对的历史，前面已经算失败的不叫它）；不是流程的不给 */
  stepsLeft?: (() => string | undefined) | undefined;
  /** 这一轮里没做成的几步（先后照发生的顺序，同一步只算一次） */
  blocked: readonly BlockedStep[];
}

export function runEnd(input: RunEndInput): RunEnd {
  const { turn, blocked } = input;
  if (turn.outcome === "interrupted") return { state: "interrupted", reason: interruptedReason() };
  if (turn.outcome === "aborted" && input.navigating) return { state: "rolled_back", reason: rolledBackReason(input.navigating) };
  const failure = turnFailure(turn) ?? input.reported ?? input.stepsLeft?.();
  if (failure !== undefined) return { state: "failed", reason: blocked.length > 0 ? failedWithBlocked(failure, blocked) : failure };
  if (blocked.length > 0) return { state: "partial", reason: partialReason(blocked) };
  return { state: "done" };
}
