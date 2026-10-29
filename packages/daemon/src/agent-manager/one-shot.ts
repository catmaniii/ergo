// 一次性的 agent 子进程（13 号票的评审子 agent、20 号票并行派出的子 agent 共用）：
// 经 agent 管家拉起（占子进程名额、满了排队）→ 接上守卫（每次工具调用照常判定）→ 接上代为执行的工具 →
// 就绪后送一条输入 → 这一轮结束（turn_end）就结束子进程。调用方拿结局：这一轮怎么结束的、最后一段回复的文字；
// 没等到这一轮结束子进程就退出了（被结束、意外退出、排队时被取消）的另算。
// 调用方还能知道输入送出去没有、"手头这一步"什么时候做完（当前的工具调用都结束了、下一次模型调用之前：工具包变了重新装配时
// 在这里停掉它，规格第 11 节"工具包变了立即生效"）。
import type { GuardedSession, GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { TurnOutcome } from "../runtime/index.ts";
import type { AgentManager, ManagedAgent, ManagedExit, SpawnAgentRequest } from "./agent-manager.ts";
import { type HostTool, hostToolTimeouts, serveHostTools } from "./host-tools.ts";

export interface OneShotRequest {
  agents: AgentManager;
  guards: Pick<GuardRuntime, "attach">;
  /** 拉起参数（代为执行的工具、它们的超时和中文名、守卫转发由这里填） */
  spawn: Omit<SpawnAgentRequest, "hostTools" | "toolTimeouts" | "toolTitles" | "forwardToolCalls">;
  hostTools: readonly HostTool[];
  /** 守卫看到的会话 */
  guard: GuardedSession;
  /** 就绪后交给它的那一条输入（到时候现生成） */
  input: () => string;
  log: (line: string) => void;
}

/** 一次性子进程的结局；reply 是这一轮里最后一段有文字的回复 */
export type OneShotEnd =
  | { kind: "turn_end"; outcome: TurnOutcome; errorMessage?: string; reply: string }
  | { kind: "exited"; exit: ManagedExit; reply: string };

export interface OneShot {
  /** 子进程（中止这一轮、提前结束它用） */
  readonly proc: ManagedAgent;
  readonly ended: Promise<OneShotEnd>;
  /** 那一条输入送出去了没有（还在排队、还没就绪的没有） */
  started(): boolean;
  /** 手头这一步做完了（一次工具调用结束、没有别的工具调用在做）时通知 */
  onStepEnd(listener: () => void): void;
}

/** 拉起一个一次性子进程（管家拒绝拉起时抛错） */
export function runOneShotAgent(request: OneShotRequest): OneShot {
  const { agentId } = request.spawn;
  const proc = request.agents.spawn({
    ...request.spawn,
    hostTools: request.hostTools.map((t) => t.spec),
    toolTimeouts: hostToolTimeouts(request.hostTools),
    // 活动状态里"调用：提交评审结论"这类说法（25 号票）
    toolTitles: Object.fromEntries(request.hostTools.map((t) => [t.spec.name, t.descriptor.title])),
    forwardToolCalls: true,
  });
  request.guards.attach(proc, request.guard);
  serveHostTools(proc, request.hostTools, { log: request.log });
  let sent = false;
  let reply = "";
  let turn: OneShotEnd | undefined;
  /** 在做的工具调用个数 */
  let inFlight = 0;
  const stepListeners: Array<() => void> = [];
  const ended = new Promise<OneShotEnd>((resolve) => {
    proc.onReport((report) => {
      if (report.type === "ready" && !sent) {
        sent = true;
        try {
          proc.send({ type: "user_input", inputId: `${agentId}-input`, text: request.input() });
        } catch (err) {
          // 刚好退出了：按退出算
          request.log(`交给 ${agentId} 的输入没送出去：${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (report.type === "tool_call_start") {
        inFlight += 1;
      } else if (report.type === "tool_call_end") {
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) for (const listener of stepListeners) listener();
      } else if (report.type === "message_final") {
        const text = report.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        if (text.trim()) reply = text;
      } else if (report.type === "turn_end" && !turn) {
        turn = { kind: "turn_end", outcome: report.outcome, ...(report.errorMessage === undefined ? {} : { errorMessage: report.errorMessage }), reply };
        resolve(turn);
        proc.kill();
      }
    });
    void proc.exited.then((exit) => resolve(turn ?? { kind: "exited", exit, reply }));
  });
  return { proc, ended, started: () => sent, onStepEnd: (listener) => stepListeners.push(listener) };
}
