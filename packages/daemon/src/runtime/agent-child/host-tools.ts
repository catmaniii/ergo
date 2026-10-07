// 守护进程代为执行的工具：把装配参数里的 HostToolSpec 登记成 pi 的自定义工具。
// 模型调用时（pi 已按 JSON Schema 校验过参数），发 host_tool_call 给守护进程，等同一 requestId 的 host_tool_result，
// 再把结果交回模型。等的时候回合被中止，这次调用按出错结束。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentReport, HostToolResult, HostToolSpec } from "../host-protocol.ts";

export class HostToolBridge {
  private requestSeq = 0;
  private readonly waiting = new Map<string, (result: HostToolResult) => void>();
  private readonly emit: (report: AgentReport) => void;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  /** 交给 createAgentSession 的自定义工具 */
  tools(specs: readonly HostToolSpec[]): ToolDefinition[] {
    return specs.map(
      (spec): ToolDefinition => ({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        // 参数是普通的 JSON Schema（跨进程传过来，没有 TypeBox 的标记）；pi 照样按它编译校验。
        // 类型上 pi 要的是它自己那份 TypeBox 的 schema，这里按 ToolDefinition 的参数类型断言（守护进程不引用 TypeBox）
        parameters: spec.parameters as unknown as ToolDefinition["parameters"],
        execute: async (toolCallId, params, signal) => {
          const result = await this.call(spec.name, toolCallId, params, signal);
          return { content: [{ type: "text", text: result.text }], details: undefined, ...(result.isError ? { isError: true } : {}) };
        },
      }),
    );
  }

  /** 守护进程的结果到了；没有对应的请求时返回 false */
  reply(requestId: string, result: HostToolResult): boolean {
    const resolve = this.waiting.get(requestId);
    if (!resolve) return false;
    this.waiting.delete(requestId);
    resolve(result);
    return true;
  }

  private call(toolName: string, toolCallId: string, args: unknown, signal: AbortSignal | undefined): Promise<HostToolResult> {
    const requestId = `host-tool-${++this.requestSeq}`;
    return new Promise<HostToolResult>((resolve) => {
      this.waiting.set(requestId, resolve);
      signal?.addEventListener(
        "abort",
        () => {
          if (this.waiting.delete(requestId)) resolve({ text: "回合已中止", isError: true });
        },
        { once: true },
      );
      this.emit({ type: "host_tool_call", requestId, toolCallId, toolName, args });
    });
  }
}
