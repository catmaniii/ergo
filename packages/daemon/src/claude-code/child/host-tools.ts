// 二狗的工具交给 Claude（291 号票，issue 24 方案 2.4 的 host_tool_call）：守护进程代为执行的工具（装配参数 contributions.tools：提交计划、
// 汇报进展、给秘书发消息、发附件、读附件、联网搜索、工具包里的 MCP……，插件给维护者的也在里面）经 SDK 的进程内 MCP 服务交给 Claude。
// Claude 调用时（MCP 的 tools/call）这里发 host_tool_call、等守护进程的 host_tool_result，结果照 MCP 的写法交回（文字，看图的附图片）。
// - 服务：二狗自己的工具在一个叫 ergo 的服务里（Claude 看到的名字是 mcp__ergo__<工具名>）；工具包里的 MCP 在二狗这边本来就叫
//   mcp__<服务>__<工具>，按服务各起一个同名的进程内服务（Claude 看到的名字和二狗的一样，不叠两层前缀）。
// - 不用 SDK 的 createSdkMcpServer / tool()：它们要 zod 的 schema，二狗的工具声明是普通的 JSON Schema（协议包 TypeBox 序列化的）；SDK 只要
//   一个有 connect(transport) 的对象（Query.connectSdkMcpServer），这里自己实现 MCP 的几条：initialize、ping、tools/list、tools/call、
//   notifications/cancelled（不加依赖，也不用把 JSON Schema 转回 zod）。
// - 工具包变了（宿主协议 toolkit，守护进程只在能力清单 live_toolkit 的运行时送）：同一个服务的工具清单当场换，发 notifications/tools/list_changed，
//   Claude Code 重新列工具，下一次调用就是新的。SDK 的 setMcpServers 对同名、已登记的服务保留原来的连接（sdk.mjs 里 already registered 那段），
//   换不了它的工具，所以只在服务增减时（工具包加减了 MCP）用 setMcpServers；同一个服务里的工具增减不重连——重连会把手头在等结果的调用
//   （比如正是维护者自己调"增减 skill"引起的这次变更）断掉。
// - 调用 id：Claude Code 在 tools/call 的 _meta 里带 claudecode/toolUseId（就是 assistant 消息里 tool_use 的 id，守卫、记录都按它）；
//   没带（老版本）时按工具名取还没交过结果的那次调用（resolveId，translator 记着）。
// - 一次一个：几个调用排队按先后执行（和 pi 那边一样：连发几个附件，聊天里的先后和模型说的一致）。
// - 调用被取消（Claude Code 发 notifications/cancelled：打断、超时）或子进程收尾：在等的按"回合已中止"交回；之后才到的结果不报错、扔掉。
// 守卫：调用之前照常过 PreToolUse 钩子（guard.ts：mcp__ergo__<工具名> 映射成二狗的工具名，按工具的登记判）。
// @i18n-ignore-file model：交回 Claude 的工具结果；日志
import type { McpServerConfig, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { mcpToolName, oldNameOf } from "@ergo/protocol";
import type { AgentReport, HostToolResult, HostToolSpec, JsonValue } from "../../runtime/host-protocol.ts";

/** 二狗自己的工具所在的进程内 MCP 服务的名字：Claude 看到的工具名是 mcp__ergo__<工具名>，定了别改 */
export const ERGO_MCP_SERVER = "ergo";

/** Claude Code 在 tools/call 的 _meta 里带的工具调用 id */
const TOOL_USE_META = "claudecode/toolUseId";

/** MCP 协议版本（Claude Code 没给时回这个） */
const MCP_PROTOCOL_VERSION = "2025-06-18";

const ABORTED: HostToolResult = { text: "回合已中止", isError: true };

/**
 * Claude 的工具名 → 二狗的工具名：mcp__ergo__<名字> 去掉前缀；别的（工具包里的 MCP、Claude 自带的）原样。
 * 312 号票：服务名以前是 ergou，接管的旧会话记录里的 mcp__ergou__<名字> 同样去掉前缀
 */
export function hostToolNameOf(claudeName: string): string {
  for (const server of [ERGO_MCP_SERVER, oldNameOf(ERGO_MCP_SERVER)]) {
    const prefix = `mcp__${server}__`;
    if (claudeName.startsWith(prefix)) return claudeName.slice(prefix.length);
  }
  return claudeName;
}

/** 二狗的一个工具在哪个服务、叫什么：mcp__<服务>__<工具> 的归那个服务，别的归 ergo */
function placeOf(hostName: string): { server: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(hostName);
  return match && match[1] !== ERGO_MCP_SERVER ? { server: match[1]!, tool: match[2]! } : { server: ERGO_MCP_SERVER, tool: hostName };
}

/** JSON-RPC 的一条消息（只看用到的字段） */
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** SDK 交给服务的进程内传输（Query.connectSdkMcpServer 的那个）：服务回的消息经 send 交给 Claude Code */
interface McpTransport {
  start?(): Promise<void>;
  send(message: RpcMessage): Promise<void>;
  close?(): Promise<void>;
  onmessage?: (message: RpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

interface ServerTool {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

/** 一个进程内 MCP 服务：SDK 叫 connect(transport) 接上；工具清单能当场换 */
class InProcessServer {
  private tools: ServerTool[] = [];
  private readonly transports = new Set<McpTransport>();
  readonly name: string;
  private readonly call: (server: string, tool: string, args: JsonValue, meta: Record<string, unknown>, cancel: AbortSignal) => Promise<HostToolResult>;
  private readonly log: (line: string) => void;
  /** 在做的调用：传输 + 请求 id → 取消它 */
  private readonly running = new Map<McpTransport, Map<string, AbortController>>();

  constructor(name: string, deps: { call: InProcessServer["call"]; log: (line: string) => void }) {
    this.name = name;
    this.call = deps.call;
    this.log = deps.log;
  }

  get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** 换工具清单：变了就告诉接着的 Claude Code 重新列 */
  setTools(tools: ServerTool[]): boolean {
    if (JSON.stringify(tools) === JSON.stringify(this.tools)) return false;
    this.tools = tools;
    for (const transport of this.transports) void this.post(transport, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return true;
  }

  /** SDK 接上一条进程内传输（MCP SDK 的 Protocol.connect 的写法） */
  async connect(transport: McpTransport): Promise<void> {
    this.transports.add(transport);
    this.running.set(transport, new Map());
    transport.onmessage = (message) => this.onMessage(transport, message);
    transport.onclose = () => {
      this.transports.delete(transport);
      for (const controller of this.running.get(transport)?.values() ?? []) controller.abort();
      this.running.delete(transport);
    };
    await transport.start?.();
  }

  private onMessage(transport: McpTransport, message: RpcMessage): void {
    if (message.id === undefined || message.id === null) {
      // 通知：取消一次调用（打断、超时）；别的（initialized……）不管
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        if (requestId !== undefined) this.running.get(transport)?.get(String(requestId))?.abort();
      }
      return;
    }
    if (message.method === undefined) return;
    const id = message.id;
    const respond = (result: unknown) => this.post(transport, { jsonrpc: "2.0", id, result });
    switch (message.method) {
      case "initialize":
        void respond({
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: this.name, version: "1.0.0" },
        });
        return;
      case "ping":
        void respond({});
        return;
      case "tools/list":
        void respond({ tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        return;
      case "tools/call":
        void this.onCall(transport, String(id), message.params ?? {}).then(respond);
        return;
      default:
        void this.post(transport, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  }

  private async onCall(transport: McpTransport, requestId: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = typeof params.name === "string" ? params.name : "";
    if (!this.tools.some((t) => t.name === tool)) return { content: [{ type: "text", text: `没有这个工具：${tool}` }], isError: true };
    const controller = new AbortController();
    this.running.get(transport)?.set(requestId, controller);
    try {
      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as JsonValue;
      const meta = (typeof params._meta === "object" && params._meta !== null ? params._meta : {}) as Record<string, unknown>;
      const result = await this.call(this.name, tool, args, meta, controller.signal);
      return {
        content: [{ type: "text", text: result.text }, ...(result.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mime }))],
        ...(result.isError ? { isError: true } : {}),
      };
    } finally {
      this.running.get(transport)?.delete(requestId);
    }
  }

  private async post(transport: McpTransport, message: RpcMessage): Promise<void> {
    try {
      await transport.send(message);
    } catch (err) {
      this.log(`进程内 MCP 服务 ${this.name} 回不了消息：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export interface HostToolBridgeDeps {
  emit: (report: AgentReport) => void;
  /** 这一轮已经进了上下文的插话（输入 id，按先后；86 号票）：随 host_tool_call 报 */
  interjected: () => readonly string[];
  /** _meta 里没带调用 id 时：按 Claude 的工具名取还没交过结果的那次调用（没有是 undefined） */
  resolveId: (claudeName: string) => string | undefined;
  log: (line: string) => void;
}

/** 二狗的工具交给 Claude 的那一层：按服务分好的进程内 MCP 服务、在等的调用 */
export class HostToolBridge {
  private readonly servers = new Map<string, InProcessServer>();
  private readonly waiting = new Map<string, (result: HostToolResult) => void>();
  /** 被取消、子进程不再等的请求：之后到的结果扔掉，不报错 */
  private readonly dropped = new Set<string>();
  private requestSeq = 0;
  private fallbackSeq = 0;
  /** 一次一个：排在前面的调用做完才发下一个 */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: HostToolBridgeDeps;

  constructor(deps: HostToolBridgeDeps) {
    this.deps = deps;
    // 二狗自己的服务总在（工具清单是空的也在）：之后加的工具不用另起服务
    this.servers.set(ERGO_MCP_SERVER, this.newServer(ERGO_MCP_SERVER));
  }

  /** 二狗现在交给 Claude 的工具（二狗这边的名字） */
  get toolNames(): string[] {
    return [...this.servers.values()].flatMap((server) => server.toolNames.map((tool) => (server.name === ERGO_MCP_SERVER ? tool : mcpToolName(server.name, tool))));
  }

  /**
   * 整份换成这些工具（拉起时的装配、宿主协议 toolkit）：同一个服务的清单当场换（变了的发 list_changed）。返回服务有没有增减——
   * 有的话 query 活着时要 setMcpServers
   */
  setTools(specs: readonly HostToolSpec[]): boolean {
    const grouped = new Map<string, ServerTool[]>([[ERGO_MCP_SERVER, []]]);
    for (const spec of specs) {
      const { server, tool } = placeOf(spec.name);
      grouped.set(server, [...(grouped.get(server) ?? []), { name: tool, description: spec.description, inputSchema: spec.parameters }]);
    }
    let reshaped = false;
    // 边遍历边删当前这一项是安全的
    for (const name of this.servers.keys()) {
      if (grouped.has(name)) continue;
      // 工具包里去掉的 MCP：服务拿掉（setMcpServers 断开它，这个服务上还在等结果的调用按"回合已中止"交回）
      this.servers.delete(name);
      reshaped = true;
    }
    for (const [name, tools] of grouped) {
      let server = this.servers.get(name);
      if (!server) {
        server = this.newServer(name);
        this.servers.set(name, server);
        reshaped = true;
      }
      server.setTools(tools);
    }
    return reshaped;
  }

  /** 交给 query 的 mcpServers（拉起时、服务增减时的 setMcpServers）：每个服务一条 type: "sdk" */
  mcpServers(): Record<string, McpServerConfig> {
    return Object.fromEntries(
      [...this.servers.values()].map((server): [string, McpServerConfig] => [
        server.name,
        { type: "sdk", name: server.name, instance: server as unknown as McpSdkServerConfigWithInstance["instance"] },
      ]),
    );
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

  /** 子进程收尾、query 结束：在等的都按"回合已中止"交回 */
  abortAll(): void {
    // 边遍历边删当前这一项是安全的
    for (const [requestId, resolve] of this.waiting) {
      this.waiting.delete(requestId);
      this.dropped.add(requestId);
      resolve(ABORTED);
    }
  }

  private newServer(name: string): InProcessServer {
    return new InProcessServer(name, { call: (server, tool, args, meta, cancel) => this.call(server, tool, args, meta, cancel), log: this.deps.log });
  }

  private call(server: string, tool: string, args: JsonValue, meta: Record<string, unknown>, cancel: AbortSignal): Promise<HostToolResult> {
    const toolName = server === ERGO_MCP_SERVER ? tool : mcpToolName(server, tool);
    const claudeName = mcpToolName(server, tool);
    const run = this.chain.then(() => (cancel.aborted ? ABORTED : this.send(toolName, claudeName, args, meta, cancel)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private send(toolName: string, claudeName: string, args: JsonValue, meta: Record<string, unknown>, cancel: AbortSignal): Promise<HostToolResult> {
    const metaId = meta[TOOL_USE_META];
    const toolCallId = typeof metaId === "string" && metaId ? metaId : (this.deps.resolveId(claudeName) ?? `mcp-call-${++this.fallbackSeq}`);
    const requestId = `host-tool-${++this.requestSeq}`;
    return new Promise<HostToolResult>((resolve) => {
      this.waiting.set(requestId, resolve);
      cancel.addEventListener(
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
