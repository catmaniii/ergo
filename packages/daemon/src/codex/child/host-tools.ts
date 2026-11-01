// 二狗的工具交给 Codex（host_tool_call）：守护进程代为执行的工具（装配参数 contributions.tools）经一个 stdio MCP 中转（mcp-relay.ts）交给 Codex，服务名 ergo。
// Codex 看到的名字是 mcp__ergo__<工具名>。工具包里的 MCP（二狗这边叫 mcp__<服务>__<工具>）也放在这一个服务里，叫 <服务>__<工具>：
// 不用每个服务另起一个中转，这里按表换回二狗的名字。
// - 调用：中转把 tools/call 转到这里；这里先过守卫（中转是真正执行的地方，绕不过去），放行才发 host_tool_call，等 host_tool_result，照 MCP 的写法交回；
// - 调用 id：Codex 的 tools/call 不带工具调用 id（_meta 里只有 threadId、progressToken），按工具名认领 item/started 报过、还没人认领的那次（claim）；
//   认领不到（item/started 还没到）等一小会儿再认一次，还没有就自己起一个；
// - 一次一个：几个调用排队按先后执行（和 pi、Claude Code 那边一样）；
// - 调用被取消（中转断开：Codex 打断、超时）或子进程收尾：在等的按"回合已中止"交回，之后才到的结果扔掉不报错。
// @i18n-ignore-file model：交回 Codex 的工具结果
import { mcpToolName } from "@ergo/protocol";
import type { AgentReport, GuardVerdict, HostToolResult, HostToolSpec, JsonValue } from "../../runtime/host-protocol.ts";

/** 二狗的工具所在的 MCP 服务的名字：Codex 看到的工具名是 mcp__ergo__<名字>，定了别改 */
export const ERGO_MCP_SERVER = "ergo";

const ABORTED: HostToolResult = { text: "回合已中止", isError: true };

/** 认领调用 id 最多等多久、隔多久看一次 */
const CLAIM_WAIT_MS = 500;
const CLAIM_POLL_MS = 20;

/** 二狗的工具名 → 服务里的名字：mcp__<服务>__<工具> 写成 <服务>__<工具>，别的原样 */
export function relayNameOf(hostName: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(hostName);
  return match ? `${match[1]}__${match[2]}` : hostName;
}

export interface HostToolDeps {
  emit: (report: AgentReport) => void;
  /** 这一轮已经进了上下文的插话（输入 id，按先后）：随 host_tool_call 报 */
  interjected: () => readonly string[];
  /** 按 Codex 的工具名认领 item/started 报过、还没人认领的那次调用 */
  claim: (relayName: string) => string | undefined;
  /** 这次调用报开始（还没报过的话）并过守卫：交回判定 */
  decide: (call: { id: string; hostName: string; relayName: string; args: JsonValue }) => Promise<GuardVerdict>;
}

export class HostToolBridge {
  /** 服务里的名字 → 二狗的工具 */
  private readonly tools = new Map<string, HostToolSpec>();
  private readonly waiting = new Map<string, (result: HostToolResult) => void>();
  private readonly dropped = new Set<string>();
  private requestSeq = 0;
  private fallbackSeq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: HostToolDeps;

  constructor(specs: readonly HostToolSpec[], deps: HostToolDeps) {
    this.deps = deps;
    for (const spec of specs) this.tools.set(relayNameOf(spec.name), spec);
  }

  /** 服务里的这个名字对应的二狗工具名；不是二狗的是 undefined */
  hostNameOf(relayName: string): string | undefined {
    return this.tools.get(relayName)?.name;
  }

  /** 中转的 tools/list */
  list(): Array<{ name: string; description: string; inputSchema: JsonValue }> {
    return [...this.tools].map(([name, spec]) => ({ name, description: spec.description, inputSchema: spec.parameters }));
  }

  /** 中转的 tools/call：排队，轮到了过守卫、发 host_tool_call；交回 MCP 的结果 */
  call(relayName: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const spec = this.tools.get(relayName);
    if (!spec) return Promise.resolve(mcpResult({ text: `没有这个工具：${relayName}`, isError: true }));
    const run = this.chain.then(() => (signal.aborted ? ABORTED : this.run(spec, relayName, (args ?? {}) as JsonValue, signal)));
    this.chain = run.catch(() => undefined);
    return run.then(mcpResult);
  }

  /** 守护进程的结果到了：交给在等的那次调用；已经被取消的扔掉。没有这个请求是 false */
  reply(requestId: string, result: HostToolResult): boolean {
    const resolve = this.waiting.get(requestId);
    if (resolve) {
      this.waiting.delete(requestId);
      resolve(result);
      return true;
    }
    return this.dropped.delete(requestId);
  }

  /** 这一轮结束、子进程收尾：在等的都按"回合已中止"交回 */
  abortAll(): void {
    for (const [requestId, resolve] of this.waiting) {
      this.waiting.delete(requestId);
      this.dropped.add(requestId);
      resolve(ABORTED);
    }
  }

  private async run(spec: HostToolSpec, relayName: string, args: JsonValue, signal: AbortSignal): Promise<HostToolResult> {
    const id = (await this.claimId(relayName)) ?? `mcp-call-${++this.fallbackSeq}`;
    const verdict = await this.deps.decide({ id, hostName: spec.name, relayName, args });
    if (!verdict.allow) return { text: verdict.reason, isError: true };
    if (signal.aborted) return ABORTED;
    const result = await this.send(id, spec.name, (verdict.args ?? args) as JsonValue, signal);
    return verdict.resultPrefix ? { ...result, text: `${verdict.resultPrefix}\n${result.text}` } : result;
  }

  private async claimId(relayName: string): Promise<string | undefined> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const id = this.deps.claim(relayName);
      if (id !== undefined || Date.now() >= deadline) return id;
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    }
  }

  private send(toolCallId: string, toolName: string, args: JsonValue, signal: AbortSignal): Promise<HostToolResult> {
    const requestId = `host-tool-${++this.requestSeq}`;
    return new Promise<HostToolResult>((resolve) => {
      this.waiting.set(requestId, resolve);
      signal.addEventListener(
        "abort",
        () => {
          if (!this.waiting.delete(requestId)) return;
          this.dropped.add(requestId);
          resolve(ABORTED);
        },
        { once: true },
      );
      const interjected = this.deps.interjected();
      this.deps.emit({ type: "host_tool_call", requestId, toolCallId, toolName, args, ...(interjected.length > 0 ? { interjected: [...interjected] } : {}) });
    });
  }
}

/** 结果照 MCP 的写法：文字，看图的附图片 */
function mcpResult(result: HostToolResult): unknown {
  return {
    content: [{ type: "text", text: result.text }, ...(result.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mime }))],
    ...(result.isError ? { isError: true } : {}),
  };
}

/** 工具包里的 MCP 在二狗这边的名字（守卫、记录都按它）：host-tools 之外的模块不用知道拼法 */
export { mcpToolName };
