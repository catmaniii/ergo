// 二狗的工具交给 Codex 的 stdio MCP 中转（ADR-0046）：Codex 按启动参数（-c mcp_servers.ergo.*）拉起它（一个会话可能拉起不止一个），它在 stdin / stdout 上说 MCP，
// 工具清单和每次调用都转给适配子进程（child/host-tools.ts）。它自己不记任何状态。
// 不用动态工具（dynamicTools）：0.166 只有 thread/start 能带，thread/resume、thread/fork 带不了——接管来的会话、重新拉起接着的会话都拿不到新工具。
// 只引 node 自带的模块和 bridge-client.ts。
// @i18n-ignore-file model：交回 Codex、给模型看的说明
import { askBridge } from "./bridge-client.ts";

const [pipe = "", token = ""] = process.argv.slice(2);

const MCP_PROTOCOL_VERSION = "2025-06-18";

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/** 在做的调用：请求 id → 取消它 */
const running = new Map<string, AbortController>();

const post = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function call(id: string | number, params: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  running.set(String(id), controller);
  try {
    const result = await askBridge(pipe, { token, kind: "call", name: params.name, args: params.arguments ?? {} }, controller.signal);
    post({ jsonrpc: "2.0", id, result });
  } catch (err) {
    post({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `这次调用没做成：${err instanceof Error ? err.message : String(err)}` }], isError: true } });
  } finally {
    running.delete(String(id));
  }
}

function onMessage(message: Message): void {
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === "notifications/cancelled") running.get(String(params.requestId))?.abort();
    return;
  }
  switch (method) {
    case "initialize":
      post({ jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ergo", version: "1.0.0" } } });
      return;
    case "ping":
      post({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      askBridge(pipe, { token, kind: "list" }).then(
        (tools) => post({ jsonrpc: "2.0", id, result: { tools } }),
        (err: unknown) => post({ jsonrpc: "2.0", id, error: { code: -32000, message: `连不上二狗：${err instanceof Error ? err.message : String(err)}` } }),
      );
      return;
    case "tools/call":
      void call(id, params);
      return;
    default:
      post({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method ?? ""}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line) as Message);
    } catch {
      // 看不懂的行不管
    }
  }
});
process.stdin.on("end", () => process.exit(0));
