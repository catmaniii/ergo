// 守卫转发：子进程里每次工具调用先停在 pi 的 tool_call 钩子里，发 guard_request 给守护进程，
// 等到同一 requestId 的 guard_reply 才决定执行与否（规格第 3 节）。
// 判定"不放行"时用钩子的 block 结果让 pi 不执行这次调用。
// 放行时带了 args 的（59 号票：流程执行时按计划改回参数），原地把这次调用的参数整份换成它（pi 的 tool_call 钩子允许原地改
// event.input，改后不再校验），工具结果出来时在前面加上 resultPrefix（pi 的 tool_result 钩子），模型知道实际执行的是哪一版。
// 本票只立通路；超时（最长等 5 分钟，之后挂起）和守卫本身在 07 号票。
// 128 号票起不再单独挂一个 pi 扩展：桥接扩展（bridge.ts）在 tool_call、tool_result 里叫这里的两个方法（守卫是内核，不算插件的钩子）。
import type { ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentReport, GuardVerdict } from "../host-protocol.ts";

export class GuardForwarder {
  private requestSeq = 0;
  private readonly waiting = new Map<string, (verdict: GuardVerdict) => void>();
  /** 按计划改过参数的调用：工具结果前面要加的话（调用 id → 话） */
  private readonly prefixes = new Map<string, string>();
  private readonly emit: (report: AgentReport) => void;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  /** 模型要调用一个工具（pi 的 tool_call）：送守护进程判定，等到判定再放行或拦下；signal 是这一回合的中止信号 */
  async onToolCall(event: ToolCallEvent, signal: AbortSignal | undefined): Promise<ToolCallEventResult | undefined> {
    const requestId = `guard-${++this.requestSeq}`;
    const verdict = await new Promise<GuardVerdict>((resolve) => {
      this.waiting.set(requestId, resolve);
      // 等判定时回合被中止：这次调用按"不放行"处理
      signal?.addEventListener(
        "abort",
        () => {
          if (this.waiting.delete(requestId)) resolve({ allow: false, reason: "回合已中止" }); // @i18n-ignore model：交给模型的守卫结果
        },
        { once: true },
      );
      this.emit({ type: "guard_request", requestId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.input });
    });
    if (!verdict.allow) return { block: true, reason: verdict.reason };
    if (verdict.args) {
      const input = event.input as Record<string, unknown>;
      for (const key of Object.keys(input)) if (!Object.hasOwn(verdict.args, key)) delete input[key];
      Object.assign(input, verdict.args);
    }
    if (verdict.resultPrefix) this.prefixes.set(event.toolCallId, verdict.resultPrefix);
    return undefined;
  }

  /** 工具结果出来了（pi 的 tool_result）：按计划改过参数的，前面加上实际执行的是哪一版 */
  onToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    const prefix = this.prefixes.get(event.toolCallId);
    if (prefix === undefined) return undefined;
    this.prefixes.delete(event.toolCallId);
    return { content: [{ type: "text", text: prefix }, ...event.content], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
  }

  /** 守护进程的判定到了；没有对应的请求时返回 false */
  reply(requestId: string, verdict: GuardVerdict): boolean {
    const resolve = this.waiting.get(requestId);
    if (!resolve) return false;
    this.waiting.delete(requestId);
    resolve(verdict);
    return true;
  }
}
