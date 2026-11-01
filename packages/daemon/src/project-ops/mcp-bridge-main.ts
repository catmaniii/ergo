// @i18n-ignore-file log：转发程序的说明只进守护进程的日志和 MCP 的报错
// 项目自动转的 MCP 的 stdio 程序（ADR-0045）：说标准的 MCP（每行一个 JSON-RPC 2.0 消息，initialize、ping、tools/list、tools/call），
// 工具清单和调用都经本机端口问守护进程（POST ERGO_OPS_MCP_URL，带 Authorization: Bearer ERGO_OPS_MCP_TOKEN），它自己不存状态、不做判断。
// 守护进程照 MCP 登记拉起它（mcp/client.ts，放进这个 MCP 的 Job 对象），凭证经登记的 env 注入。
// - 只转三样：工具名、参数、_meta 里的调用者（ergo/caller）。别的 _meta 不转，所以验收用的测试标记（ergo/test）走不到这条路；
// - 守护进程连不上、回 4xx / 5xx：tools/list 回 JSON-RPC 的错（自检看得到原因），tools/call 回 isError 的结果（模型看得到原因），进程不退；
// - 调用被中止（notifications/cancelled）：断开这次请求，守护进程那边跟着中止。stdin 关了就退出。
// 不 import 二狗的任何东西：只用 Node 自带的，将来配给外面的 MCP 客户端也是这一个文件（这一期只接二狗内部）。
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
/** 调用者在 _meta 里的键（和协议包的 PROJECT_OPS_MCP_CALLER_META 一样，这里不 import） */
const CALLER_META = "ergo/caller";

const url = process.env.ERGO_OPS_MCP_URL;
const token = process.env.ERGO_OPS_MCP_TOKEN;

type RpcId = number | string;
interface RpcMessage {
  id?: RpcId | null;
  method?: string;
  params?: Record<string, unknown>;
}

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const reply = (id: RpcId, result: unknown) => send({ id, result });
const replyError = (id: RpcId, code: number, message: string) => send({ id, error: { code, message } });

/** 问守护进程：回 JSON；回不了的抛错，错误说明是能给人看的那句 */
async function ask(body: object, signal?: AbortSignal): Promise<unknown> {
  if (!url || !token) throw new Error("环境里没有 ERGO_OPS_MCP_URL、ERGO_OPS_MCP_TOKEN：这个程序要由二狗按 MCP 登记拉起");
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted) throw new Error("调用被中止了", { cause: err });
    throw new Error(`连不上二狗（${err instanceof Error ? err.message : String(err)}）`, { cause: err });
  }
  const text = await res.text();
  if (res.ok) return JSON.parse(text) as unknown;
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // 不是 JSON：原样说
  }
  throw new Error(`二狗回 ${res.status}：${message}`);
}

/** 正在调的（notifications/cancelled 按 id 中止） */
const running = new Map<RpcId, AbortController>();

async function callTool(id: RpcId, params: Record<string, unknown>): Promise<void> {
  const abort = new AbortController();
  running.set(id, abort);
  const meta = params["_meta"] as Record<string, unknown> | undefined;
  try {
    const result = await ask({ method: "tools/call", name: params.name, arguments: params.arguments ?? {}, ...(meta?.[CALLER_META] ? { caller: meta[CALLER_META] } : {}) }, abort.signal);
    reply(id, result);
  } catch (err) {
    reply(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
  } finally {
    running.delete(id);
  }
}

async function listTools(id: RpcId): Promise<void> {
  try {
    reply(id, await ask({ method: "tools/list" }));
  } catch (err) {
    replyError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

function handle(message: RpcMessage): void {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled") running.get(params.requestId as RpcId)?.abort();
    return;
  }
  if (method === "initialize") return reply(id, { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ergo-project-ops", version: "1" } });
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return void listTools(id);
  if (method === "tools/call") return void callTool(id, params);
  replyError(id, -32601, `不支持 ${String(method)}`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  let message: RpcMessage;
  try {
    message = JSON.parse(line) as RpcMessage;
  } catch {
    return send({ id: null, error: { code: -32700, message: "不是 JSON" } });
  }
  handle(message);
}).on("close", () => process.exit(0));
